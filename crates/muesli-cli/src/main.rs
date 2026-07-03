//! `muesli` — the Local Agent (ADR 0014; docs/design/local-agent-cli.md).
//!
//! `login`, `open`, `share`, `status`, `unlink`, `mcp`, and the Phase 5 folder daemon
//! `sync`. The CLI is a pure **sync bridge**: it never hosts the Document — it keeps a CRDT
//! replica synced with the server room, ingests disk edits as text diffs, and materializes
//! remote edits back to disk (docs/design/ingest-and-materialization.md). Hands-off git.
//! The per-file bridge machinery lives in `session.rs` (shared by `open` and `sync`).

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use notify::{RecursiveMode, Watcher};
use tokio::sync::{mpsc, watch};

use muesli_cli::{api, session, store, sync};
use session::{FileSession, SessionCtx, SessionMode, SessionOutcome, Stop};

const DEFAULT_SERVER: &str = "ws://localhost:8787/ws";

#[derive(Parser)]
#[command(name = "muesli", version, about = "Muesli local agent — live multiplayer for plain .md files")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Sign in: device-code flow against the server's OIDC issuer; stores a delegated
    /// agent token in the OS keychain.
    Login {
        #[arg(long, default_value = DEFAULT_SERVER, env = "MUESLI_SERVER")]
        server: String,
    },
    /// Link a markdown file and keep it live-synced with a Muesli server.
    Open {
        /// The markdown file to sync (created if missing).
        file: PathBuf,
        /// Sync server websocket base URL.
        #[arg(long, default_value = DEFAULT_SERVER, env = "MUESLI_SERVER")]
        server: String,
        /// Document id (room name). Defaults to the file stem.
        #[arg(long)]
        doc: Option<String>,
        /// Web app base URL used to print the share link.
        #[arg(long, default_value = "http://localhost:5173", env = "MUESLI_WEB")]
        web: String,
    },
    /// Folder sync, Drive-desktop-style (Phase 5, ADR 0014): every .md under <dir> is
    /// linked and live-synced; drop a new .md in and it auto-links. Up to 64 concurrent
    /// connections; beyond that, sessions lazily connect on change / round-robin.
    Sync {
        /// The folder to sync (recursively; hidden dirs, node_modules, target skipped).
        dir: PathBuf,
        /// Sync server websocket base URL.
        #[arg(long, default_value = DEFAULT_SERVER, env = "MUESLI_SERVER")]
        server: String,
        /// Prefix prepended to derived doc slugs (e.g. --prefix team → team-sub-notes).
        #[arg(long)]
        prefix: Option<String>,
        /// Web app base URL (the printed link base).
        #[arg(long, default_value = "http://localhost:5173", env = "MUESLI_WEB")]
        web: String,
    },
    /// Create a role-scoped share link for a linked file or document id.
    Share {
        /// A linked markdown file, or a document id.
        target: String,
        #[arg(long, default_value = "editor")]
        role: String,
        #[arg(long, default_value = DEFAULT_SERVER, env = "MUESLI_SERVER")]
        server: String,
        #[arg(long, default_value = "http://localhost:5173", env = "MUESLI_WEB")]
        web: String,
    },
    /// Who am I, and which files are linked.
    Status {
        #[arg(long, default_value = DEFAULT_SERVER, env = "MUESLI_SERVER")]
        server: String,
    },
    /// Forget a link. The local file stays exactly as it is (never deleted).
    Unlink { file: PathBuf },
    /// Remove the stored token for a server.
    Logout {
        #[arg(long, default_value = DEFAULT_SERVER, env = "MUESLI_SERVER")]
        server: String,
    },
    /// stdio MCP transport (ADR 0008): newline-delimited JSON-RPC on stdin/stdout, proxied
    /// to the server's POST /mcp with the stored token. MCP client config: command
    /// "muesli", args ["mcp"].
    Mcp {
        #[arg(long, default_value = DEFAULT_SERVER, env = "MUESLI_SERVER")]
        server: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "muesli=info".into()),
        )
        .init();

    match Cli::parse().cmd {
        Cmd::Login { server } => login(server).await,
        Cmd::Open { file, server, doc, web } => open(file, server, doc, web).await,
        Cmd::Sync { dir, server, prefix, web } => sync::sync(dir, server, prefix, web).await,
        Cmd::Share { target, role, server, web } => share(target, role, server, web).await,
        Cmd::Status { server } => status(server).await,
        Cmd::Unlink { file } => unlink(file),
        Cmd::Logout { server } => {
            store::delete_token(&server)?;
            println!("✓ signed out of {}", store::http_base(&server));
            Ok(())
        }
        Cmd::Mcp { server } => mcp_proxy(server).await,
    }
}

