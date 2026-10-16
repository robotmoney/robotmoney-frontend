-- compat: additive
-- metadata_version: 1
--
-- Purge the projects fixture dataset production persisted (issue 1208).
--
-- WHY. Production v0.5.4 ran RM_ENV=smoke without PROJECTS_SOURCE=live, so the
-- projects worker persisted backend/src/projects/fixtures/dataset.ts: four
-- fabricated projects with their agents, coins, wallets (e.g. 'Virtuals DAO
-- Treasury' at $4,200,000) and vaults, served publicly on /projects/:slug,
-- /api/projects/* and /api/dashboards/{wallets,vaults,entities}. On v0.6.0
-- (PROJECTS_SOURCE=live) projects.refresh_wallets and projects.fetch_vaults
-- fail on every fake address each cron, which holds the analytics lane for
-- over an hour and cost production its hourly vault samples. The selector fix
-- (#1244) stops a deployed stack persisting the fixture again; it deletes
-- nothing. This migration removes the rows already there.
--
-- WHY A MIGRATION AND NOT THE SCRIPT ISSUE 1208 DESCRIBED. The issue asked for
-- scripts/oneoff/purge-projects-fixture.ts and put a migration out of scope
-- (owner, 2026-10-08). On 2026-10-09 the owner ruled that production data is
-- changed only through a migration. That later rule wins: this file is the
-- purge, the script is not written.
--
-- WHAT IT DELETES. Only rows with the exact synthetic identity the fixture
-- wrote, and only under a fixture project. A project qualifies when BOTH hold:
--   * its slug AND its logo_url equal a fixture pair (the logos are
--     https://cdn.example/..., which no live source produces), and
--   * every agent, coin, wallet and vault under it is a fixture row, and no
--     agent_activity_log row references one of its agents.
-- A project that fails the second test is LEFT WHOLE, with a NOTICE naming the
-- slug. The script would have refused; a migration that raised would stop the
-- release, so it skips instead and the operator reads the NOTICE.
-- Qualifying projects are deleted with their fixture agents, coins, wallets and
-- vaults. The six daily_* / agent_revenue_daily tables go with them through
-- their ON DELETE CASCADE foreign keys. A fixture-address wallet or vault with
-- no project (project_id NULL after an earlier SET NULL) is deleted by its
-- exact address.
--
-- IDEMPOTENT. A second run, or a database that never held the fixture (every CI
-- and clean database), matches nothing and deletes nothing.
DO $$
DECLARE
  fixture_agent_names constant text[] := ARRAY[
    'G.A.M.E. Protocol Agent', 'aixbt', 'Coinbase x402 Facilitator', 'No Activity Agent'];
  fixture_coingecko_ids constant text[] := ARRAY['virtual-protocol', 'aixbt'];
  fixture_coin_contracts constant text[] := ARRAY['0xgame00000000000000000000000000000000coin'];
  fixture_wallets constant text[] := ARRAY[
    '0xwallet0000000000000000000000000000000aaa', '0xwallet0000000000000000000000000000000bbb',
    '0xwallet0000000000000000000000000000000ccc', '0xwallet0000000000000000000000000000000ddd'];
  fixture_vaults constant text[] := ARRAY[
    '0xvault0000000000000000000000000000000aaa', '0xvault0000000000000000000000000000000bbb'];
  qualifying uuid[];
  skipped text[];
  n_projects int;
BEGIN
  SELECT coalesce(array_agg(t.id) FILTER (WHERE NOT t.is_bad), '{}'),
         coalesce(array_agg(t.slug) FILTER (WHERE t.is_bad), '{}')
    INTO qualifying, skipped
    FROM (
      SELECT fp.id, fp.slug,
             (EXISTS (SELECT 1 FROM openclaw_agents a WHERE a.project_id = fp.id AND a.name <> ALL (fixture_agent_names))
              OR EXISTS (SELECT 1 FROM lobster_coins c WHERE c.project_id = fp.id
                          AND NOT (coalesce(c.coingecko_id, '') = ANY (fixture_coingecko_ids)
                                   OR coalesce(c.contract_address, '') = ANY (fixture_coin_contracts)))
              OR EXISTS (SELECT 1 FROM tracked_wallets w WHERE w.project_id = fp.id AND coalesce(w.address, '') <> ALL (fixture_wallets))
              OR EXISTS (SELECT 1 FROM agent_vaults v WHERE v.project_id = fp.id AND coalesce(v.vault_address, '') <> ALL (fixture_vaults))
              OR EXISTS (SELECT 1 FROM agent_activity_log l JOIN openclaw_agents a ON a.id = l.agent_id WHERE a.project_id = fp.id)
             ) AS is_bad
        FROM (
          SELECT p.id, p.slug
            FROM projects p
            JOIN (VALUES
              ('virtuals-protocol',         'https://cdn.example/virtuals.png'),
              ('aixbt',                     'https://cdn.example/aixbt.png'),
              ('coinbase-x402-facilitator', 'https://cdn.example/x402.png'),
              ('tokenless-no-activity',     'https://cdn.example/noactivity.png')
            ) AS f(slug, logo_url) ON p.slug = f.slug AND p.logo_url = f.logo_url
        ) fp
    ) t;

  IF cardinality(skipped) > 0 THEN
    RAISE NOTICE '0118: fixture project(s) % carry non-fixture rows or activity-log references and were left whole', skipped;
  END IF;

  DELETE FROM openclaw_agents WHERE project_id = ANY (qualifying) AND name = ANY (fixture_agent_names);
  DELETE FROM lobster_coins WHERE project_id = ANY (qualifying)
     AND (coingecko_id = ANY (fixture_coingecko_ids) OR contract_address = ANY (fixture_coin_contracts));
  DELETE FROM tracked_wallets WHERE address = ANY (fixture_wallets) AND (project_id IS NULL OR project_id = ANY (qualifying));
  DELETE FROM agent_vaults WHERE vault_address = ANY (fixture_vaults) AND (project_id IS NULL OR project_id = ANY (qualifying));
  DELETE FROM projects WHERE id = ANY (qualifying);
  GET DIAGNOSTICS n_projects = ROW_COUNT;
  IF n_projects > 0 THEN
    RAISE NOTICE '0118: removed % fixture project(s) and their fixture rows', n_projects;
  END IF;
END
$$;
