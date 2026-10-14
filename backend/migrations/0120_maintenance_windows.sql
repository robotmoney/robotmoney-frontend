-- compat: additive
-- metadata_version: 1
--
-- Maintenance windows (issue 1220, scope item (a)): the product's notion of a
-- planned period when api, workers or the database are down for a release.
--
-- WHY. The v0.6.0 runbook stopped every container for 20 to 45 minutes with no
-- word to visitors. A window is announced before it starts (a site banner),
-- shown while it runs (a maintenance view), and closed or cancelled afterwards.
-- The public answer is GET /api/status/maintenance (src/ops/maintenance.ts).
--
-- APPEND-ONLY EVENT LOG. One row per state change of a window, never an UPDATE:
-- `scheduled`, `started`, `ended` or `cancelled`. `window_id` groups the events
-- of one window and its newest row is its state. Every row repeats the window's
-- times and message, so the newest row alone answers the public route. The
-- audited admin routes write one `audit_log` row beside each event.
--
-- GRANTS. rm_app reads and INSERTs. No runtime role holds UPDATE, DELETE or
-- TRUNCATE (D55 (6)); schema/grants.sql lists the table with the insert-only
-- tables so reconciliation re-asserts it on every migrate run.
--
-- ADDITIVE and IDEMPOTENT: a new table created only if absent, and a GRANT
-- already held is a no-op (tests/prod-baseline.test.ts re-applies the newest
-- migration).

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id           bigserial   NOT NULL,
  window_id    uuid        NOT NULL,
  event        text        NOT NULL,
  starts_at    timestamptz NOT NULL,
  expected_end timestamptz NOT NULL,
  message      text        NOT NULL DEFAULT '',
  actor        text        NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_windows_pkey PRIMARY KEY (id),
  CONSTRAINT maintenance_windows_event_check CHECK (event IN ('scheduled', 'started', 'ended', 'cancelled')),
  CONSTRAINT maintenance_windows_times_check CHECK (expected_end > starts_at),
  CONSTRAINT maintenance_windows_message_check CHECK (char_length(message) <= 500)
);

CREATE INDEX IF NOT EXISTS maintenance_windows_window_idx ON maintenance_windows (window_id, id DESC);

GRANT INSERT ON maintenance_windows TO rm_app;
GRANT USAGE ON SEQUENCE maintenance_windows_id_seq TO rm_app;
