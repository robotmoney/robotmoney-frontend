// Reading the backups for an audit: tables as of a backup, streamed, never held whole.
//
// An audit works from a CONTEXT: the repo and the backup it is "as of". Append-only tables are every row added by
// backups up to that one; revised tables are their replayed state at it.
import { appendOnly, revised } from "../config.ts";
import type { BackupRecord } from "../model.ts";
import { loadRecords, loadState, resolvePath, scanCsvGz, type Layout } from "../repo.ts";
import { resolveBackup } from "../query.ts";

export interface Ctx {
  layout: Layout;
  records: BackupRecord[];
  /** The backup the audit is as of. */
  asOf: BackupRecord;
}

export function openCtx(root: string, asOfSpec?: string): Ctx {
  const layout: Layout = { root };
  const records = loadRecords(layout);
  return { layout, records, asOf: resolveBackup(records, asOfSpec) };
}

export type Row = Record<string, string | null>;

/** Stream every row of a table as of the context, as {column: value}. */
export async function scanTable(ctx: Ctx, table: string, onRow: (r: Row) => void): Promise<void> {
  if (revised(table)) {
    const cfg = revised(table)!;
    const st = await loadState(ctx.layout, { name: table, key: cfg.key }, ctx.asOf.backup);
    for (const k of [...st.rows.keys()].sort()) {
      const r: Row = {};
      st.names.forEach((n, i) => (r[n] = st.rows.get(k)![i] ?? null));
      onRow(r);
    }
    return;
  }
  if (!appendOnly(table)) throw new Error(`unknown table ${table}`);
  for (const rec of ctx.records) {
    if (rec.backup > ctx.asOf.backup) break;
    for (const f of rec.append_only[table]?.files ?? []) {
      await scanCsvGz(resolvePath(ctx.layout, f.path), (fields, header) => {
        const r: Row = {};
        for (let i = 0; i < header.length; i++) r[header[i]!] = fields[i] ?? null;
        onRow(r);
      });
    }
  }
}

export async function loadTable(ctx: Ctx, table: string, keep: (r: Row) => boolean = () => true): Promise<Row[]> {
  const out: Row[] = [];
  await scanTable(ctx, table, (r) => {
    if (keep(r)) out.push(r);
  });
  return out;
}

export const num = (v: string | null | undefined): number => (v == null || v === "" ? NaN : Number(v));
/** A database timestamp (`2026-09-21 02:01:14.005+00`) as a Date. */
export const dbDate = (v: string): Date => new Date(v.replace(" ", "T").replace(/\+00$/, "Z"));
export const day = (v: string): string => v.slice(0, 10);
