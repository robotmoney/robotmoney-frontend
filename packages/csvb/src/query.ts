// Reading the backups: what exists, what a table looked like at a given backup, how one row changed, what
// changed between two backups. All answers come from the files in the repo.
import { encodeCsvRow } from "@robotmoney/analyst-sdk/src/archive/format1.ts";
import type { BackupRecord } from "./model.ts";
import { KEY_SEP, keyOf, loadRecords, loadState, resolvePath, scanCsvGz, tableInfo, type Layout, type State } from "./repo.ts";

/**
 * Turn "latest", a backup id, a date (`2026-10-05`) or a time (`2026-10-05T14:54`, `2026-10-05T145420Z`) into the
 * latest backup at or before it.
 */
export function resolveBackup(records: BackupRecord[], spec: string | undefined): BackupRecord {
  if (records.length === 0) throw new Error("the repo has no backups yet");
  const s = (spec ?? "latest").trim();
  if (s === "latest") return records[records.length - 1]!;
  let bound: string;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4}-\d{2}-\d{2})$/.exec(s))) bound = `${m[1]}T235959Z`;
  else if ((m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):?(\d{2})(?::?(\d{2}))?Z?$/.exec(s))) bound = `${m[1]}T${m[2]}${m[3]}${m[4] ?? "59"}Z`;
  else throw new Error(`cannot read ${JSON.stringify(spec)} as a backup (use latest, a backup id, a date, or a date and time)`);
  const hit = [...records].reverse().find((r) => r.backup <= bound);
  if (!hit) throw new Error(`no backup at or before ${s}; the first is ${records[0]!.backup}`);
  return hit;
}

export function describeAnomaly(an: import("./model.ts").Anomaly): string {
  return an.kind === "deleted_rows"
    ? `${an.table}: ${an.count} row(s) in the repo are gone from the database (ids ${an.ids.slice(0, 5).join(", ")}${an.count > 5 ? ", ..." : ""}); the repo keeps its copy`
    : `${an.table}: ${an.count} row(s) with ids ${an.id_min}..${an.id_max} committed after an earlier backup passed them; captured in ${an.files.join(", ")}`;
}

export function parseWhere(items: string[]): { col: string; val: string }[] {
  return items.map((w) => {
    const i = w.indexOf("=");
    if (i < 1) throw new Error(`--where wants column=value, got ${JSON.stringify(w)}`);
    return { col: w.slice(0, i), val: w.slice(i + 1) };
  });
}

function matcher(names: string[], where: { col: string; val: string }[]): (f: (string | null)[]) => boolean {
  const idx = where.map((w) => {
    const i = names.indexOf(w.col);
    if (i < 0) throw new Error(`no column ${w.col} (columns: ${names.join(", ")})`);
    return { i, val: w.val };
  });
  return (f) => idx.every((x) => (f[x.i] ?? "") === x.val);
}

// ── list ────────────────────────────────────────────────────────────────────────────────────

export function listBackups(l: Layout): string[] {
  const out: string[] = [];
  for (const r of loadRecords(l)) {
    const added = Object.entries(r.append_only).filter(([, a]) => a.rows_added > 0).map(([t, a]) => `${t}+${a.rows_added}`);
    const rev = Object.entries(r.revisions).filter(([, v]) => v.file).map(([t, v]) => `${t} ${v.upserts} changed${v.deletes ? `, ${v.deletes} removed` : ""}`);
    out.push(`${r.backup}  snapshot ${r.snapshot.exported_at_db}${r.snapshot.was_replica ? "" : " (NOT a replica)"}`);
    out.push(`    added:   ${added.join(", ") || "nothing"}`);
    out.push(`    revised: ${rev.join("; ") || "nothing changed"}`);
    for (const an of r.anomalies ?? []) out.push(`    ANOMALY: ${describeAnomaly(an)}`);
  }
  return out;
}

// ── resolve ─────────────────────────────────────────────────────────────────────────────────

/** Print a table as of a backup, as CSV, to `write`. Returns the number of rows printed. */
export async function resolveTable(l: Layout, table: string, asOf: string | undefined, where: { col: string; val: string }[], write: (s: string) => void, limit = Infinity): Promise<{ backup: string; rows: number; kind: string }> {
  const records = loadRecords(l);
  const at = resolveBackup(records, asOf);
  const info = tableInfo(records, table);
  const kind = info.kind;
  let rows = 0;
  if (info.kind === "revised") {
    const st = await loadState(l, { name: table, key: info.key }, at.backup);
    const keep = matcher(st.names, where);
    write(encodeCsvRow(st.names));
    for (const k of [...st.rows.keys()].sort()) {
      const f = st.rows.get(k)!;
      if (!keep(f)) continue;
      if (rows >= limit) break;
      write(encodeCsvRow(f));
      rows += 1;
    }
    return { backup: at.backup, rows, kind };
  }
  let printedHeader = false;
  const idEq = where.find((w) => w.col === "id");
  for (const r of records) {
    if (r.backup > at.backup) break;
    for (const f of r.append_only[table]?.files ?? []) {
      if (idEq && (BigInt(idEq.val) < BigInt(f.id_min!) || BigInt(idEq.val) > BigInt(f.id_max!))) continue;
      let keep: ((x: (string | null)[]) => boolean) | null = null;
      await scanCsvGz(resolvePath(l, f.path), (fields, hd) => {
        if (!printedHeader) {
          write(encodeCsvRow(hd));
          printedHeader = true;
        }
        keep ??= matcher(hd, where);
        if (rows < limit && keep(fields)) {
          write(encodeCsvRow(fields));
          rows += 1;
        }
      });
    }
  }
  return { backup: at.backup, rows, kind };
}

