//! @mention parsing (sub-project ④b). A mention is the literal token
//! `@[Display Name](muesli:user/<uuid>)` stored verbatim in a comment/reply/suggestion
//! body. Parsing is server-side and authoritative: clients cannot forge a mention for
//! someone without it being re-derived here from the stored body.
//!
//! The parsed recipient ids become `mention` rows (migration 0012), which power the
//! "mentions you" comments filter and — in sub-project ④c — notification enqueueing.

use uuid::Uuid;

/// Extract the distinct user ids mentioned in `body`, in first-seen order.
///
/// A mention is `@[<label>](muesli:user/<uuid>)`. The label is opaque (any text without a
/// `]`); only the `muesli:user/<uuid>` target is authoritative. Malformed tokens (bad
/// scheme, non-uuid target) are ignored. Repeated mentions of the same user collapse to one.
pub fn parse_mentions(body: &str) -> Vec<Uuid> {
    let mut out: Vec<Uuid> = Vec::new();
    let mut i = 0;
    while let Some(at) = body[i..].find("@[") {
        let start = i + at;
        // Find the label close `]` then require `(muesli:user/` immediately after.
        let after_label_open = start + 2;
        let Some(close_rel) = body[after_label_open..].find(']') else {
            break; // no more closes anywhere; nothing left to match
        };
        let label_close = after_label_open + close_rel;
        const PREFIX: &str = "](muesli:user/";
        let target_open = label_close; // points at the ']'
        if body[target_open..].starts_with(PREFIX) {
            let id_start = target_open + PREFIX.len();
            if let Some(paren_rel) = body[id_start..].find(')') {
                let id_end = id_start + paren_rel;
                let raw = &body[id_start..id_end];
                if let Ok(id) = Uuid::parse_str(raw) {
                    if !out.contains(&id) {
                        out.push(id);
                    }
                }
                i = id_end + 1; // continue scanning after the `)`
                continue;
            }
        }
        // Not a well-formed mention here; advance past this `@` and keep scanning.
        i = start + 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uid(s: &str) -> Uuid {
        Uuid::parse_str(s).unwrap()
    }

    #[test]
    fn extracts_single_mention_id() {
        let body =
            "hey @[Ada Lovelace](muesli:user/00000000-0000-0000-0000-000000000001) take a look";
        assert_eq!(
            parse_mentions(body),
            vec![uid("00000000-0000-0000-0000-000000000001")]
        );
    }

    #[test]
    fn extracts_multiple_in_order() {
        let body = "@[A](muesli:user/00000000-0000-0000-0000-00000000000a) and \
                    @[B](muesli:user/00000000-0000-0000-0000-00000000000b)";
        assert_eq!(
            parse_mentions(body),
            vec![
                uid("00000000-0000-0000-0000-00000000000a"),
                uid("00000000-0000-0000-0000-00000000000b"),
            ]
        );
    }

    #[test]
    fn dedups_repeated_mentions_of_one_user() {
        let id = "00000000-0000-0000-0000-000000000007";
        let body = format!("@[Sam](muesli:user/{id}) ... ping @[Sam Again](muesli:user/{id})");
        assert_eq!(parse_mentions(&body), vec![uid(id)]);
    }

    #[test]
    fn ignores_malformed_tokens() {
        // Wrong scheme, missing uuid, plain text @, unterminated, non-uuid target.
        let body = "@[X](http://evil/00000000-0000-0000-0000-000000000001) \
                    @[Y](muesli:user/not-a-uuid) \
                    @notachip just an at-sign \
                    @[Z](muesli:user/ \
                    @[W]() ";
        assert_eq!(parse_mentions(body), Vec::<Uuid>::new());
    }

    #[test]
    fn empty_body_yields_nothing() {
        assert_eq!(parse_mentions(""), Vec::<Uuid>::new());
    }

    #[test]
    fn valid_mention_after_a_malformed_one_is_still_found() {
        let body =
            "@[bad](muesli:user/nope) then @[ok](muesli:user/00000000-0000-0000-0000-0000000000ff)";
        assert_eq!(
            parse_mentions(body),
            vec![uid("00000000-0000-0000-0000-0000000000ff")]
        );
    }

    #[test]
    fn handles_multibyte_label_text() {
        let body = "@[日本語の名前](muesli:user/00000000-0000-0000-0000-0000000000ab) こんにちは";
        assert_eq!(
            parse_mentions(body),
            vec![uid("00000000-0000-0000-0000-0000000000ab")]
        );
    }
}
