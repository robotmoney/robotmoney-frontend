-- §9.8 store reconciliation. The canonical, append-only take store is
-- committee_recommendations (0004); getSession reads from it. The 0001 tables
-- committee_takes and committee_submissions are vestigial prototype remnants —
-- they are unreferenced anywhere in backend/src, mcp/src, contract/src, and the
-- frontend (verified by grep). Drop them so the schema reflects one source of
-- truth for member-submitted signed recommendations.
DROP TABLE IF EXISTS committee_takes;
DROP TABLE IF EXISTS committee_submissions;
