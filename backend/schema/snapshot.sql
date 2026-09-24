-- Snapshot, part 1 of 3: the SCHEMA DECLARATION (smoke-production-spec.md §8.1).
--
-- Canonical description of the schema at the version named in schema/snapshot.json,
-- and the blank-database bootstrap. NEVER applied to a populated database.
--
-- Generated from a database built by applying every file in backend/migrations/
-- in order, dumped schema-only. Two things are deliberately absent:
--   * grants and default privileges -- they are part 3 (schema/grants.sql), because
--     reconciliation runs on EVERY migrate run while this file runs only on a blank
--     database (§8.3);
--   * `CREATE EXTENSION pgcrypto` -- provider-managed (PROVIDER_MANAGED_EXCLUSIONS in
--     src/db/schema-snapshot.ts); a managed cluster installs it and rm_owner may not.
--
-- Ownership: applied by rm_owner, so every object it creates is owned by rm_owner,
-- which is what the check-2 denylist (`object_ownership`) requires.
--
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
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--




--
-- Name: rm_analytics_cutover_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rm_analytics_cutover_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  RAISE EXCEPTION 'analytics cutover ledger is immutable: % is not permitted on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'feature_not_supported';
END;
$$;


--
-- Name: rm_analytics_output_ledger_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rm_analytics_output_ledger_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  RAISE EXCEPTION 'analytics output ledger is immutable: % is not permitted on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'feature_not_supported';
END;
$$;


--
-- Name: rm_analytics_overwrite_event_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rm_analytics_overwrite_event_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  RAISE EXCEPTION
    'analytics_overwrite_events is immutable: UPDATE is not permitted'
    USING ERRCODE = 'feature_not_supported';
END;
$$;


--
-- Name: rm_analytics_run_ledger_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rm_analytics_run_ledger_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  RAISE EXCEPTION 'analytics run ledger is immutable: % is not permitted on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'feature_not_supported';
END;
$$;


--
-- Name: rm_append_only_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rm_append_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- 0A000 = feature_not_supported: the operation is refused categorically, not
  -- because of this caller's privileges or this row's contents.
  --
  -- THE MESSAGE IS THE ASSERTION SURFACE, so it is stable and it is specific.
  -- SQLSTATE alone is NOT sufficient evidence that this function ran:
  -- PostgreSQL's own heap_truncate_check_FKs() raises
  -- `cannot truncate a table referenced in a foreign key constraint` with the
  -- SAME 0A000, and fires BEFORE the trigger stage — so on any table with an
  -- inbound FK (most of these) a SQLSTATE-only check is green against a
  -- database where this migration was never applied. Every caller that verifies
  -- the guard matches this text, table name and TG_OP included.
  --
  -- Which of the two triggers refused it goes in DETAIL, so the primary message
  -- stays byte-stable for those assertions.
  RAISE EXCEPTION
    'table "%" is append-only: row deletion is not permitted (%). History rows are not removed; correct a row with an UPDATE or an offsetting row.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000',
          DETAIL = format('refused by trigger %s, %s level (migration 0032)', TG_NAME, TG_LEVEL);
END;
$$;


--
-- Name: rm_aum_evidence_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rm_aum_evidence_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION
    'table "%" is immutable AUM evidence: % is not permitted',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000';
END;
$$;


--
-- Name: rm_capture_analytics_overwrite(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rm_capture_analytics_overwrite() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  key jsonb;
BEGIN
  IF TG_TABLE_NAME = 'raw_indicator_history' THEN
    key := jsonb_build_object('date', OLD.date, 'indicator', OLD.indicator);
  ELSIF TG_TABLE_NAME = 'regime_snapshots' THEN
    key := jsonb_build_object('date', OLD.date);
  ELSIF TG_TABLE_NAME = 'research_signals' THEN
    key := jsonb_build_object('signal_key', OLD.signal_key, 'date', OLD.date);
  ELSE
    RAISE EXCEPTION 'unsupported analytics overwrite source table: %', TG_TABLE_NAME;
  END IF;

  INSERT INTO public.analytics_overwrite_events
    (table_name, operation, natural_key, previous_row, replacement_row)
  VALUES
    (TG_TABLE_NAME,
     CASE TG_OP WHEN 'UPDATE' THEN 'update' ELSE 'delete' END,
     key,
     to_jsonb(OLD),
     CASE TG_OP WHEN 'UPDATE' THEN to_jsonb(NEW) ELSE NULL END);

  RETURN CASE TG_OP WHEN 'UPDATE' THEN NEW ELSE OLD END;
END;
$$;


--
-- Name: rm_consensus_receipt_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rm_consensus_receipt_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION
    'swarm_consensus_receipts is immutable once published: % refused (issue #754). A consensus receipt''s canonical bytes are what an on-chain digest commits to; publish a corrected receipt under a new session rather than editing this one.',
    TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;


--
-- Name: rm_source_ledger_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rm_source_ledger_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  RAISE EXCEPTION 'source ledger is immutable: % is not permitted on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'feature_not_supported';
END;
$$;


--
-- Name: rm_text_array_is_canonical_set(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rm_text_array_is_canonical_set(input_values text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  SELECT NOT EXISTS (
           SELECT 1 FROM unnest(input_values) AS value
            WHERE value IS NULL OR btrim(value) = ''
         )
     AND cardinality(input_values) = (
           SELECT count(DISTINCT value COLLATE "C") FROM unnest(input_values) AS value
         )
     AND input_values = COALESCE(
           (SELECT array_agg(value ORDER BY value COLLATE "C")
              FROM unnest(input_values) AS value),
           '{}'::text[]
         );
$$;


--
-- Name: rm_wallet_aum_snapshot_constituent_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rm_wallet_aum_snapshot_constituent_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.snapshot_run_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM wallet_aum_snapshot_runs
     WHERE run_id = OLD.snapshot_run_id AND state IN ('complete', 'degraded')
  ) THEN
    RAISE EXCEPTION
      'published AUM snapshot run % is immutable: % on % is not permitted',
      OLD.snapshot_run_id, TG_OP, TG_TABLE_NAME
      USING ERRCODE = '0A000';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.snapshot_run_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM wallet_aum_snapshot_runs
     WHERE run_id = NEW.snapshot_run_id AND state IN ('complete', 'degraded')
  ) THEN
    RAISE EXCEPTION
      'published AUM snapshot run % is immutable: % on % is not permitted',
      NEW.snapshot_run_id, TG_OP, TG_TABLE_NAME
      USING ERRCODE = '0A000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: rm_wallet_aum_snapshot_finalize_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rm_wallet_aum_snapshot_finalize_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  actual_balance_keys text[];
  actual_sleeve_keys text[];
BEGIN
  IF NEW.state NOT IN ('complete', 'degraded') THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(array_agg(symbol ORDER BY symbol COLLATE "C"), '{}'::text[])
    INTO actual_balance_keys
    FROM wallet_balance_samples
   WHERE snapshot_run_id = NEW.run_id AND sample_date = NEW.sample_date;

  SELECT COALESCE(
           array_agg(
             concat('[', to_jsonb(lower(wallet_address))::text, ',', to_jsonb(symbol)::text, ']')
             ORDER BY concat('[', to_jsonb(lower(wallet_address))::text, ',', to_jsonb(symbol)::text, ']') COLLATE "C"
           ),
           '{}'::text[]
         )
    INTO actual_sleeve_keys
    FROM wallet_sleeve_samples
   WHERE snapshot_run_id = NEW.run_id AND sample_date = NEW.sample_date;

  IF actual_balance_keys <> NEW.present_balance_keys
     OR actual_sleeve_keys <> NEW.present_sleeve_keys THEN
    RAISE EXCEPTION
      'publishable AUM snapshot run % constituent keys do not match its declared present sets',
      NEW.run_id
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM wallet_balance_samples
     WHERE snapshot_run_id = NEW.run_id AND sample_date <> NEW.sample_date
    UNION ALL
    SELECT 1 FROM wallet_sleeve_samples
     WHERE snapshot_run_id = NEW.run_id AND sample_date <> NEW.sample_date
  ) THEN
    RAISE EXCEPTION
      'publishable AUM snapshot run % contains rows for another sample_date',
      NEW.run_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: rm_wallet_aum_snapshot_run_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rm_wallet_aum_snapshot_run_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION
    'table "%" is append-only AUM snapshot evidence: % is not permitted',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000';
END;
$$;


