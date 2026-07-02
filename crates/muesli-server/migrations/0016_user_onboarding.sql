-- First-login onboarding (BYO storage phase 3, spec 2026-07-02 §1). The flag is
-- server-side so onboarding shows once per USER, not once per browser/device.
-- Null = not onboarded; completing OR skipping stamps it (skip is a decision,
-- not a snooze). Existing users are deliberately left null: they will see
-- onboarding once and dismiss it — acceptable at the current user count, and it
-- avoids guessing a backfill cutoff.
alter table users
    add column onboarded_at timestamptz;
