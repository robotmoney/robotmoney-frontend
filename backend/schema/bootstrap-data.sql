-- Snapshot, part 2 of 3: BOOTSTRAP DATA (smoke-production-spec.md §8.1).
--
-- The operational rows the application needs to run: singletons and the seed
-- `job_schedules` rows. NOT `--seed` demo data -- §5 makes `--seed` explicit and
-- never implied by any mode, and §10 W2 requires a snapshot-bootstrapped database
-- to boot and pass preflight without it.
--
-- The swarm.* schedules land DISABLED here on purpose: enablement is a production
-- initialization step (`bun run schedules:enable`, §6.3/§9.1), never a boot or a
-- bootstrap side-effect.
--
-- PostgreSQL database dump
--


-- Dumped from database version 18.6 (Debian 18.6-1.pgdg13+2)
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: analytics_read_mode; Type: TABLE DATA; Schema: public; Owner: rm_owner
--

INSERT INTO public.analytics_read_mode (id, mode, updated_at, updated_by) VALUES (true, 'compatibility', '2026-09-23 04:55:53.137749+00', 'migration 0060');


--
-- Data for Name: asset_price_floors; Type: TABLE DATA; Schema: public; Owner: rm_owner
--

INSERT INTO public.asset_price_floors (symbol, first_priceable_date, proven, resolved_at) VALUES ('USDC', '2026-03-18', true, '2026-09-23 04:55:52.961235+00');
INSERT INTO public.asset_price_floors (symbol, first_priceable_date, proven, resolved_at) VALUES ('ZYFAI-SS1', '2026-03-18', true, '2026-09-23 04:55:52.961235+00');
INSERT INTO public.asset_price_floors (symbol, first_priceable_date, proven, resolved_at) VALUES ('GIZA-SS1', '2026-03-18', true, '2026-09-23 04:55:52.961235+00');


--
-- Data for Name: job_schedules; Type: TABLE DATA; Schema: public; Owner: rm_owner
--

INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (1, 'regime.classify', '30 22 * * *', '{}', 'UTC', false, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (2, 'research.refresh', '0 23 * * *', '{}', 'UTC', false, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (3, 'vault.sample_share_price', '0 * * * *', '{}', 'UTC', true, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (4, 'vault.sample_adapters', '0 * * * *', '{}', 'UTC', true, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (5, 'wallet.sample_balances', '* * * * *', '{}', 'UTC', true, NULL, NULL, 'collapse-per-bucket');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (6, 'wallet.sample_sleeves', '* * * * *', '{}', 'UTC', true, NULL, NULL, 'collapse-per-bucket');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (7, 'buybacks.refresh', '15 */6 * * *', '{}', 'UTC', true, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (8, 'ops.repair_gaps', '*/5 * * * *', '{}', 'UTC', true, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (9, 'ops.backfill_asset_prices', '*/15 * * * *', '{}', 'UTC', true, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (10, 'analytics.parity_sweep', '20 * * * *', '{}', 'UTC', true, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (11, 'projects.discover', '0 2 * * *', '{}', 'UTC', true, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (12, 'projects.refresh_coins', '10 * * * *', '{}', 'UTC', true, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (13, 'projects.refresh_wallets', '20 */6 * * *', '{}', 'UTC', true, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (14, 'projects.fetch_vaults', '30 */6 * * *', '{}', 'UTC', true, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (15, 'projects.snapshot_daily', '40 0 * * *', '{}', 'UTC', true, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (16, 'projects.sync_revenue', '50 1 * * *', '{}', 'UTC', true, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (17, 'projects.recompute_coverage', '0 3 * * *', '{}', 'UTC', true, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (18, 'swarm.open_session', '0 6 * * *', '{}', 'UTC', false, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (19, 'swarm.publish_brief', '0 7 * * *', '{"windowMinutes": 60}', 'UTC', false, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (20, 'swarm.close_window', '0 8 * * *', '{}', 'UTC', false, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (21, 'swarm.aggregate', '0 9 * * *', '{}', 'UTC', false, NULL, NULL, 'all');
INSERT INTO public.job_schedules (id, kind, cron, payload, timezone, enabled, last_enqueued_at, next_run_at, catchup_policy) VALUES (22, 'swarm.publish', '0 10 * * *', '{}', 'UTC', false, NULL, NULL, 'all');


--
-- Data for Name: swarm_judge_config; Type: TABLE DATA; Schema: public; Owner: rm_owner
--

INSERT INTO public.swarm_judge_config (id, mode, min_takes, model, updated_at, third_party_enabled, policy_updated_at) VALUES (1, 'off', 3, NULL, '2026-09-23 04:55:52.930498+00', false, '2026-09-23 04:55:52.930498+00');


--
-- Data for Name: swarm_judge_fault_injection; Type: TABLE DATA; Schema: public; Owner: rm_owner
--

INSERT INTO public.swarm_judge_fault_injection (id, enabled, body, remaining, session_id, note, updated_by, updated_at) VALUES (1, false, '', 0, NULL, NULL, NULL, '2026-09-23 04:55:53.108409+00');


--
-- Name: job_schedules_id_seq; Type: SEQUENCE SET; Schema: public; Owner: rm_owner
--

SELECT pg_catalog.setval('public.job_schedules_id_seq', 22, true);


--
-- PostgreSQL database dump complete
--


