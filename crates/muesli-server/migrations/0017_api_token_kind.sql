-- Distinguish the desktop app's own device-login token (minted by cli_login's OS-Keychain
-- flow) from an ordinary delegated agent key (minted via POST /api/me/tokens,
-- settings.md §2.2). Both are Bearer api_tokens rows and both act within their owner's
-- permissions, but the notifications REST surface (notifications_api.rs) must accept only
-- the former: an ordinary delegated key must not gain read/write access to its owner's
-- mention inbox and preferences merely by being a valid Bearer token — that would defeat
-- mcp.rs's `inbox_user` wall, which deliberately holds MCP-connected agents to their OWN
-- identity's inbox rather than their owner's.
--
-- Existing rows default to 'delegated' (fail closed: a token minted before this column
-- existed is treated as the more restricted kind, not the more privileged one).
alter table api_tokens
    add column kind text not null default 'delegated'; -- 'device' | 'delegated'

-- Backfill: without this, every pre-existing device-login token (the desktop app's own
-- Keychain-stored Bearer token, minted by cli_login and never refreshed — server_login in
-- apps/desktop/src-tauri/src/auth/mod.rs is the only call site) defaults to 'delegated'
-- above and the notifications bell 403s forever for every account that signed in before
-- this migration ran. That is the exact regression this column exists to prevent, just
-- moved from "never worked" to "stopped working on upgrade".
--
-- cli_login's `label` (auth.rs, CliLoginRequest) is NOT a safe backfill key: the CLI's own
-- login command mints "muesli-cli@{hostname}" (recognizable), but the desktop app calls
-- the same cli_login with its own label() — the OS account name, or bare hostname as a
-- fallback (apps/desktop/src-tauri/src/auth/mod.rs) — indistinguishable from a label a
-- human would naturally choose for a POST /api/me/tokens delegated key. Matching on label
-- would either miss most desktop installs (too narrow) or reclassify ordinary delegated
-- keys as 'device' (too broad) — the latter hands a third-party agent key its owner's full
-- mention inbox read/write, which is the exact hole migration 0017 exists to close.
--
-- Instead, key off an existing, non-user-controllable invariant already in audit_log
-- (migration 0007): both mint paths write an 'agent_token_minted' event carrying the
-- freshly created agent's id as detail->>'agent_id', but only account.rs's mint_token
-- (the POST /api/me/tokens path) includes a 'token_id' key in that detail — auth.rs's
-- cli_login never has, all the way back to this table's introduction. api_tokens.principal_id
-- is that same agent id, minted fresh per token (create_agent_user is called once per mint,
-- never reused), so the join below is exact, not a heuristic over user input.
--
-- Accepted residual risk: audit writes are fire-and-forget (audit.rs — never block or fail
-- the action they describe), so a token whose audit insert failed keeps 'delegated' after
-- this backfill. That fails closed the same way an unrecognized kind value already does
-- (see TokenKind::from_db) — the bell stays broken for that one account rather than a
-- delegated key gaining privilege it never had.
update api_tokens t
set kind = 'device'
where t.kind = 'delegated'
  and exists (
      select 1
      from audit_log a
      where a.action = 'agent_token_minted'
        and not (a.detail ? 'token_id')
        -- guard the cast: never let a malformed detail blob fail the whole migration
        and (a.detail ->> 'agent_id') ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (a.detail ->> 'agent_id')::uuid = t.principal_id
  );
