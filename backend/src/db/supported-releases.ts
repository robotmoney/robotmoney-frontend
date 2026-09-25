// The releases a production database may be upgraded FROM — spec §8.4's
// `SUPPORTED_RELEASES`, and the one list the first production migrate of §9.1
// matches a pre-identity ledger against (D55 (5), (8)).
//
// Governed by smoke-production-spec.md §8.4 ("an upgrade from a populated
// database of each supported release (`SUPPORTED_RELEASES`: v0.5.0 alone)
// passes its data assertions") and §9.1 ("The first production migrate runs
// before the identity row exists"). The spec's "v0.5.0 alone" predates the
// production ledger read below; the baseline is that ledger (see WHICH
// BASELINE), and the spec and D55 (8) are amended to say so.
//
// WHY THE FILENAME LIST, AND NOT A TAG OR A NUMBER. §8.1: "the exact filename
// list of the migrations it embodies (a number alone is not an identity)". This
// repository has two files numbered 0059, and five files v0.5.0 lacks
// (0056_swarm_judge_requires_model.sql and four more up to
// 0061_rm_worker_wallet_backfill_grant.sql) sort BETWEEN files it has. So a
// release is identified by its whole list, and a ledger matches it only when
// the two lists are equal: no file missing, none extra, none renamed. A ledger
// that is a prefix, a superset or a near miss is a partly migrated or
// hand-edited database, and the one guarded exception of §4.3 is not for it.
//
// WHICH BASELINE: WHAT PRODUCTION'S LEDGER ACTUALLY HOLDS. D55 (8) named
// v0.5.0 as the release production runs. Production's `schema_migrations`,
// read on 2026-09-25 as rm_readonly on the read-only replica, holds 73 rows:
// all 72 files of the v0.5.0 tag plus `0062_rm_readonly_sequence_select.sql`,
// applied 2026-09-22 03:35 UTC. That file is in neither v0.5.0 nor the current
// releases-0.5.x: it came from the archived 0.5.x line (commit 61fab107, last
// changed by c3a68812; tag `archive/releases-0.5.x-2026-09-24`). Production
// ran c3a68812's SQL, not 61fab107's (verified on the replica: the
// rm_readonly_test role is gone and rm_worker holds the INSERT/UPDATE grants
// only c3a68812 adds), so tests replay the archive tag's bytes. The owner
// ruled that observed set the ground truth (2026-09-25), so the one supported
// baseline is that exact set, named for its provenance. A pure v0.5.0 ledger is
// NOT supported: no database holds it (production, and every rehearsal dump
// taken from production, carries the 0062 row), and it is the "one file less"
// case the first production migrate refuses.
//
// The list is pinned twice, and a test fails when either disagrees: the v0.5.0
// part in backend/tests/fixtures/releases/v0.5.0/release.json with a sha256 per
// file (read from the tag), and the whole observed ledger in
// backend/tests/fixtures/releases/production-2026-09-25/baseline.json, which
// also keeps the out-of-band file's archived bytes
// (backend/tests/upgrade-from-release.test.ts). Adding or changing a baseline
// takes an owner decision.

/** One baseline an upgrade may start from: a release tag, plus any file the
 *  target's ledger records beyond that tag's list. */
export interface SupportedRelease {
  /** The baseline's name, as a receipt and a refusal print it. */
  readonly name: string;
  /** The release tag the baseline starts from. */
  readonly release: string;
  /** Files the ledger records that the tag did not ship, applied out of band. */
  readonly outOfBand: readonly string[];
  /** Where the list comes from. */
  readonly provenance: string;
  /** Every migration filename the ledger records, in filename (apply) order. */
  readonly migrations: readonly string[];
}

