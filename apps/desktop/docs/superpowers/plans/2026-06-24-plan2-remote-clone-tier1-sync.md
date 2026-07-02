# Plan 2: Remote Clone + Tier-1 File Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Join a cloud-only workspace → lazily clone its documents into a Finder folder (folder tree rebuilt, each doc's text pulled and written, file↔doc links recorded), then run a Rust daemon that keeps the whole folder's **content** live — materializing remote edits to disk and ingesting disk edits back — with no cursors yet.

**Architecture:** Reuse the muesli backend wholesale. The clone enumerates `GET /api/documents` (filtered client-side by the selected workspace's `workspace_id`), rebuilds the folder tree on disk, pulls each doc's current text over `GET /api/documents/{slug}/text`, writes the `.md` files atomically, and pre-records each file↔slug link in `muesli_cli::store`'s `index.db`. demo_muesli then runs `muesli_cli::sync::run` as an embedded, Tauri-managed daemon over that folder: because every cloned file already has a link, the daemon binds each to its existing server room and live-syncs content via `muesli-cli`'s `FileSession` (y-sync step1/2 + reconcile, 50 ms ingest settle, 500 ms materialize debounce, atomic temp+rename, byte-compare echo guard). The open editor reads from disk (no second replica) and reloads when the daemon writes the file.

**Tech Stack:** Rust (Tauri 2 backend) with path-dependency reuse of `muesli-core` / `muesli-cli` / `muesli-server`; `tokio` (`watch` channels, `JoinHandle`); SvelteKit + Svelte 5 runes frontend; the device-code auth + workspace registry from Plan 1.

## Global Constraints

- **Path deps** point at the sibling checkout: `muesli-core = { path = "../../muesli/crates/muesli-core" }` and `muesli-cli = { path = "../../muesli/crates/muesli-cli" }` from `src-tauri/` (already wired in Plan 1). The lib crate names are `muesli_core` / `muesli_cli` (underscored) even though the package names are hyphenated.
- **Terminology:** "workspace" everywhere (never "vault").
- **Branch:** `feat/auth-remote-workspaces` (the same branch Plan 1 merged into `feat/muesli-editor-port`); create it from the current `feat/muesli-editor-port` HEAD if it is not checked out.
- **Clean commits:** NO `Co-Authored-By` trailer (Julian's repo convention). Conventional-commit subjects.
- **Token store reuse:** the agent token lives in the macOS Keychain under service `muesli`, keyed by `muesli_cli::store::http_base(server)`. Read it with `muesli_cli::store::load_token(server)` — never re-implement.
- **Links are owned by `muesli_cli::store`**, not by demo_muesli's `workspace_index`. The clone pre-records links with `muesli_cli::store::record_link`; the daemon reads them with `load_links`/`find_link`. Do NOT add a `links` table to `workspace_index` (it would desync from the store the daemon actually reads). This supersedes Plan 1's "Notes for Plan 2" line about adding a links table to `index.db`.
- **`pnpm check` must report 0 errors / 0 warnings** before any frontend task is marked complete.
- **macOS only.** Rust tests that link ScreenCaptureKit crash under DYLD unless run with:
  `DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx`
  Prefix every `cargo test`/`cargo build` for `demo_muesli`'s `src-tauri` with that env var.
- **Upstream muesli changes** land on muesli branch `feat/cli-list-workspaces` (the branch Plan 1's upstream work is on, not yet merged to muesli `main`). Keep them minimal and additive.
- **Tier boundary:** Plan 2 delivers **content** liveness only. Live cursors / in-editor lockstep (the `TauriProvider`) are Plan 3. Structural sync (remote folder/rename/move/delete propagation, the workspace event stream, and workspace-correct placement of brand-new local files) is Plan 4. Where this plan reuses `sync::run`'s folder-placement reconciler, note that for cloned docs it is inert (it only repositions docs still at the server root with a default title — cloned docs already carry their folder + title), so leaving it on is harmless; making new-local-file placement workspace-correct is explicitly Plan 4.

---

### Task 1: Upstream `muesli_cli::api` — `workspace_id` on list rows + `doc_text` pull helper

**Files:**
- Modify: `/Users/julianbeaulieu/Code/muesli/crates/muesli-cli/src/api.rs` (`DocInfo`, `FolderInfo`, add `doc_text`)
- Test: same file's `#[cfg(test)]` module

**Interfaces:**
- Consumes: nothing new (reuses the private `auth()` helper and `crate::store::http_base`).
- Produces:
  - `DocInfo { slug: String, title: Option<String>, folder_id: Option<String>, workspace_id: Option<String> }`
  - `FolderInfo { id: String, parent_id: Option<String>, name: String, workspace_id: Option<String> }`
  - `pub async fn doc_text(server: &str, token: Option<&str>, slug: &str) -> anyhow::Result<String>`

**Context:** `GET /api/documents` returns every document/folder the caller can see across all their workspaces, each row carrying a `workspace_id`. The current `DocInfo`/`FolderInfo` drop that field, so the clone can't tell which rows belong to the workspace being cloned. `GET /api/documents/{slug}/text` returns `{ "seq": <i64>, "text": <string> }` and works even in volatile mode — the clone uses it for the eager content pull.

- [ ] **Step 1: Write the failing test**

Add to the existing `#[cfg(test)]` area of `api.rs` (it already has `mod workspace_list_tests`). Append a new module:

```rust
#[cfg(test)]
mod plan2_tests {
    use super::{DocInfo, FolderInfo};

    #[test]
    fn doc_and_folder_rows_carry_workspace_id() {
        let doc: DocInfo = serde_json::from_str(
            r#"{"slug":"notes","title":"Notes","folder_id":"f1","workspace_id":"w1"}"#,
        )
        .unwrap();
        assert_eq!(doc.workspace_id.as_deref(), Some("w1"));
        assert_eq!(doc.folder_id.as_deref(), Some("f1"));

        // workspace_id is optional: open-mode / legacy rows may omit it.
        let doc2: DocInfo =
            serde_json::from_str(r#"{"slug":"x","title":null,"folder_id":null}"#).unwrap();
        assert_eq!(doc2.workspace_id, None);

        let folder: FolderInfo = serde_json::from_str(
            r#"{"id":"f1","parent_id":null,"name":"Inbox","workspace_id":"w1"}"#,
        )
        .unwrap();
        assert_eq!(folder.workspace_id.as_deref(), Some("w1"));
        assert_eq!(folder.name, "Inbox");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/julianbeaulieu/Code/muesli && cargo test -p muesli-cli plan2_tests 2>&1 | tail -20`
Expected: FAIL to compile — `DocInfo`/`FolderInfo` have no field `workspace_id`.

- [ ] **Step 3: Add the fields and the helper**

In `api.rs`, extend the two structs (keep `#[derive(Deserialize, Clone)]`; add `#[serde(default)]` so rows without the field still parse):

```rust
/// A folder row from `GET /api/documents` (the `folders` array).
#[derive(Deserialize, Clone)]
pub struct FolderInfo {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    /// The owning workspace (None in open mode / legacy rows).
    #[serde(default)]
    pub workspace_id: Option<String>,
}

/// A document row from `GET /api/documents` (only the fields placement/clone need).
#[derive(Deserialize, Clone)]
pub struct DocInfo {
    pub slug: String,
    pub title: Option<String>,
    pub folder_id: Option<String>,
    /// The owning workspace (None in open mode / legacy rows).
    #[serde(default)]
    pub workspace_id: Option<String>,
}
```

Then add the pull helper after `place_document` (it reuses the module-private `auth()` and `http_base`):

```rust
#[derive(Deserialize)]
struct DocText {
    text: String,
}

/// Fetch a document's current plain-text (`GET /api/documents/{slug}/text` → `{seq,text}`).
/// Used by the clone for the eager initial content pull; the daemon keeps it live after.
pub async fn doc_text(server: &str, token: Option<&str>, slug: &str) -> Result<String> {
    let req =
        reqwest::Client::new().get(format!("{}/api/documents/{}/text", http_base(server), slug));
    let res = auth(req, token).send().await?.error_for_status()?;
    Ok(res.json::<DocText>().await.context("parsing document text")?.text)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/julianbeaulieu/Code/muesli && cargo test -p muesli-cli plan2_tests 2>&1 | tail -20`
Expected: PASS. Also run `cargo build -p muesli-cli` — the existing `reconcile_loop`/`sync.rs` consumers of `DocInfo`/`FolderInfo` still compile (new fields are additive).

- [ ] **Step 5: Commit (on the muesli repo)**

```bash
cd /Users/julianbeaulieu/Code/muesli
git checkout feat/cli-list-workspaces
git add crates/muesli-cli/src/api.rs
git commit -m "feat(cli): expose workspace_id on doc/folder rows + doc_text pull helper"
```

---

### Task 2: `clone::plan_layout` — reconstruct on-disk paths from server rows (pure)

**Files:**
- Create: `/Users/julianbeaulieu/Code/demo_muesli/src-tauri/src/clone/mod.rs`
- Create: `/Users/julianbeaulieu/Code/demo_muesli/src-tauri/src/clone/paths.rs`
- Modify: `/Users/julianbeaulieu/Code/demo_muesli/src-tauri/src/lib.rs` (add `mod clone;`)
- Test: inline `#[cfg(test)]` in `paths.rs`

**Interfaces:**
- Consumes: `muesli_cli::api::{DocInfo, FolderInfo}` (Task 1).
- Produces:
  - `pub struct PlannedFile { pub slug: String, pub rel_path: std::path::PathBuf }`
  - `pub fn plan_layout(docs: &[muesli_cli::api::DocInfo], folders: &[muesli_cli::api::FolderInfo]) -> Vec<PlannedFile>`

**Context:** The clone is the inverse of `muesli sync`'s slug-from-path naming: given the server's folder rows (`id`, `parent_id`, `name`) and doc rows (`slug`, `title`, `folder_id`), compute a relative `.md` path for each doc. A doc's directory is the chain of folder names from root to its `folder_id`; its filename is the sanitized `title` (falling back to `slug`) + `.md`. Filenames are sanitized (path separators and control characters folded to `-`) and de-duplicated within a directory by numeric suffix, deterministically (process rows sorted by slug) so a re-clone reproduces identical paths — which is what makes the clone resumable against the link index.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/clone/paths.rs` with only the test first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use muesli_cli::api::{DocInfo, FolderInfo};
    use std::path::PathBuf;

    fn folder(id: &str, parent: Option<&str>, name: &str) -> FolderInfo {
        FolderInfo {
            id: id.into(),
            parent_id: parent.map(Into::into),
            name: name.into(),
            workspace_id: Some("w1".into()),
        }
    }
    fn doc(slug: &str, title: Option<&str>, folder: Option<&str>) -> DocInfo {
        DocInfo {
            slug: slug.into(),
            title: title.map(Into::into),
            folder_id: folder.map(Into::into),
            workspace_id: Some("w1".into()),
        }
    }

    #[test]
    fn root_doc_uses_title_then_slug() {
        let plan = plan_layout(&[doc("welcome", Some("Welcome"), None)], &[]);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].slug, "welcome");
        assert_eq!(plan[0].rel_path, PathBuf::from("Welcome.md"));
    }

    #[test]
    fn missing_title_falls_back_to_slug() {
        let plan = plan_layout(&[doc("abc-123", None, None)], &[]);
        assert_eq!(plan[0].rel_path, PathBuf::from("abc-123.md"));
    }

    #[test]
    fn nested_folders_become_directories() {
        let folders = vec![
            folder("f1", None, "Projects"),
            folder("f2", Some("f1"), "Muesli"),
        ];
        let plan = plan_layout(&[doc("spec", Some("Spec"), Some("f2"))], &folders);
        assert_eq!(plan[0].rel_path, PathBuf::from("Projects/Muesli/Spec.md"));
    }

    #[test]
    fn unsafe_title_chars_are_sanitized() {
        let plan = plan_layout(&[doc("s", Some("a/b: c?"), None)], &[]);
        assert_eq!(plan[0].rel_path, PathBuf::from("a-b-c.md"));
    }

    #[test]
    fn duplicate_names_in_same_dir_get_suffixes_deterministically() {
        // Two docs, same title, same (root) dir. Sorted by slug: "a" first, "b" second.
        let plan = plan_layout(
            &[doc("b", Some("Notes"), None), doc("a", Some("Notes"), None)],
            &[],
        );
        let by_slug: std::collections::HashMap<_, _> =
            plan.iter().map(|p| (p.slug.as_str(), p.rel_path.clone())).collect();
        assert_eq!(by_slug["a"], PathBuf::from("Notes.md"));
        assert_eq!(by_slug["b"], PathBuf::from("Notes-2.md"));
    }

    #[test]
    fn orphan_folder_ref_falls_back_to_root() {
        // folder_id points at a folder not in the list → place at root, never panic.
        let plan = plan_layout(&[doc("x", Some("X"), Some("missing"))], &[]);
        assert_eq!(plan[0].rel_path, PathBuf::from("X.md"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/julianbeaulieu/Code/demo_muesli/src-tauri && DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test clone::paths 2>&1 | tail -20`
Expected: FAIL to compile — `plan_layout`, `PlannedFile` not defined; `mod clone` not declared.

- [ ] **Step 3: Implement `plan_layout` + sanitization**

Prepend to `src-tauri/src/clone/paths.rs` (above the test module):

```rust
//! Inverse of muesli's slug-from-path naming: rebuild on-disk `.md` paths from the
//! server's folder + document rows so the clone can lay out a workspace as a Finder tree.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use muesli_cli::api::{DocInfo, FolderInfo};

/// One document's planned location under the clone root.
pub struct PlannedFile {
    pub slug: String,
    pub rel_path: PathBuf,
}

/// Compute a deterministic relative `.md` path for every document. Directory = the folder
/// name chain (root → `folder_id`); filename = sanitized title (else slug) + `.md`, with
/// numeric suffixes resolving same-directory collisions. Deterministic in slug order so a
/// re-clone reproduces identical paths (the basis for resumability via the link index).
pub fn plan_layout(docs: &[DocInfo], folders: &[FolderInfo]) -> Vec<PlannedFile> {
    let by_id: HashMap<&str, &FolderInfo> = folders.iter().map(|f| (f.id.as_str(), f)).collect();

    // Folder id → directory segments (root → folder). Guard against cycles/orphans.
    let dir_segments = |mut folder_id: Option<&str>| -> Vec<String> {
        let mut chain: Vec<String> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        while let Some(id) = folder_id {
            let Some(folder) = by_id.get(id) else { break }; // orphan ref → stop (root-ish)
            if !seen.insert(id) {
                break; // cycle guard
            }
            chain.push(sanitize_segment(&folder.name));
            folder_id = folder.parent_id.as_deref();
        }
        chain.reverse();
        chain
    };

    let mut ordered: Vec<&DocInfo> = docs.iter().collect();
    ordered.sort_by(|a, b| a.slug.cmp(&b.slug));

    // Per-directory set of taken filenames (without extension) for collision suffixing.
    let mut taken: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    let mut out = Vec::with_capacity(ordered.len());
    for doc in ordered {
        let dir: PathBuf = dir_segments(doc.folder_id.as_deref()).iter().collect();
        let base = {
            let raw = doc.title.as_deref().filter(|t| !t.trim().is_empty()).unwrap_or(&doc.slug);
            let s = sanitize_segment(raw);
            if s.is_empty() { sanitize_segment(&doc.slug) } else { s }
        };
        let stem = unique_stem(&base, taken.entry(dir.clone()).or_default());
        let rel_path = dir.join(format!("{stem}.md"));
        out.push(PlannedFile { slug: doc.slug.clone(), rel_path });
    }
    out
}

/// Fold path separators, control chars, and reserved filename characters to single dashes;
/// trim leading/trailing dashes and dots. Keeps spaces and unicode letters (human-friendly).
fn sanitize_segment(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut pending_dash = false;
    for ch in name.chars() {
        let bad = ch.is_control()
            || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
        if bad {
            pending_dash = true;
        } else {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch);
        }
    }
    out.trim().trim_matches(|c| c == '-' || c == '.').to_string()
}

/// `base`, or `base-2`, `base-3`, … until free in `taken`. Records the result in `taken`.
fn unique_stem(base: &str, taken: &mut HashSet<String>) -> String {
    let base = if base.is_empty() { "untitled".to_string() } else { base.to_string() };
    if taken.insert(base.clone()) {
        return base;
    }
    for n in 2.. {
        let candidate = format!("{base}-{n}");
        if taken.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!()
}
```

Create `src-tauri/src/clone/mod.rs` with just the submodule declaration for now (Task 3 fills the rest):

```rust
//! Lazy clone of a cloud workspace into a Finder folder (Plan 2).

pub mod paths;
```

Add to `src-tauri/src/lib.rs` alongside the other `mod` declarations:

```rust
mod clone;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/julianbeaulieu/Code/demo_muesli/src-tauri && DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test clone::paths 2>&1 | tail -20`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/julianbeaulieu/Code/demo_muesli
git add src-tauri/src/clone/ src-tauri/src/lib.rs
git commit -m "feat: reconstruct on-disk workspace layout from server rows"
```

---

### Task 3: `clone::clone_workspace` — pull content, write files, record links (resumable)

**Files:**
- Modify: `/Users/julianbeaulieu/Code/demo_muesli/src-tauri/src/clone/mod.rs`
- Test: inline `#[cfg(test)]` in `clone/mod.rs` (the network-free planning seam)

**Interfaces:**
- Consumes: `plan_layout` (Task 2); `muesli_cli::api::{list_docs_and_folders, doc_text}`, `muesli_cli::store::{record_link, find_link, http_base}`, `muesli_cli::session::atomic_write`.
- Produces: `pub async fn clone_workspace(server: &str, workspace_id: &str, root: &std::path::Path) -> anyhow::Result<usize>` returning the number of documents present locally after the clone.
- Produces (test seam): `pub(crate) fn filter_workspace(docs: Vec<DocInfo>, folders: Vec<FolderInfo>, workspace_id: &str) -> (Vec<DocInfo>, Vec<FolderInfo>)`.

**Context:** The clone is the one-time materialization the spec calls "eager full pull." It must write canonical absolute paths that match what the daemon's `discover_md_files` will later produce (it canonicalizes the root, then joins relative paths), so the pre-recorded links resolve. It is resumable: a doc whose target path already has a link is skipped, so re-opening a half-cloned workspace continues. A failed single-doc pull writes an empty file and still records the link — the daemon's `reconcile()` will materialize the room into it on first connect (the "live room, empty file" branch), so no document is silently lost.

- [ ] **Step 1: Write the failing test**

The network calls aren't unit-testable here (covered by Task 9 integration), but the workspace filter is the load-bearing pure seam. Add to `clone/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use muesli_cli::api::{DocInfo, FolderInfo};

    fn doc(slug: &str, ws: Option<&str>) -> DocInfo {
        DocInfo { slug: slug.into(), title: None, folder_id: None, workspace_id: ws.map(Into::into) }
    }
    fn folder(id: &str, ws: Option<&str>) -> FolderInfo {
        FolderInfo { id: id.into(), parent_id: None, name: id.into(), workspace_id: ws.map(Into::into) }
    }

    #[test]
    fn filter_keeps_only_the_target_workspace() {
        let docs = vec![doc("a", Some("w1")), doc("b", Some("w2")), doc("c", None)];
        let folders = vec![folder("f1", Some("w1")), folder("f2", Some("w2"))];
        let (docs, folders) = filter_workspace(docs, folders, "w1");
        assert_eq!(docs.iter().map(|d| d.slug.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(folders.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), vec!["f1"]);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/julianbeaulieu/Code/demo_muesli/src-tauri && DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test clone::tests 2>&1 | tail -20`
Expected: FAIL to compile — `filter_workspace`/`clone_workspace` not defined.

- [ ] **Step 3: Implement the clone**

Replace `clone/mod.rs` contents with:

```rust
//! Lazy clone of a cloud workspace into a Finder folder (Plan 2).

pub mod paths;

use std::path::Path;

use anyhow::{Context, Result};
use muesli_cli::api::{self, DocInfo, FolderInfo};
use muesli_cli::{session, store};

use paths::plan_layout;

/// Keep only the documents and folders belonging to `workspace_id`.
pub(crate) fn filter_workspace(
    docs: Vec<DocInfo>,
    folders: Vec<FolderInfo>,
    workspace_id: &str,
) -> (Vec<DocInfo>, Vec<FolderInfo>) {
    let docs = docs
        .into_iter()
        .filter(|d| d.workspace_id.as_deref() == Some(workspace_id))
        .collect();
    let folders = folders
        .into_iter()
        .filter(|f| f.workspace_id.as_deref() == Some(workspace_id))
        .collect();
    (docs, folders)
}

/// Eager full pull of a workspace into `root` (which must already exist). Rebuilds the folder
/// tree, pulls each document's current text, writes the `.md` files atomically, and records
/// each file↔slug link in the shared index the daemon reads. Resumable: documents already
/// linked at their target path are left untouched. Returns the document count present after.
pub async fn clone_workspace(server: &str, workspace_id: &str, root: &Path) -> Result<usize> {
    // Canonicalize once: the daemon's discovery canonicalizes the root, so links must too.
    let root = root
        .canonicalize()
        .with_context(|| format!("clone target does not exist: {}", root.display()))?;
    let token = store::load_token(server);

    let (docs, folders) = api::list_docs_and_folders(server, token.as_deref())
        .await
        .context("listing workspace documents")?;
    let (docs, folders) = filter_workspace(docs, folders, workspace_id);

    let plan = plan_layout(&docs, &folders);
    let mut present = 0usize;
    for item in &plan {
        let file = root.join(&item.rel_path);
        // Resumable: an existing link at this path means this doc is already cloned.
        if store::find_link(&file).is_some() {
            present += 1;
            continue;
        }
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        // Pull current text; on failure write empty — the daemon's reconcile() will
        // materialize the room into the empty file on first connect (never loses content).
        let text = match api::doc_text(server, token.as_deref(), &item.slug).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(%e, slug = %item.slug, "clone: text pull failed; writing empty placeholder");
                String::new()
            }
        };
        session::atomic_write(&file, &text)
            .with_context(|| format!("writing {}", file.display()))?;
        store::record_link(&file, &item.slug, server)
            .with_context(|| format!("recording link for {}", item.slug))?;
        present += 1;
    }
    Ok(present)
}
```

- [ ] **Step 4: Run test + build**

Run: `cd /Users/julianbeaulieu/Code/demo_muesli/src-tauri && DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test clone:: 2>&1 | tail -20`
Expected: PASS (filter + all paths tests). `cargo build` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/julianbeaulieu/Code/demo_muesli
git add src-tauri/src/clone/mod.rs
git commit -m "feat: eager workspace clone — pull text, write files, record links"
```

---

### Task 4: `sync_daemon::DaemonHandle` — Tauri-managed wrapper around `muesli_cli::sync::run`

**Files:**
- Create: `/Users/julianbeaulieu/Code/demo_muesli/src-tauri/src/sync_daemon/mod.rs`
- Modify: `/Users/julianbeaulieu/Code/demo_muesli/src-tauri/src/lib.rs` (`mod sync_daemon;`)
- Test: inline `#[cfg(test)]` in `sync_daemon/mod.rs`

**Interfaces:**
- Consumes: `muesli_cli::sync::{run, DaemonStatus, DaemonState}`, `muesli_cli::store::http_base`.
- Produces:
  - `pub struct DaemonHandle` (holds a `Mutex<Option<Running>>`) with `new()`, `start(&self, dir: PathBuf, server: String)`, `stop(&self)`, `status(&self) -> DaemonStatusView`, and `active_dir(&self) -> Option<PathBuf>`.
  - `pub struct DaemonStatusView { pub running: bool, pub dir: Option<String>, pub files: usize, pub last_activity: Option<String>, pub events: u64, pub error: Option<String> }` (`Serialize`).

**Context:** `muesli_cli::sync::run(dir, server, prefix, web, verbose, stop_rx, status_tx)` is the whole folder daemon — discovery, the bounded session pool (≤64 live websockets, 30 s idle-disconnect, 300 s repoll), the recursive watcher, and per-file `FileSession` content sync. demo_muesli runs exactly one daemon at a time (the active workspace). The handle owns the `tokio` task plus its stop/status `watch` channels, so a workspace switch stops the old daemon before starting the new one. `verbose = false` (no stdout); `prefix = None`; `web` is only used for human stdout, so pass the http base. The folder-placement reconciler inside `run` is inert for cloned docs (Global Constraints, Tier boundary).

- [ ] **Step 1: Write the failing test**

`sync::run` needs a real server + filesystem, so the unit test covers only the lifecycle invariants of the handle (no-op start when already on the same dir, status before/after, clean stop). Create `sync_daemon/mod.rs` with the test first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_is_idle_before_start() {
        let h = DaemonHandle::new();
        let s = h.status();
        assert!(!s.running);
        assert_eq!(s.files, 0);
        assert!(h.active_dir().is_none());
    }

    #[test]
    fn stop_when_idle_is_a_noop() {
        let h = DaemonHandle::new();
        h.stop(); // must not panic / must not require a running daemon
        assert!(!h.status().running);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/julianbeaulieu/Code/demo_muesli/src-tauri && DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test sync_daemon 2>&1 | tail -20`
Expected: FAIL to compile — `DaemonHandle` not defined.

- [ ] **Step 3: Implement the handle**

Prepend to `sync_daemon/mod.rs`:

```rust
//! The embedded Tier-1 content-sync daemon: a Tauri-managed wrapper around
//! `muesli_cli::sync::run` for the active workspace folder (Plan 2). One daemon at a time;
//! switching workspaces stops the old and starts the new.

use std::path::PathBuf;
use std::sync::Mutex;

use muesli_cli::store;
use muesli_cli::sync::{self, DaemonState, DaemonStatus};
use serde::Serialize;
use tokio::sync::watch;

/// A snapshot of the daemon for the frontend StatusBar.
#[derive(Serialize, Clone, Default)]
pub struct DaemonStatusView {
    pub running: bool,
    pub dir: Option<String>,
    pub files: usize,
    pub last_activity: Option<String>,
    pub events: u64,
    pub error: Option<String>,
}

struct Running {
    dir: PathBuf,
    stop_tx: watch::Sender<bool>,
    status_rx: watch::Receiver<DaemonStatus>,
    task: tokio::task::JoinHandle<()>,
}

/// Owns the single active daemon. Managed in Tauri state.
pub struct DaemonHandle {
    inner: Mutex<Option<Running>>,
}

impl DaemonHandle {
    pub fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }

    /// Start (or restart) the daemon over `dir`. If a daemon is already running on the same
    /// canonical dir, this is a no-op; otherwise the existing daemon is stopped first.
    pub fn start(&self, dir: PathBuf, server: String) {
        let dir = dir.canonicalize().unwrap_or(dir);
        let mut guard = self.inner.lock().unwrap();
        if guard.as_ref().is_some_and(|r| r.dir == dir) {
            return; // already syncing this workspace
        }
        if let Some(prev) = guard.take() {
            let _ = prev.stop_tx.send(true);
            prev.task.abort();
        }
        let (stop_tx, stop_rx) = watch::channel(false);
        let (status_tx, status_rx) = watch::channel(DaemonStatus::default());
        let web = store::http_base(&server);
        let run_dir = dir.clone();
        let task = tokio::spawn(async move {
            if let Err(e) =
                sync::run(run_dir, server, None, web, false, stop_rx, status_tx).await
            {
                // `tracing` is not a direct dep of this crate; stderr surfaces in the
                // `tauri dev` console (matches the clone module's error path).
                eprintln!("workspace sync daemon error: {e:#}");
            }
        });
        *guard = Some(Running { dir, stop_tx, status_rx, task });
    }

    /// Request a clean (flushing) stop of the active daemon, if any.
    pub fn stop(&self) {
        if let Some(prev) = self.inner.lock().unwrap().take() {
            let _ = prev.stop_tx.send(true);
            // Don't abort: let it flush dirty replicas. The task ends on its own.
        }
    }

    pub fn active_dir(&self) -> Option<PathBuf> {
        self.inner.lock().unwrap().as_ref().map(|r| r.dir.clone())
    }

    pub fn status(&self) -> DaemonStatusView {
        let guard = self.inner.lock().unwrap();
        let Some(r) = guard.as_ref() else {
            return DaemonStatusView::default();
        };
        let st = r.status_rx.borrow().clone();
        let error = match &st.state {
            DaemonState::Error(msg) => Some(msg.clone()),
            _ => None,
        };
        DaemonStatusView {
            running: !matches!(st.state, DaemonState::Stopped),
            dir: Some(r.dir.display().to_string()),
            files: st.files,
            last_activity: st.last_activity,
            events: st.events,
            error,
        }
    }
}

impl Default for DaemonHandle {
    fn default() -> Self {
        Self::new()
    }
}
```

Add to `src-tauri/src/lib.rs`:

```rust
mod sync_daemon;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/julianbeaulieu/Code/demo_muesli/src-tauri && DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo test sync_daemon 2>&1 | tail -20`
Expected: PASS (2 tests). `cargo build` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/julianbeaulieu/Code/demo_muesli
git add src-tauri/src/sync_daemon/mod.rs src-tauri/src/lib.rs
git commit -m "feat: Tauri-managed Tier-1 content-sync daemon handle"
```

---

### Task 5: Tauri commands — clone + daemon lifecycle, registered and state-managed

**Files:**
- Create: `/Users/julianbeaulieu/Code/demo_muesli/src-tauri/src/sync_cmd.rs`
- Modify: `/Users/julianbeaulieu/Code/demo_muesli/src-tauri/src/lib.rs` (`mod sync_cmd;`, manage `DaemonHandle`, register the four commands)
- Test: none (thin glue; exercised in Task 9 integration)

**Interfaces:**
- Consumes: `clone::clone_workspace` (Task 3), `sync_daemon::{DaemonHandle, DaemonStatusView}` (Task 4).
- Produces four Tauri commands:
  - `clone_workspace(server: String, workspace_id: String, path: String) -> Result<usize, String>`
  - `start_workspace_sync(server: String, path: String) -> Result<(), String>`
  - `stop_workspace_sync() -> Result<(), String>`
  - `workspace_sync_status() -> DaemonStatusView`

**Context:** These wire the async clone + the daemon handle to the frontend. The `DaemonHandle` is a single piece of Tauri-managed state (`tauri::State<DaemonHandle>`). The clone command resolves the token internally (via the store), so the frontend never handles tokens.

- [ ] **Step 1: Implement the command module**

Create `src-tauri/src/sync_cmd.rs`:

```rust
//! Tauri commands for the clone + Tier-1 daemon (Plan 2).

use std::path::PathBuf;

use tauri::State;

use crate::clone::clone_workspace;
use crate::sync_daemon::{DaemonHandle, DaemonStatusView};

/// Eager-clone a cloud workspace into `path` (the folder the user picked). Returns the count
/// of documents present locally after the clone.
#[tauri::command]
pub async fn clone_workspace(
    server: String,
    workspace_id: String,
    path: String,
) -> Result<usize, String> {
    clone_workspace_inner(&server, &workspace_id, &path).await.map_err(|e| format!("{e:#}"))
}

async fn clone_workspace_inner(
    server: &str,
    workspace_id: &str,
    path: &str,
) -> anyhow::Result<usize> {
    clone_workspace(server, workspace_id, &PathBuf::from(path)).await
}

/// Start (or switch to) the Tier-1 content-sync daemon over `path`.
#[tauri::command]
pub fn start_workspace_sync(
    server: String,
    path: String,
    daemon: State<'_, DaemonHandle>,
) -> Result<(), String> {
    daemon.start(PathBuf::from(path), server);
    Ok(())
}

/// Stop the active daemon (clean flush).
#[tauri::command]
pub fn stop_workspace_sync(daemon: State<'_, DaemonHandle>) -> Result<(), String> {
    daemon.stop();
    Ok(())
}

/// Current daemon status for the StatusBar.
#[tauri::command]
pub fn workspace_sync_status(daemon: State<'_, DaemonHandle>) -> DaemonStatusView {
    daemon.status()
}
```

> Note: the command function is named `clone_workspace` and so is the imported library fn — Rust resolves the `#[tauri::command]` to the local item; the `use crate::clone::clone_workspace` is shadowed inside the command body, so the inner helper calls it explicitly. (If the reviewer prefers, rename the library import `use crate::clone::clone_workspace as do_clone;` and call `do_clone(...)` — behavior identical.)

- [ ] **Step 2: Register in `lib.rs`**

In `src-tauri/src/lib.rs`: add `mod sync_cmd;`, manage the daemon handle, and register the commands. The manage call goes on the builder (before `.invoke_handler`):

```rust
        .manage(sync_daemon::DaemonHandle::new())
```

Add the four commands to the existing `tauri::generate_handler![ ... ]` list:

```rust
            sync_cmd::clone_workspace,
            sync_cmd::start_workspace_sync,
            sync_cmd::stop_workspace_sync,
            sync_cmd::workspace_sync_status,
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cd /Users/julianbeaulieu/Code/demo_muesli/src-tauri && DYLD_LIBRARY_PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx cargo build 2>&1 | tail -20`
Expected: clean build. (`tauri::command` async + `State` signatures resolve.)

- [ ] **Step 4: Commit**

```bash
cd /Users/julianbeaulieu/Code/demo_muesli
git add src-tauri/src/sync_cmd.rs src-tauri/src/lib.rs
git commit -m "feat: Tauri commands for workspace clone + daemon lifecycle"
```

---

### Task 6: Frontend wrappers + daemon-status store

**Files:**
- Modify: `/Users/julianbeaulieu/Code/demo_muesli/src/lib/tauri.ts` (4 wrappers + `DaemonStatusView` type)
- Create: `/Users/julianbeaulieu/Code/demo_muesli/src/lib/sync/daemon.svelte.ts` (status store)
- Test: none (typed glue; `pnpm check` is the gate)

**Interfaces:**
- Consumes: the four Tauri commands (Task 5).
- Produces:
  - `tauri.ts`: `cloneWorkspace(server, workspaceId, path): Promise<number>`, `startWorkspaceSync(server, path): Promise<void>`, `stopWorkspaceSync(): Promise<void>`, `workspaceSyncStatus(): Promise<DaemonStatusView>`, and `export interface DaemonStatusView`.
  - `daemon.svelte.ts`: `export const daemon` — a runes store with `status: DaemonStatusView | null`, `start(server, path)`, `stop()`, and an internal poll that refreshes `status` while running.

**Context:** Mirror the existing `tauri.ts` wrapper style (snake_case args matching the Rust serde, thin `invoke` calls). The daemon store gives the StatusBar a reactive `status`; it polls `workspace_sync_status` every 1 s while a workspace is synced (Plan 3's event stream will replace polling with push).

- [ ] **Step 1: Add the wrappers + type to `tauri.ts`**

Follow the file's existing pattern (an `invoke` import and one exported async fn per command). Append:

```ts
export interface DaemonStatusView {
  running: boolean;
  dir: string | null;
  files: number;
  last_activity: string | null;
  events: number;
  error: string | null;
}

export const cloneWorkspace = (
  server: string,
  workspaceId: string,
  path: string,
): Promise<number> =>
  invoke("clone_workspace", { server, workspaceId, path });

export const startWorkspaceSync = (server: string, path: string): Promise<void> =>
  invoke("start_workspace_sync", { server, path });

export const stopWorkspaceSync = (): Promise<void> => invoke("stop_workspace_sync");

export const workspaceSyncStatus = (): Promise<DaemonStatusView> =>
  invoke("workspace_sync_status");
```

> Tauri maps the Rust command arg `workspace_id` to the JS key `workspaceId` automatically (camelCase ↔ snake_case). Keep `workspaceId` here.

- [ ] **Step 2: Create the daemon status store**

Create `src/lib/sync/daemon.svelte.ts`:

```ts
import {
  startWorkspaceSync,
  stopWorkspaceSync,
  workspaceSyncStatus,
  type DaemonStatusView,
} from "$lib/tauri";

/**
 * The Tier-1 daemon's reactive status, polled while a workspace is synced. Plan 3's
 * workspace event stream will replace the poll with push notifications.
 */
class DaemonStore {
  status = $state<DaemonStatusView | null>(null);
  #timer: ReturnType<typeof setInterval> | null = null;

  async start(server: string, path: string): Promise<void> {
    await startWorkspaceSync(server, path);
    this.#poll();
    if (!this.#timer) this.#timer = setInterval(() => this.#poll(), 1000);
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await stopWorkspaceSync();
    this.status = null;
  }

  async #poll(): Promise<void> {
    try {
      this.status = await workspaceSyncStatus();
    } catch {
      // transient; keep the last snapshot
    }
  }
}

export const daemon = new DaemonStore();
```

- [ ] **Step 3: Run the check**

Run: `cd /Users/julianbeaulieu/Code/demo_muesli && pnpm check 2>&1 | tail -20`
Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Commit**

```bash
cd /Users/julianbeaulieu/Code/demo_muesli
git add src/lib/tauri.ts src/lib/sync/daemon.svelte.ts
git commit -m "feat: frontend wrappers + reactive daemon-status store"
```

---

### Task 7: Clone-on-open + daemon lifecycle in the workspaces store and picker

**Files:**
- Modify: `/Users/julianbeaulieu/Code/demo_muesli/src/lib/workspaces.svelte.ts` (`openWorkspaceView` clones + starts daemon; switching stops the old)
- Modify: `/Users/julianbeaulieu/Code/demo_muesli/src/lib/WorkspacePicker.svelte` (cloud-only choose → progress while cloning)
- Modify: `/Users/julianbeaulieu/Code/demo_muesli/src/lib/StatusBar.svelte` (show daemon state)
- Test: none (`pnpm check` + Task 9 manual verification)

**Interfaces:**
- Consumes: `cloneWorkspace` (Task 6), `daemon` store (Task 6), `registerClonedWorkspace` (Plan 1).
- Produces: updated `openWorkspaceView` semantics — cloud-only → clone, register cloned, start daemon, open; local/cloned with a server → start daemon, open; local-only → just open (no daemon).

**Context:** Plan 1 left the cloud-only branch as "register the chosen path and open it empty" (`WorkspacePicker.svelte:21` and `workspaces.svelte.ts:76`). Plan 2 replaces "open empty" with the real clone, then brings the daemon up. Every time the active workspace changes, the previous daemon is stopped first (one daemon at a time). A **local-only** workspace (no `server`) never starts a daemon — solo offline editing, by design.

- [ ] **Step 1: Update `openWorkspaceView` and add a daemon-aware open path**

In `workspaces.svelte.ts`, import the clone + daemon:

```ts
import { cloneWorkspace } from "$lib/tauri";
import { daemon } from "$lib/sync/daemon.svelte";
```

Replace `openWorkspaceView` with:

```ts
  /**
   * Open a workspace from the picker.
   * - cloud-only → clone into `chosenPath`, register as cloned, start the daemon, open.
   * - cloned / local-with-server → open, start the daemon for content sync.
   * - local-only (no server) → open, no daemon (solo offline editing).
   */
  async openWorkspaceView(view: WorkspaceView, chosenPath?: string): Promise<void> {
    this.error = null;
    // cloud-only: clone first, into the folder the user picked.
    if (!view.local_path && chosenPath && view.server) {
      this.cloning = true;
      try {
        await cloneWorkspace(view.server, view.id, chosenPath);
        await registerClonedWorkspace(view.id, view.server, view.name, chosenPath);
      } catch (e) {
        this.error = String(e);
        this.cloning = false;
        return;
      }
      this.cloning = false;
      await this.openFolderWithSync(chosenPath, view.server);
      await this.refresh();
      return;
    }
    // Already-local (cloned or local-only).
    if (view.local_path) {
      await this.openFolderWithSync(view.local_path, view.server);
    }
  }

  /** Open a folder in the tree and, when it has a server, (re)start the Tier-1 daemon. */
  private async openFolderWithSync(path: string, server: string | null): Promise<void> {
    await workspace.openWorkspace(path);
    if (server) {
      await daemon.start(server, path); // start() stops any prior daemon (one at a time)
    } else {
      await daemon.stop();
    }
  }
```

Add the `cloning` field near the other `$state` declarations:

```ts
  cloning = $state(false);
```

Also update `openLocalFolder` to stop any running daemon (a local-only folder has no server):

```ts
  async openLocalFolder(path: string, name: string): Promise<void> {
    await registerLocalWorkspace(path, name, path); // id = path for local-only
    await daemon.stop();
    await workspace.openWorkspace(path);
    await this.refresh();
  }
```

- [ ] **Step 2: Show clone progress in the picker**

In `WorkspacePicker.svelte`, the cloud-only `choose` already calls `openWorkspaceView(view, path)`. Add a busy state so the picker reflects the clone. Replace the `choose` function and add a reactive guard:

```svelte
  async function choose(view: WorkspaceView) {
    if (view.state === "cloud-only") {
      const path = await pickFolder();
      if (!path) return;
      open = false;
      // openWorkspaceView flips workspaces.cloning while the pull runs.
      await workspaces.openWorkspaceView(view, path);
    } else {
      open = false;
      await workspaces.openWorkspaceView(view);
    }
  }
```

And in the trailing-icon area of the cloud-only row, show a spinner while cloning that workspace. Where the row currently renders `{#if view.state === "cloud-only"} <span ...>not downloaded</span>`, change to:

```svelte
          {#if view.state === "cloud-only"}
            {#if workspaces.cloning}
              <span class="loading loading-spinner loading-xs shrink-0"></span>
            {:else}
              <span class="shrink-0 text-[10px] text-base-content/40">not downloaded</span>
            {/if}
          {:else if isActive(view)}
            <Check size={15} class="shrink-0 text-success" />
          {/if}
```

- [ ] **Step 3: Surface daemon status**

Add a compact indicator to the existing `StatusBar.svelte` (import `daemon` from `$lib/sync/daemon.svelte`), placed alongside its current `syncStatus` indicator:

```svelte
{#if daemon.status?.running}
  <span class="text-xs text-base-content/60">
    Syncing {daemon.status.files} file{daemon.status.files === 1 ? "" : "s"}
    {#if daemon.status.last_activity} · {daemon.status.last_activity}{/if}
  </span>
{:else if daemon.status?.error}
  <span class="text-xs text-error">Sync error: {daemon.status.error}</span>
{/if}
```

- [ ] **Step 4: Run the check**

Run: `cd /Users/julianbeaulieu/Code/demo_muesli && pnpm check 2>&1 | tail -20`
Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
cd /Users/julianbeaulieu/Code/demo_muesli
git add src/lib/workspaces.svelte.ts src/lib/WorkspacePicker.svelte src/lib/StatusBar.svelte
git commit -m "feat: clone-on-open + Tier-1 daemon lifecycle in the picker"
```

---

### Task 8: Editor reflects daemon writes — reload the open file on external change

**Files:**
- Modify: `/Users/julianbeaulieu/Code/demo_muesli/src/lib/EditorPane.svelte`
- Test: none (`pnpm check` + Task 9 manual verification)

**Interfaces:**
- Consumes: the existing disk read used by the local-open path; the `daemon` store (to know a workspace is synced).
- Produces: while a file in a synced workspace is open, the editor reloads its content when the daemon materializes a remote edit to disk — but only when the buffer has no pending local change (never clobbers in-flight typing).

**Context:** Plan 2's editor opens files from disk (the fast local path retained from Plan 1; the per-note `WebsocketProvider` must NOT run for synced workspaces — a second replica is exactly what the single-replica architecture forbids). When the daemon writes a remote edit to the open file, the editor needs to show it. Until Plan 3's `TauriProvider` gives in-editor lockstep, Plan 2 uses a coarse poll-and-reload: every ~1 s, if the file's on-disk content differs from what the editor last loaded *and* the editor is clean (no unsaved edits), replace the document. If the editor is dirty, skip — the user's save will flow to disk, the daemon ingests it, and the CRDT merges both sides (content-safe, no lost edits). This is intentionally simple and is superseded in Plan 3.

- [ ] **Step 1: Gate the per-note websocket off for synced workspaces**

In `EditorPane.svelte`, the open flow snapshots `const useSync = settings.syncEnabled;` (line ~78) and, when set, builds a `WebsocketProvider` session. For Plan 2, a workspace managed by the daemon must not also open a per-note socket. Change the snapshot to also require that no daemon is running:

```ts
  import { daemon } from "$lib/sync/daemon.svelte";
  // ...
  // Per-note websocket sync is the legacy path; it must not run alongside the Tier-1
  // daemon (one replica per doc). When a workspace is synced, the editor reads from disk
  // and the daemon owns sync. (Plan 3 attaches the editor to the daemon replica directly.)
  const useSync = settings.syncEnabled && !daemon.status?.running;
```

- [ ] **Step 2: Add poll-and-reload for the open file**

Add a **separate** top-level `$effect` (sibling to the existing mount effect, not nested in it) that depends on `activePath` + `activeMode` + the daemon running flag. It uses the existing disk read `readNote`, the component handle `editorState.activeView` (the live `EditorView`), the last-loaded text `editorState.currentText`, and the active tab's `dirty` flag (`tabs.active()?.dirty`). Insert after the mount `$effect` closes (after line ~223):

```ts
  // While a synced workspace is open, reflect the daemon's materialized remote edits.
  // Reload only when the on-disk content changed AND the buffer is clean (never clobber
  // unsaved local edits — those converge via save → daemon ingest → CRDT merge). Coarse by
  // design; Plan 3's TauriProvider replaces this with in-editor lockstep.
  $effect(() => {
    const path = activePath;
    const mode = activeMode;
    if (mode !== "edit" || !path || !daemon.status?.running) return;

    const timer = setInterval(async () => {
      const view = editorState.activeView;
      if (!view) return;
      if (tabs.active()?.dirty) return; // unsaved local edits — let them converge via save
      let onDisk: string;
      try {
        onDisk = await readNote(path);
      } catch {
        return; // transient (atomic rename window) — retry next tick
      }
      // Re-check after the await: tab may have switched, or the user may have typed.
      if (tabs.active()?.path !== path || tabs.active()?.dirty) return;
      const inEditor = view.state.doc.toString();
      if (onDisk === inEditor) return;
      // Full-document replace, preserving the selection clamped to the new length.
      const len = onDisk.length;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: onDisk },
        selection: { anchor: Math.min(sel.anchor, len), head: Math.min(sel.head, len) },
      });
      editorState.currentText = onDisk;
    }, 1000);
    return () => clearInterval(timer);
  });
```

> This introduces NO new file-watch mechanism — the 1 s poll is sufficient for one open file in Plan 2 and is removed in Plan 3. `activePath`/`activeMode` are the existing value-stable deriveds (lines 36-37); `editorState.activeView`/`editorState.currentText` and `tabs.active()` already exist.

- [ ] **Step 3: Run the check**

Run: `cd /Users/julianbeaulieu/Code/demo_muesli && pnpm check 2>&1 | tail -20`
Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Commit**

```bash
cd /Users/julianbeaulieu/Code/demo_muesli
git add src/lib/EditorPane.svelte
git commit -m "feat: editor reflects daemon writes; no per-note socket when synced"
```

---

### Task 9: Integration verification against a live dev muesli-server

**Files:**
- None (verification task; capture findings in the progress ledger and the final review)

**Context:** The dev stack from Plan 1 is the harness: `cd /Users/julianbeaulieu/Code/muesli && docker compose up -d postgres redis dex` then run `muesli-server` in OIDC mode per its README (the `.env` is dev-only and the user has explicitly cleared reading it for this project). demo_muesli runs on `1420` (`pnpm tauri dev`). Sign in is already working from Plan 1 (token in Keychain, identity `dev@muesli.md`).

This task confirms the end-to-end Plan 2 deliverable. Treat any failure as a `systematic-debugging` cycle, not a guess.

- [ ] **Step 1: Seed a remote workspace with content**

In the muesli web app (or via `muesli` CLI against the dev server), ensure the signed-in user's workspace has at least: one root document with a few paragraphs, and one document inside a nested folder (e.g. `Projects/Muesli/Spec`). Note their titles.

- [ ] **Step 2: Clone via the picker**

In demo_muesli: open the WorkspacePicker → choose the cloud-only workspace → pick an empty folder (e.g. `~/muesli/<workspace>`). Expected:
- The picker shows the cloning spinner, then the workspace opens.
- The chosen folder in Finder contains the rebuilt tree: the root `.md` and `Projects/Muesli/<Spec>.md`, each with the **actual document text** (not empty).
- `muesli_cli`'s index has the links: `sqlite3 "$(echo ~)/Library/Application Support/muesli/index.db" 'select file_path, doc_id from links;'` lists each cloned file mapped to its slug.

- [ ] **Step 3: Remote → disk content liveness**

Edit the root document in the muesli web app (type a sentence). Within ~1 s the daemon materializes it: the local `.md` file updates on disk, and if it's the open document in demo_muesli, the editor reflects the new text (poll-and-reload). StatusBar shows a "received edit" activity pulse.

- [ ] **Step 4: Disk → remote content liveness**

Edit a cloned `.md` file on disk — both ways: (a) in demo_muesli's editor and save; (b) in an external editor (e.g. `code`/TextEdit). Within ~1 s the daemon ingests it and the change appears in the muesli web app. Confirm no echo loop (the file isn't rewritten in place repeatedly — the byte-compare echo guard holds).

- [ ] **Step 5: Offline / reconnect reconcile**

Stop `muesli-server`. Edit a cloned file on disk. Restart `muesli-server`. The daemon reconnects (backoff) and `reconcile()` merges the offline disk edit into the room — the web app shows it after reconnect; no content is lost.

- [ ] **Step 6: Switch + resume**

Switch to a local-only workspace (daemon stops — StatusBar clears), then back to the cloned workspace (daemon restarts; existing links mean no re-clone, instant resume). Close and reopen the app; reopening the cloned workspace resumes sync without re-downloading.

- [ ] **Step 7: Record results**

Append a verification note to the progress ledger: which steps passed, any bug found + fix commit. If a step fails, debug it to root cause (the daemon's `tracing` warnings surface in the `pnpm tauri dev` console), fix, re-verify.

---

## Notes for Plan 3 (presence / `TauriProvider`)

- The daemon owns one replica per live doc inside `muesli_cli::session::FileSession`. Plan 3's `TauriProvider` must attach the open editor's JS `Y.Doc` to **that same replica** over Tauri IPC (y-sync update + awareness frames), replacing Task 8's poll-and-reload and Task 7's gated-off `WebsocketProvider`. This requires exposing the open doc's replica from the daemon (a per-doc update/awareness channel out of `FileSession`) — a `muesli-cli` seam to add upstream.
- Cursor color derives deterministically from user-id; awareness local state `{ name, color, kind: "human" }` (spec "Presence / identity").

## Notes for Plan 4 (structure sync)

- Remote structural ops (folder/doc created, renamed, moved, deleted) propagate via the **workspace event stream** (a new server surface) → daemon mutates the local tree. Local structural ops → REST (`POST /api/folders`, `PATCH /api/documents/{slug}`) with echo guards.
- **Workspace-correct placement of brand-new local files** is Plan 4: `sync::run`'s reconciler + `create_folder`/`place_document` currently target the caller's primary workspace (the endpoints take no `workspace_id`). Making a new local file in a *cloned non-primary* workspace land in the right workspace needs `workspace_id` threaded through those endpoints (server + `muesli_cli::api`). Inert for Plan 2 (cloned docs already carry their folder + title, so the reconciler skips them).
```
