-- Admin passkeys (issue #587)
CREATE TABLE IF NOT EXISTS admin_passkey (
  id           text PRIMARY KEY, -- base64url credential_id
  public_key   bytea NOT NULL,
  counter      bigint NOT NULL,
  transports   text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

-- Every ceremony gets its own single-use challenge. A second browser tab (or
-- an unauthenticated authentication request) cannot replace another ceremony.
CREATE TABLE IF NOT EXISTS admin_webauthn_challenge (
  flow       text NOT NULL CHECK (flow IN ('registration', 'authentication')),
  challenge  text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

-- `token` stores a SHA-256 digest, never a bearer token in plaintext.
CREATE TABLE IF NOT EXISTS admin_session (
  token      text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

REVOKE ALL ON admin_passkey FROM rm_worker;
REVOKE ALL ON admin_webauthn_challenge FROM rm_worker;
REVOKE ALL ON admin_session FROM rm_worker;
