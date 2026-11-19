// Shared reads for v0.9.0's regime checks (issue 1182, PR 1646, D83): the served regime history and an
// independent statement of D83's selection rule over the frozen ledger's metadata. Not a check itself.
//
// THE RULE (D83 items 3, 5, 6; regime-engine.md §8.1). The ledger is `analytics_output_snapshots` of kind
// regime_snapshots, each artifact a run's whole recomputed history. An artifact "carries" its run's as-of
// day when its payload has a row for it (natural_keys, or the payload when natural_keys is NULL).
//   - The ledger start is the as-of day of the first carrying artifact (lowest run, then artifact id).
//     Days before it are served from that first artifact (a reconstruction, frozen).
//   - From the start, only a run's own as-of row publishes a day. Day D's figure is the D row of the LAST
//     carrying artifact with as-of D written during D (UTC, created_at); when none was written during D,
//     the FIRST one written after it. A day no carrying artifact has as its as-of is a gap.
// This file restates the rule from D83's text; it does not import the backend's selectPublications, so the
// check is an independent oracle of what the api serves.
import type { ReadOnlySession } from "../../db-read.ts";
import type { VersionCheckContext } from "../../version-check.ts";

/** One regime artifact's metadata. */
export interface ArtifactMeta {
  readonly id: number;
  readonly runId: number;
  /** Its run's as-of day. */
  readonly asof: string;
  /** The UTC day it was written. */
  readonly writtenOn: string;
  /** Whether its payload carries its as-of row. */
  readonly carries: boolean;
}

export interface Selection {
  /** The as-of day of the first carrying artifact, or null when no artifact carries one. */
  readonly start: string | null;
  /** The artifact the days before the start come from. */
  readonly first: ArtifactMeta | null;
  /** From the start: each published day's artifact. */
  readonly byDay: ReadonlyMap<string, ArtifactMeta>;
  /** Days from the start to `today` that no artifact published. */
  readonly gaps: readonly string[];
}

/** One served history point (GET /api/dashboards/regime-snapshots `history[]`). */
export interface Point {
  readonly date: string;
  readonly composite: number | null;
  readonly regime: string | null;
}

const byRunThenId = (a: ArtifactMeta, b: ArtifactMeta): number => a.runId - b.runId || a.id - b.id;

/** PURE. The UTC days from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** PURE. D83's selection over the artifacts' metadata, up to `today`. */
export function selectPublished(artifacts: readonly ArtifactMeta[], today: string): Selection {
  const carrying = artifacts.filter((a) => a.carries).sort(byRunThenId);
  const first = carrying[0] ?? null;
  if (first === null) return { start: null, first: null, byDay: new Map(), gaps: [] };
  const start = first.asof;
  const byDay = new Map<string, ArtifactMeta>();
  const candidates = new Map<string, ArtifactMeta[]>();
  for (const a of carrying) if (a.asof >= start && a.asof <= today) candidates.set(a.asof, [...(candidates.get(a.asof) ?? []), a]);
  for (const [day, list] of candidates) {
    const during = list.filter((a) => a.writtenOn <= day);
    const chosen = during.length > 0 ? during.sort(byRunThenId).at(-1)! : list.sort(byRunThenId)[0]!;
    byDay.set(day, chosen);
  }
  const gaps = daysBetween(start, today).filter((d) => !byDay.has(d));
  return { start, first, byDay, gaps };
}