/** The 72 files of the v0.5.0 tag, in filename order. */
const V0_5_0_MIGRATIONS: readonly string[] = [
  "0001_backends.sql",
  "0002_dashboards.sql",
  "0003_task_queue.sql",
  "0004_committee.sql",
  "0005_job_schedules_seed.sql",
  "0006_committee_reconcile.sql",
  "0007_committee_rls_stub.sql",
  "0008_committee_memos.sql",
  "0009_analytics_v2.sql",
  "0010_backtest_correlations.sql",
  "0011_regime_dashboard_extras.sql",
  "0012_vault_share_price_history.sql",
  "0013_projects.sql",
  "0014_projects_pipelines.sql",
  "0014_wallet_balance_samples.sql",
  "0015_buyback_swaps.sql",
  "0016_worker_role.sql",
  "0017_admin_surface.sql",
  "0018_research_telemetry.sql",
  "0019_committee_self_serve_claim.sql",
  "0020_committee_agent_health.sql",
  "0021_chain_indexer_samples.sql",
  "0021_committee_waitlist.sql",
  "0022_committee_application_received_notification.sql",
  "0022_committee_session_convened_at.sql",
  "0023_agent_activity_log.sql",
  "0023_analytics_submissions.sql",
  "0023_list2_leaderboard.sql",
  "0024_analytics_provenance_source.sql",
  "0025_swarm_rename.sql",
  "0026_swarm_sessions_legacy_takes.sql",
  "0027_drop_swarm_sessions_legacy_takes.sql",
  "0028_admin_credential.sql",
  "0028_swarm_briefs_session_key.sql",
  "0028_swarm_take_revisions.sql",
  "0029_admin_auth_recovery.sql",
  "0029_admin_passkey.sql",
  "0030_swarm_member_handle.sql",
  "0031_swarm_member_handle_namespace.sql",
  "0032_append_only_history.sql",
  "0032_wallet_balance_samples_strategy_nav_idle_only.sql",
  "0033_swarm_member_uuid_ids.sql",
  "0033_wallet_backfill.sql",
  "0034_job_schedules_catchup_policy.sql",
  "0035_swarm_member_avatar_bytes.sql",
  "0036_quarantine_backfilled_samples.sql",
  "0037_aum_repairable_quarantine.sql",
  "0038_wallet_aum_snapshot_foundation.sql",
  "0039_swarm_judge.sql",
  "0040_swarm_judgements_append_only.sql",
  "0041_swarm_judgement_soak_record.sql",
  "0042_swarm_consensus_receipts.sql",
  "0043_swarm_member_judges.sql",
  "0044_wallet_backfill_leg_terminal.sql",
  "0045_chain_address_floors.sql",
  "0046_asset_prices.sql",
  "0047_swarm_session_subject_name_backfill.sql",
  "0048_swarm_judge_third_party_flag.sql",
  "0049_swarm_recommendations_signing_key.sql",
  "0050_swarm_member_keys_append_only.sql",
  "0051_swarm_vault_recommendation_type_repair.sql",
  "0052_swarm_judgement_digest_scheme.sql",
  "0053_database_role_taxonomy.sql",
  "0054_rm_worker_allowlist.sql",
  "0055_swarm_recommendations_member_received_idx.sql",
  "0056_analytics_overwrite_events.sql",
  "0057_source_acquisition_ledger.sql",
  "0058_analytics_run_ledger.sql",
  "0059_analytics_output_and_report_snapshots.sql",
  "0059_swarm_framework_subject_snapshot_cleanup.sql",
  "0060_analytics_ledger_cutover.sql",
  "0061_source_value_provenance.sql",
];

/** Production's observed ledger (see the header). Adding one takes an owner decision. */
export const SUPPORTED_RELEASES: readonly SupportedRelease[] = [
  {
    name: "v0.5.0+0062_rm_readonly_sequence_select (production ledger 2026-09-25)",
    release: "v0.5.0",
    outOfBand: ["0062_rm_readonly_sequence_select.sql"],
    provenance:
      "production schema_migrations read 2026-09-25 as rm_readonly on the read-only replica: the 72 files of " +
      "v0.5.0 plus 0062_rm_readonly_sequence_select.sql (archived 0.5.x line, c3a68812 SQL), applied " +
      "2026-09-22 03:35 UTC",
    migrations: [...V0_5_0_MIGRATIONS, "0062_rm_readonly_sequence_select.sql"],
  },
];

/** How a ledger differs from one baseline's list. Both empty means equal. */
export interface LedgerDifference {
  /** The baseline's name. */
  readonly name: string;
  /** Files the release shipped that the ledger does not record. */
  readonly missing: readonly string[];
  /** Files the ledger records that the release did not ship. A renamed file
   *  appears once here and once in `missing`. */
  readonly extra: readonly string[];
}

/** The difference between a ledger and one release's filename list. */
export function ledgerDifference(ledger: readonly string[], release: SupportedRelease): LedgerDifference {
  const recorded = new Set(ledger);
  const shipped = new Set(release.migrations);
  return {
    name: release.name,
    missing: release.migrations.filter((file) => !recorded.has(file)),
    extra: [...recorded].filter((file) => !shipped.has(file)).sort(),
  };
}

/**
 * The supported release whose filename list the ledger equals EXACTLY, or
 * `null`. Order is not compared: the ledger is keyed by filename and the apply
 * order is the filename order (§8.1). A duplicate cannot occur —
 * `schema_migrations.name` is the primary key.
 */
export function matchSupportedRelease(
  ledger: readonly string[],
  releases: readonly SupportedRelease[] = SUPPORTED_RELEASES,
): SupportedRelease | null {
  for (const release of releases) {
    const { missing, extra } = ledgerDifference(ledger, release);
    if (missing.length === 0 && extra.length === 0) return release;
  }
  return null;
}

const NAMED_AT_MOST = 8;

/** An operator-readable account of how a ledger differs from every supported release. */
export function describeUnmatchedLedger(
  ledger: readonly string[],
  releases: readonly SupportedRelease[] = SUPPORTED_RELEASES,
): string {
  return releases
    .map((release) => {
      const { missing, extra } = ledgerDifference(ledger, release);
      // A ledger far past the release would otherwise print forty names.
      const named = (files: readonly string[]): string =>
        files.length > NAMED_AT_MOST ? `${files.slice(0, NAMED_AT_MOST).join(", ")}, …` : files.join(", ");
      const parts = [
        ...(missing.length > 0 ? [`${missing.length} missing (${named(missing)})`] : []),
        ...(extra.length > 0 ? [`${extra.length} extra (${named(extra)})`] : []),
      ];
      return `against ${release.name}: ${parts.length > 0 ? parts.join("; ") : "equal"}`;
    })
    .join("; ");
}
