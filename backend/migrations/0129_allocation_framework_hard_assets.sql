-- compat: additive
-- metadata_version: 1
--
-- The published allocation framework becomes 50 / 7 / 29 / 14, with Hard Assets
-- (gold) in the place of Agent Tokens (issue 1496, Linear RM-190).
--
-- WHY. GET /api/dashboards/allocation and each new allocation brief read the
-- single allocation_framework row (id = 1). Nothing writes it except the seed,
-- and the seed only fills an empty table (db/seed.ts), so changing
-- ALLOCATION_FRAMEWORK_SEED alone never reaches production. Production data
-- changes only through a migration (D66).
--
-- WHAT IT CHANGES. Only the id = 1 row: buckets becomes Conservative DeFi Yield
-- 50% (Aave, Morpho, Compound, Sky, 25% each), Protocol Tokens 7% (BTC, ETH,
-- 50% each), Real World Assets 29% (SPY 100%), Hard Assets 14% (Gold 100%).
-- vault_contract is untouched. No session, brief or receipt row is touched.
--
-- ASOF. A session's bucket list is picked by its asOf against this row's asof:
-- before it, agent_tokens; on or after it, hard_assets. A session already open
-- at deploy keeps the list it opened with, so asof is set to the first day on
-- which no session exists yet: today, or the day after the newest existing
-- session when one already carries today's date. Past receipts keep verifying
-- with agent_tokens because their sessions are all before this asof.
--
-- IDEMPOTENT. The row is rewritten only while it does not yet carry the
-- hard_assets bucket, so a second run leaves asof and buckets as the first set
-- them. A database with no row (every clean database) matches nothing: the
-- seed inserts the same framework.
UPDATE allocation_framework
   SET asof = GREATEST(
         (now() AT TIME ZONE 'UTC')::date,
         COALESCE((SELECT max(date) + 1 FROM swarm_sessions), (now() AT TIME ZONE 'UTC')::date)
       ),
       buckets = '[
         {"id":"conservative_defi_yield","name":"Conservative DeFi Yield","target_weight":0.5,"items":[
           {"id":"aave","name":"Aave","target_weight":0.25},
           {"id":"morpho","name":"Morpho","target_weight":0.25},
           {"id":"compound","name":"Compound","target_weight":0.25},
           {"id":"sky","name":"Sky","target_weight":0.25}]},
         {"id":"protocol_tokens","name":"Protocol Tokens","target_weight":0.07,"items":[
           {"id":"btc","name":"BTC","target_weight":0.5},
           {"id":"eth","name":"ETH","target_weight":0.5}]},
         {"id":"real_world_assets","name":"Real World Assets","target_weight":0.29,"items":[
           {"id":"spy","name":"SPY","target_weight":1}]},
         {"id":"hard_assets","name":"Hard Assets","target_weight":0.14,"items":[
           {"id":"gold","name":"Gold","target_weight":1}]}
       ]'::jsonb
 WHERE id = 1
   AND NOT (buckets @> '[{"id":"hard_assets"}]'::jsonb);