/** The regime artifacts' metadata, read as rm_readonly. */
export async function readArtifacts(db: ReadOnlySession): Promise<ArtifactMeta[]> {
  const rows = await db.query<{ id: string; run_id: string; asof: string; written_on: string; carries: boolean | null }>(
    `SELECT aos.id::text AS id, aos.run_id::text AS run_id, r.asof::text AS asof,
            ((aos.created_at AT TIME ZONE 'UTC')::date)::text AS written_on,
            CASE WHEN aos.natural_keys IS NULL THEN NULL ELSE aos.natural_keys @> ARRAY[r.asof::text] END AS carries
       FROM analytics_output_snapshots aos JOIN analytics_ledger_runs r ON r.id = aos.run_id
      WHERE aos.artifact_kind = 'regime_snapshots'
      ORDER BY aos.run_id, aos.id`,
  );
  const out: ArtifactMeta[] = [];
  for (const r of rows) {
    let carries = r.carries;
    if (carries === null) {
      // natural_keys is NULL (a payload Postgres could not index): the payload decides, as the api's selection does.
      const [hit] = await db.query<{ carries: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM analytics_output_snapshots aos, jsonb_array_elements(convert_from(aos.payload_bytes, 'UTF8')::jsonb) e
                         WHERE aos.id = ${Number(r.id)} AND e->>'date' = '${r.asof.replace(/[^0-9-]/g, "")}') AS carries`,
      );
      carries = hit?.carries ?? false;
    }
    out.push({ id: Number(r.id), runId: Number(r.run_id), asof: r.asof, writtenOn: r.written_on, carries });
  }
  return out;
}

/** The rows of one artifact for the given days (or every day before `before`), the last element per day winning, as the writer's. */
export async function readArtifactRows(db: ReadOnlySession, artifactId: number, filter: { days: readonly string[] } | { before: string }): Promise<Map<string, Point>> {
  const where = "days" in filter
    ? `e.value->>'date' = ANY(ARRAY[${filter.days.map((d) => `'${d.replace(/[^0-9-]/g, "")}'`).join(",") || "NULL"}]::text[])`
    : `e.value->>'date' < '${filter.before.replace(/[^0-9-]/g, "")}'`;
  const rows = await db.query<{ date: string; composite: string | null; regime: string | null }>(
    `SELECT e.value->>'date' AS date, e.value->>'composite' AS composite, e.value->>'regime' AS regime
       FROM analytics_output_snapshots aos,
            jsonb_array_elements(convert_from(aos.payload_bytes, 'UTF8')::jsonb) WITH ORDINALITY AS e(value, ord)
      WHERE aos.id = ${Math.trunc(artifactId)} AND ${where}
      ORDER BY e.ord`,
  );
  const out = new Map<string, Point>();
  for (const r of rows) out.set(r.date, { date: r.date, composite: r.composite === null ? null : Number(r.composite), regime: r.regime });
  return out;
}

/** The newest regime artifact's id, or 0. */
export async function newestArtifactId(db: ReadOnlySession): Promise<number> {
  const [r] = await db.query<{ id: string | null }>("SELECT max(id)::text AS id FROM analytics_output_snapshots WHERE artifact_kind = 'regime_snapshots'");
  return Number(r?.id ?? 0);
}

/** The longest history the endpoint serves (backend/src/api/routes/dashboards.ts caps range at 3650). */
export const MAX_RANGE = 3650;

/** GET the served regime history through the public origin, past any cache; the UTC day it was asked on. */
export async function readServed(ctx: Pick<VersionCheckContext, "http">): Promise<{ today: string; source: string | null; history: Point[] } | { error: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const res = await ctx.http(`/api/dashboards/regime-snapshots?range=${MAX_RANGE}&rm-v090-regime=${Date.now()}`);
  if (res.status !== 200) return { error: `GET /api/dashboards/regime-snapshots answered ${res.status}` };
  try {
    const body = JSON.parse(res.text) as { source?: unknown; history?: { date?: unknown; composite?: unknown; regime?: unknown }[] };
    const history = (body.history ?? []).map((h) => ({ date: String(h.date), composite: typeof h.composite === "number" ? h.composite : null, regime: typeof h.regime === "string" ? h.regime : null }));
    return { today, source: typeof body.source === "string" ? body.source : null, history };
  } catch {
    return { error: "GET /api/dashboards/regime-snapshots is not JSON" };
  }
}
