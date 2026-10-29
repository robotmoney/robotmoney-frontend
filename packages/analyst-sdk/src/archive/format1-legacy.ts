// The legacy snapshot-time backups of format 1, baked as chain facts (issue
// 1477, decision D80).
//
// Until issue 1477, csvb named a backup by the replica snapshot time it ran at
// (`YYYY-MM-DDTHHMMSSZ`), while the public archive routes cut one backup per UTC
// day. From then on both writers cut at UTC day boundaries
// (format1.ts, planCuts). The robotmoney/csv-backups repo keeps every
// snapshot-time backup it already holds, byte for byte. The closed list below
// names them.
//
// The newest of them is the JUNCTION: one extra cut point, with its own id,
// where the repo's chain and the API's day-cut chain meet. The API serves it as
// one backup between the day-cut backups around it (its watermark_after is the
// watermarks below). The first day-cut backup after it chains from those
// watermarks in both writers, so a repo clone plus an API increment join here.
// The watermarks are the junction's watermark_after per append-only table, as
// csv/2026-10-28T180400Z/backup.json in robotmoney/csv-backups (commit 91b9af5) records them.
// They are facts about production ids: tests plant a synthetic junction through
// the writers' test seams and never use these.

/** Every snapshot-time backup csvb wrote before the day cut, oldest first. Closed: no id is added. */
export const LEGACY_BACKUP_IDS: readonly string[] = [
  "2026-10-05T205831Z",
  "2026-10-19T200614Z",
  "2026-10-19T200748Z",
  "2026-10-19T200831Z",
  "2026-10-19T201050Z",
  "2026-10-19T201057Z",
  "2026-10-19T202421Z",
  "2026-10-27T020813Z",
  "2026-10-28T180400Z",
];

/** The junction: the newest legacy backup and its watermark_after per append-only table. */
export const LEGACY_JUNCTION = {
  id: "2026-10-28T180400Z",
  watermarks: {
    analytics_output_snapshots: "1658",
    analytics_report_snapshots: "682",
    source_value_versions: "23411277",
    analytics_ledger_runs: "801",
    analytics_ledger_run_events: "1559",
    analytics_ledger_methodology_versions: "2",
    analytics_data_vintages: "695",
    analytics_vintage_members: "26417730",
    analytics_overwrite_events: "3851706",
    analytics_parity_observations: "3463",
  } as Readonly<Record<string, string>>,
} as const;
