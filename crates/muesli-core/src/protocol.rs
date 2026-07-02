//! The y-websocket wire protocol (internal/design/sync-protocol.md): binary frames of
//! lib0 var-uint message types. Sync carries yrs/Yjs v1 update payloads; awareness payloads
//! are mostly relayed opaquely, decoded only enough to track client ids for join-replay and
//! disconnect cleanup.

pub const MSG_SYNC: u64 = 0;
pub const MSG_AWARENESS: u64 = 1;
#[allow(dead_code)]
pub const MSG_AUTH: u64 = 2;
pub const MSG_QUERY_AWARENESS: u64 = 3;

pub const SYNC_STEP1: u64 = 0;
pub const SYNC_STEP2: u64 = 1;
pub const SYNC_UPDATE: u64 = 2;

#[derive(Debug)]
pub enum ProtoError {
    UnexpectedEof,
    InvalidUtf8,
}

pub struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    pub fn read_var_u64(&mut self) -> Result<u64, ProtoError> {
        let mut num: u64 = 0;
        let mut shift = 0u32;
        loop {
            let byte = *self.buf.get(self.pos).ok_or(ProtoError::UnexpectedEof)?;
            self.pos += 1;
            num |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(num);
            }
            shift += 7;
            if shift > 63 {
                return Err(ProtoError::UnexpectedEof);
            }
        }
    }

    pub fn read_bytes(&mut self) -> Result<&'a [u8], ProtoError> {
        let len = self.read_var_u64()? as usize;
        let end = self.pos.checked_add(len).ok_or(ProtoError::UnexpectedEof)?;
        if end > self.buf.len() {
            return Err(ProtoError::UnexpectedEof);
        }
        let out = &self.buf[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    pub fn read_string(&mut self) -> Result<&'a str, ProtoError> {
        std::str::from_utf8(self.read_bytes()?).map_err(|_| ProtoError::InvalidUtf8)
    }
}

pub fn write_var_u64(out: &mut Vec<u8>, mut n: u64) {
    while n >= 0x80 {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

pub fn write_bytes(out: &mut Vec<u8>, data: &[u8]) {
    write_var_u64(out, data.len() as u64);
    out.extend_from_slice(data);
}

pub fn write_string(out: &mut Vec<u8>, s: &str) {
    write_bytes(out, s.as_bytes());
}

/// Frame a sync message: [MSG_SYNC, subtype, len-prefixed payload].
pub fn frame_sync(subtype: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 8);
    write_var_u64(&mut out, MSG_SYNC);
    write_var_u64(&mut out, subtype);
    write_bytes(&mut out, payload);
    out
}

/// Frame an awareness message: [MSG_AWARENESS, len-prefixed awareness update].
pub fn frame_awareness(update: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(update.len() + 8);
    write_var_u64(&mut out, MSG_AWARENESS);
    write_bytes(&mut out, update);
    out
}

/// One client's entry inside an awareness update. `json == "null"` means "left".
#[derive(Debug, Clone)]
pub struct AwarenessEntry {
    pub client_id: u64,
    pub clock: u64,
    pub json: String,
}

/// Decode an awareness update payload: varUint count, then per client
/// (varUint clientId, varUint clock, varString stateJson).
pub fn decode_awareness(payload: &[u8]) -> Result<Vec<AwarenessEntry>, ProtoError> {
    let mut c = Cursor::new(payload);
    let count = c.read_var_u64()?;
    let mut entries = Vec::with_capacity(count.min(1024) as usize);
    for _ in 0..count {
        let client_id = c.read_var_u64()?;
        let clock = c.read_var_u64()?;
        let json = c.read_string()?.to_string();
        entries.push(AwarenessEntry {
            client_id,
            clock,
            json,
        });
    }
    Ok(entries)
}

/// Encode an awareness update payload from entries.
pub fn encode_awareness(entries: &[AwarenessEntry]) -> Vec<u8> {
    let mut out = Vec::new();
    write_var_u64(&mut out, entries.len() as u64);
    for e in entries {
        write_var_u64(&mut out, e.client_id);
        write_var_u64(&mut out, e.clock);
        write_string(&mut out, &e.json);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn var_u64_round_trip() {
        for n in [
            0u64,
            1,
            127,
            128,
            300,
            16383,
            16384,
            u32::MAX as u64,
            u64::MAX / 2,
        ] {
            let mut buf = Vec::new();
            write_var_u64(&mut buf, n);
            assert_eq!(Cursor::new(&buf).read_var_u64().unwrap(), n);
        }
    }

    #[test]
    fn awareness_round_trip() {
        let entries = vec![
            AwarenessEntry {
                client_id: 42,
                clock: 7,
                json: r#"{"user":{"name":"jb"}}"#.into(),
            },
            AwarenessEntry {
                client_id: 1337,
                clock: 1,
                json: "null".into(),
            },
        ];
        let payload = encode_awareness(&entries);
        let back = decode_awareness(&payload).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].client_id, 42);
        assert_eq!(back[1].json, "null");
    }

    #[test]
    fn sync_frame_shape() {
        let f = frame_sync(SYNC_UPDATE, &[9, 9, 9]);
        let mut c = Cursor::new(&f);
        assert_eq!(c.read_var_u64().unwrap(), MSG_SYNC);
        assert_eq!(c.read_var_u64().unwrap(), SYNC_UPDATE);
        assert_eq!(c.read_bytes().unwrap(), &[9, 9, 9]);
    }
}
