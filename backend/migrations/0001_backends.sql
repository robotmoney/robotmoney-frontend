-- Backend state consolidated from Upstash Redis (comments) and GitHub-as-DB
-- (committee). All previously-committed JSON/CSV moves into Postgres.

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

CREATE TABLE comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page        text NOT NULL,
  author      text NOT NULL,
  content     text NOT NULL,
  parent_id   uuid REFERENCES comments(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  ip_hash     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_page_created_idx ON comments (page, created_at DESC);

CREATE TABLE committee_members (
  id            text PRIMARY KEY,
  status        text NOT NULL DEFAULT 'inactive',
  name          text NOT NULL,
  tagline       text,
  lens          text,
  mandate       text,
  biases        jsonb,
  voice_md      text,
  mode          text,
  submit        jsonb,
  operator      text,
  avatar        jsonb,
  contact_email text,
  key_hash      text,
  public_key    text,
  applied_at    timestamptz,
  activated_at  timestamptz
);

CREATE TABLE committee_subjects (
  id                  text PRIMARY KEY,
  status              text NOT NULL DEFAULT 'active',
  name                text NOT NULL,
  operator            text,
  homepage            text,
  x_handle            text,
  thesis_blurb        text,
  wallets             jsonb,
  nft_contracts       jsonb,
  source              jsonb,
  recommendation_type text,
  linked_member_id    text,
  structural_notes    jsonb,
  last_reviewed       date
);

CREATE TABLE committee_sessions (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date                            date NOT NULL,
  subject_id                      text NOT NULL,
  subject_name                    text,
  regime_summary                  jsonb,
  subject_snapshot_total_value_usd numeric,
  synthesis                       text,
  committee_recommendation        jsonb,
  social_draft_id                 text,
  generated_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (date, subject_id)
);

CREATE TABLE committee_takes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES committee_sessions(id) ON DELETE CASCADE,
  member_id    text NOT NULL,
  member_name  text,
  mode         text,
  stance       text,
  confidence   numeric,
  body         text,
  model        text,
  generated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX committee_takes_session_idx ON committee_takes (session_id);

CREATE TABLE committee_briefs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date       date NOT NULL,
  subject_id text NOT NULL,
  body       jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (date, subject_id)
);

CREATE TABLE committee_subject_snapshots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id     text NOT NULL,
  date           date NOT NULL,
  total_value_usd numeric,
  positions      jsonb,
  wallets        jsonb,
  notable        jsonb,
  UNIQUE (subject_id, date)
);

CREATE TABLE committee_applications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   text,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

CREATE TABLE committee_submissions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id  text NOT NULL,
  date       date,
  subject_id text,
  nonce      text NOT NULL,
  stance     text,
  confidence numeric,
  body       text,
  signature  text,
  verified   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, nonce)
);

-- Single-row allocation framework; shared by /allocation and the IC subject view.
CREATE TABLE allocation_framework (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  asof          date,
  vault_contract text,
  buckets       jsonb NOT NULL DEFAULT '[]'::jsonb
);
