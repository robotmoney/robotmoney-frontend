-- compat: additive
-- metadata_version: 1
--
-- Record which spoof generation installed a member key — issue #1026,
-- smoke-production-spec.md §6.4, criteria 146 and 147.
--
-- §6.4's recovery rule: a rerun after a crash "reads it back, finds the
-- database ALREADY at that generation, skips (1) and (2), and performs only (3)
-- and (4)" (scripts/lib/swarm/spoof-keys.ts, `rebindSpoofedKeys`). That needs
-- the database to say which generation it is at, and today nothing records it:
-- `SpoofRebindDeps.readInstalledGeneration()` has no column to read.
--
-- THE SHAPE, AND WHY IT IS THIS ONE. The rebind already writes one row per
-- spoofed member: a new `swarm_member_keys` row carrying the generation's
-- public key and bearer hash, which becomes the member's active key while the
-- older rows stay as history (§6.4: "historical verification keys are
-- preserved"). The generation id goes on THAT row, in the same INSERT, inside
-- the same fenced transaction. `readInstalledGeneration` then reads it from the
-- spoofed members' active keys: all of them carry the id, or — because the
-- rebind is one transaction — none do.
--
-- `swarm_member_keys` is append-only (0050; its rows are retired with
-- `active = false`, never deleted), so the alternatives were worse:
--   * a separate one-row "installed generation" table would be UPDATEd or
--     DELETEd on every rebind, a second source of truth that can disagree with
--     the keys it describes, and a runtime delete D55 (6) forbids;
--   * UPDATEing an existing key row would rewrite history on an append-only
--     table.
-- A column written only at INSERT needs neither: no row is ever updated or
-- deleted to record a generation.
--
-- ADDITIVE (spec §8.4): a nullable column with no default. Every existing key
-- reads NULL, "not installed by a spoof generation" — true of every key today.
-- Code built before this file never names the column; its INSERTs leave it
-- NULL. The CHECK accepts every existing row and refuses only an empty string,
-- which no writer produces (a generation id is `gen-` plus hex).
--
-- GRANTS: none. The rebind INSERTs through the role that already inserts key
-- rows (rm_app holds SELECT, INSERT, UPDATE; 0065 revoked DELETE and TRUNCATE
-- and grants.sql re-asserts that). A new column inherits the table's
-- privileges.

ALTER TABLE swarm_member_keys ADD COLUMN spoof_generation_id text;
ALTER TABLE swarm_member_keys ADD CONSTRAINT swarm_member_keys_spoof_generation_id_check
  CHECK (spoof_generation_id IS NULL OR spoof_generation_id <> '');

COMMENT ON COLUMN swarm_member_keys.spoof_generation_id IS
  'The --spoof-keys generation that installed this key (smoke spec §6.4), written by the rebind''s INSERT and never updated. A rerun finds the database at a generation when every spoofed member''s active key carries its id. NULL = not a spoofed key.';