// ---------------------------------------------------------------------------
// mcp: stdio ⇄ POST /mcp proxy (docs/design/mcp-and-agent-auth.md)
// ---------------------------------------------------------------------------

/// Forward each stdin line (one JSON-RPC message) to POST {server}/mcp. Responses go to
/// stdout as single-line JSON; notification acks (202/empty) produce no output; stderr is
/// for logs only — stdout must stay pure protocol.
async fn mcp_proxy(server: String) -> Result<()> {
    use tokio::io::AsyncBufReadExt;

    let url = format!("{}/mcp", store::http_base(&server));
    let token = store::load_token(&server);
    if token.is_none() {
        eprintln!("muesli mcp: no stored token for {} (fine on an open server)", store::http_base(&server));
    }
    let client = reqwest::Client::new();
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // We need the id to (a) know whether a response is owed and (b) synthesize an
        // error response when the server is unreachable.
        let id = match serde_json::from_str::<serde_json::Value>(line) {
            Ok(v) => v.get("id").cloned().filter(|i| !i.is_null()),
            Err(e) => {
                write_line(
                    &mut stdout,
                    &serde_json::json!({
                        "jsonrpc": "2.0", "id": null,
                        "error": { "code": -32700, "message": format!("parse error: {e}") }
                    }),
                )
                .await?;
                continue;
            }
        };

        let mut req = client
            .post(&url)
            .header("content-type", "application/json")
            .body(line.to_string());
        if let Some(t) = &token {
            req = req.bearer_auth(t);
        }
        match req.send().await {
            Ok(res) => {
                let status = res.status();
                let body = res.text().await.unwrap_or_default();
                if status.as_u16() == 401 {
                    eprintln!("muesli mcp: server returned 401 unauthorized — run `muesli login`");
                }
                let Some(id) = id else { continue }; // notification: 202/empty, nothing to write
                match serde_json::from_str::<serde_json::Value>(&body) {
                    // A proper JSON-RPC response: re-serialize compact = guaranteed one line.
                    Ok(v) if v.get("jsonrpc").is_some() => write_line(&mut stdout, &v).await?,
                    _ => {
                        let detail = body.split_whitespace().collect::<Vec<_>>().join(" ");
                        write_line(
                            &mut stdout,
                            &serde_json::json!({
                                "jsonrpc": "2.0", "id": id,
                                "error": { "code": -32000, "message": format!("server error ({status}): {detail}") }
                            }),
                        )
                        .await?;
                    }
                }
            }
            Err(e) => {
                eprintln!("muesli mcp: request failed: {e}");
                if let Some(id) = id {
                    write_line(
                        &mut stdout,
                        &serde_json::json!({
                            "jsonrpc": "2.0", "id": id,
                            "error": { "code": -32000, "message": format!("muesli server unreachable: {e}") }
                        }),
                    )
                    .await?;
                }
            }
        }
    }
    Ok(())
}

async fn write_line(
    stdout: &mut tokio::io::Stdout,
    value: &serde_json::Value,
) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut buf = serde_json::to_vec(value)?;
    buf.push(b'\n');
    stdout.write_all(&buf).await?;
    stdout.flush().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// login / share / status / unlink
// ---------------------------------------------------------------------------

async fn login(server: String) -> Result<()> {
    let config = api::auth_config(&server).await?;
    if config.mode == "open" {
        println!("✓ {} runs in open mode — no sign-in needed.", store::http_base(&server));
        return Ok(());
    }
    let issuer = config.issuer.context("server reported oidc mode but no issuer")?;
    let client_id = config.cli_client_id.context("server reported no CLI client id")?;

    let id_token = api::device_flow(&issuer, &client_id).await?;
    let label = format!("muesli-cli@{}", hostname());
    let login = api::cli_login(&server, &id_token, &label).await?;
    store::save_token(&server, &login.token)?;
    println!(
        "✓ signed in as {} (agent identity: {label})",
        login.owner_email.as_deref().unwrap_or("<unknown>")
    );
    Ok(())
}