--
-- Name: swarm_members_assert_handle_namespace(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.swarm_members_assert_handle_namespace() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  -- Is this write PLACING an id? True on INSERT, and on the (never used by this
  -- application, but expressible) UPDATE that moves a primary key. See
  -- direction 2 for why the distinction is load-bearing.
  id_arrives boolean := true;
  colliding text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- An UPDATE that moves neither public name cannot create a collision, and
    -- must not be refused because of one that already exists on the row (see
    -- the deploy note above): status flips, version bumps and profile edits
    -- stay writable either way.
    IF NEW.handle IS NOT DISTINCT FROM OLD.handle
       AND NEW.id IS NOT DISTINCT FROM OLD.id THEN
      RETURN NEW;
    END IF;
    id_arrives := NEW.id IS DISTINCT FROM OLD.id;
  END IF;

  -- DIRECTION 1 — the handle this write places is already another member's id.
  -- Checked on every write that moves either name. This is the ONLY direction a
  -- handle-only rename can create: a forbidden pair exists exactly when some
  -- row's handle equals some other row's id, so the write that MOVES that
  -- handle is refused here, whichever of the two rows is written second and
  -- however many rows one UPDATE statement touches.
  SELECT m.id INTO colliding
    FROM swarm_members m
    WHERE m.id <> NEW.id AND m.id = NEW.handle
    LIMIT 1;
  IF colliding IS NOT NULL THEN
    RAISE EXCEPTION
      'handle % is already member %''s id, so it would address more than one swarm member',
      NEW.handle, colliding
      USING ERRCODE = '23505', CONSTRAINT = 'swarm_members_handle_namespace';
  END IF;

  -- DIRECTION 2 — the id this write places is already another member's handle.
  -- This is what makes the check symmetric on INSERT: without it, the pair is
  -- creatable by publishing A(handle='woon') first and inserting B(id='woon')
  -- second, because that INSERT never looks at anyone else's handle.
  --
  -- Gated on `id_arrives` deliberately. `NEW.id` does not move on a rename, and
  -- neither does any other row's handle, so on a handle-only UPDATE this clause
  -- can only ever report a collision the write did not create — the same reason
  -- the early return above exists. Ungated it froze the HIJACKED member out of
  -- the handle namespace entirely: with A(id='a1', handle='woon') and
  -- B(id='woon', handle='b1'), every rename B attempted was refused, including
  -- to names nobody held, and the admin surface reported that as
  -- "handle already taken" — false, and pointing at the wrong row. The repair
  -- is to move A's handle, and B's own edits must stay writable meanwhile.
  IF id_arrives THEN
    SELECT m.id INTO colliding
      FROM swarm_members m
      WHERE m.id <> NEW.id AND m.handle = NEW.id
      LIMIT 1;
    IF colliding IS NOT NULL THEN
      RAISE EXCEPTION
        'id % is already member %''s handle, so it would address more than one swarm member',
        NEW.id, colliding
        USING ERRCODE = '23505', CONSTRAINT = 'swarm_members_handle_namespace';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: swarm_members_default_handle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.swarm_members_default_handle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.handle IS NULL OR NEW.handle = '' THEN NEW.handle := NEW.id; END IF;
  RETURN NEW;
END;
$$;


--
-- Name: swarm_recommendations_default_final(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.swarm_recommendations_default_final() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- A writer that knows D51 set the flag itself; the partial unique index
  -- is its check.
  IF NEW.final THEN
    RETURN NEW;
  END IF;
  -- Only the member's newest revision in the session is the counting take.
  IF EXISTS (
    SELECT 1 FROM public.swarm_recommendations
     WHERE session_id = NEW.session_id
       AND member_id = NEW.member_id
       AND revision >= NEW.revision
  ) THEN
    RETURN NEW;
  END IF;
  UPDATE public.swarm_recommendations
     SET final = false
   WHERE session_id = NEW.session_id
     AND member_id = NEW.member_id
     AND final;
  NEW.final := true;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_credential; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_credential (
    id integer NOT NULL,
    pass_hash text NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    recovery_hash text,
    CONSTRAINT admin_credential_id_check CHECK ((id = 1))
);


--
-- Name: admin_passkey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_passkey (
    id text NOT NULL,
    public_key bytea NOT NULL,
    counter bigint NOT NULL,
    transports text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_session (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: admin_webauthn_challenge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_webauthn_challenge (
    flow text NOT NULL,
    challenge text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT admin_webauthn_challenge_flow_check CHECK ((flow = ANY (ARRAY['registration'::text, 'authentication'::text])))
);


--
-- Name: agent_activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_activity_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    agent_id uuid,
    agent_name text DEFAULT ''::text NOT NULL,
    action_type text NOT NULL,
    status text NOT NULL,
    commit_summary text,
    submitted_by text,
    approved_by text,
    score numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_activity_log_status_check CHECK ((status = ANY (ARRAY['success'::text, 'pending'::text, 'rejected'::text])))
);


--
-- Name: agent_revenue_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_revenue_daily (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id uuid NOT NULL,
    revenue_date date DEFAULT CURRENT_DATE NOT NULL,
    revenue_usd numeric DEFAULT 0 NOT NULL,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_vaults; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_vaults (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    name text DEFAULT ''::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    vault_address text,
    protocol text,
    data_source text,
    chain text,
    strategy_type text,
    tvl_usd numeric,
    yield_apy numeric,
    refreshed_at timestamp with time zone,
    last_refresh_status text,
    last_rebalance_at timestamp with time zone
);


--
-- Name: allocation_framework; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.allocation_framework (
    id integer DEFAULT 1 NOT NULL,
    asof date,
    vault_contract text,
    buckets jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT allocation_framework_id_check CHECK ((id = 1))
);


--
-- Name: analytics_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_artifacts (
    id bigint NOT NULL,
    analytics_run_id uuid,
    stage_run_id bigint,
    tool_id text NOT NULL,
    kind text NOT NULL,
    artifact_key text NOT NULL,
    checksum text,
    row_count integer,
    first_date date,
    last_date date,
    preview jsonb,
    storage_ref jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: analytics_artifacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.analytics_artifacts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: analytics_artifacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.analytics_artifacts_id_seq OWNED BY public.analytics_artifacts.id;


--
-- Name: analytics_data_vintages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_data_vintages (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    tool_id text NOT NULL,
    knowledge_time_cutoff timestamp with time zone NOT NULL,
    market_time_cutoff date NOT NULL,
    methodology_version_id bigint NOT NULL,
    build_identity text NOT NULL,
    manifest jsonb NOT NULL,
    manifest_digest text NOT NULL,
    member_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT analytics_data_vintages_build_identity_check CHECK (((build_identity <> ''::text) AND (length(build_identity) <= 256))),
    CONSTRAINT analytics_data_vintages_manifest_digest_check CHECK ((manifest_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT analytics_data_vintages_member_count_check CHECK ((member_count >= 0)),
    CONSTRAINT analytics_data_vintages_tool_id_check CHECK (((tool_id <> ''::text) AND (length(tool_id) <= 64)))
);


--
-- Name: analytics_data_vintages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analytics_data_vintages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analytics_data_vintages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analytics_ledger_methodology_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_ledger_methodology_versions (
    id bigint NOT NULL,
    tool_id text NOT NULL,
    version_label text NOT NULL,
    config jsonb NOT NULL,
    config_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT analytics_ledger_methodology_versions_config_digest_check CHECK ((config_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT analytics_ledger_methodology_versions_tool_id_check CHECK (((tool_id <> ''::text) AND (length(tool_id) <= 64))),
    CONSTRAINT analytics_ledger_methodology_versions_version_label_check CHECK (((version_label <> ''::text) AND (length(version_label) <= 128)))
);


--
-- Name: analytics_ledger_methodology_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analytics_ledger_methodology_versions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analytics_ledger_methodology_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analytics_ledger_run_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_ledger_run_events (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    sequence integer NOT NULL,
    event_type text NOT NULL,
    detail text,
    knowledge_time timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT analytics_ledger_run_events_event_type_check CHECK ((event_type = ANY (ARRAY['started'::text, 'succeeded'::text, 'degraded'::text, 'failed'::text]))),
    CONSTRAINT analytics_ledger_run_events_sequence_check CHECK ((sequence > 0))
);


--
-- Name: analytics_ledger_run_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analytics_ledger_run_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analytics_ledger_run_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analytics_ledger_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_ledger_runs (
    id bigint NOT NULL,
    run_key text NOT NULL,
    asof date NOT NULL,
    tool_id text NOT NULL,
    source_label text NOT NULL,
    methodology_version_id bigint NOT NULL,
    build_identity text NOT NULL,
    job_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT analytics_ledger_runs_build_identity_check CHECK (((build_identity <> ''::text) AND (length(build_identity) <= 256))),
    CONSTRAINT analytics_ledger_runs_run_key_check CHECK ((run_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT analytics_ledger_runs_source_label_check CHECK ((source_label = ANY (ARRAY['live'::text, 'hermetic'::text, 'fixture'::text]))),
    CONSTRAINT analytics_ledger_runs_tool_id_check CHECK (((tool_id <> ''::text) AND (length(tool_id) <= 64)))
);


--
-- Name: analytics_ledger_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analytics_ledger_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analytics_ledger_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analytics_output_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_output_snapshots (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    artifact_kind text NOT NULL,
    payload_bytes bytea NOT NULL,
    checksum text NOT NULL,
    byte_length bigint GENERATED ALWAYS AS (octet_length(payload_bytes)) STORED,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT analytics_output_snapshots_artifact_kind_check CHECK ((artifact_kind = ANY (ARRAY['regime_snapshots'::text, 'research_signals'::text, 'warnings'::text, 'logs'::text, 'exceptions'::text]))),
    CONSTRAINT analytics_output_snapshots_check CHECK ((encode(public.digest(payload_bytes, 'sha256'::text), 'hex'::text) = checksum)),
    CONSTRAINT analytics_output_snapshots_checksum_check CHECK ((checksum ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: analytics_output_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analytics_output_snapshots ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analytics_output_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analytics_overwrite_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_overwrite_events (
    id bigint NOT NULL,
    table_name text NOT NULL,
    operation text NOT NULL,
    natural_key jsonb NOT NULL,
    previous_row jsonb NOT NULL,
    replacement_row jsonb,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT analytics_overwrite_events_operation_check CHECK ((operation = ANY (ARRAY['update'::text, 'delete'::text]))),
    CONSTRAINT analytics_overwrite_events_replacement_check CHECK ((((operation = 'update'::text) AND (replacement_row IS NOT NULL)) OR ((operation = 'delete'::text) AND (replacement_row IS NULL)))),
    CONSTRAINT analytics_overwrite_events_table_name_check CHECK ((table_name = ANY (ARRAY['raw_indicator_history'::text, 'regime_snapshots'::text, 'research_signals'::text])))
);


--
-- Name: analytics_overwrite_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analytics_overwrite_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analytics_overwrite_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analytics_parity_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_parity_observations (
    id bigint NOT NULL,
    domain text NOT NULL,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    legacy_row_count integer NOT NULL,
    ledger_row_count integer NOT NULL,
    legacy_checksum text NOT NULL,
    ledger_checksum text NOT NULL,
    matched boolean NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT analytics_parity_observations_domain_check CHECK ((domain = ANY (ARRAY['raw_indicator_history'::text, 'regime_snapshots'::text, 'research_signals'::text, 'swarm_briefs'::text]))),
    CONSTRAINT analytics_parity_observations_ledger_checksum_check CHECK ((ledger_checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT analytics_parity_observations_ledger_row_count_check CHECK ((ledger_row_count >= 0)),
    CONSTRAINT analytics_parity_observations_legacy_checksum_check CHECK ((legacy_checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT analytics_parity_observations_legacy_row_count_check CHECK ((legacy_row_count >= 0))
);


--
-- Name: analytics_parity_observations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analytics_parity_observations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analytics_parity_observations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analytics_read_mode; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_read_mode (
    id boolean DEFAULT true NOT NULL,
    mode text DEFAULT 'compatibility'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_by text,
    CONSTRAINT analytics_read_mode_id_check CHECK (id),
    CONSTRAINT analytics_read_mode_mode_check CHECK ((mode = ANY (ARRAY['compatibility'::text, 'ledger'::text])))
);


--
-- Name: analytics_report_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_report_snapshots (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    asof date NOT NULL,
    report_bytes bytea NOT NULL,
    checksum text NOT NULL,
    byte_length bigint GENERATED ALWAYS AS (octet_length(report_bytes)) STORED,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT analytics_report_snapshots_check CHECK ((encode(public.digest(report_bytes, 'sha256'::text), 'hex'::text) = checksum)),
    CONSTRAINT analytics_report_snapshots_checksum_check CHECK ((checksum ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: analytics_report_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analytics_report_snapshots ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analytics_report_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analytics_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id bigint,
    job_kind text NOT NULL,
    attempt integer NOT NULL,
    asof date NOT NULL,
    source_mode text NOT NULL,
    tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    current_stage text,
    code_version text DEFAULT 'unknown'::text NOT NULL,
    warning_count integer DEFAULT 0 NOT NULL,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    created_by text NOT NULL,
    audit_request_id uuid,
    CONSTRAINT analytics_runs_source_mode_check CHECK ((source_mode = ANY (ARRAY['live'::text, 'hermetic'::text]))),
    CONSTRAINT analytics_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'warning'::text, 'failed'::text])))
);


--
-- Name: analytics_stage_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_stage_runs (
    id bigint NOT NULL,
    analytics_run_id uuid,
    tool_id text NOT NULL,
    stage text NOT NULL,
    sequence smallint NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    CONSTRAINT analytics_stage_runs_stage_check CHECK ((stage = ANY (ARRAY['access'::text, 'extract'::text, 'transform'::text, 'analyze'::text, 'store'::text, 'report'::text]))),
    CONSTRAINT analytics_stage_runs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'warning'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: analytics_stage_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.analytics_stage_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: analytics_stage_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.analytics_stage_runs_id_seq OWNED BY public.analytics_stage_runs.id;


--
-- Name: analytics_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    action_type text NOT NULL,
    submitter_handle text NOT NULL,
    agent_id text,
    summary text NOT NULL,
    registration jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    ip_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analytics_submissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text])))
);


--
-- Name: analytics_vintage_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_vintage_members (
    id bigint NOT NULL,
    vintage_id bigint NOT NULL,
    source_value_version_id bigint NOT NULL,
    source_key text NOT NULL,
    CONSTRAINT analytics_vintage_members_source_key_check CHECK (((source_key <> ''::text) AND (length(source_key) <= 128)))
);


--
-- Name: analytics_vintage_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analytics_vintage_members ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analytics_vintage_members_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: asset_price_floors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_price_floors (
    symbol text NOT NULL,
    first_priceable_date date NOT NULL,
    proven boolean NOT NULL,
    resolved_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: asset_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_prices (
    price_date date NOT NULL,
    symbol text NOT NULL,
    time_basis text NOT NULL,
    price_usd numeric NOT NULL,
    currency text NOT NULL,
    source text NOT NULL,
    pool_key text,
    token_address text,
    observed_at timestamp with time zone NOT NULL,
    fetched_at timestamp with time zone NOT NULL,
    response_hash text,
    config_identity text NOT NULL,
    CONSTRAINT asset_prices_currency_check CHECK ((currency = 'USD'::text)),
    CONSTRAINT asset_prices_price_usd_check CHECK ((price_usd > (0)::numeric)),
    CONSTRAINT asset_prices_time_basis_check CHECK ((time_basis = 'utc-daily-close'::text))
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    scope jsonb,
    at timestamp with time zone DEFAULT now() NOT NULL,
    request_id uuid DEFAULT gen_random_uuid(),
    target_type text,
    target_id text,
    reason text,
    before_state jsonb,
    after_state jsonb,
    outcome text DEFAULT 'succeeded'::text NOT NULL,
    job_id bigint,
    session_id uuid
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: automation_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_tokens (
    instance text NOT NULL,
    token_hash text NOT NULL,
    rights text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text DEFAULT CURRENT_USER NOT NULL,
    note text,
    holder text DEFAULT 'system-scheduler'::text NOT NULL,
    CONSTRAINT automation_tokens_hash_shape_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT automation_tokens_holder_check CHECK ((holder = ANY (ARRAY['system-scheduler'::text, 'analytics-producer'::text, 'operator'::text]))),
    CONSTRAINT automation_tokens_holder_rights_check CHECK ((((holder = 'system-scheduler'::text) AND (rights <@ ARRAY['read_subjects'::text, 'read_sessions'::text, 'lifecycle_transitions'::text])) OR ((holder = 'analytics-producer'::text) AND (rights <@ ARRAY['analytics_ingestion'::text])) OR ((holder = 'operator'::text) AND (rights <@ ARRAY['admin'::text])))),
    CONSTRAINT automation_tokens_instance_check CHECK ((instance ~ '^[a-z0-9][a-z0-9_-]{2,63}$'::text)),
    CONSTRAINT automation_tokens_rights_known_check CHECK ((rights <@ ARRAY['read_subjects'::text, 'read_sessions'::text, 'lifecycle_transitions'::text, 'analytics_ingestion'::text, 'admin'::text])),
    CONSTRAINT automation_tokens_rights_nonempty_check CHECK ((cardinality(rights) > 0))
);


--
-- Name: buyback_scan_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.buyback_scan_state (
    id integer DEFAULT 1 NOT NULL,
    last_scanned_block bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT buyback_scan_state_id_check CHECK ((id = 1))
);


--
-- Name: buyback_swaps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.buyback_swaps (
    id bigint NOT NULL,
    block_number bigint,
    tx_hash text NOT NULL,
    log_index integer,
    occurred_on date,
    weth_spent numeric,
    value_usd numeric,
    robotmoney_received numeric,
    provenance text DEFAULT 'live'::text NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: buyback_swaps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.buyback_swaps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: buyback_swaps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.buyback_swaps_id_seq OWNED BY public.buyback_swaps.id;


--
-- Name: chain_address_floors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chain_address_floors (
    address text NOT NULL,
    floor_block bigint NOT NULL,
    resolved_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chain_day_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chain_day_blocks (
    sample_date date NOT NULL,
    block_number bigint NOT NULL,
    block_timestamp timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone DEFAULT now() NOT NULL,
    block_hash text,
    boundary_next_block_number bigint,
    boundary_next_block_hash text,
    boundary_next_block_timestamp timestamp with time zone,
    CONSTRAINT chain_day_blocks_proof_shape CHECK ((((block_hash IS NULL) AND (boundary_next_block_number IS NULL) AND (boundary_next_block_hash IS NULL) AND (boundary_next_block_timestamp IS NULL)) OR ((block_number >= 0) AND (block_hash ~ '^0x[0-9a-f]{64}$'::text) AND (boundary_next_block_number = (block_number + 1)) AND (boundary_next_block_hash ~ '^0x[0-9a-f]{64}$'::text) AND (block_timestamp < (((sample_date + 1))::timestamp without time zone AT TIME ZONE 'UTC'::text)) AND (boundary_next_block_timestamp >= (((sample_date + 1))::timestamp without time zone AT TIME ZONE 'UTC'::text)))))
);


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    page text NOT NULL,
    author text NOT NULL,
    content text NOT NULL,
    parent_id uuid,
    status text DEFAULT 'visible'::text NOT NULL,
    ip_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT comments_status_check CHECK ((status = ANY (ARRAY['visible'::text, 'hidden'::text])))
);


--
-- Name: swarm_agent_health_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_agent_health_events (
    id bigint CONSTRAINT committee_agent_health_events_id_not_null NOT NULL,
    event_type text CONSTRAINT committee_agent_health_events_event_type_not_null NOT NULL,
    session_id uuid,
    member_id text,
    detail jsonb DEFAULT '{}'::jsonb CONSTRAINT committee_agent_health_events_detail_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT committee_agent_health_events_created_at_not_null NOT NULL,
    CONSTRAINT swarm_agent_health_events_event_type_check CHECK ((event_type = ANY (ARRAY['absent'::text, 'rejected_signature'::text])))
);


--
-- Name: committee_agent_health_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.committee_agent_health_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: committee_agent_health_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.committee_agent_health_events_id_seq OWNED BY public.swarm_agent_health_events.id;


--
-- Name: swarm_member_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_member_keys (
    id bigint CONSTRAINT committee_member_keys_id_not_null NOT NULL,
    member_id text CONSTRAINT committee_member_keys_member_id_not_null NOT NULL,
    public_key text CONSTRAINT committee_member_keys_public_key_not_null NOT NULL,
    alg text DEFAULT 'ed25519'::text CONSTRAINT committee_member_keys_alg_not_null NOT NULL,
    token_hash text,
    active boolean DEFAULT true CONSTRAINT committee_member_keys_active_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT committee_member_keys_created_at_not_null NOT NULL
);


--
-- Name: committee_member_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.committee_member_keys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: committee_member_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.committee_member_keys_id_seq OWNED BY public.swarm_member_keys.id;


--
-- Name: swarm_memos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_memos (
    id bigint CONSTRAINT committee_memos_id_not_null NOT NULL,
    member_id text CONSTRAINT committee_memos_member_id_not_null NOT NULL,
    session_id uuid CONSTRAINT committee_memos_session_id_not_null NOT NULL,
    title text DEFAULT ''::text CONSTRAINT committee_memos_title_not_null NOT NULL,
    body text CONSTRAINT committee_memos_body_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT committee_memos_created_at_not_null NOT NULL
);


--
-- Name: committee_memos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.committee_memos_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: committee_memos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.committee_memos_id_seq OWNED BY public.swarm_memos.id;


--
-- Name: swarm_scheduler_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_scheduler_jobs (
    id bigint NOT NULL,
    kind text NOT NULL,
    target text NOT NULL,
    idempotency_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acked_at timestamp with time zone,
    CONSTRAINT swarm_scheduler_jobs_key_check CHECK ((idempotency_key ~ '^[A-Za-z0-9._:-]{4,128}$'::text)),
    CONSTRAINT swarm_scheduler_jobs_kind_check CHECK ((kind <> ''::text)),
    CONSTRAINT swarm_scheduler_jobs_target_check CHECK ((target <> ''::text))
);


--
-- Name: swarm_scheduler_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.swarm_scheduler_jobs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.swarm_scheduler_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: swarm_session_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_session_events (
    id bigint CONSTRAINT committee_session_events_id_not_null NOT NULL,
    session_id uuid,
    from_state text,
    to_state text CONSTRAINT committee_session_events_to_state_not_null NOT NULL,
    action text CONSTRAINT committee_session_events_action_not_null NOT NULL,
    actor text CONSTRAINT committee_session_events_actor_not_null NOT NULL,
    reason text,
    job_id bigint,
    at timestamp with time zone DEFAULT now() CONSTRAINT committee_session_events_at_not_null NOT NULL
);


--
-- Name: committee_session_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.committee_session_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: committee_session_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.committee_session_events_id_seq OWNED BY public.swarm_session_events.id;


--
-- Name: daily_agent_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_agent_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id uuid NOT NULL,
    snapshot_date date DEFAULT CURRENT_DATE NOT NULL,
    x402_volume_usd numeric DEFAULT 0 NOT NULL,
    x402_txn_count integer DEFAULT 0 NOT NULL,
    productivity_score numeric DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_coin_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_coin_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    coin_id uuid NOT NULL,
    snapshot_date date DEFAULT CURRENT_DATE NOT NULL,
    price_usd numeric DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    market_cap numeric,
    volume_24h numeric
);


--
-- Name: daily_tvl_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_tvl_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vault_id uuid NOT NULL,
    snapshot_date date DEFAULT CURRENT_DATE NOT NULL,
    tvl_usd numeric DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_wallet_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_wallet_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wallet_id uuid NOT NULL,
    snapshot_date date DEFAULT CURRENT_DATE NOT NULL,
    total_balance_usd numeric DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deployment_identity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deployment_identity (
    id boolean DEFAULT true NOT NULL,
    kind text NOT NULL,
    written_at timestamp with time zone DEFAULT now() NOT NULL,
    written_by text DEFAULT CURRENT_USER NOT NULL,
    note text,
    CONSTRAINT deployment_identity_id_check CHECK (id),
    CONSTRAINT deployment_identity_kind_check CHECK ((kind = ANY (ARRAY['production'::text, 'rehearsal'::text])))
);


--
-- Name: job_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_runs (
    id bigint NOT NULL,
    job_id bigint,
    kind text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text NOT NULL,
    error text,
    output jsonb
);


--
-- Name: job_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.job_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: job_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.job_runs_id_seq OWNED BY public.job_runs.id;


--
-- Name: job_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_schedules (
    id integer NOT NULL,
    kind text NOT NULL,
    cron text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_enqueued_at timestamp with time zone,
    next_run_at timestamp with time zone,
    catchup_policy text DEFAULT 'all'::text NOT NULL,
    CONSTRAINT job_schedules_catchup_policy_check CHECK ((catchup_policy = ANY (ARRAY['all'::text, 'collapse-per-bucket'::text])))
);


--
-- Name: job_schedules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.job_schedules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: job_schedules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.job_schedules_id_seq OWNED BY public.job_schedules.id;


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id bigint NOT NULL,
    kind text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    last_error text,
    dedupe_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scope_type text,
    scope_id text,
    requested_by text,
    audit_request_id uuid,
    CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'dead'::text, 'cancelled'::text])))
);


--
-- Name: jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.jobs_id_seq OWNED BY public.jobs.id;


--
-- Name: lobster_coins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lobster_coins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    name text DEFAULT ''::text NOT NULL,
    ticker text,
    market_cap numeric,
    fdv numeric,
    percent_change_24h numeric,
    logo_url text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    coingecko_id text,
    contract_address text,
    chain text,
    price_usd numeric,
    volume_24h numeric,
    refreshed_at timestamp with time zone
);


--
-- Name: openclaw_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.openclaw_agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    name text DEFAULT ''::text NOT NULL,
    protocol_standard text,
    x402_score numeric,
    x402_txn_count integer,
    x402_resources_count integer,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    wallet_address text,
    virtuals_agent_id text,
    x402_volume_usd numeric,
    cumulative_revenue_usd numeric,
    productivity_score numeric,
    source_confidence text,
    enriched_at timestamp with time zone
);


--
-- Name: prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prices (
    id bigint NOT NULL,
    ts timestamp with time zone NOT NULL,
    symbol text NOT NULL,
    price_usd numeric,
    source text
);


--
-- Name: prices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prices_id_seq OWNED BY public.prices.id;


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    logo_url text,
    description text,
    overview_short text,
    overview_long text,
    website_url text,
    twitter_handle text,
    data_coverage_score smallint,
    has_agent boolean DEFAULT false NOT NULL,
    has_coin boolean DEFAULT false NOT NULL,
    has_wallet boolean DEFAULT false NOT NULL,
    has_vault boolean DEFAULT false NOT NULL,
    is_sticky boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    breadth_score smallint,
    identity_score smallint,
    onchain_score smallint,
    activity_score smallint,
    coverage_calculated_at timestamp with time zone,
    resolved_at timestamp with time zone
);


--
-- Name: raw_indicator_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.raw_indicator_history (
    date date NOT NULL,
    indicator text NOT NULL,
    value double precision NOT NULL,
    source text
);


--
-- Name: regime_indicators; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.regime_indicators (
    id bigint NOT NULL,
    indicator_key text NOT NULL,
    date date NOT NULL,
    value numeric,
    source text
);


--
-- Name: regime_indicators_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.regime_indicators_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: regime_indicators_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.regime_indicators_id_seq OWNED BY public.regime_indicators.id;


--
-- Name: regime_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.regime_snapshots (
    date date NOT NULL,
    composite numeric,
    composite_percentile numeric,
    regime text,
    macro_regime text,
    onchain_regime text,
    factor_regime text,
    percentiles jsonb,
    indicators jsonb,
    macro_index numeric,
    onchain_index numeric,
    factor_index numeric,
    macro_percentile numeric,
    onchain_percentile numeric,
    factor_percentile numeric,
    panel_weights jsonb,
    version text,
    backtest jsonb,
    correlations jsonb,
    panels jsonb,
    bucket_thresholds jsonb,
    extras jsonb,
    source text
);


--
-- Name: research_pipeline_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_pipeline_artifacts (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    stage text NOT NULL,
    kind text NOT NULL,
    checksum text,
    preview jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: research_pipeline_artifacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.research_pipeline_artifacts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: research_pipeline_artifacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.research_pipeline_artifacts_id_seq OWNED BY public.research_pipeline_artifacts.id;


--
-- Name: research_pipeline_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_pipeline_runs (
    id bigint NOT NULL,
    job_id bigint,
    kind text NOT NULL,
    asof date NOT NULL,
    source text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    checksum text,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT research_pipeline_runs_source_check CHECK (((source <> ''::text) AND (length(source) <= 32))),
    CONSTRAINT research_pipeline_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'degraded'::text, 'failed'::text])))
);


--
-- Name: research_pipeline_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.research_pipeline_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: research_pipeline_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.research_pipeline_runs_id_seq OWNED BY public.research_pipeline_runs.id;


--
-- Name: research_pipeline_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_pipeline_stages (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    stage text NOT NULL,
    sequence integer NOT NULL,
    status text NOT NULL,
    summary text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone NOT NULL,
    CONSTRAINT research_pipeline_stages_stage_check CHECK ((stage = ANY (ARRAY['access'::text, 'extract'::text, 'transform'::text, 'analyze'::text, 'store'::text, 'report'::text]))),
    CONSTRAINT research_pipeline_stages_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'warn'::text, 'error'::text])))
);


--
-- Name: research_pipeline_stages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.research_pipeline_stages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: research_pipeline_stages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.research_pipeline_stages_id_seq OWNED BY public.research_pipeline_stages.id;


--
-- Name: research_pipeline_warnings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_pipeline_warnings (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    stage text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: research_pipeline_warnings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.research_pipeline_warnings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: research_pipeline_warnings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.research_pipeline_warnings_id_seq OWNED BY public.research_pipeline_warnings.id;


--
-- Name: research_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_signals (
    id bigint NOT NULL,
    signal_key text NOT NULL,
    date date NOT NULL,
    payload jsonb
);


--
-- Name: research_signals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.research_signals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: research_signals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.research_signals_id_seq OWNED BY public.research_signals.id;


--
-- Name: schema_manifest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_manifest (
    singleton boolean DEFAULT true NOT NULL,
    format_version integer NOT NULL,
    declaration text NOT NULL,
    filenames text[] NOT NULL,
    content_hash text NOT NULL,
    CONSTRAINT schema_manifest_singleton_check CHECK (singleton)
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    compat text,
    metadata_version integer,
    CONSTRAINT schema_migrations_compat_check CHECK (((compat IS NULL) OR (compat = ANY (ARRAY['additive'::text, 'breaking'::text]))))
);


--
-- Name: source_acquisition_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_acquisition_events (
    id bigint NOT NULL,
    acquisition_id uuid NOT NULL,
    sequence integer NOT NULL,
    event_type text NOT NULL,
    detail text,
    knowledge_time timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT source_acquisition_events_event_type_check CHECK ((event_type = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text]))),
    CONSTRAINT source_acquisition_events_sequence_check CHECK ((sequence > 0))
);


