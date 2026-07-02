//! Muesli local-agent engine (ADR 0014). The sync bridge, the path↔doc index, the OS
//! token store, and the server API client — factored into a library so both shells reuse
//! one engine: the `muesli` CLI (`src/main.rs`) and the desktop editor (`apps/desktop`).
//!
//! The engine never hosts the Document; it keeps a CRDT replica synced with the server room,
//! ingests disk edits as text diffs, and materializes remote edits back to disk
//! (internal/design/ingest-and-materialization.md). The desktop app drives [`sync::run`]
//! (programmatic stop + a [`sync::DaemonStatus`] feed); the CLI drives the [`sync::sync`] wrapper.

pub mod api;
pub mod session;
pub mod store;
pub mod sync;
