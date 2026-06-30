-- Member-hosted memos (ARCHITECTURE.md §9.3). Members publish long-form analysis
-- at their own URLs; the memo_url in a submission is covered by the signature and
-- linked from the published session. For the demo, RM hosts the memo storage so
-- the post_memo MCP tool and GET serving work out of the box.
CREATE TABLE IF NOT EXISTS committee_memos (
  id         bigserial PRIMARY KEY,
  member_id  text NOT NULL REFERENCES committee_members(id),
  session_id bigint NOT NULL REFERENCES committee_sessions(id),
  title      text NOT NULL DEFAULT '',
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