--
-- Name: source_acquisition_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.source_acquisition_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.source_acquisition_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: source_acquisitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_acquisitions (
    id uuid NOT NULL,
    provider text NOT NULL,
    parser_version text NOT NULL,
    cache_identity text NOT NULL,
    requested_by_run_id bigint,
    knowledge_time timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT source_acquisitions_cache_identity_check CHECK (((cache_identity <> ''::text) AND (length(cache_identity) <= 256))),
    CONSTRAINT source_acquisitions_parser_version_check CHECK (((parser_version <> ''::text) AND (length(parser_version) <= 128))),
    CONSTRAINT source_acquisitions_provider_check CHECK (((provider <> ''::text) AND (length(provider) <= 64)))
);


--
-- Name: source_fetches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_fetches (
    id uuid NOT NULL,
    acquisition_id uuid NOT NULL,
    sequence integer NOT NULL,
    request_identity jsonb NOT NULL,
    cache_status text NOT NULL,
    response_status integer,
    response_checksum text,
    provider_release_id text,
    error_detail text,
    knowledge_time timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT source_fetches_cache_status_check CHECK ((cache_status = ANY (ARRAY['disabled'::text, 'hit'::text, 'miss'::text]))),
    CONSTRAINT source_fetches_response_status_check CHECK (((response_status >= 100) AND (response_status <= 599))),
    CONSTRAINT source_fetches_sequence_check CHECK ((sequence > 0))
);


