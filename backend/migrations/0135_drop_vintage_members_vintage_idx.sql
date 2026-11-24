-- compat: additive
-- metadata_version: 1
--
-- Drop the redundant analytics_vintage_members_vintage_idx (issue 1717).
--
-- WHY. POST /api/analytics/vintages (freezeVintage) inserts the full member set
-- of every vintage, 10,000 rows per statement. On production that INSERT ran a
-- mean 7.6 s (pg_stat_statements, 241 calls since 2026-11-07). Every member row
-- writes every index on the table. analytics_vintage_members_vintage_idx
-- (vintage_id) repeats the leading column of the UNIQUE index
-- (vintage_id, source_value_version_id), so it costs one index write per row
-- and 53 MB while serving no lookup the unique index cannot. Lookups by
-- vintage_id (loadFrozenVintage, the archive members step) plan on the unique
-- index or on analytics_vintage_members_vintage_id_idx (vintage_id, id) from
-- 0134. EXPLAIN before and after is on PR 1740.
--
-- LOCKS. DROP INDEX takes an ACCESS EXCLUSIVE lock on the table for the moment
-- of the catalog change; it does not rewrite anything. lock_timeout 2s bounds
-- the wait for the lock, the same rule as 0130 and 0134.
--
-- ADDITIVE. No row, column, grant or statement an older image runs changes;
-- its queries still plan on the remaining indexes. IDEMPOTENT: IF EXISTS.
SET LOCAL lock_timeout = '2s';

DROP INDEX IF EXISTS analytics_vintage_members_vintage_idx;
