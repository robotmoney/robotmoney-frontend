// Extract stage: generate the canonical EDGAR/MNA seed artifact from LIVE (or
// injected/mocked, for tests) EDGAR responses over an explicit,
// caller-supplied pinned range. Pure orchestration + atomic filesystem
// replace — no SQL, no analytics store writer, no smoke/bootstrap wiring.
// Used ONLY by the explicit `backend/scripts/edgar-seed-regenerate.ts`
// operator command — never implicitly by migrations, smoke boot, or CI.
import { gzipSync, gunzipSync } from "node:zlib";
import { writeFileSync, readFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fetchEdgarMonthCount, enumerateMonths } from "./edgar.ts";
import {
  EDGAR_SEED_INDICATOR,
  EDGAR_SEED_SOURCE,
  canonicalCsv,
  parseCanonicalCsv,
  buildManifest,
  validateSeed,
  type EdgarSeedManifest,
  type EdgarSeedRow,
} from "./edgar-seed.ts";

export interface RegenerateOptions {
  startIso: string;
  endIso: string; // pinned as-of range end (must be the last day of a complete month)
  asOf: string; // the date the regeneration was pinned/run (YYYY-MM-DD)
  fetchMonth?: typeof fetchEdgarMonthCount; // injectable — tests supply deterministic mocked responses
  logger?: { log?: (m: string) => void; warn?: (m: string) => void };
  requestDelayMs?: number; // politeness delay between month requests (default 250ms)
}

// Fetch every month's count in [startIso, endIso]. REFUSES (throws) on the
// first unrecovered month — regeneration NEVER commits partial history, in
// contrast to extract/edgar.ts's live research sweep, which gracefully
// degrades (circuit breaker) because a partial live update is acceptable but
// a partial COMMITTED seed is not.
export async function fetchCompleteEdgarSeed(opts: RegenerateOptions): Promise<EdgarSeedRow[]> {
  const fetchMonth = opts.fetchMonth ?? fetchEdgarMonthCount;
  const logger = opts.logger ?? console;
  const delayMs = opts.requestDelayMs ?? 250;
  const months = enumerateMonths(opts.startIso, opts.endIso);
  if (months.length === 0) {
    throw new Error(`EDGAR seed regeneration: range [${opts.startIso}, ${opts.endIso}] contains no months`);
  }
  const rows: EdgarSeedRow[] = [];
  for (const { monthStart, monthEnd } of months) {
    const count = await fetchMonth(monthStart, monthEnd, 15000, logger);
    if (count == null) {
      throw new Error(
        `EDGAR seed regeneration REFUSED: month ${monthStart} is unrecoverable after retries — no partial seed is ever committed`,
      );
    }
    rows.push({ date: monthEnd, indicator: EDGAR_SEED_INDICATOR, value: count });
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return rows;
}

export interface GeneratedSeed {
  rows: EdgarSeedRow[];
  manifest: EdgarSeedManifest;
  gz: Buffer;
}

// Fetch (bounded, refuses partial) → canonicalize → manifest → self-validate
// → gzip. Throws loudly on any incompleteness or inconsistency; never
// returns a partial/unvalidated artifact.
export async function generateEdgarSeedArtifact(opts: RegenerateOptions): Promise<GeneratedSeed> {
  const rows = await fetchCompleteEdgarSeed(opts);
  const manifest = buildManifest(rows, { asOf: opts.asOf, source: EDGAR_SEED_SOURCE });
  validateSeed(rows, manifest); // self-check before ever touching disk
  const gz = gzipSync(Buffer.from(canonicalCsv(rows), "utf8"));
  return { rows, manifest, gz };
}

// Atomically replace the committed artifact + manifest pair: write BOTH to
// temp files, round-trip + re-validate the temp pair, THEN rename both into
// place. If anything fails before the renames — including a validation
// failure on the round-tripped temp pair — the ORIGINAL pair is left
// completely untouched; a partial or corrupt write can never land.
export function replaceSeedArtifactAtomically(csvGzPath: string, manifestPath: string, generated: GeneratedSeed): void {
  mkdirSync(dirname(csvGzPath), { recursive: true });
  const tmpGz = `${csvGzPath}.tmp-${crypto.randomUUID()}`;
  const tmpManifest = `${manifestPath}.tmp-${crypto.randomUUID()}`;
  try {
    writeFileSync(tmpGz, generated.gz);
    writeFileSync(tmpManifest, `${JSON.stringify(generated.manifest, null, 2)}\n`);

    // Round-trip the TEMP pair through the exact parse/validate path before
    // committing — never rename in a pair we have not proven parses and
    // validates end-to-end.
    const text = gunzipSync(readFileSync(tmpGz)).toString("utf8");
    const rows = parseCanonicalCsv(text);
    validateSeed(rows, generated.manifest);

    renameSync(tmpGz, csvGzPath);
    renameSync(tmpManifest, manifestPath);
  } finally {
    try { unlinkSync(tmpGz); } catch { /* already renamed, or never written */ }
    try { unlinkSync(tmpManifest); } catch { /* already renamed, or never written */ }
  }
}