--
-- Name: source_payloads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_payloads (
    checksum text NOT NULL,
    payload_bytes bytea NOT NULL,
    byte_length bigint GENERATED ALWAYS AS (octet_length(payload_bytes)) STORED,
    knowledge_time timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT source_payloads_check CHECK ((encode(public.digest(payload_bytes, 'sha256'::text), 'hex'::text) = checksum)),
    CONSTRAINT source_payloads_checksum_check CHECK ((checksum ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: source_value_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_value_versions (
    id bigint NOT NULL,
    acquisition_id uuid,
    source_key text NOT NULL,
    market_date date,
    market_instant timestamp with time zone,
    value double precision NOT NULL,
    prior_version_id bigint,
    revision_kind text NOT NULL,
    knowledge_time timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    provenance text,
    CONSTRAINT source_value_versions_check CHECK (((((market_date IS NOT NULL))::integer + ((market_instant IS NOT NULL))::integer) = 1)),
    CONSTRAINT source_value_versions_check1 CHECK (((revision_kind = 'legacy_baseline'::text) = (acquisition_id IS NULL))),
    CONSTRAINT source_value_versions_provenance_check CHECK (((provenance IS NULL) OR ((provenance <> ''::text) AND (length(provenance) <= 64)))),
    CONSTRAINT source_value_versions_revision_kind_check CHECK ((revision_kind = ANY (ARRAY['legacy_baseline'::text, 'initial'::text, 'unchanged'::text, 'revision'::text]))),
    CONSTRAINT source_value_versions_source_key_check CHECK (((source_key <> ''::text) AND (length(source_key) <= 128))),
    CONSTRAINT source_value_versions_value_check CHECK (((value <> 'Infinity'::double precision) AND (value <> '-Infinity'::double precision) AND (value <> 'NaN'::double precision)))
);


--
-- Name: source_value_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.source_value_versions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.source_value_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: swarm_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_applications (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT committee_applications_id_not_null NOT NULL,
    member_id text,
    payload jsonb CONSTRAINT committee_applications_payload_not_null NOT NULL,
    status text DEFAULT 'pending'::text CONSTRAINT committee_applications_status_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT committee_applications_created_at_not_null NOT NULL,
    reviewed_at timestamp with time zone,
    CONSTRAINT swarm_applications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: swarm_brief_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_brief_revisions (
    id bigint NOT NULL,
    session_id uuid NOT NULL,
    revision integer NOT NULL,
    body_bytes bytea NOT NULL,
    checksum text NOT NULL,
    report_snapshot_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT swarm_brief_revisions_check CHECK ((encode(public.digest(body_bytes, 'sha256'::text), 'hex'::text) = checksum)),
    CONSTRAINT swarm_brief_revisions_checksum_check CHECK ((checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT swarm_brief_revisions_revision_check CHECK ((revision > 0))
);


--
-- Name: swarm_brief_revisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.swarm_brief_revisions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.swarm_brief_revisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: swarm_briefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_briefs (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT committee_briefs_id_not_null NOT NULL,
    date date CONSTRAINT committee_briefs_date_not_null NOT NULL,
    subject_id text CONSTRAINT committee_briefs_subject_id_not_null NOT NULL,
    body jsonb,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT committee_briefs_created_at_not_null NOT NULL,
    session_id uuid,
    report_snapshot_id bigint
);


--
-- Name: swarm_claim_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_claim_challenges (
    member_id text CONSTRAINT committee_claim_challenges_member_id_not_null NOT NULL,
    challenge text CONSTRAINT committee_claim_challenges_challenge_not_null NOT NULL,
    issued_at timestamp with time zone DEFAULT now() CONSTRAINT committee_claim_challenges_issued_at_not_null NOT NULL,
    expires_at timestamp with time zone CONSTRAINT committee_claim_challenges_expires_at_not_null NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT swarm_claim_challenges_expiry_check CHECK ((expires_at > issued_at))
);


--
-- Name: swarm_consensus_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_consensus_receipts (
    session_id uuid NOT NULL,
    subject_id text NOT NULL,
    schema_version text NOT NULL,
    judgement_id bigint NOT NULL,
    session_version integer NOT NULL,
    receipt jsonb NOT NULL,
    canonical_bytes text NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT swarm_consensus_receipts_bytes_prefix_check CHECK ((canonical_bytes ~~ (('robotmoney:consensus-receipt:v1'::text || chr(10)) || '%'::text))),
    CONSTRAINT swarm_consensus_receipts_session_matches_check CHECK ((((receipt ->> 'session_id'::text) = (session_id)::text) AND ((receipt ->> 'subject_id'::text) = subject_id) AND ((receipt ->> 'schema_version'::text) = schema_version)))
);


--
-- Name: swarm_judge_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_judge_config (
    id smallint DEFAULT 1 NOT NULL,
    mode text DEFAULT 'off'::text NOT NULL,
    min_takes integer DEFAULT 3 NOT NULL,
    model text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    third_party_enabled boolean DEFAULT false NOT NULL,
    policy_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT swarm_judge_config_id_check CHECK ((id = 1)),
    CONSTRAINT swarm_judge_config_min_takes_check CHECK ((min_takes >= 1)),
    CONSTRAINT swarm_judge_config_mode_check CHECK ((mode = ANY (ARRAY['off'::text, 'shadow'::text, 'enforce'::text]))),
    CONSTRAINT swarm_judge_config_mode_requires_model_check CHECK (((mode = 'off'::text) OR ((model IS NOT NULL) AND (btrim(model) <> ''::text)))),
    CONSTRAINT swarm_judge_config_model_check CHECK (((model IS NULL) OR (btrim(model) <> ''::text)))
);


--
-- Name: swarm_judge_fault_injection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_judge_fault_injection (
    id smallint DEFAULT 1 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    remaining integer DEFAULT 0 NOT NULL,
    session_id uuid,
    note text,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT swarm_judge_fault_injection_body_check CHECK ((length(body) <= 20000)),
    CONSTRAINT swarm_judge_fault_injection_check CHECK (((NOT enabled) OR ((length(btrim(body)) > 0) AND (remaining > 0)))),
    CONSTRAINT swarm_judge_fault_injection_id_check CHECK ((id = 1)),
    CONSTRAINT swarm_judge_fault_injection_note_check CHECK (((note IS NULL) OR (length(note) <= 500))),
    CONSTRAINT swarm_judge_fault_injection_remaining_check CHECK (((remaining >= 0) AND (remaining <= 100)))
);


--
-- Name: swarm_member_avatars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_member_avatars (
    member_id text NOT NULL,
    content_type text NOT NULL,
    bytes bytea NOT NULL,
    byte_size integer NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: swarm_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_members (
    id text CONSTRAINT committee_members_id_not_null NOT NULL,
    status text DEFAULT 'inactive'::text CONSTRAINT committee_members_status_not_null NOT NULL,
    name text CONSTRAINT committee_members_name_not_null NOT NULL,
    tagline text,
    lens text,
    mandate text,
    biases jsonb,
    voice_md text,
    mode text,
    submit jsonb,
    operator text,
    avatar jsonb,
    contact_email text,
    key_hash text,
    public_key text,
    applied_at timestamp with time zone,
    activated_at timestamp with time zone,
    version integer DEFAULT 1 CONSTRAINT committee_members_version_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT committee_members_updated_at_not_null NOT NULL,
    handle text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    CONSTRAINT swarm_members_role_check CHECK ((role = ANY (ARRAY['member'::text, 'judge'::text]))),
    CONSTRAINT swarm_members_status_check CHECK ((status = ANY (ARRAY['applied'::text, 'active'::text, 'inactive'::text])))
);


--
-- Name: swarm_recommendations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_recommendations (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT committee_recommendations_id_not_null NOT NULL,
    session_id uuid CONSTRAINT committee_recommendations_session_id_not_null NOT NULL,
    member_id text CONSTRAINT committee_recommendations_member_id_not_null NOT NULL,
    subject_id text CONSTRAINT committee_recommendations_subject_id_not_null NOT NULL,
    date date CONSTRAINT committee_recommendations_date_not_null NOT NULL,
    nonce text CONSTRAINT committee_recommendations_nonce_not_null NOT NULL,
    stance text CONSTRAINT committee_recommendations_stance_not_null NOT NULL,
    confidence numeric,
    body text,
    memo_url text,
    payload jsonb CONSTRAINT committee_recommendations_payload_not_null NOT NULL,
    signature text CONSTRAINT committee_recommendations_signature_not_null NOT NULL,
    verified boolean DEFAULT false CONSTRAINT committee_recommendations_verified_not_null NOT NULL,
    received_at timestamp with time zone DEFAULT now() CONSTRAINT committee_recommendations_received_at_not_null NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    signing_key_id bigint,
    report_snapshot_id bigint,
    final boolean DEFAULT false NOT NULL,
    CONSTRAINT swarm_recommendations_revision_positive CHECK ((revision >= 1))
);


--
-- Name: swarm_session_judgements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_session_judgements (
    id bigint NOT NULL,
    session_id uuid NOT NULL,
    mode text NOT NULL,
    source text NOT NULL,
    fallback_reason text,
    model text,
    prompt_hash text NOT NULL,
    inputs_digest text NOT NULL,
    take_count integer NOT NULL,
    min_takes integer NOT NULL,
    opinion jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied boolean DEFAULT false NOT NULL,
    applied_skipped_reason text,
    dropped_positions integer DEFAULT 0 NOT NULL,
    dropped_disagreements integer DEFAULT 0 NOT NULL,
    judged_by text DEFAULT 'robotmoney-in-house'::text NOT NULL,
    judged_by_member_id text,
    digest_scheme text DEFAULT 'derivation-v1'::text NOT NULL,
    usage_input_tokens integer,
    usage_output_tokens integer,
    usage_total_tokens integer,
    usage_cost_usd numeric(18,8),
    CONSTRAINT swarm_session_judgements_applied_mode_check CHECK (((mode = 'enforce'::text) OR ((applied = false) AND (applied_skipped_reason IS NULL)))),
    CONSTRAINT swarm_session_judgements_applied_reason_check CHECK ((NOT (applied AND (applied_skipped_reason IS NOT NULL)))),
    CONSTRAINT swarm_session_judgements_drop_counts_check CHECK (((dropped_positions >= 0) AND (dropped_disagreements >= 0))),
    CONSTRAINT swarm_session_judgements_fallback_reason_check CHECK (((source = 'fallback'::text) = (fallback_reason IS NOT NULL))),
    CONSTRAINT swarm_session_judgements_judged_by_check CHECK ((((judged_by = 'robotmoney-in-house'::text) AND (judged_by_member_id IS NULL)) OR ((judged_by = judged_by_member_id) AND (judged_by_member_id IS NOT NULL)))),
    CONSTRAINT swarm_session_judgements_min_takes_check CHECK ((min_takes >= 1)),
    CONSTRAINT swarm_session_judgements_mode_check CHECK ((mode = ANY (ARRAY['shadow'::text, 'enforce'::text]))),
    CONSTRAINT swarm_session_judgements_no_weights_check CHECK ((NOT jsonb_path_exists(opinion, '$.**?(@.type() == "object").keyvalue()?((((((((((((@."key" == "weight" || @."key" == "weights") || @."key" == "bucket_weight") || @."key" == "bucket_weights") || @."key" == "bucketweights") || @."key" == "allocation") || @."key" == "allocations") || @."key" == "target_weight") || @."key" == "target_weights") || @."key" == "vector") || @."key" == "weighting") || @."key" == "weightings") || @."key" == "portfolio")'::jsonpath))),
    CONSTRAINT swarm_session_judgements_source_check CHECK ((source = ANY (ARRAY['model'::text, 'fallback'::text]))),
    CONSTRAINT swarm_session_judgements_take_count_check CHECK ((take_count >= 0)),
    CONSTRAINT swarm_session_judgements_usage_cost_usd_check CHECK (((usage_cost_usd IS NULL) OR (usage_cost_usd >= (0)::numeric))),
    CONSTRAINT swarm_session_judgements_usage_input_tokens_check CHECK (((usage_input_tokens IS NULL) OR (usage_input_tokens >= 0))),
    CONSTRAINT swarm_session_judgements_usage_output_tokens_check CHECK (((usage_output_tokens IS NULL) OR (usage_output_tokens >= 0))),
    CONSTRAINT swarm_session_judgements_usage_total_tokens_check CHECK (((usage_total_tokens IS NULL) OR (usage_total_tokens >= 0)))
);


--
-- Name: swarm_session_judgements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.swarm_session_judgements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: swarm_session_judgements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.swarm_session_judgements_id_seq OWNED BY public.swarm_session_judgements.id;


--
-- Name: swarm_session_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_session_members (
    session_id uuid CONSTRAINT committee_session_members_session_id_not_null NOT NULL,
    member_id text CONSTRAINT committee_session_members_member_id_not_null NOT NULL,
    member_name text CONSTRAINT committee_session_members_member_name_not_null NOT NULL,
    member_lens text,
    status text DEFAULT 'expected'::text CONSTRAINT committee_session_members_status_not_null NOT NULL,
    included_at timestamp with time zone DEFAULT now() CONSTRAINT committee_session_members_included_at_not_null NOT NULL,
    excused_at timestamp with time zone,
    reason text,
    CONSTRAINT swarm_session_members_status_check CHECK ((status = ANY (ARRAY['expected'::text, 'excused'::text])))
);


--
-- Name: swarm_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_sessions (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT committee_sessions_id_not_null NOT NULL,
    subject_id text CONSTRAINT committee_sessions_subject_id_not_null NOT NULL,
    subject_name text,
    regime_summary jsonb,
    subject_snapshot_total_value_usd numeric,
    synthesis text,
    swarm_recommendation jsonb,
    social_draft_id text,
    generated_at timestamp with time zone DEFAULT now() CONSTRAINT committee_sessions_generated_at_not_null NOT NULL,
    state text DEFAULT 'scheduled'::text CONSTRAINT committee_sessions_state_not_null NOT NULL,
    window_closes_at timestamp with time zone,
    published_at timestamp with time zone,
    version integer DEFAULT 1 CONSTRAINT committee_sessions_version_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT committee_sessions_updated_at_not_null NOT NULL,
    brief_opens_at timestamp with time zone,
    publish_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    convened_at timestamp with time zone DEFAULT now() CONSTRAINT committee_sessions_convened_at_not_null NOT NULL,
    date date GENERATED ALWAYS AS (((convened_at AT TIME ZONE 'UTC'::text))::date) STORED,
    judge_mode text,
    judging_requested_at timestamp with time zone,
    judging_deadline_at timestamp with time zone,
    consensus_recorded_at timestamp with time zone,
    judging_outcome text,
    successor_session_id uuid,
    judging_duration_seconds integer,
    CONSTRAINT swarm_sessions_judge_mode_check CHECK (((judge_mode IS NULL) OR (judge_mode = ANY (ARRAY['off'::text, 'enforce'::text])))),
    CONSTRAINT swarm_sessions_judging_duration_seconds_check CHECK (((judging_duration_seconds IS NULL) OR (judging_duration_seconds > 0))),
    CONSTRAINT swarm_sessions_judging_outcome_check CHECK (((judging_outcome IS NULL) OR (judging_outcome = ANY (ARRAY['judged'::text, 'no_consensus'::text, 'not_judged'::text])))),
    CONSTRAINT swarm_sessions_judging_request_pair_check CHECK (((judging_requested_at IS NULL) = (judging_deadline_at IS NULL))),
    CONSTRAINT swarm_sessions_state_check CHECK ((state = ANY (ARRAY['collecting'::text, 'window_closed'::text, 'aggregated'::text, 'judging'::text, 'judged'::text, 'published'::text, 'scheduled'::text, 'cancelled'::text]))),
    CONSTRAINT swarm_sessions_successor_not_self_check CHECK (((successor_session_id IS NULL) OR (successor_session_id <> id)))
);


--
-- Name: swarm_stream_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_stream_events (
    seq bigint NOT NULL,
    kind text NOT NULL,
    subject_id text,
    session_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    committed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT swarm_stream_events_kind_check CHECK ((kind = ANY (ARRAY['subject.changed'::text, 'epoch.turned_over'::text, 'session.judged'::text]))),
    CONSTRAINT swarm_stream_events_seq_positive_check CHECK ((seq > 0))
);


--
-- Name: swarm_subject_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_subject_snapshots (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT committee_subject_snapshots_id_not_null NOT NULL,
    subject_id text CONSTRAINT committee_subject_snapshots_subject_id_not_null NOT NULL,
    date date CONSTRAINT committee_subject_snapshots_date_not_null NOT NULL,
    total_value_usd numeric,
    positions jsonb,
    wallets jsonb,
    notable jsonb
);


--
-- Name: swarm_subjects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_subjects (
    id text CONSTRAINT committee_subjects_id_not_null NOT NULL,
    status text DEFAULT 'active'::text CONSTRAINT committee_subjects_status_not_null NOT NULL,
    name text CONSTRAINT committee_subjects_name_not_null NOT NULL,
    operator text,
    homepage text,
    x_handle text,
    thesis_blurb text,
    wallets jsonb,
    nft_contracts jsonb,
    source jsonb,
    recommendation_type text,
    linked_member_id text,
    structural_notes jsonb,
    last_reviewed date,
    version integer DEFAULT 1 CONSTRAINT committee_subjects_version_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT committee_subjects_updated_at_not_null NOT NULL,
    epoch_duration_seconds integer DEFAULT 3600 NOT NULL,
    epoch_anchor timestamp with time zone DEFAULT '1970-01-01 00:00:00+00'::timestamp with time zone NOT NULL,
    judging_duration_seconds integer DEFAULT 900 NOT NULL,
    CONSTRAINT swarm_subjects_epoch_duration_seconds_check CHECK ((epoch_duration_seconds > 0)),
    CONSTRAINT swarm_subjects_judging_duration_seconds_check CHECK ((judging_duration_seconds > 0)),
    CONSTRAINT swarm_subjects_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))
);


--
-- Name: swarm_waitlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swarm_waitlist (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT committee_waitlist_id_not_null NOT NULL,
    email text CONSTRAINT committee_waitlist_email_not_null NOT NULL,
    email_norm text CONSTRAINT committee_waitlist_email_norm_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT committee_waitlist_created_at_not_null NOT NULL,
    source text
);


--
-- Name: tracked_wallets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tracked_wallets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    label text DEFAULT ''::text NOT NULL,
    chain text,
    balance_usd numeric,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    address text,
    last_tx_at timestamp with time zone,
    refreshed_at timestamp with time zone,
    category text
);


--
-- Name: vault_adapter_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_adapter_samples (
    id bigint NOT NULL,
    vault_address text NOT NULL,
    adapter_address text NOT NULL,
    adapter_name text NOT NULL,
    sample_hour timestamp with time zone NOT NULL,
    balance_usd numeric,
    configured boolean DEFAULT true NOT NULL,
    provenance text DEFAULT 'live'::text NOT NULL,
    sampled_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vault_adapter_samples_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vault_adapter_samples_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vault_adapter_samples_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vault_adapter_samples_id_seq OWNED BY public.vault_adapter_samples.id;


--
-- Name: vault_apy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_apy (
    date date NOT NULL,
    apy_7d numeric,
    apy_30d numeric,
    share_price numeric,
    computed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vault_share_price_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_share_price_history (
    id bigint NOT NULL,
    vault_address text NOT NULL,
    sample_hour timestamp with time zone NOT NULL,
    sampled_at timestamp with time zone DEFAULT now() NOT NULL,
    total_assets numeric NOT NULL,
    total_supply numeric NOT NULL,
    share_price numeric
);


--
-- Name: vault_share_price_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vault_share_price_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vault_share_price_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vault_share_price_history_id_seq OWNED BY public.vault_share_price_history.id;


--
-- Name: vault_tvl; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_tvl (
    id bigint NOT NULL,
    ts timestamp with time zone NOT NULL,
    vault_address text NOT NULL,
    asset_symbol text NOT NULL,
    asset_name text,
    balance numeric,
    price_usd numeric,
    value_usd numeric,
    total_vault_value numeric,
    total_shares numeric,
    share_price numeric
);


--
-- Name: vault_tvl_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vault_tvl_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vault_tvl_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vault_tvl_id_seq OWNED BY public.vault_tvl.id;


--
-- Name: wallet_aum_snapshot_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_aum_snapshot_runs (
    run_id bigint NOT NULL,
    sample_date date NOT NULL,
    time_basis text NOT NULL,
    state text NOT NULL,
    manifest_version text NOT NULL,
    manifest_json jsonb NOT NULL,
    manifest_hash text NOT NULL,
    config_identity text NOT NULL,
    snapshot_id text,
    expected_balance_keys text[] DEFAULT '{}'::text[] NOT NULL,
    present_balance_keys text[] DEFAULT '{}'::text[] NOT NULL,
    missing_balance_keys text[] DEFAULT '{}'::text[] NOT NULL,
    unexpected_balance_keys text[] DEFAULT '{}'::text[] NOT NULL,
    expected_sleeve_keys text[] DEFAULT '{}'::text[] NOT NULL,
    present_sleeve_keys text[] DEFAULT '{}'::text[] NOT NULL,
    missing_sleeve_keys text[] DEFAULT '{}'::text[] NOT NULL,
    unexpected_sleeve_keys text[] DEFAULT '{}'::text[] NOT NULL,
    observed_at timestamp with time zone,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    chain_id bigint,
    block_number bigint,
    block_hash text,
    block_timestamp timestamp with time zone,
    boundary_next_block_number bigint,
    boundary_next_block_hash text,
    boundary_next_block_timestamp timestamp with time zone,
    source_evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    price_evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    producer_revision_status text NOT NULL,
    producer_revision text,
    producer_revision_unavailable_reason text,
    failure_code text,
    failure_detail text,
    CONSTRAINT wallet_aum_snapshot_runs_check CHECK ((((producer_revision_status = 'available'::text) AND (producer_revision IS NOT NULL) AND (btrim(producer_revision) <> ''::text) AND (producer_revision_unavailable_reason IS NULL)) OR ((producer_revision_status = 'unavailable'::text) AND (producer_revision IS NULL) AND (producer_revision_unavailable_reason IS NOT NULL) AND (btrim(producer_revision_unavailable_reason) <> ''::text)))),
    CONSTRAINT wallet_aum_snapshot_runs_check1 CHECK ((((state = ANY (ARRAY['complete'::text, 'degraded'::text])) AND (snapshot_id IS NOT NULL) AND (observed_at IS NOT NULL) AND (published_at IS NOT NULL) AND (producer_revision_status = 'available'::text) AND (chain_id IS NOT NULL) AND (block_number IS NOT NULL) AND (block_hash IS NOT NULL) AND (block_timestamp IS NOT NULL) AND (cardinality(expected_balance_keys) > 0) AND (cardinality(missing_balance_keys) = 0) AND (cardinality(unexpected_balance_keys) = 0) AND (cardinality(missing_sleeve_keys) = 0) AND (cardinality(unexpected_sleeve_keys) = 0) AND (expected_balance_keys = present_balance_keys) AND (expected_sleeve_keys = present_sleeve_keys)) OR ((state = ANY (ARRAY['unavailable'::text, 'failed-retryable'::text])) AND (snapshot_id IS NULL) AND (published_at IS NULL)))),
    CONSTRAINT wallet_aum_snapshot_runs_check2 CHECK ((((block_number IS NULL) AND (block_hash IS NULL) AND (block_timestamp IS NULL)) OR ((block_number IS NOT NULL) AND (block_hash IS NOT NULL) AND (block_number >= 0) AND (block_hash ~ '^0x[0-9a-f]{64}$'::text) AND (block_timestamp IS NOT NULL)))),
    CONSTRAINT wallet_aum_snapshot_runs_check3 CHECK ((((boundary_next_block_number IS NULL) AND (boundary_next_block_hash IS NULL) AND (boundary_next_block_timestamp IS NULL)) OR ((boundary_next_block_number IS NOT NULL) AND (boundary_next_block_hash IS NOT NULL) AND (boundary_next_block_hash ~ '^0x[0-9a-f]{64}$'::text) AND (boundary_next_block_timestamp IS NOT NULL) AND (block_number IS NOT NULL) AND (boundary_next_block_number = (block_number + 1)) AND (block_timestamp < boundary_next_block_timestamp)))),
    CONSTRAINT wallet_aum_snapshot_runs_check4 CHECK (((time_basis <> 'utc-daily-close'::text) OR (state <> ALL (ARRAY['complete'::text, 'degraded'::text])) OR ((boundary_next_block_number IS NOT NULL) AND (block_timestamp < (((sample_date + 1))::timestamp without time zone AT TIME ZONE 'UTC'::text)) AND (boundary_next_block_timestamp >= (((sample_date + 1))::timestamp without time zone AT TIME ZONE 'UTC'::text))))),
    CONSTRAINT wallet_aum_snapshot_runs_config_identity_check CHECK ((btrim(config_identity) <> ''::text)),
    CONSTRAINT wallet_aum_snapshot_runs_expected_balance_keys_check CHECK (public.rm_text_array_is_canonical_set(expected_balance_keys)),
    CONSTRAINT wallet_aum_snapshot_runs_expected_sleeve_keys_check CHECK (public.rm_text_array_is_canonical_set(expected_sleeve_keys)),
    CONSTRAINT wallet_aum_snapshot_runs_manifest_hash_check CHECK ((manifest_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT wallet_aum_snapshot_runs_manifest_json_check CHECK ((jsonb_typeof(manifest_json) = 'object'::text)),
    CONSTRAINT wallet_aum_snapshot_runs_manifest_version_check CHECK ((btrim(manifest_version) <> ''::text)),
    CONSTRAINT wallet_aum_snapshot_runs_missing_balance_keys_check CHECK (public.rm_text_array_is_canonical_set(missing_balance_keys)),
    CONSTRAINT wallet_aum_snapshot_runs_missing_sleeve_keys_check CHECK (public.rm_text_array_is_canonical_set(missing_sleeve_keys)),
    CONSTRAINT wallet_aum_snapshot_runs_present_balance_keys_check CHECK (public.rm_text_array_is_canonical_set(present_balance_keys)),
    CONSTRAINT wallet_aum_snapshot_runs_present_sleeve_keys_check CHECK (public.rm_text_array_is_canonical_set(present_sleeve_keys)),
    CONSTRAINT wallet_aum_snapshot_runs_price_evidence_check CHECK ((jsonb_typeof(price_evidence) = 'object'::text)),
    CONSTRAINT wallet_aum_snapshot_runs_producer_revision_status_check CHECK ((producer_revision_status = ANY (ARRAY['available'::text, 'unavailable'::text]))),
    CONSTRAINT wallet_aum_snapshot_runs_snapshot_id_check CHECK (((snapshot_id IS NULL) OR (snapshot_id ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT wallet_aum_snapshot_runs_source_evidence_check CHECK ((jsonb_typeof(source_evidence) = 'object'::text)),
    CONSTRAINT wallet_aum_snapshot_runs_state_check CHECK ((state = ANY (ARRAY['complete'::text, 'degraded'::text, 'unavailable'::text, 'failed-retryable'::text]))),
    CONSTRAINT wallet_aum_snapshot_runs_time_basis_check CHECK ((time_basis = ANY (ARRAY['live'::text, 'utc-daily-close'::text]))),
    CONSTRAINT wallet_aum_snapshot_runs_unexpected_balance_keys_check CHECK (public.rm_text_array_is_canonical_set(unexpected_balance_keys)),
    CONSTRAINT wallet_aum_snapshot_runs_unexpected_sleeve_keys_check CHECK (public.rm_text_array_is_canonical_set(unexpected_sleeve_keys))
);


--
-- Name: wallet_aum_snapshot_runs_run_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wallet_aum_snapshot_runs_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wallet_aum_snapshot_runs_run_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wallet_aum_snapshot_runs_run_id_seq OWNED BY public.wallet_aum_snapshot_runs.run_id;


--
-- Name: wallet_backfill_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_backfill_state (
    sample_date date NOT NULL,
    status text NOT NULL,
    block_number bigint,
    balance_rows integer DEFAULT 0 NOT NULL,
    sleeve_rows integer DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    detail text,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL,
    defer_leg text,
    defer_streak integer DEFAULT 0 NOT NULL,
    defer_leg_at timestamp with time zone,
    CONSTRAINT wallet_backfill_state_status_check CHECK ((status = ANY (ARRAY['filled'::text, 'skipped'::text, 'failed'::text, 'exhausted'::text, 'blocked'::text])))
);


--
-- Name: wallet_balance_sample_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_balance_sample_evidence (
    evidence_id bigint NOT NULL,
    original_id bigint NOT NULL,
    sample_date date NOT NULL,
    symbol text NOT NULL,
    amount numeric,
    price_usd numeric,
    value_usd numeric NOT NULL,
    provenance text NOT NULL,
    sampled_at timestamp with time zone NOT NULL,
    strategy_nav_idle_only boolean,
    evidence_reason text NOT NULL,
    replacement_block_number bigint,
    archived_at timestamp with time zone DEFAULT now() NOT NULL,
    snapshot_run_id bigint,
    amount_observed_at timestamp with time zone,
    price_observed_at timestamp with time zone,
    recorded_at timestamp with time zone,
    CONSTRAINT wallet_balance_sample_evidence_snapshot_identity_shape CHECK ((((snapshot_run_id IS NULL) AND (amount_observed_at IS NULL) AND (price_observed_at IS NULL) AND (recorded_at IS NULL)) OR ((snapshot_run_id IS NOT NULL) AND (amount_observed_at IS NOT NULL) AND (price_observed_at IS NOT NULL) AND (recorded_at IS NOT NULL) AND (recorded_at >= amount_observed_at) AND (recorded_at >= price_observed_at))))
);


--
-- Name: wallet_balance_sample_evidence_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wallet_balance_sample_evidence_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wallet_balance_sample_evidence_evidence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wallet_balance_sample_evidence_evidence_id_seq OWNED BY public.wallet_balance_sample_evidence.evidence_id;


--
-- Name: wallet_balance_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_balance_samples (
    id bigint NOT NULL,
    sample_date date NOT NULL,
    symbol text NOT NULL,
    amount numeric,
    price_usd numeric,
    value_usd numeric NOT NULL,
    provenance text DEFAULT 'live'::text NOT NULL,
    sampled_at timestamp with time zone DEFAULT now() NOT NULL,
    strategy_nav_idle_only boolean,
    snapshot_run_id bigint,
    amount_observed_at timestamp with time zone,
    price_observed_at timestamp with time zone,
    recorded_at timestamp with time zone,
    CONSTRAINT wallet_balance_samples_snapshot_identity_shape CHECK ((((snapshot_run_id IS NULL) AND (amount_observed_at IS NULL) AND (price_observed_at IS NULL) AND (recorded_at IS NULL)) OR ((snapshot_run_id IS NOT NULL) AND (amount_observed_at IS NOT NULL) AND (price_observed_at IS NOT NULL) AND (recorded_at IS NOT NULL) AND (recorded_at >= amount_observed_at) AND (recorded_at >= price_observed_at))))
);


--
-- Name: wallet_balance_samples_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wallet_balance_samples_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wallet_balance_samples_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wallet_balance_samples_id_seq OWNED BY public.wallet_balance_samples.id;


--
-- Name: wallet_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_balances (
    id bigint NOT NULL,
    ts timestamp with time zone NOT NULL,
    wallet_address text NOT NULL,
    chain text NOT NULL,
    asset_symbol text NOT NULL,
    asset_name text,
    balance numeric,
    price_usd numeric,
    value_usd numeric
);


--
-- Name: wallet_balances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wallet_balances_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wallet_balances_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wallet_balances_id_seq OWNED BY public.wallet_balances.id;


--
-- Name: wallet_sleeve_sample_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_sleeve_sample_evidence (
    evidence_id bigint NOT NULL,
    original_id bigint NOT NULL,
    sample_date date NOT NULL,
    wallet_address text NOT NULL,
    symbol text NOT NULL,
    amount numeric,
    price_usd numeric,
    value_usd numeric,
    provenance text NOT NULL,
    sampled_at timestamp with time zone NOT NULL,
    evidence_reason text NOT NULL,
    replacement_block_number bigint,
    archived_at timestamp with time zone DEFAULT now() NOT NULL,
    snapshot_run_id bigint,
    amount_observed_at timestamp with time zone,
    price_observed_at timestamp with time zone,
    recorded_at timestamp with time zone,
    CONSTRAINT wallet_sleeve_sample_evidence_snapshot_identity_shape CHECK ((((snapshot_run_id IS NULL) AND (amount_observed_at IS NULL) AND (price_observed_at IS NULL) AND (recorded_at IS NULL)) OR ((snapshot_run_id IS NOT NULL) AND (amount_observed_at IS NOT NULL) AND (price_observed_at IS NOT NULL) AND (recorded_at IS NOT NULL) AND (recorded_at >= amount_observed_at) AND (recorded_at >= price_observed_at))))
);


--
-- Name: wallet_sleeve_sample_evidence_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wallet_sleeve_sample_evidence_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wallet_sleeve_sample_evidence_evidence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wallet_sleeve_sample_evidence_evidence_id_seq OWNED BY public.wallet_sleeve_sample_evidence.evidence_id;


--
-- Name: wallet_sleeve_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_sleeve_samples (
    id bigint NOT NULL,
    sample_date date NOT NULL,
    wallet_address text NOT NULL,
    symbol text NOT NULL,
    amount numeric,
    price_usd numeric,
    value_usd numeric,
    provenance text DEFAULT 'live'::text NOT NULL,
    sampled_at timestamp with time zone DEFAULT now() NOT NULL,
    snapshot_run_id bigint,
    amount_observed_at timestamp with time zone,
    price_observed_at timestamp with time zone,
    recorded_at timestamp with time zone,
    CONSTRAINT wallet_sleeve_samples_snapshot_identity_shape CHECK ((((snapshot_run_id IS NULL) AND (amount_observed_at IS NULL) AND (price_observed_at IS NULL) AND (recorded_at IS NULL)) OR ((snapshot_run_id IS NOT NULL) AND (amount_observed_at IS NOT NULL) AND (price_observed_at IS NOT NULL) AND (recorded_at IS NOT NULL) AND (recorded_at >= amount_observed_at) AND (recorded_at >= price_observed_at))))
);


--
-- Name: wallet_sleeve_samples_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wallet_sleeve_samples_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wallet_sleeve_samples_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wallet_sleeve_samples_id_seq OWNED BY public.wallet_sleeve_samples.id;


--
-- Name: analytics_artifacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_artifacts ALTER COLUMN id SET DEFAULT nextval('public.analytics_artifacts_id_seq'::regclass);


--
-- Name: analytics_stage_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_stage_runs ALTER COLUMN id SET DEFAULT nextval('public.analytics_stage_runs_id_seq'::regclass);


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: buyback_swaps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buyback_swaps ALTER COLUMN id SET DEFAULT nextval('public.buyback_swaps_id_seq'::regclass);


--
-- Name: job_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runs ALTER COLUMN id SET DEFAULT nextval('public.job_runs_id_seq'::regclass);


--
-- Name: job_schedules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_schedules ALTER COLUMN id SET DEFAULT nextval('public.job_schedules_id_seq'::regclass);


--
-- Name: jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs ALTER COLUMN id SET DEFAULT nextval('public.jobs_id_seq'::regclass);


--
-- Name: prices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prices ALTER COLUMN id SET DEFAULT nextval('public.prices_id_seq'::regclass);


--
-- Name: regime_indicators id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regime_indicators ALTER COLUMN id SET DEFAULT nextval('public.regime_indicators_id_seq'::regclass);


--
-- Name: research_pipeline_artifacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_artifacts ALTER COLUMN id SET DEFAULT nextval('public.research_pipeline_artifacts_id_seq'::regclass);


--
-- Name: research_pipeline_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_runs ALTER COLUMN id SET DEFAULT nextval('public.research_pipeline_runs_id_seq'::regclass);


--
-- Name: research_pipeline_stages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_stages ALTER COLUMN id SET DEFAULT nextval('public.research_pipeline_stages_id_seq'::regclass);


--
-- Name: research_pipeline_warnings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_warnings ALTER COLUMN id SET DEFAULT nextval('public.research_pipeline_warnings_id_seq'::regclass);


--
-- Name: research_signals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_signals ALTER COLUMN id SET DEFAULT nextval('public.research_signals_id_seq'::regclass);


--
-- Name: swarm_agent_health_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_agent_health_events ALTER COLUMN id SET DEFAULT nextval('public.committee_agent_health_events_id_seq'::regclass);


--
-- Name: swarm_member_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_member_keys ALTER COLUMN id SET DEFAULT nextval('public.committee_member_keys_id_seq'::regclass);


--
-- Name: swarm_memos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_memos ALTER COLUMN id SET DEFAULT nextval('public.committee_memos_id_seq'::regclass);


--
-- Name: swarm_session_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_session_events ALTER COLUMN id SET DEFAULT nextval('public.committee_session_events_id_seq'::regclass);


--
-- Name: swarm_session_judgements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_session_judgements ALTER COLUMN id SET DEFAULT nextval('public.swarm_session_judgements_id_seq'::regclass);


--
-- Name: vault_adapter_samples id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_adapter_samples ALTER COLUMN id SET DEFAULT nextval('public.vault_adapter_samples_id_seq'::regclass);


--
-- Name: vault_share_price_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_price_history ALTER COLUMN id SET DEFAULT nextval('public.vault_share_price_history_id_seq'::regclass);


--
-- Name: vault_tvl id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_tvl ALTER COLUMN id SET DEFAULT nextval('public.vault_tvl_id_seq'::regclass);


--
-- Name: wallet_aum_snapshot_runs run_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_aum_snapshot_runs ALTER COLUMN run_id SET DEFAULT nextval('public.wallet_aum_snapshot_runs_run_id_seq'::regclass);


--
-- Name: wallet_balance_sample_evidence evidence_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_balance_sample_evidence ALTER COLUMN evidence_id SET DEFAULT nextval('public.wallet_balance_sample_evidence_evidence_id_seq'::regclass);


--
-- Name: wallet_balance_samples id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_balance_samples ALTER COLUMN id SET DEFAULT nextval('public.wallet_balance_samples_id_seq'::regclass);


--
-- Name: wallet_balances id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_balances ALTER COLUMN id SET DEFAULT nextval('public.wallet_balances_id_seq'::regclass);


--
-- Name: wallet_sleeve_sample_evidence evidence_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_sleeve_sample_evidence ALTER COLUMN evidence_id SET DEFAULT nextval('public.wallet_sleeve_sample_evidence_evidence_id_seq'::regclass);


--
-- Name: wallet_sleeve_samples id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_sleeve_samples ALTER COLUMN id SET DEFAULT nextval('public.wallet_sleeve_samples_id_seq'::regclass);


--
-- Name: admin_credential admin_credential_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_credential
    ADD CONSTRAINT admin_credential_pkey PRIMARY KEY (id);


--
-- Name: admin_passkey admin_passkey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_passkey
    ADD CONSTRAINT admin_passkey_pkey PRIMARY KEY (id);


--
-- Name: admin_session admin_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_session
    ADD CONSTRAINT admin_session_pkey PRIMARY KEY (token);


--
-- Name: admin_webauthn_challenge admin_webauthn_challenge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_webauthn_challenge
    ADD CONSTRAINT admin_webauthn_challenge_pkey PRIMARY KEY (challenge);


--
-- Name: agent_activity_log agent_activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_activity_log
    ADD CONSTRAINT agent_activity_log_pkey PRIMARY KEY (id);


--
-- Name: agent_revenue_daily agent_revenue_daily_agent_id_revenue_date_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_revenue_daily
    ADD CONSTRAINT agent_revenue_daily_agent_id_revenue_date_source_key UNIQUE (agent_id, revenue_date, source);


--
-- Name: agent_revenue_daily agent_revenue_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_revenue_daily
    ADD CONSTRAINT agent_revenue_daily_pkey PRIMARY KEY (id);


--
-- Name: agent_vaults agent_vaults_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_vaults
    ADD CONSTRAINT agent_vaults_pkey PRIMARY KEY (id);


--
-- Name: allocation_framework allocation_framework_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allocation_framework
    ADD CONSTRAINT allocation_framework_pkey PRIMARY KEY (id);


--
-- Name: analytics_artifacts analytics_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_artifacts
    ADD CONSTRAINT analytics_artifacts_pkey PRIMARY KEY (id);


--
-- Name: analytics_data_vintages analytics_data_vintages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_data_vintages
    ADD CONSTRAINT analytics_data_vintages_pkey PRIMARY KEY (id);


--
-- Name: analytics_data_vintages analytics_data_vintages_run_id_tool_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_data_vintages
    ADD CONSTRAINT analytics_data_vintages_run_id_tool_id_key UNIQUE (run_id, tool_id);


--
-- Name: analytics_ledger_methodology_versions analytics_ledger_methodology_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_ledger_methodology_versions
    ADD CONSTRAINT analytics_ledger_methodology_versions_pkey PRIMARY KEY (id);


--
-- Name: analytics_ledger_methodology_versions analytics_ledger_methodology_versions_tool_id_config_digest_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_ledger_methodology_versions
    ADD CONSTRAINT analytics_ledger_methodology_versions_tool_id_config_digest_key UNIQUE (tool_id, config_digest);


--
-- Name: analytics_ledger_run_events analytics_ledger_run_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_ledger_run_events
    ADD CONSTRAINT analytics_ledger_run_events_pkey PRIMARY KEY (id);


--
-- Name: analytics_ledger_run_events analytics_ledger_run_events_run_id_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_ledger_run_events
    ADD CONSTRAINT analytics_ledger_run_events_run_id_sequence_key UNIQUE (run_id, sequence);


--
-- Name: analytics_ledger_runs analytics_ledger_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_ledger_runs
    ADD CONSTRAINT analytics_ledger_runs_pkey PRIMARY KEY (id);


--
-- Name: analytics_ledger_runs analytics_ledger_runs_run_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_ledger_runs
    ADD CONSTRAINT analytics_ledger_runs_run_key_key UNIQUE (run_key);


--
-- Name: analytics_output_snapshots analytics_output_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_output_snapshots
    ADD CONSTRAINT analytics_output_snapshots_pkey PRIMARY KEY (id);


--
-- Name: analytics_output_snapshots analytics_output_snapshots_run_id_artifact_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_output_snapshots
    ADD CONSTRAINT analytics_output_snapshots_run_id_artifact_kind_key UNIQUE (run_id, artifact_kind);


--
-- Name: analytics_overwrite_events analytics_overwrite_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_overwrite_events
    ADD CONSTRAINT analytics_overwrite_events_pkey PRIMARY KEY (id);


--
-- Name: analytics_parity_observations analytics_parity_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_parity_observations
    ADD CONSTRAINT analytics_parity_observations_pkey PRIMARY KEY (id);


--
-- Name: analytics_read_mode analytics_read_mode_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_read_mode
    ADD CONSTRAINT analytics_read_mode_pkey PRIMARY KEY (id);


--
-- Name: analytics_report_snapshots analytics_report_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_report_snapshots
    ADD CONSTRAINT analytics_report_snapshots_pkey PRIMARY KEY (id);


--
-- Name: analytics_report_snapshots analytics_report_snapshots_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_report_snapshots
    ADD CONSTRAINT analytics_report_snapshots_run_id_key UNIQUE (run_id);


--
-- Name: analytics_runs analytics_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_runs
    ADD CONSTRAINT analytics_runs_pkey PRIMARY KEY (id);


--
-- Name: analytics_stage_runs analytics_stage_runs_analytics_run_id_tool_id_stage_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_stage_runs
    ADD CONSTRAINT analytics_stage_runs_analytics_run_id_tool_id_stage_key UNIQUE (analytics_run_id, tool_id, stage);


--
-- Name: analytics_stage_runs analytics_stage_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_stage_runs
    ADD CONSTRAINT analytics_stage_runs_pkey PRIMARY KEY (id);


--
-- Name: analytics_submissions analytics_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_submissions
    ADD CONSTRAINT analytics_submissions_pkey PRIMARY KEY (id);


--
-- Name: analytics_vintage_members analytics_vintage_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_vintage_members
    ADD CONSTRAINT analytics_vintage_members_pkey PRIMARY KEY (id);


--
-- Name: analytics_vintage_members analytics_vintage_members_vintage_id_source_value_version_i_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_vintage_members
    ADD CONSTRAINT analytics_vintage_members_vintage_id_source_value_version_i_key UNIQUE (vintage_id, source_value_version_id);


--
-- Name: asset_price_floors asset_price_floors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_price_floors
    ADD CONSTRAINT asset_price_floors_pkey PRIMARY KEY (symbol);


--
-- Name: asset_prices asset_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_prices
    ADD CONSTRAINT asset_prices_pkey PRIMARY KEY (price_date, symbol, time_basis);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: automation_tokens automation_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_tokens
    ADD CONSTRAINT automation_tokens_pkey PRIMARY KEY (instance, holder);


--
-- Name: automation_tokens automation_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_tokens
    ADD CONSTRAINT automation_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: buyback_scan_state buyback_scan_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buyback_scan_state
    ADD CONSTRAINT buyback_scan_state_pkey PRIMARY KEY (id);


--
-- Name: buyback_swaps buyback_swaps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buyback_swaps
    ADD CONSTRAINT buyback_swaps_pkey PRIMARY KEY (id);


--
-- Name: buyback_swaps buyback_swaps_tx_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buyback_swaps
    ADD CONSTRAINT buyback_swaps_tx_hash_key UNIQUE (tx_hash);


--
-- Name: chain_address_floors chain_address_floors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chain_address_floors
    ADD CONSTRAINT chain_address_floors_pkey PRIMARY KEY (address);


--
-- Name: chain_day_blocks chain_day_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chain_day_blocks
    ADD CONSTRAINT chain_day_blocks_pkey PRIMARY KEY (sample_date);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: daily_agent_snapshots daily_agent_snapshots_agent_id_snapshot_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_agent_snapshots
    ADD CONSTRAINT daily_agent_snapshots_agent_id_snapshot_date_key UNIQUE (agent_id, snapshot_date);


--
-- Name: daily_agent_snapshots daily_agent_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_agent_snapshots
    ADD CONSTRAINT daily_agent_snapshots_pkey PRIMARY KEY (id);


--
-- Name: daily_coin_snapshots daily_coin_snapshots_coin_id_snapshot_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_coin_snapshots
    ADD CONSTRAINT daily_coin_snapshots_coin_id_snapshot_date_key UNIQUE (coin_id, snapshot_date);


--
-- Name: daily_coin_snapshots daily_coin_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_coin_snapshots
    ADD CONSTRAINT daily_coin_snapshots_pkey PRIMARY KEY (id);


--
-- Name: daily_tvl_snapshots daily_tvl_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_tvl_snapshots
    ADD CONSTRAINT daily_tvl_snapshots_pkey PRIMARY KEY (id);


--
-- Name: daily_tvl_snapshots daily_tvl_snapshots_vault_id_snapshot_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_tvl_snapshots
    ADD CONSTRAINT daily_tvl_snapshots_vault_id_snapshot_date_key UNIQUE (vault_id, snapshot_date);


--
-- Name: daily_wallet_snapshots daily_wallet_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_wallet_snapshots
    ADD CONSTRAINT daily_wallet_snapshots_pkey PRIMARY KEY (id);


--
-- Name: daily_wallet_snapshots daily_wallet_snapshots_wallet_id_snapshot_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_wallet_snapshots
    ADD CONSTRAINT daily_wallet_snapshots_wallet_id_snapshot_date_key UNIQUE (wallet_id, snapshot_date);


--
-- Name: deployment_identity deployment_identity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_identity
    ADD CONSTRAINT deployment_identity_pkey PRIMARY KEY (id);


--
-- Name: job_runs job_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runs
    ADD CONSTRAINT job_runs_pkey PRIMARY KEY (id);


--
-- Name: job_schedules job_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_schedules
    ADD CONSTRAINT job_schedules_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: lobster_coins lobster_coins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lobster_coins
    ADD CONSTRAINT lobster_coins_pkey PRIMARY KEY (id);


--
-- Name: openclaw_agents openclaw_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.openclaw_agents
    ADD CONSTRAINT openclaw_agents_pkey PRIMARY KEY (id);


--
-- Name: prices prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prices
    ADD CONSTRAINT prices_pkey PRIMARY KEY (id);


--
-- Name: prices prices_ts_symbol_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prices
    ADD CONSTRAINT prices_ts_symbol_key UNIQUE (ts, symbol);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: projects projects_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_slug_key UNIQUE (slug);


--
-- Name: raw_indicator_history raw_indicator_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_indicator_history
    ADD CONSTRAINT raw_indicator_history_pkey PRIMARY KEY (date, indicator);


--
-- Name: regime_indicators regime_indicators_indicator_key_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regime_indicators
    ADD CONSTRAINT regime_indicators_indicator_key_date_key UNIQUE (indicator_key, date);


--
-- Name: regime_indicators regime_indicators_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regime_indicators
    ADD CONSTRAINT regime_indicators_pkey PRIMARY KEY (id);


--
-- Name: regime_snapshots regime_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regime_snapshots
    ADD CONSTRAINT regime_snapshots_pkey PRIMARY KEY (date);


--
-- Name: research_pipeline_artifacts research_pipeline_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_artifacts
    ADD CONSTRAINT research_pipeline_artifacts_pkey PRIMARY KEY (id);


--
-- Name: research_pipeline_runs research_pipeline_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_runs
    ADD CONSTRAINT research_pipeline_runs_pkey PRIMARY KEY (id);


--
-- Name: research_pipeline_stages research_pipeline_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_stages
    ADD CONSTRAINT research_pipeline_stages_pkey PRIMARY KEY (id);


--
-- Name: research_pipeline_stages research_pipeline_stages_run_id_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_stages
    ADD CONSTRAINT research_pipeline_stages_run_id_sequence_key UNIQUE (run_id, sequence);


--
-- Name: research_pipeline_warnings research_pipeline_warnings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_warnings
    ADD CONSTRAINT research_pipeline_warnings_pkey PRIMARY KEY (id);


--
-- Name: research_signals research_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_signals
    ADD CONSTRAINT research_signals_pkey PRIMARY KEY (id);


--
-- Name: research_signals research_signals_signal_key_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_signals
    ADD CONSTRAINT research_signals_signal_key_date_key UNIQUE (signal_key, date);


--
-- Name: schema_manifest schema_manifest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_manifest
    ADD CONSTRAINT schema_manifest_pkey PRIMARY KEY (singleton);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);


--
-- Name: source_acquisition_events source_acquisition_events_acquisition_id_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_acquisition_events
    ADD CONSTRAINT source_acquisition_events_acquisition_id_sequence_key UNIQUE (acquisition_id, sequence);


--
-- Name: source_acquisition_events source_acquisition_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_acquisition_events
    ADD CONSTRAINT source_acquisition_events_pkey PRIMARY KEY (id);


--
-- Name: source_acquisitions source_acquisitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_acquisitions
    ADD CONSTRAINT source_acquisitions_pkey PRIMARY KEY (id);


--
-- Name: source_fetches source_fetches_acquisition_id_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_fetches
    ADD CONSTRAINT source_fetches_acquisition_id_sequence_key UNIQUE (acquisition_id, sequence);


--
-- Name: source_fetches source_fetches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_fetches
    ADD CONSTRAINT source_fetches_pkey PRIMARY KEY (id);


--
-- Name: source_payloads source_payloads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_payloads
    ADD CONSTRAINT source_payloads_pkey PRIMARY KEY (checksum);


--
-- Name: source_value_versions source_value_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_value_versions
    ADD CONSTRAINT source_value_versions_pkey PRIMARY KEY (id);


--
-- Name: swarm_agent_health_events swarm_agent_health_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_agent_health_events
    ADD CONSTRAINT swarm_agent_health_events_pkey PRIMARY KEY (id);


--
-- Name: swarm_applications swarm_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_applications
    ADD CONSTRAINT swarm_applications_pkey PRIMARY KEY (id);


--
-- Name: swarm_brief_revisions swarm_brief_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_brief_revisions
    ADD CONSTRAINT swarm_brief_revisions_pkey PRIMARY KEY (id);


--
-- Name: swarm_brief_revisions swarm_brief_revisions_session_id_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_brief_revisions
    ADD CONSTRAINT swarm_brief_revisions_session_id_revision_key UNIQUE (session_id, revision);


--
-- Name: swarm_briefs swarm_briefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_briefs
    ADD CONSTRAINT swarm_briefs_pkey PRIMARY KEY (id);


--
-- Name: swarm_claim_challenges swarm_claim_challenges_challenge_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_claim_challenges
    ADD CONSTRAINT swarm_claim_challenges_challenge_key UNIQUE (challenge);


--
-- Name: swarm_claim_challenges swarm_claim_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_claim_challenges
    ADD CONSTRAINT swarm_claim_challenges_pkey PRIMARY KEY (member_id);


--
-- Name: swarm_consensus_receipts swarm_consensus_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_consensus_receipts
    ADD CONSTRAINT swarm_consensus_receipts_pkey PRIMARY KEY (session_id);


--
-- Name: swarm_judge_config swarm_judge_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_judge_config
    ADD CONSTRAINT swarm_judge_config_pkey PRIMARY KEY (id);


--
-- Name: swarm_judge_fault_injection swarm_judge_fault_injection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_judge_fault_injection
    ADD CONSTRAINT swarm_judge_fault_injection_pkey PRIMARY KEY (id);


--
-- Name: swarm_member_avatars swarm_member_avatars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_member_avatars
    ADD CONSTRAINT swarm_member_avatars_pkey PRIMARY KEY (member_id);


--
-- Name: swarm_member_keys swarm_member_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_member_keys
    ADD CONSTRAINT swarm_member_keys_pkey PRIMARY KEY (id);


--
-- Name: swarm_members swarm_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_members
    ADD CONSTRAINT swarm_members_pkey PRIMARY KEY (id);


--
-- Name: swarm_memos swarm_memos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_memos
    ADD CONSTRAINT swarm_memos_pkey PRIMARY KEY (id);


--
-- Name: swarm_recommendations swarm_recommendations_member_id_nonce_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_recommendations
    ADD CONSTRAINT swarm_recommendations_member_id_nonce_key UNIQUE (member_id, nonce);


--
-- Name: swarm_recommendations swarm_recommendations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_recommendations
    ADD CONSTRAINT swarm_recommendations_pkey PRIMARY KEY (id);


--
-- Name: swarm_scheduler_jobs swarm_scheduler_jobs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_scheduler_jobs
    ADD CONSTRAINT swarm_scheduler_jobs_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: swarm_scheduler_jobs swarm_scheduler_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_scheduler_jobs
    ADD CONSTRAINT swarm_scheduler_jobs_pkey PRIMARY KEY (id);


--
-- Name: swarm_session_events swarm_session_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_session_events
    ADD CONSTRAINT swarm_session_events_pkey PRIMARY KEY (id);


--
-- Name: swarm_session_judgements swarm_session_judgements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_session_judgements
    ADD CONSTRAINT swarm_session_judgements_pkey PRIMARY KEY (id);


--
-- Name: swarm_session_members swarm_session_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_session_members
    ADD CONSTRAINT swarm_session_members_pkey PRIMARY KEY (session_id, member_id);


--
-- Name: swarm_sessions swarm_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_sessions
    ADD CONSTRAINT swarm_sessions_pkey PRIMARY KEY (id);


--
-- Name: swarm_stream_events swarm_stream_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_stream_events
    ADD CONSTRAINT swarm_stream_events_pkey PRIMARY KEY (seq);


--
-- Name: swarm_subject_snapshots swarm_subject_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_subject_snapshots
    ADD CONSTRAINT swarm_subject_snapshots_pkey PRIMARY KEY (id);


--
-- Name: swarm_subject_snapshots swarm_subject_snapshots_subject_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_subject_snapshots
    ADD CONSTRAINT swarm_subject_snapshots_subject_id_date_key UNIQUE (subject_id, date);


--
-- Name: swarm_subjects swarm_subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_subjects
    ADD CONSTRAINT swarm_subjects_pkey PRIMARY KEY (id);


--
-- Name: swarm_waitlist swarm_waitlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_waitlist
    ADD CONSTRAINT swarm_waitlist_pkey PRIMARY KEY (id);


--
-- Name: tracked_wallets tracked_wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tracked_wallets
    ADD CONSTRAINT tracked_wallets_pkey PRIMARY KEY (id);


--
-- Name: vault_adapter_samples vault_adapter_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_adapter_samples
    ADD CONSTRAINT vault_adapter_samples_pkey PRIMARY KEY (id);


--
-- Name: vault_adapter_samples vault_adapter_samples_vault_address_adapter_address_sample__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_adapter_samples
    ADD CONSTRAINT vault_adapter_samples_vault_address_adapter_address_sample__key UNIQUE (vault_address, adapter_address, sample_hour);


--
-- Name: vault_apy vault_apy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_apy
    ADD CONSTRAINT vault_apy_pkey PRIMARY KEY (date);


--
-- Name: vault_share_price_history vault_share_price_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_price_history
    ADD CONSTRAINT vault_share_price_history_pkey PRIMARY KEY (id);


--
-- Name: vault_share_price_history vault_share_price_history_vault_address_sample_hour_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_share_price_history
    ADD CONSTRAINT vault_share_price_history_vault_address_sample_hour_key UNIQUE (vault_address, sample_hour);


--
-- Name: vault_tvl vault_tvl_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_tvl
    ADD CONSTRAINT vault_tvl_pkey PRIMARY KEY (id);


--
-- Name: vault_tvl vault_tvl_ts_vault_address_asset_symbol_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_tvl
    ADD CONSTRAINT vault_tvl_ts_vault_address_asset_symbol_key UNIQUE (ts, vault_address, asset_symbol);


--
-- Name: wallet_aum_snapshot_runs wallet_aum_snapshot_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_aum_snapshot_runs
    ADD CONSTRAINT wallet_aum_snapshot_runs_pkey PRIMARY KEY (run_id);


--
-- Name: wallet_aum_snapshot_runs wallet_aum_snapshot_runs_snapshot_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_aum_snapshot_runs
    ADD CONSTRAINT wallet_aum_snapshot_runs_snapshot_id_key UNIQUE (snapshot_id);


--
-- Name: wallet_backfill_state wallet_backfill_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_backfill_state
    ADD CONSTRAINT wallet_backfill_state_pkey PRIMARY KEY (sample_date);


--
-- Name: wallet_balance_sample_evidence wallet_balance_sample_evidence_original_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_balance_sample_evidence
    ADD CONSTRAINT wallet_balance_sample_evidence_original_id_key UNIQUE (original_id);


--
-- Name: wallet_balance_sample_evidence wallet_balance_sample_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_balance_sample_evidence
    ADD CONSTRAINT wallet_balance_sample_evidence_pkey PRIMARY KEY (evidence_id);


--
-- Name: wallet_balance_samples wallet_balance_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_balance_samples
    ADD CONSTRAINT wallet_balance_samples_pkey PRIMARY KEY (id);


--
-- Name: wallet_balance_samples wallet_balance_samples_sample_date_symbol_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_balance_samples
    ADD CONSTRAINT wallet_balance_samples_sample_date_symbol_key UNIQUE (sample_date, symbol);


--
-- Name: wallet_balances wallet_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_balances
    ADD CONSTRAINT wallet_balances_pkey PRIMARY KEY (id);


--
-- Name: wallet_balances wallet_balances_ts_wallet_address_asset_symbol_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_balances
    ADD CONSTRAINT wallet_balances_ts_wallet_address_asset_symbol_key UNIQUE (ts, wallet_address, asset_symbol);


--
-- Name: wallet_sleeve_sample_evidence wallet_sleeve_sample_evidence_original_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_sleeve_sample_evidence
    ADD CONSTRAINT wallet_sleeve_sample_evidence_original_id_key UNIQUE (original_id);


--
-- Name: wallet_sleeve_sample_evidence wallet_sleeve_sample_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_sleeve_sample_evidence
    ADD CONSTRAINT wallet_sleeve_sample_evidence_pkey PRIMARY KEY (evidence_id);


--
-- Name: wallet_sleeve_samples wallet_sleeve_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_sleeve_samples
    ADD CONSTRAINT wallet_sleeve_samples_pkey PRIMARY KEY (id);


--
-- Name: wallet_sleeve_samples wallet_sleeve_samples_sample_date_wallet_address_symbol_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_sleeve_samples
    ADD CONSTRAINT wallet_sleeve_samples_sample_date_wallet_address_symbol_key UNIQUE (sample_date, wallet_address, symbol);


--
-- Name: agent_activity_log_agent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_activity_log_agent_idx ON public.agent_activity_log USING btree (agent_id);


--
-- Name: agent_activity_log_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_activity_log_occurred_idx ON public.agent_activity_log USING btree (occurred_at DESC);


--
-- Name: agent_revenue_daily_agent_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_revenue_daily_agent_date_idx ON public.agent_revenue_daily USING btree (agent_id, revenue_date);


--
-- Name: agent_vaults_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_vaults_project_idx ON public.agent_vaults USING btree (project_id);


--
-- Name: agent_vaults_project_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_vaults_project_name_idx ON public.agent_vaults USING btree (project_id, name);


--
-- Name: analytics_artifacts_key_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_artifacts_key_created_idx ON public.analytics_artifacts USING btree (artifact_key, created_at DESC);


--
-- Name: analytics_artifacts_run_tool_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_artifacts_run_tool_idx ON public.analytics_artifacts USING btree (analytics_run_id, tool_id);


--
-- Name: analytics_ledger_runs_asof_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_ledger_runs_asof_idx ON public.analytics_ledger_runs USING btree (asof DESC);


--
-- Name: analytics_ledger_runs_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_ledger_runs_job_idx ON public.analytics_ledger_runs USING btree (job_id);


--
-- Name: analytics_output_snapshots_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_output_snapshots_run_idx ON public.analytics_output_snapshots USING btree (run_id);


--
-- Name: analytics_overwrite_events_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_overwrite_events_lookup_idx ON public.analytics_overwrite_events USING btree (table_name, natural_key, recorded_at DESC);


--
-- Name: analytics_parity_observations_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_parity_observations_domain_idx ON public.analytics_parity_observations USING btree (domain, observed_at DESC);


--
-- Name: analytics_report_snapshots_asof_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_report_snapshots_asof_idx ON public.analytics_report_snapshots USING btree (asof DESC);


--
-- Name: analytics_runs_asof_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_runs_asof_kind_idx ON public.analytics_runs USING btree (asof DESC, job_kind);


--
-- Name: analytics_runs_job_attempt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_runs_job_attempt_idx ON public.analytics_runs USING btree (job_id, attempt);


--
-- Name: analytics_runs_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_runs_started_idx ON public.analytics_runs USING btree (started_at DESC);


--
-- Name: analytics_submissions_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_submissions_status_created_idx ON public.analytics_submissions USING btree (status, created_at DESC);


--
-- Name: analytics_vintage_members_vintage_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_vintage_members_vintage_idx ON public.analytics_vintage_members USING btree (vintage_id);


--
-- Name: asset_prices_symbol_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_prices_symbol_date_idx ON public.asset_prices USING btree (symbol, price_date);


--
-- Name: audit_log_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_at_idx ON public.audit_log USING btree (at DESC);


--
-- Name: audit_log_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_request_idx ON public.audit_log USING btree (request_id);


--
-- Name: audit_log_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_target_idx ON public.audit_log USING btree (target_type, target_id, at DESC);


--
-- Name: buyback_swaps_occurred_on_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX buyback_swaps_occurred_on_idx ON public.buyback_swaps USING btree (occurred_on DESC);


--
-- Name: comments_page_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comments_page_created_idx ON public.comments USING btree (page, created_at DESC);


--
-- Name: daily_agent_snapshots_agent_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_agent_snapshots_agent_date_idx ON public.daily_agent_snapshots USING btree (agent_id, snapshot_date);


--
-- Name: daily_coin_snapshots_coin_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_coin_snapshots_coin_date_idx ON public.daily_coin_snapshots USING btree (coin_id, snapshot_date);


--
-- Name: daily_tvl_snapshots_vault_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_tvl_snapshots_vault_date_idx ON public.daily_tvl_snapshots USING btree (vault_id, snapshot_date);


--
-- Name: daily_wallet_snapshots_wallet_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_wallet_snapshots_wallet_date_idx ON public.daily_wallet_snapshots USING btree (wallet_id, snapshot_date);


--
-- Name: job_runs_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_runs_job_idx ON public.job_runs USING btree (job_id);


--
-- Name: job_runs_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_runs_started_idx ON public.job_runs USING btree (started_at DESC);


--
-- Name: job_schedules_kind_cron_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX job_schedules_kind_cron_idx ON public.job_schedules USING btree (kind, cron);


--
-- Name: jobs_dedupe_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX jobs_dedupe_key_idx ON public.jobs USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: jobs_pending_run_after_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_pending_run_after_idx ON public.jobs USING btree (run_after) WHERE (status = 'pending'::text);


--
-- Name: jobs_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_scope_idx ON public.jobs USING btree (scope_type, scope_id, id DESC);


--
-- Name: lobster_coins_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lobster_coins_project_idx ON public.lobster_coins USING btree (project_id);


--
-- Name: lobster_coins_project_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX lobster_coins_project_name_idx ON public.lobster_coins USING btree (project_id, name);


--
-- Name: openclaw_agents_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX openclaw_agents_project_idx ON public.openclaw_agents USING btree (project_id);


--
-- Name: openclaw_agents_project_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX openclaw_agents_project_name_idx ON public.openclaw_agents USING btree (project_id, name);


--
-- Name: prices_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prices_ts_idx ON public.prices USING btree (ts);


--
-- Name: projects_status_score_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX projects_status_score_idx ON public.projects USING btree (status, data_coverage_score DESC);


--
-- Name: raw_indicator_history_indicator_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX raw_indicator_history_indicator_idx ON public.raw_indicator_history USING btree (indicator);


--
-- Name: regime_indicators_key_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX regime_indicators_key_date_idx ON public.regime_indicators USING btree (indicator_key, date);


--
-- Name: research_pipeline_artifacts_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pipeline_artifacts_run_idx ON public.research_pipeline_artifacts USING btree (run_id);


--
-- Name: research_pipeline_runs_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pipeline_runs_created_idx ON public.research_pipeline_runs USING btree (created_at DESC);


--
-- Name: research_pipeline_runs_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pipeline_runs_job_idx ON public.research_pipeline_runs USING btree (job_id);


--
-- Name: research_pipeline_runs_kind_asof_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pipeline_runs_kind_asof_idx ON public.research_pipeline_runs USING btree (kind, asof DESC);


--
-- Name: research_pipeline_runs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pipeline_runs_status_idx ON public.research_pipeline_runs USING btree (status);


--
-- Name: research_pipeline_stages_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pipeline_stages_run_idx ON public.research_pipeline_stages USING btree (run_id);


--
-- Name: research_pipeline_warnings_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pipeline_warnings_run_idx ON public.research_pipeline_warnings USING btree (run_id);


--
-- Name: source_value_versions_acquisition_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_value_versions_acquisition_key_idx ON public.source_value_versions USING btree (acquisition_id, source_key, market_date, market_instant) NULLS NOT DISTINCT;


--
-- Name: source_value_versions_legacy_baseline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_value_versions_legacy_baseline_idx ON public.source_value_versions USING btree (source_key, market_date) WHERE (revision_kind = 'legacy_baseline'::text);


--
-- Name: source_value_versions_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_value_versions_lookup_idx ON public.source_value_versions USING btree (source_key, market_date, market_instant, knowledge_time DESC, id DESC);


--
-- Name: source_value_versions_one_successor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_value_versions_one_successor_idx ON public.source_value_versions USING btree (prior_version_id) WHERE (prior_version_id IS NOT NULL);


--
-- Name: swarm_agent_health_events_absent_once_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX swarm_agent_health_events_absent_once_idx ON public.swarm_agent_health_events USING btree (session_id, member_id) WHERE (event_type = 'absent'::text);


--
-- Name: swarm_agent_health_events_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_agent_health_events_member_idx ON public.swarm_agent_health_events USING btree (member_id, created_at DESC);


--
-- Name: swarm_agent_health_events_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_agent_health_events_session_idx ON public.swarm_agent_health_events USING btree (session_id, created_at DESC);


--
-- Name: swarm_agent_health_events_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_agent_health_events_type_idx ON public.swarm_agent_health_events USING btree (event_type, created_at DESC);


--
-- Name: swarm_brief_revisions_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_brief_revisions_session_idx ON public.swarm_brief_revisions USING btree (session_id);


--
-- Name: swarm_briefs_session_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX swarm_briefs_session_key ON public.swarm_briefs USING btree (session_id);


--
-- Name: swarm_briefs_sessionless_day_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX swarm_briefs_sessionless_day_key ON public.swarm_briefs USING btree (date, subject_id) WHERE (session_id IS NULL);


--
-- Name: swarm_briefs_subject_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_briefs_subject_date_idx ON public.swarm_briefs USING btree (subject_id, date);


--
-- Name: swarm_claim_challenges_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_claim_challenges_expiry_idx ON public.swarm_claim_challenges USING btree (expires_at);


--
-- Name: swarm_consensus_receipts_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_consensus_receipts_subject_idx ON public.swarm_consensus_receipts USING btree (subject_id, published_at DESC);


--
-- Name: swarm_member_keys_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_member_keys_member_idx ON public.swarm_member_keys USING btree (member_id);


--
-- Name: swarm_member_keys_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX swarm_member_keys_token_idx ON public.swarm_member_keys USING btree (token_hash) WHERE (token_hash IS NOT NULL);


--
-- Name: swarm_members_handle_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX swarm_members_handle_key ON public.swarm_members USING btree (handle);


--
-- Name: swarm_recommendations_member_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_recommendations_member_received_idx ON public.swarm_recommendations USING btree (member_id, received_at DESC);


--
-- Name: swarm_recommendations_member_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_recommendations_member_session_idx ON public.swarm_recommendations USING btree (member_id, session_id);


--
-- Name: swarm_recommendations_one_final_per_member; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX swarm_recommendations_one_final_per_member ON public.swarm_recommendations USING btree (session_id, member_id) WHERE final;


--
-- Name: swarm_recommendations_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_recommendations_session_idx ON public.swarm_recommendations USING btree (session_id);


--
-- Name: swarm_recommendations_session_member_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_recommendations_session_member_latest_idx ON public.swarm_recommendations USING btree (session_id, member_id, revision DESC);


--
-- Name: swarm_recommendations_session_member_revision_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX swarm_recommendations_session_member_revision_key ON public.swarm_recommendations USING btree (session_id, member_id, revision);


--
-- Name: swarm_scheduler_jobs_unacked_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_scheduler_jobs_unacked_idx ON public.swarm_scheduler_jobs USING btree (created_at) WHERE (acked_at IS NULL);


--
-- Name: swarm_session_events_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_session_events_session_idx ON public.swarm_session_events USING btree (session_id, at);


--
-- Name: swarm_session_judgements_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_session_judgements_session_idx ON public.swarm_session_judgements USING btree (session_id, created_at DESC);


--
-- Name: swarm_sessions_one_collecting_per_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX swarm_sessions_one_collecting_per_subject ON public.swarm_sessions USING btree (subject_id) WHERE (state = 'collecting'::text);


--
-- Name: swarm_sessions_subject_convened_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_sessions_subject_convened_desc_idx ON public.swarm_sessions USING btree (subject_id, convened_at DESC);


--
-- Name: swarm_sessions_subject_convened_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX swarm_sessions_subject_convened_key ON public.swarm_sessions USING btree (subject_id, convened_at);


--
-- Name: swarm_sessions_unsettled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_sessions_unsettled_idx ON public.swarm_sessions USING btree (state) WHERE (state = ANY (ARRAY['window_closed'::text, 'aggregated'::text, 'judging'::text, 'judged'::text]));


--
-- Name: swarm_stream_events_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX swarm_stream_events_subject_idx ON public.swarm_stream_events USING btree (subject_id, seq);


--
-- Name: swarm_waitlist_email_norm_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX swarm_waitlist_email_norm_uq ON public.swarm_waitlist USING btree (email_norm);


--
-- Name: tracked_wallets_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tracked_wallets_project_idx ON public.tracked_wallets USING btree (project_id);


--
-- Name: tracked_wallets_project_label_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tracked_wallets_project_label_idx ON public.tracked_wallets USING btree (project_id, label);


--
-- Name: vault_adapter_samples_vault_adapter_hour_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_adapter_samples_vault_adapter_hour_idx ON public.vault_adapter_samples USING btree (vault_address, adapter_address, sample_hour);


--
-- Name: vault_share_price_history_vault_hour_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_share_price_history_vault_hour_idx ON public.vault_share_price_history USING btree (vault_address, sample_hour);


--
-- Name: vault_tvl_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vault_tvl_ts_idx ON public.vault_tvl USING btree (ts);


--
-- Name: wallet_aum_snapshot_runs_date_basis_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_aum_snapshot_runs_date_basis_created_idx ON public.wallet_aum_snapshot_runs USING btree (sample_date, time_basis, created_at DESC);


--
-- Name: wallet_aum_snapshot_runs_state_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_aum_snapshot_runs_state_date_idx ON public.wallet_aum_snapshot_runs USING btree (state, sample_date);


--
-- Name: wallet_backfill_state_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_backfill_state_status_idx ON public.wallet_backfill_state USING btree (status, sample_date);


--
-- Name: wallet_balance_sample_evidence_date_symbol_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_balance_sample_evidence_date_symbol_idx ON public.wallet_balance_sample_evidence USING btree (sample_date, symbol);


--
-- Name: wallet_balance_sample_evidence_snapshot_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_balance_sample_evidence_snapshot_run_idx ON public.wallet_balance_sample_evidence USING btree (snapshot_run_id) WHERE (snapshot_run_id IS NOT NULL);


--
-- Name: wallet_balance_samples_snapshot_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_balance_samples_snapshot_run_idx ON public.wallet_balance_samples USING btree (snapshot_run_id) WHERE (snapshot_run_id IS NOT NULL);


--
-- Name: wallet_balance_samples_symbol_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_balance_samples_symbol_date_idx ON public.wallet_balance_samples USING btree (symbol, sample_date);


--
-- Name: wallet_balances_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_balances_ts_idx ON public.wallet_balances USING btree (ts);


--
-- Name: wallet_sleeve_sample_evidence_date_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_sleeve_sample_evidence_date_key_idx ON public.wallet_sleeve_sample_evidence USING btree (sample_date, wallet_address, symbol);


--
-- Name: wallet_sleeve_sample_evidence_snapshot_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_sleeve_sample_evidence_snapshot_run_idx ON public.wallet_sleeve_sample_evidence USING btree (snapshot_run_id) WHERE (snapshot_run_id IS NOT NULL);


--
-- Name: wallet_sleeve_samples_snapshot_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_sleeve_samples_snapshot_run_idx ON public.wallet_sleeve_samples USING btree (snapshot_run_id) WHERE (snapshot_run_id IS NOT NULL);


--
-- Name: wallet_sleeve_samples_wallet_sym_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_sleeve_samples_wallet_sym_date_idx ON public.wallet_sleeve_samples USING btree (wallet_address, symbol, sample_date);


--
-- Name: agent_activity_log agent_activity_log_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_activity_log_append_only BEFORE DELETE OR TRUNCATE ON public.agent_activity_log FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.agent_activity_log ENABLE ALWAYS TRIGGER agent_activity_log_append_only;


--
-- Name: agent_activity_log agent_activity_log_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_activity_log_append_only_row BEFORE DELETE ON public.agent_activity_log FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.agent_activity_log ENABLE ALWAYS TRIGGER agent_activity_log_append_only_row;


--
-- Name: analytics_data_vintages analytics_data_vintages_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_data_vintages_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.analytics_data_vintages FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_run_ledger_immutable();

ALTER TABLE public.analytics_data_vintages ENABLE ALWAYS TRIGGER analytics_data_vintages_immutable;


--
-- Name: analytics_data_vintages analytics_data_vintages_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_data_vintages_immutable_row BEFORE DELETE OR UPDATE ON public.analytics_data_vintages FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_run_ledger_immutable();

ALTER TABLE public.analytics_data_vintages ENABLE ALWAYS TRIGGER analytics_data_vintages_immutable_row;


--
-- Name: analytics_ledger_methodology_versions analytics_ledger_methodology_versions_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_ledger_methodology_versions_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.analytics_ledger_methodology_versions FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_run_ledger_immutable();

ALTER TABLE public.analytics_ledger_methodology_versions ENABLE ALWAYS TRIGGER analytics_ledger_methodology_versions_immutable;


--
-- Name: analytics_ledger_methodology_versions analytics_ledger_methodology_versions_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_ledger_methodology_versions_immutable_row BEFORE DELETE OR UPDATE ON public.analytics_ledger_methodology_versions FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_run_ledger_immutable();

ALTER TABLE public.analytics_ledger_methodology_versions ENABLE ALWAYS TRIGGER analytics_ledger_methodology_versions_immutable_row;


--
-- Name: analytics_ledger_run_events analytics_ledger_run_events_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_ledger_run_events_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.analytics_ledger_run_events FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_run_ledger_immutable();

ALTER TABLE public.analytics_ledger_run_events ENABLE ALWAYS TRIGGER analytics_ledger_run_events_immutable;


--
-- Name: analytics_ledger_run_events analytics_ledger_run_events_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_ledger_run_events_immutable_row BEFORE DELETE OR UPDATE ON public.analytics_ledger_run_events FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_run_ledger_immutable();

ALTER TABLE public.analytics_ledger_run_events ENABLE ALWAYS TRIGGER analytics_ledger_run_events_immutable_row;


--
-- Name: analytics_ledger_runs analytics_ledger_runs_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_ledger_runs_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.analytics_ledger_runs FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_run_ledger_immutable();

ALTER TABLE public.analytics_ledger_runs ENABLE ALWAYS TRIGGER analytics_ledger_runs_immutable;


--
-- Name: analytics_ledger_runs analytics_ledger_runs_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_ledger_runs_immutable_row BEFORE DELETE OR UPDATE ON public.analytics_ledger_runs FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_run_ledger_immutable();

ALTER TABLE public.analytics_ledger_runs ENABLE ALWAYS TRIGGER analytics_ledger_runs_immutable_row;


--
-- Name: analytics_output_snapshots analytics_output_snapshots_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_output_snapshots_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.analytics_output_snapshots FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_output_ledger_immutable();

ALTER TABLE public.analytics_output_snapshots ENABLE ALWAYS TRIGGER analytics_output_snapshots_immutable;


--
-- Name: analytics_output_snapshots analytics_output_snapshots_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_output_snapshots_immutable_row BEFORE DELETE OR UPDATE ON public.analytics_output_snapshots FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_output_ledger_immutable();

ALTER TABLE public.analytics_output_snapshots ENABLE ALWAYS TRIGGER analytics_output_snapshots_immutable_row;


--
-- Name: analytics_overwrite_events analytics_overwrite_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_overwrite_events_append_only BEFORE DELETE OR TRUNCATE ON public.analytics_overwrite_events FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.analytics_overwrite_events ENABLE ALWAYS TRIGGER analytics_overwrite_events_append_only;


--
-- Name: analytics_overwrite_events analytics_overwrite_events_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_overwrite_events_append_only_row BEFORE DELETE ON public.analytics_overwrite_events FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.analytics_overwrite_events ENABLE ALWAYS TRIGGER analytics_overwrite_events_append_only_row;


--
-- Name: analytics_overwrite_events analytics_overwrite_events_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_overwrite_events_immutable BEFORE UPDATE ON public.analytics_overwrite_events FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_overwrite_event_immutable();

ALTER TABLE public.analytics_overwrite_events ENABLE ALWAYS TRIGGER analytics_overwrite_events_immutable;


--
-- Name: analytics_overwrite_events analytics_overwrite_events_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_overwrite_events_immutable_row BEFORE UPDATE ON public.analytics_overwrite_events FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_overwrite_event_immutable();

ALTER TABLE public.analytics_overwrite_events ENABLE ALWAYS TRIGGER analytics_overwrite_events_immutable_row;


--
-- Name: analytics_parity_observations analytics_parity_observations_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_parity_observations_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.analytics_parity_observations FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_cutover_immutable();

ALTER TABLE public.analytics_parity_observations ENABLE ALWAYS TRIGGER analytics_parity_observations_immutable;


--
-- Name: analytics_parity_observations analytics_parity_observations_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_parity_observations_immutable_row BEFORE DELETE OR UPDATE ON public.analytics_parity_observations FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_cutover_immutable();

ALTER TABLE public.analytics_parity_observations ENABLE ALWAYS TRIGGER analytics_parity_observations_immutable_row;


--
-- Name: analytics_report_snapshots analytics_report_snapshots_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_report_snapshots_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.analytics_report_snapshots FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_output_ledger_immutable();

ALTER TABLE public.analytics_report_snapshots ENABLE ALWAYS TRIGGER analytics_report_snapshots_immutable;


--
-- Name: analytics_report_snapshots analytics_report_snapshots_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_report_snapshots_immutable_row BEFORE DELETE OR UPDATE ON public.analytics_report_snapshots FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_output_ledger_immutable();

ALTER TABLE public.analytics_report_snapshots ENABLE ALWAYS TRIGGER analytics_report_snapshots_immutable_row;


--
-- Name: analytics_vintage_members analytics_vintage_members_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_vintage_members_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.analytics_vintage_members FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_run_ledger_immutable();

ALTER TABLE public.analytics_vintage_members ENABLE ALWAYS TRIGGER analytics_vintage_members_immutable;


--
-- Name: analytics_vintage_members analytics_vintage_members_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_vintage_members_immutable_row BEFORE DELETE OR UPDATE ON public.analytics_vintage_members FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_run_ledger_immutable();

ALTER TABLE public.analytics_vintage_members ENABLE ALWAYS TRIGGER analytics_vintage_members_immutable_row;


--
-- Name: audit_log audit_log_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_log_append_only BEFORE DELETE OR TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.audit_log ENABLE ALWAYS TRIGGER audit_log_append_only;


--
-- Name: audit_log audit_log_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_log_append_only_row BEFORE DELETE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.audit_log ENABLE ALWAYS TRIGGER audit_log_append_only_row;


--
-- Name: raw_indicator_history raw_indicator_history_capture_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER raw_indicator_history_capture_delete AFTER DELETE ON public.raw_indicator_history FOR EACH ROW EXECUTE FUNCTION public.rm_capture_analytics_overwrite();

ALTER TABLE public.raw_indicator_history ENABLE ALWAYS TRIGGER raw_indicator_history_capture_delete;


--
-- Name: raw_indicator_history raw_indicator_history_capture_overwrite; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER raw_indicator_history_capture_overwrite AFTER UPDATE ON public.raw_indicator_history FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION public.rm_capture_analytics_overwrite();

ALTER TABLE public.raw_indicator_history ENABLE ALWAYS TRIGGER raw_indicator_history_capture_overwrite;


--
-- Name: regime_snapshots regime_snapshots_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER regime_snapshots_append_only BEFORE DELETE OR TRUNCATE ON public.regime_snapshots FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.regime_snapshots ENABLE ALWAYS TRIGGER regime_snapshots_append_only;


--
-- Name: regime_snapshots regime_snapshots_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER regime_snapshots_append_only_row BEFORE DELETE ON public.regime_snapshots FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.regime_snapshots ENABLE ALWAYS TRIGGER regime_snapshots_append_only_row;


--
-- Name: regime_snapshots regime_snapshots_capture_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER regime_snapshots_capture_delete AFTER DELETE ON public.regime_snapshots FOR EACH ROW EXECUTE FUNCTION public.rm_capture_analytics_overwrite();

ALTER TABLE public.regime_snapshots ENABLE ALWAYS TRIGGER regime_snapshots_capture_delete;


--
-- Name: regime_snapshots regime_snapshots_capture_overwrite; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER regime_snapshots_capture_overwrite AFTER UPDATE ON public.regime_snapshots FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION public.rm_capture_analytics_overwrite();

ALTER TABLE public.regime_snapshots ENABLE ALWAYS TRIGGER regime_snapshots_capture_overwrite;


--
-- Name: research_signals research_signals_capture_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER research_signals_capture_delete AFTER DELETE ON public.research_signals FOR EACH ROW EXECUTE FUNCTION public.rm_capture_analytics_overwrite();

ALTER TABLE public.research_signals ENABLE ALWAYS TRIGGER research_signals_capture_delete;


--
-- Name: research_signals research_signals_capture_overwrite; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER research_signals_capture_overwrite AFTER UPDATE ON public.research_signals FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION public.rm_capture_analytics_overwrite();

ALTER TABLE public.research_signals ENABLE ALWAYS TRIGGER research_signals_capture_overwrite;


--
-- Name: schema_migrations schema_migrations_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER schema_migrations_append_only BEFORE DELETE OR TRUNCATE ON public.schema_migrations FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.schema_migrations ENABLE ALWAYS TRIGGER schema_migrations_append_only;


--
-- Name: schema_migrations schema_migrations_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER schema_migrations_append_only_row BEFORE DELETE ON public.schema_migrations FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.schema_migrations ENABLE ALWAYS TRIGGER schema_migrations_append_only_row;


--
-- Name: source_acquisition_events source_acquisition_events_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_acquisition_events_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.source_acquisition_events FOR EACH STATEMENT EXECUTE FUNCTION public.rm_source_ledger_immutable();

ALTER TABLE public.source_acquisition_events ENABLE ALWAYS TRIGGER source_acquisition_events_immutable;


--
-- Name: source_acquisition_events source_acquisition_events_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_acquisition_events_immutable_row BEFORE DELETE OR UPDATE ON public.source_acquisition_events FOR EACH ROW EXECUTE FUNCTION public.rm_source_ledger_immutable();

ALTER TABLE public.source_acquisition_events ENABLE ALWAYS TRIGGER source_acquisition_events_immutable_row;


--
-- Name: source_acquisitions source_acquisitions_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_acquisitions_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.source_acquisitions FOR EACH STATEMENT EXECUTE FUNCTION public.rm_source_ledger_immutable();

ALTER TABLE public.source_acquisitions ENABLE ALWAYS TRIGGER source_acquisitions_immutable;


--
-- Name: source_acquisitions source_acquisitions_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_acquisitions_immutable_row BEFORE DELETE OR UPDATE ON public.source_acquisitions FOR EACH ROW EXECUTE FUNCTION public.rm_source_ledger_immutable();

ALTER TABLE public.source_acquisitions ENABLE ALWAYS TRIGGER source_acquisitions_immutable_row;


--
-- Name: source_fetches source_fetches_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_fetches_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.source_fetches FOR EACH STATEMENT EXECUTE FUNCTION public.rm_source_ledger_immutable();

ALTER TABLE public.source_fetches ENABLE ALWAYS TRIGGER source_fetches_immutable;


--
-- Name: source_fetches source_fetches_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_fetches_immutable_row BEFORE DELETE OR UPDATE ON public.source_fetches FOR EACH ROW EXECUTE FUNCTION public.rm_source_ledger_immutable();

ALTER TABLE public.source_fetches ENABLE ALWAYS TRIGGER source_fetches_immutable_row;


--
-- Name: source_payloads source_payloads_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_payloads_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.source_payloads FOR EACH STATEMENT EXECUTE FUNCTION public.rm_source_ledger_immutable();

ALTER TABLE public.source_payloads ENABLE ALWAYS TRIGGER source_payloads_immutable;


--
-- Name: source_payloads source_payloads_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_payloads_immutable_row BEFORE DELETE OR UPDATE ON public.source_payloads FOR EACH ROW EXECUTE FUNCTION public.rm_source_ledger_immutable();

ALTER TABLE public.source_payloads ENABLE ALWAYS TRIGGER source_payloads_immutable_row;


--
-- Name: source_value_versions source_value_versions_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_value_versions_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.source_value_versions FOR EACH STATEMENT EXECUTE FUNCTION public.rm_source_ledger_immutable();

ALTER TABLE public.source_value_versions ENABLE ALWAYS TRIGGER source_value_versions_immutable;


--
-- Name: source_value_versions source_value_versions_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_value_versions_immutable_row BEFORE DELETE OR UPDATE ON public.source_value_versions FOR EACH ROW EXECUTE FUNCTION public.rm_source_ledger_immutable();

ALTER TABLE public.source_value_versions ENABLE ALWAYS TRIGGER source_value_versions_immutable_row;


--
-- Name: swarm_applications swarm_applications_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_applications_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_applications FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_applications ENABLE ALWAYS TRIGGER swarm_applications_append_only;


--
-- Name: swarm_applications swarm_applications_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_applications_append_only_row BEFORE DELETE ON public.swarm_applications FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_applications ENABLE ALWAYS TRIGGER swarm_applications_append_only_row;


--
-- Name: swarm_brief_revisions swarm_brief_revisions_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_brief_revisions_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.swarm_brief_revisions FOR EACH STATEMENT EXECUTE FUNCTION public.rm_analytics_output_ledger_immutable();

ALTER TABLE public.swarm_brief_revisions ENABLE ALWAYS TRIGGER swarm_brief_revisions_immutable;


--
-- Name: swarm_brief_revisions swarm_brief_revisions_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_brief_revisions_immutable_row BEFORE DELETE OR UPDATE ON public.swarm_brief_revisions FOR EACH ROW EXECUTE FUNCTION public.rm_analytics_output_ledger_immutable();

ALTER TABLE public.swarm_brief_revisions ENABLE ALWAYS TRIGGER swarm_brief_revisions_immutable_row;


--
-- Name: swarm_briefs swarm_briefs_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_briefs_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_briefs FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_briefs ENABLE ALWAYS TRIGGER swarm_briefs_append_only;


--
-- Name: swarm_briefs swarm_briefs_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_briefs_append_only_row BEFORE DELETE ON public.swarm_briefs FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_briefs ENABLE ALWAYS TRIGGER swarm_briefs_append_only_row;


--
-- Name: swarm_consensus_receipts swarm_consensus_receipts_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_consensus_receipts_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_consensus_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_consensus_receipts ENABLE ALWAYS TRIGGER swarm_consensus_receipts_append_only;


--
-- Name: swarm_consensus_receipts swarm_consensus_receipts_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_consensus_receipts_append_only_row BEFORE DELETE ON public.swarm_consensus_receipts FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_consensus_receipts ENABLE ALWAYS TRIGGER swarm_consensus_receipts_append_only_row;


--
-- Name: swarm_consensus_receipts swarm_consensus_receipts_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_consensus_receipts_immutable BEFORE UPDATE ON public.swarm_consensus_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.rm_consensus_receipt_immutable();

ALTER TABLE public.swarm_consensus_receipts ENABLE ALWAYS TRIGGER swarm_consensus_receipts_immutable;


--
-- Name: swarm_consensus_receipts swarm_consensus_receipts_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_consensus_receipts_immutable_row BEFORE UPDATE ON public.swarm_consensus_receipts FOR EACH ROW EXECUTE FUNCTION public.rm_consensus_receipt_immutable();

ALTER TABLE public.swarm_consensus_receipts ENABLE ALWAYS TRIGGER swarm_consensus_receipts_immutable_row;


--
-- Name: swarm_member_keys swarm_member_keys_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_member_keys_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_member_keys FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_member_keys ENABLE ALWAYS TRIGGER swarm_member_keys_append_only;


--
-- Name: swarm_member_keys swarm_member_keys_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_member_keys_append_only_row BEFORE DELETE ON public.swarm_member_keys FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_member_keys ENABLE ALWAYS TRIGGER swarm_member_keys_append_only_row;


--
-- Name: swarm_members swarm_members_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_members_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_members FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_members ENABLE ALWAYS TRIGGER swarm_members_append_only;


--
-- Name: swarm_members swarm_members_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_members_append_only_row BEFORE DELETE ON public.swarm_members FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_members ENABLE ALWAYS TRIGGER swarm_members_append_only_row;


--
-- Name: swarm_members swarm_members_default_handle_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_members_default_handle_trigger BEFORE INSERT ON public.swarm_members FOR EACH ROW EXECUTE FUNCTION public.swarm_members_default_handle();


--
-- Name: swarm_members swarm_members_handle_namespace_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_members_handle_namespace_trigger BEFORE INSERT OR UPDATE ON public.swarm_members FOR EACH ROW EXECUTE FUNCTION public.swarm_members_assert_handle_namespace();

ALTER TABLE public.swarm_members ENABLE ALWAYS TRIGGER swarm_members_handle_namespace_trigger;


--
-- Name: swarm_memos swarm_memos_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_memos_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_memos FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_memos ENABLE ALWAYS TRIGGER swarm_memos_append_only;


--
-- Name: swarm_memos swarm_memos_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_memos_append_only_row BEFORE DELETE ON public.swarm_memos FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_memos ENABLE ALWAYS TRIGGER swarm_memos_append_only_row;


--
-- Name: swarm_recommendations swarm_recommendations_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_recommendations_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_recommendations FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_recommendations ENABLE ALWAYS TRIGGER swarm_recommendations_append_only;


--
-- Name: swarm_recommendations swarm_recommendations_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_recommendations_append_only_row BEFORE DELETE ON public.swarm_recommendations FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_recommendations ENABLE ALWAYS TRIGGER swarm_recommendations_append_only_row;


--
-- Name: swarm_recommendations swarm_recommendations_default_final_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_recommendations_default_final_trigger BEFORE INSERT ON public.swarm_recommendations FOR EACH ROW EXECUTE FUNCTION public.swarm_recommendations_default_final();


--
-- Name: swarm_scheduler_jobs swarm_scheduler_jobs_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_scheduler_jobs_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_scheduler_jobs FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_scheduler_jobs ENABLE ALWAYS TRIGGER swarm_scheduler_jobs_append_only;


--
-- Name: swarm_scheduler_jobs swarm_scheduler_jobs_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_scheduler_jobs_append_only_row BEFORE DELETE ON public.swarm_scheduler_jobs FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_scheduler_jobs ENABLE ALWAYS TRIGGER swarm_scheduler_jobs_append_only_row;


--
-- Name: swarm_session_events swarm_session_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_session_events_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_session_events FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_session_events ENABLE ALWAYS TRIGGER swarm_session_events_append_only;


--
-- Name: swarm_session_events swarm_session_events_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_session_events_append_only_row BEFORE DELETE ON public.swarm_session_events FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_session_events ENABLE ALWAYS TRIGGER swarm_session_events_append_only_row;


--
-- Name: swarm_session_judgements swarm_session_judgements_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_session_judgements_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_session_judgements FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_session_judgements ENABLE ALWAYS TRIGGER swarm_session_judgements_append_only;


--
-- Name: swarm_session_judgements swarm_session_judgements_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_session_judgements_append_only_row BEFORE DELETE ON public.swarm_session_judgements FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_session_judgements ENABLE ALWAYS TRIGGER swarm_session_judgements_append_only_row;


--
-- Name: swarm_session_members swarm_session_members_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_session_members_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_session_members FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_session_members ENABLE ALWAYS TRIGGER swarm_session_members_append_only;


--
-- Name: swarm_session_members swarm_session_members_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_session_members_append_only_row BEFORE DELETE ON public.swarm_session_members FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_session_members ENABLE ALWAYS TRIGGER swarm_session_members_append_only_row;


--
-- Name: swarm_sessions swarm_sessions_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_sessions_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_sessions FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_sessions ENABLE ALWAYS TRIGGER swarm_sessions_append_only;


--
-- Name: swarm_sessions swarm_sessions_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_sessions_append_only_row BEFORE DELETE ON public.swarm_sessions FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_sessions ENABLE ALWAYS TRIGGER swarm_sessions_append_only_row;


--
-- Name: swarm_stream_events swarm_stream_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_stream_events_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_stream_events FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_stream_events ENABLE ALWAYS TRIGGER swarm_stream_events_append_only;


--
-- Name: swarm_stream_events swarm_stream_events_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_stream_events_append_only_row BEFORE DELETE ON public.swarm_stream_events FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_stream_events ENABLE ALWAYS TRIGGER swarm_stream_events_append_only_row;


--
-- Name: swarm_subject_snapshots swarm_subject_snapshots_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_subject_snapshots_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_subject_snapshots FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_subject_snapshots ENABLE ALWAYS TRIGGER swarm_subject_snapshots_append_only;


--
-- Name: swarm_subject_snapshots swarm_subject_snapshots_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_subject_snapshots_append_only_row BEFORE DELETE ON public.swarm_subject_snapshots FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_subject_snapshots ENABLE ALWAYS TRIGGER swarm_subject_snapshots_append_only_row;


--
-- Name: swarm_subjects swarm_subjects_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_subjects_append_only BEFORE DELETE OR TRUNCATE ON public.swarm_subjects FOR EACH STATEMENT EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_subjects ENABLE ALWAYS TRIGGER swarm_subjects_append_only;


--
-- Name: swarm_subjects swarm_subjects_append_only_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER swarm_subjects_append_only_row BEFORE DELETE ON public.swarm_subjects FOR EACH ROW EXECUTE FUNCTION public.rm_append_only_guard();

ALTER TABLE public.swarm_subjects ENABLE ALWAYS TRIGGER swarm_subjects_append_only_row;


--
-- Name: wallet_aum_snapshot_runs wallet_aum_snapshot_runs_finalize; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_aum_snapshot_runs_finalize BEFORE INSERT ON public.wallet_aum_snapshot_runs FOR EACH ROW EXECUTE FUNCTION public.rm_wallet_aum_snapshot_finalize_guard();

ALTER TABLE public.wallet_aum_snapshot_runs ENABLE ALWAYS TRIGGER wallet_aum_snapshot_runs_finalize;


--
-- Name: wallet_aum_snapshot_runs wallet_aum_snapshot_runs_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_aum_snapshot_runs_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.wallet_aum_snapshot_runs FOR EACH STATEMENT EXECUTE FUNCTION public.rm_wallet_aum_snapshot_run_guard();

ALTER TABLE public.wallet_aum_snapshot_runs ENABLE ALWAYS TRIGGER wallet_aum_snapshot_runs_immutable;


--
-- Name: wallet_aum_snapshot_runs wallet_aum_snapshot_runs_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_aum_snapshot_runs_immutable_row BEFORE DELETE OR UPDATE ON public.wallet_aum_snapshot_runs FOR EACH ROW EXECUTE FUNCTION public.rm_wallet_aum_snapshot_run_guard();

ALTER TABLE public.wallet_aum_snapshot_runs ENABLE ALWAYS TRIGGER wallet_aum_snapshot_runs_immutable_row;


--
-- Name: wallet_balance_sample_evidence wallet_balance_sample_evidence_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_balance_sample_evidence_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.wallet_balance_sample_evidence FOR EACH STATEMENT EXECUTE FUNCTION public.rm_aum_evidence_guard();

ALTER TABLE public.wallet_balance_sample_evidence ENABLE ALWAYS TRIGGER wallet_balance_sample_evidence_immutable;


--
-- Name: wallet_balance_sample_evidence wallet_balance_sample_evidence_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_balance_sample_evidence_immutable_row BEFORE DELETE OR UPDATE ON public.wallet_balance_sample_evidence FOR EACH ROW EXECUTE FUNCTION public.rm_aum_evidence_guard();

ALTER TABLE public.wallet_balance_sample_evidence ENABLE ALWAYS TRIGGER wallet_balance_sample_evidence_immutable_row;


--
-- Name: wallet_balance_sample_evidence wallet_balance_sample_evidence_snapshot_final_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_balance_sample_evidence_snapshot_final_guard BEFORE INSERT OR DELETE OR UPDATE ON public.wallet_balance_sample_evidence FOR EACH ROW EXECUTE FUNCTION public.rm_wallet_aum_snapshot_constituent_guard();

ALTER TABLE public.wallet_balance_sample_evidence ENABLE ALWAYS TRIGGER wallet_balance_sample_evidence_snapshot_final_guard;


--
-- Name: wallet_balance_samples wallet_balance_samples_snapshot_final_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_balance_samples_snapshot_final_guard BEFORE INSERT OR DELETE OR UPDATE ON public.wallet_balance_samples FOR EACH ROW EXECUTE FUNCTION public.rm_wallet_aum_snapshot_constituent_guard();

ALTER TABLE public.wallet_balance_samples ENABLE ALWAYS TRIGGER wallet_balance_samples_snapshot_final_guard;


--
-- Name: wallet_sleeve_sample_evidence wallet_sleeve_sample_evidence_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_sleeve_sample_evidence_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.wallet_sleeve_sample_evidence FOR EACH STATEMENT EXECUTE FUNCTION public.rm_aum_evidence_guard();

ALTER TABLE public.wallet_sleeve_sample_evidence ENABLE ALWAYS TRIGGER wallet_sleeve_sample_evidence_immutable;


--
-- Name: wallet_sleeve_sample_evidence wallet_sleeve_sample_evidence_immutable_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_sleeve_sample_evidence_immutable_row BEFORE DELETE OR UPDATE ON public.wallet_sleeve_sample_evidence FOR EACH ROW EXECUTE FUNCTION public.rm_aum_evidence_guard();

ALTER TABLE public.wallet_sleeve_sample_evidence ENABLE ALWAYS TRIGGER wallet_sleeve_sample_evidence_immutable_row;


--
-- Name: wallet_sleeve_sample_evidence wallet_sleeve_sample_evidence_snapshot_final_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_sleeve_sample_evidence_snapshot_final_guard BEFORE INSERT OR DELETE OR UPDATE ON public.wallet_sleeve_sample_evidence FOR EACH ROW EXECUTE FUNCTION public.rm_wallet_aum_snapshot_constituent_guard();

ALTER TABLE public.wallet_sleeve_sample_evidence ENABLE ALWAYS TRIGGER wallet_sleeve_sample_evidence_snapshot_final_guard;


--
-- Name: wallet_sleeve_samples wallet_sleeve_samples_snapshot_final_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_sleeve_samples_snapshot_final_guard BEFORE INSERT OR DELETE OR UPDATE ON public.wallet_sleeve_samples FOR EACH ROW EXECUTE FUNCTION public.rm_wallet_aum_snapshot_constituent_guard();

ALTER TABLE public.wallet_sleeve_samples ENABLE ALWAYS TRIGGER wallet_sleeve_samples_snapshot_final_guard;


--
-- Name: agent_activity_log agent_activity_log_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_activity_log
    ADD CONSTRAINT agent_activity_log_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.openclaw_agents(id) ON DELETE SET NULL;


--
-- Name: agent_revenue_daily agent_revenue_daily_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_revenue_daily
    ADD CONSTRAINT agent_revenue_daily_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.openclaw_agents(id) ON DELETE CASCADE;


--
-- Name: agent_vaults agent_vaults_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_vaults
    ADD CONSTRAINT agent_vaults_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: analytics_artifacts analytics_artifacts_analytics_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_artifacts
    ADD CONSTRAINT analytics_artifacts_analytics_run_id_fkey FOREIGN KEY (analytics_run_id) REFERENCES public.analytics_runs(id) ON DELETE CASCADE;


--
-- Name: analytics_artifacts analytics_artifacts_stage_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_artifacts
    ADD CONSTRAINT analytics_artifacts_stage_run_id_fkey FOREIGN KEY (stage_run_id) REFERENCES public.analytics_stage_runs(id) ON DELETE CASCADE;


--
-- Name: analytics_data_vintages analytics_data_vintages_methodology_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_data_vintages
    ADD CONSTRAINT analytics_data_vintages_methodology_version_id_fkey FOREIGN KEY (methodology_version_id) REFERENCES public.analytics_ledger_methodology_versions(id);


--
-- Name: analytics_data_vintages analytics_data_vintages_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_data_vintages
    ADD CONSTRAINT analytics_data_vintages_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.analytics_ledger_runs(id);


--
-- Name: analytics_ledger_run_events analytics_ledger_run_events_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_ledger_run_events
    ADD CONSTRAINT analytics_ledger_run_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.analytics_ledger_runs(id);


--
-- Name: analytics_ledger_runs analytics_ledger_runs_methodology_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_ledger_runs
    ADD CONSTRAINT analytics_ledger_runs_methodology_version_id_fkey FOREIGN KEY (methodology_version_id) REFERENCES public.analytics_ledger_methodology_versions(id);


--
-- Name: analytics_output_snapshots analytics_output_snapshots_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_output_snapshots
    ADD CONSTRAINT analytics_output_snapshots_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.analytics_ledger_runs(id);


--
-- Name: analytics_report_snapshots analytics_report_snapshots_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_report_snapshots
    ADD CONSTRAINT analytics_report_snapshots_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.analytics_ledger_runs(id);


--
-- Name: analytics_runs analytics_runs_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_runs
    ADD CONSTRAINT analytics_runs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: analytics_stage_runs analytics_stage_runs_analytics_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_stage_runs
    ADD CONSTRAINT analytics_stage_runs_analytics_run_id_fkey FOREIGN KEY (analytics_run_id) REFERENCES public.analytics_runs(id) ON DELETE CASCADE;


--
-- Name: analytics_vintage_members analytics_vintage_members_source_value_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_vintage_members
    ADD CONSTRAINT analytics_vintage_members_source_value_version_id_fkey FOREIGN KEY (source_value_version_id) REFERENCES public.source_value_versions(id);


--
-- Name: analytics_vintage_members analytics_vintage_members_vintage_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_vintage_members
    ADD CONSTRAINT analytics_vintage_members_vintage_id_fkey FOREIGN KEY (vintage_id) REFERENCES public.analytics_data_vintages(id);


--
-- Name: audit_log audit_log_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.swarm_sessions(id) ON DELETE SET NULL;


--
-- Name: comments comments_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.comments(id) ON DELETE CASCADE;


--
-- Name: swarm_agent_health_events committee_agent_health_events_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_agent_health_events
    ADD CONSTRAINT committee_agent_health_events_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.swarm_members(id);


--
-- Name: swarm_agent_health_events committee_agent_health_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_agent_health_events
    ADD CONSTRAINT committee_agent_health_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.swarm_sessions(id) ON DELETE CASCADE;


--
-- Name: swarm_claim_challenges committee_claim_challenges_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_claim_challenges
    ADD CONSTRAINT committee_claim_challenges_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.swarm_members(id) ON DELETE CASCADE;


--
-- Name: swarm_member_keys committee_member_keys_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_member_keys
    ADD CONSTRAINT committee_member_keys_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.swarm_members(id) ON DELETE CASCADE;


--
-- Name: swarm_memos committee_memos_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_memos
    ADD CONSTRAINT committee_memos_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.swarm_members(id);


--
-- Name: swarm_memos committee_memos_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_memos
    ADD CONSTRAINT committee_memos_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.swarm_sessions(id);


--
-- Name: swarm_recommendations committee_recommendations_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_recommendations
    ADD CONSTRAINT committee_recommendations_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.swarm_members(id);


--
-- Name: swarm_recommendations committee_recommendations_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_recommendations
    ADD CONSTRAINT committee_recommendations_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.swarm_sessions(id) ON DELETE CASCADE;


--
-- Name: swarm_session_events committee_session_events_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_session_events
    ADD CONSTRAINT committee_session_events_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: swarm_session_events committee_session_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_session_events
    ADD CONSTRAINT committee_session_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.swarm_sessions(id) ON DELETE CASCADE;


--
-- Name: swarm_session_members committee_session_members_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_session_members
    ADD CONSTRAINT committee_session_members_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.swarm_members(id);


--
-- Name: swarm_session_members committee_session_members_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_session_members
    ADD CONSTRAINT committee_session_members_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.swarm_sessions(id) ON DELETE CASCADE;


--
-- Name: daily_agent_snapshots daily_agent_snapshots_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_agent_snapshots
    ADD CONSTRAINT daily_agent_snapshots_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.openclaw_agents(id) ON DELETE CASCADE;


--
-- Name: daily_coin_snapshots daily_coin_snapshots_coin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_coin_snapshots
    ADD CONSTRAINT daily_coin_snapshots_coin_id_fkey FOREIGN KEY (coin_id) REFERENCES public.lobster_coins(id) ON DELETE CASCADE;


--
-- Name: daily_tvl_snapshots daily_tvl_snapshots_vault_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_tvl_snapshots
    ADD CONSTRAINT daily_tvl_snapshots_vault_id_fkey FOREIGN KEY (vault_id) REFERENCES public.agent_vaults(id) ON DELETE CASCADE;


--
-- Name: daily_wallet_snapshots daily_wallet_snapshots_wallet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_wallet_snapshots
    ADD CONSTRAINT daily_wallet_snapshots_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES public.tracked_wallets(id) ON DELETE CASCADE;


--
-- Name: lobster_coins lobster_coins_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lobster_coins
    ADD CONSTRAINT lobster_coins_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: openclaw_agents openclaw_agents_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.openclaw_agents
    ADD CONSTRAINT openclaw_agents_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: research_pipeline_artifacts research_pipeline_artifacts_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_artifacts
    ADD CONSTRAINT research_pipeline_artifacts_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.research_pipeline_runs(id) ON DELETE CASCADE;


--
-- Name: research_pipeline_stages research_pipeline_stages_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_stages
    ADD CONSTRAINT research_pipeline_stages_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.research_pipeline_runs(id) ON DELETE CASCADE;


--
-- Name: research_pipeline_warnings research_pipeline_warnings_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_warnings
    ADD CONSTRAINT research_pipeline_warnings_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.research_pipeline_runs(id) ON DELETE CASCADE;


--
-- Name: source_acquisition_events source_acquisition_events_acquisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_acquisition_events
    ADD CONSTRAINT source_acquisition_events_acquisition_id_fkey FOREIGN KEY (acquisition_id) REFERENCES public.source_acquisitions(id);


--
-- Name: source_fetches source_fetches_acquisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_fetches
    ADD CONSTRAINT source_fetches_acquisition_id_fkey FOREIGN KEY (acquisition_id) REFERENCES public.source_acquisitions(id);


--
-- Name: source_fetches source_fetches_response_checksum_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_fetches
    ADD CONSTRAINT source_fetches_response_checksum_fkey FOREIGN KEY (response_checksum) REFERENCES public.source_payloads(checksum);


--
-- Name: source_value_versions source_value_versions_acquisition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_value_versions
    ADD CONSTRAINT source_value_versions_acquisition_id_fkey FOREIGN KEY (acquisition_id) REFERENCES public.source_acquisitions(id);


--
-- Name: source_value_versions source_value_versions_prior_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_value_versions
    ADD CONSTRAINT source_value_versions_prior_version_id_fkey FOREIGN KEY (prior_version_id) REFERENCES public.source_value_versions(id);


--
-- Name: swarm_brief_revisions swarm_brief_revisions_report_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_brief_revisions
    ADD CONSTRAINT swarm_brief_revisions_report_snapshot_id_fkey FOREIGN KEY (report_snapshot_id) REFERENCES public.analytics_report_snapshots(id);


--
-- Name: swarm_brief_revisions swarm_brief_revisions_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_brief_revisions
    ADD CONSTRAINT swarm_brief_revisions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.swarm_sessions(id);


--
-- Name: swarm_briefs swarm_briefs_report_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_briefs
    ADD CONSTRAINT swarm_briefs_report_snapshot_id_fkey FOREIGN KEY (report_snapshot_id) REFERENCES public.analytics_report_snapshots(id);


--
-- Name: swarm_briefs swarm_briefs_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_briefs
    ADD CONSTRAINT swarm_briefs_session_fk FOREIGN KEY (session_id) REFERENCES public.swarm_sessions(id) ON DELETE CASCADE;


--
-- Name: swarm_briefs swarm_briefs_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_briefs
    ADD CONSTRAINT swarm_briefs_subject_fk FOREIGN KEY (subject_id) REFERENCES public.swarm_subjects(id);


--
-- Name: swarm_consensus_receipts swarm_consensus_receipts_judgement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_consensus_receipts
    ADD CONSTRAINT swarm_consensus_receipts_judgement_id_fkey FOREIGN KEY (judgement_id) REFERENCES public.swarm_session_judgements(id);


--
-- Name: swarm_consensus_receipts swarm_consensus_receipts_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_consensus_receipts
    ADD CONSTRAINT swarm_consensus_receipts_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.swarm_sessions(id);


--
-- Name: swarm_member_avatars swarm_member_avatars_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_member_avatars
    ADD CONSTRAINT swarm_member_avatars_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.swarm_members(id) ON DELETE CASCADE;


--
-- Name: swarm_recommendations swarm_recommendations_report_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_recommendations
    ADD CONSTRAINT swarm_recommendations_report_snapshot_id_fkey FOREIGN KEY (report_snapshot_id) REFERENCES public.analytics_report_snapshots(id);


--
-- Name: swarm_recommendations swarm_recommendations_signing_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_recommendations
    ADD CONSTRAINT swarm_recommendations_signing_key_id_fkey FOREIGN KEY (signing_key_id) REFERENCES public.swarm_member_keys(id) ON DELETE SET NULL;


--
-- Name: swarm_recommendations swarm_recommendations_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_recommendations
    ADD CONSTRAINT swarm_recommendations_subject_fk FOREIGN KEY (subject_id) REFERENCES public.swarm_subjects(id);


--
-- Name: swarm_session_judgements swarm_session_judgements_judged_by_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_session_judgements
    ADD CONSTRAINT swarm_session_judgements_judged_by_member_id_fkey FOREIGN KEY (judged_by_member_id) REFERENCES public.swarm_members(id);


--
-- Name: swarm_session_judgements swarm_session_judgements_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_session_judgements
    ADD CONSTRAINT swarm_session_judgements_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.swarm_sessions(id);


--
-- Name: swarm_sessions swarm_sessions_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_sessions
    ADD CONSTRAINT swarm_sessions_subject_fk FOREIGN KEY (subject_id) REFERENCES public.swarm_subjects(id);


--
-- Name: swarm_sessions swarm_sessions_successor_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_sessions
    ADD CONSTRAINT swarm_sessions_successor_fk FOREIGN KEY (successor_session_id) REFERENCES public.swarm_sessions(id);


--
-- Name: swarm_stream_events swarm_stream_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_stream_events
    ADD CONSTRAINT swarm_stream_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.swarm_sessions(id);


--
-- Name: swarm_subject_snapshots swarm_subject_snapshots_subject_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swarm_subject_snapshots
    ADD CONSTRAINT swarm_subject_snapshots_subject_fk FOREIGN KEY (subject_id) REFERENCES public.swarm_subjects(id);


--
-- Name: tracked_wallets tracked_wallets_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tracked_wallets
    ADD CONSTRAINT tracked_wallets_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: wallet_balance_sample_evidence wallet_balance_sample_evidence_snapshot_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_balance_sample_evidence
    ADD CONSTRAINT wallet_balance_sample_evidence_snapshot_run_id_fkey FOREIGN KEY (snapshot_run_id) REFERENCES public.wallet_aum_snapshot_runs(run_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: wallet_balance_samples wallet_balance_samples_snapshot_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_balance_samples
    ADD CONSTRAINT wallet_balance_samples_snapshot_run_id_fkey FOREIGN KEY (snapshot_run_id) REFERENCES public.wallet_aum_snapshot_runs(run_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: wallet_sleeve_sample_evidence wallet_sleeve_sample_evidence_snapshot_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_sleeve_sample_evidence
    ADD CONSTRAINT wallet_sleeve_sample_evidence_snapshot_run_id_fkey FOREIGN KEY (snapshot_run_id) REFERENCES public.wallet_aum_snapshot_runs(run_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: wallet_sleeve_samples wallet_sleeve_samples_snapshot_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_sleeve_samples
    ADD CONSTRAINT wallet_sleeve_samples_snapshot_run_id_fkey FOREIGN KEY (snapshot_run_id) REFERENCES public.wallet_aum_snapshot_runs(run_id) DEFERRABLE INITIALLY DEFERRED;


--
-- PostgreSQL database dump complete
--