async fn share(target: String, role: String, server: String, web: String) -> Result<()> {
    // A linked file resolves through the index; anything else is a document id.
    let doc = match session::absolutize(Path::new(&target)) {
        Ok(path) if path.exists() => match store::find_link(&path) {
            Some(link) => link.doc,
            None => bail!("{target} is not linked — run `muesli open {target}` first"),
        },
        _ => target.clone(),
    };

    match store::load_token(&server) {
        Some(token) => {
            let link = api::create_share(&server, &token, &doc, &role).await?;
            println!("✓ {} link: {}", link.role, link.url);
        }
        None => {
            // Open mode (or not signed in): the URL itself is the link if the server is open.
            let config = api::auth_config(&server).await?;
            if config.mode == "open" {
                println!("✓ link (open server): {}/#{}", web.trim_end_matches('/'), doc);
            } else {
                bail!("not signed in — run `muesli login` first");
            }
        }
    }
    Ok(())
}

async fn status(server: String) -> Result<()> {
    let http = store::http_base(&server);
    let token = store::load_token(&server);
    match api::me(&server, token.as_deref()).await {
        Ok(me) if me.mode == "open" => println!("server   {http} (open mode)"),
        Ok(me) => match me.user {
            Some(u) => println!(
                "server   {http}\nsigned in as {}",
                u.display_name.or(u.email).unwrap_or_else(|| "<unknown>".into())
            ),
            None => println!("server   {http}\nnot signed in — run `muesli login`"),
        },
        Err(e) => println!("server   {http} (unreachable: {e:#})"),
    }

    let links = store::load_links();
    if links.is_empty() {
        println!("links    none — `muesli open <file.md>` to start");
    } else {
        println!("links");
        for l in links {
            let missing = if l.file.exists() { "" } else { "  (file missing)" };
            let synced = match &l.last_synced {
                Some(t) => format!("  (last synced {t} UTC)"),
                None => String::new(),
            };
            println!("  {}  ⇄  {}/#{}{synced}{missing}", l.file.display(), l.server, l.doc);
        }
    }
    Ok(())
}

fn unlink(file: PathBuf) -> Result<()> {
    let path = session::absolutize(&file)?;
    match store::remove_link(&path)? {
        Some(link) => println!("✓ unlinked {} (was {}/#{}). File untouched.", path.display(), link.server, link.doc),
        None => println!("{} was not linked.", path.display()),
    }
    Ok(())
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "local".into())
}

// ---------------------------------------------------------------------------
// open: one file's sync bridge (the session machinery lives in session.rs)
// ---------------------------------------------------------------------------

async fn open(file: PathBuf, server: String, doc: Option<String>, web: String) -> Result<()> {
    let file = session::absolutize(&file)?;
    let doc_id = doc.unwrap_or_else(|| {
        file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "untitled".into())
    });
    let url = format!("{}/{}", store::ws_base(&server).trim_end_matches('/'), doc_id);
    let token = store::load_token(&server);

    // Watch the parent directory (editors replace files via rename, which breaks
    // file-level watches), filter to our file.
    let (fs_tx, mut fs_rx) = mpsc::unbounded_channel::<()>();
    let watch_target = file.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if event.paths.iter().any(|p| p == &watch_target) {
                let _ = fs_tx.send(());
            }
        }
    })?;
    let parent = file.parent().context("file has no parent directory")?;
    watcher.watch(parent, RecursiveMode::NonRecursive)?;

    // Ctrl-C → flush-stop (final materialize of a dirty replica happens in the session).
    let (stop_tx, mut stop_rx) = watch::channel(Stop::Run);
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        let _ = stop_tx.send(Stop::Flush);
    });

    let mut session = FileSession::new(SessionCtx {
        file,
        doc_id,
        server,
        url,
        token,
        mode: SessionMode::Open { web },
    });
    // `muesli open` has no editor bridge of its own (Task 3 wires the Tauri embedder);
    // hand `run` a throwaway control channel that never yields a command.
    let (_bridge_ctl_tx, mut bridge_ctl_rx) = mpsc::unbounded_channel::<session::BridgeCmd>();
    match session.run(&mut fs_rx, &mut stop_rx, &mut bridge_ctl_rx, None).await? {
        SessionOutcome::Stopped(_) => {
            println!("\n✓ unlinked from this session (file stays as-is)");
            Ok(())
        }
        SessionOutcome::Idle => unreachable!("open sessions have no idle timeout"),
    }
}
