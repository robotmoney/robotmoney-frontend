-- compat: additive
-- metadata_version: 1
--
-- Three service-token holders per instance, not one — issue #1026 W6,
-- docs/technical/smoke-production-spec.md §3 as amended by D52.
--
-- §3: "Three holders call the API with a service token: `system-scheduler`
-- (read subjects and sessions, perform lifecycle transitions),
-- `analytics-producer` (the analytics ingestion routes), and the operator (the
-- admin routes; this replaces the `ADMIN_TOKEN` environment variable) ...
-- Every service token is issued by the API's own automation-token store: a row
-- holding the token's hash and its rights ... Each instance holds its own
-- tokens, so provisioning one never invalidates another's."
--
-- Migration 0069 built the store for the first holder only: keyed on
-- `instance` alone, so one instance could hold one token, and with rights
-- limited to the scheduler's three. This migration makes the key
-- (instance, holder) and adds the two holders' rights.
--
-- THE KEY. (instance, holder) is what makes "provisioning one never
-- invalidates another's" hold across holders as well as across instances:
-- rotating the operator's token is an upsert on (instance, 'operator') and
-- cannot touch the scheduler's row beside it. `token_hash` stays UNIQUE on its
-- own, so two holders can never share one secret either.
--
-- THE HOLDER DEFAULTS TO `system-scheduler`, which is what every existing row
-- is: 0069's store had no other holder, and its only rights were the
-- scheduler's. The default also keeps an INSERT that names no holder meaning
-- what it meant before.
--
-- RIGHTS ARE BOUND TO THE HOLDER. §3 says `system-scheduler` and
-- `analytics-producer` "hold one API credential and no other kind", so a
-- holder's rights are a subset of that holder's own list and nothing else —
-- the scheduler cannot be provisioned `admin`, and the producer cannot be
-- provisioned `lifecycle_transitions`. The constraint is in the database, not
-- only in src/db/automation-tokens.ts, for 0069's reason: a value that gets
-- past the module is still refused.
--
--   system-scheduler    read_subjects, read_sessions, lifecycle_transitions
--   analytics-producer  analytics_ingestion
--   operator            admin
--
-- WHAT THIS DOES NOT DO. It does not wire the API's authorization to the new
-- rights or retire `ADMIN_TOKEN` / `ANALYTICS_TOKEN`; that is the auth and
-- compose change that reads these rows. It only makes the rows possible.
--
-- ADDITIVE. The runtime read (`lookupAutomationToken`: SELECT by token_hash)
-- is unchanged. The one statement whose meaning changes is the provisioning
-- upsert's `ON CONFLICT (instance)`, which now has no matching constraint; its
-- only caller is src/db/automation-tokens.ts, updated in the same change, and
-- no shipped script or service provisions a token yet (the boot's
-- provisioning step is later work). There is no older provisioning code in
-- the field whose behaviour this could break.

ALTER TABLE automation_tokens
  ADD COLUMN IF NOT EXISTS holder text NOT NULL DEFAULT 'system-scheduler';

ALTER TABLE automation_tokens DROP CONSTRAINT IF EXISTS automation_tokens_holder_check;
ALTER TABLE automation_tokens ADD CONSTRAINT automation_tokens_holder_check
  CHECK (holder IN ('system-scheduler', 'analytics-producer', 'operator'));

ALTER TABLE automation_tokens DROP CONSTRAINT IF EXISTS automation_tokens_pkey;
ALTER TABLE automation_tokens ADD CONSTRAINT automation_tokens_pkey PRIMARY KEY (instance, holder);

ALTER TABLE automation_tokens DROP CONSTRAINT IF EXISTS automation_tokens_rights_known_check;
ALTER TABLE automation_tokens ADD CONSTRAINT automation_tokens_rights_known_check
  CHECK (rights <@ ARRAY[
    'read_subjects', 'read_sessions', 'lifecycle_transitions', 'analytics_ingestion', 'admin'
  ]::text[]);

ALTER TABLE automation_tokens DROP CONSTRAINT IF EXISTS automation_tokens_holder_rights_check;
ALTER TABLE automation_tokens ADD CONSTRAINT automation_tokens_holder_rights_check
  CHECK (
    (holder = 'system-scheduler'
       AND rights <@ ARRAY['read_subjects', 'read_sessions', 'lifecycle_transitions']::text[])
    OR (holder = 'analytics-producer' AND rights <@ ARRAY['analytics_ingestion']::text[])
    OR (holder = 'operator' AND rights <@ ARRAY['admin']::text[])
  );

COMMENT ON TABLE automation_tokens IS
  'API service tokens (smoke spec §3): one row per (instance, holder) holding the hash of that holder''s bearer token and the rights it carries. The secret itself is never stored, and a token file on disk that matches no row here grants nothing.';
COMMENT ON COLUMN automation_tokens.instance IS
  'The deployment instance this token was provisioned for. Keyed with holder, so provisioning or rotating one holder''s token never invalidates another holder''s or another instance''s.';
COMMENT ON COLUMN automation_tokens.holder IS
  'Who presents this token: system-scheduler, analytics-producer or operator (smoke spec §3). Bounds the rights the row may carry.';
COMMENT ON COLUMN automation_tokens.rights IS
  'What the bearer may do, a subset of its holder''s list: system-scheduler read_subjects/read_sessions/lifecycle_transitions; analytics-producer analytics_ingestion; operator admin.';