// ── history ─────────────────────────────────────────────────────────────────────────────────

const showChange = (names: string[], was: (string | null)[] | undefined, now: (string | null)[]): string => {
  if (!was) return "new row";
  const diffs: string[] = [];
  names.forEach((n, i) => {
    if ((was[i] ?? null) !== (now[i] ?? null)) diffs.push(`${n}: ${trunc(was[i])} -> ${trunc(now[i])}`);
  });
  return diffs.join("; ") || "(no column differs)";
};
const trunc = (v: string | null): string => (v === null ? "NULL" : v.length > 60 ? `${v.slice(0, 57)}...` : v);

/** Every version of the row(s) matching `where`. For a revised table, one line per revision; for an append-only table, which backup added it. */
export async function historyOf(l: Layout, table: string, where: { col: string; val: string }[]): Promise<string[]> {
  if (where.length === 0) throw new Error("history needs --where column=value (the row's key, e.g. date=2026-10-05)");
  const records = loadRecords(l);
  const out: string[] = [];
  const info = tableInfo(records, table);
  if (info.kind === "revised") {
    const cfg = { key: info.key };
    const prev = new Map<string, (string | null)[]>();
    let names: string[] = [];
    for (const r of records) {
      const rv = r.revisions[table];
      if (!rv?.file) continue;
      await scanCsvGz(resolvePath(l, rv.file.path), (f, hd) => {
        names = hd.slice(2);
        const row = f.slice(2);
        if (!matcher(names, where)(row)) return;
        const k = keyOf(names, row, cfg.key);
        const was = prev.get(k);
        if (f[1] === "delete") {
          out.push(`${r.backup}  delete  ${k.replace(new RegExp(KEY_SEP, "g"), ",")}`);
          prev.delete(k);
        } else {
          out.push(`${r.backup}  ${was ? "changed" : "first seen"}  ${k.replace(new RegExp(KEY_SEP, "g"), ",")}  ${showChange(names, was, row)}`);
          prev.set(k, row);
        }
      });
    }
    if (out.length === 0) out.push("no revision of that row in any backup");
    return out;
  }
  for (const r of records) {
    for (const f of r.append_only[table]?.files ?? []) {
      let keep: ((x: (string | null)[]) => boolean) | null = null;
      const idEq = where.find((w) => w.col === "id");
      if (idEq && (BigInt(idEq.val) < BigInt(f.id_min!) || BigInt(idEq.val) > BigInt(f.id_max!))) continue;
      await scanCsvGz(resolvePath(l, f.path), (fields, hd) => {
        keep ??= matcher(hd, where);
        if (keep(fields)) out.push(`added by backup ${r.backup}, ${f.path}: ${hd.map((n, i) => `${n}=${trunc(fields[i] ?? null)}`).join(", ")}`);
      });
    }
  }
  if (out.length === 0) out.push("no such row in any backup");
  return out;
}

// ── diff ────────────────────────────────────────────────────────────────────────────────────

export async function diffBackups(l: Layout, table: string, fromSpec: string, toSpec: string, limit = 20): Promise<string[]> {
  const records = loadRecords(l);
  const a = resolveBackup(records, fromSpec);
  const b = resolveBackup(records, toSpec);
  if (a.backup > b.backup) throw new Error(`${a.backup} is after ${b.backup}; give the older first`);
  const out: string[] = [`${table}: ${a.backup} -> ${b.backup}`];
  const info = tableInfo(records, table);
  if (info.kind === "append-only") {
    let rows = 0;
    let lo: string | null = null;
    let hi: string | null = null;
    for (const r of records) {
      if (r.backup <= a.backup || r.backup > b.backup) continue;
      for (const f of r.append_only[table]?.files ?? []) {
        rows += f.rows;
        lo ??= f.id_min!;
        hi = f.id_max!;
      }
    }
    out.push(rows ? `${rows} rows added, ids ${lo}..${hi}` : "no rows added");
    return out;
  }
  const cfg = { name: table, key: info.key };
  const sa: State = await loadState(l, cfg, a.backup);
  const sb: State = await loadState(l, cfg, b.backup);
  let added = 0;
  let changed = 0;
  let removed = 0;
  const examples: string[] = [];
  for (const [k, row] of sb.rows) {
    const was = sa.rows.get(k);
    if (!was) added += 1;
    else if (was.some((v, i) => (v ?? null) !== (row[i] ?? null))) {
      changed += 1;
      if (examples.length < limit) examples.push(`  ${k.replace(new RegExp(KEY_SEP, "g"), ",")}  ${showChange(sb.names, was, row)}`);
    }
  }
  for (const k of sa.rows.keys()) if (!sb.rows.has(k)) removed += 1;
  out.push(`${added} new, ${changed} changed, ${removed} removed (${sa.rows.size} rows before, ${sb.rows.size} after)`);
  out.push(...examples);
  if (changed > examples.length) out.push(`  ... and ${changed - examples.length} more changed rows (use --limit)`);
  return out;
}
