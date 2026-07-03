//! Anchors (ADR 0019): a byte-range span pinned to the CRDT via yrs sticky indices
//! (the "relative positions" of ADR 0005). Anchors ride along as surrounding text changes;
//! when the anchored text is entirely deleted they resolve to a collapsed range, which the
//! server treats as orphaned (comments) or conflicted (suggestions).
//!
//! Storage format (Postgres `jsonb` / API): the two sticky indices are lib0-v1 encoded and
//! base64'd — `{"v":1,"start":"<b64>","end":"<b64>"}`. lib0 is the same stable encoding Yjs
//! itself uses for relative positions, so the bytes survive round-trips exactly.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::StickyIndex;

use crate::CoreError;

/// A pinned `[start, end)` byte-range over the document text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub start: StickyIndex,
    pub end: StickyIndex,
}

impl Anchor {
    /// Serialize for storage/wire: `{"v":1,"start":"<b64 lib0-v1>","end":"<b64 lib0-v1>"}`.
    pub fn to_json(&self) -> Value {
        json!({
            "v": 1,
            "start": B64.encode(self.start.encode_v1()),
            "end": B64.encode(self.end.encode_v1()),
        })
    }

    pub fn from_json(v: &Value) -> Result<Self, CoreError> {
        let field = |key: &str| -> Result<StickyIndex, CoreError> {
            let s = v
                .get(key)
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::Anchor(format!("anchor json missing '{key}'")))?;
            let bytes = B64
                .decode(s)
                .map_err(|e| CoreError::Anchor(format!("anchor '{key}' base64: {e}")))?;
            StickyIndex::decode_v1(&bytes)
                .map_err(|e| CoreError::Anchor(format!("anchor '{key}' decode: {e}")))
        };
        Ok(Anchor { start: field("start")?, end: field("end")? })
    }
}
