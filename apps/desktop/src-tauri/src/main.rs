// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Without a subscriber, muesli-cli's sync-daemon warn!/info! logs (session.rs) go
    // nowhere — the app has no way to surface them. That's how the wss:// TLS-feature
    // bug shipped invisibly: the daemon warned "connection lost — reconnecting" on every
    // attempt, forever, and nobody could see it. `muesli_cli=info` keeps the desktop
    // build quiet by default while still showing sync-session failures in a terminal;
    // RUST_LOG overrides it for deeper debugging.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("muesli_cli=info")),
        )
        .init();

    muesli_lib::run()
}
