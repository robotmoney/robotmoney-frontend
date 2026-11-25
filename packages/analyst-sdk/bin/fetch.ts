// `bun run fetch --into <supplementary dir> [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--field adjclose|close|volume] [--replace] <source id>...`
// Fetches supplementary series (analyst SDK requirements section 4; D79) with
// the SDK's source clients (Yahoo and FRED) and writes each as
// `<dir>/<provider>/<symbol>.csv` with its manifest. The directory must not be
// a local copy or lie inside one. `--start` defaults to 2016-01-01 and `--end` to
// today (UTC). An existing series is kept unless `--replace` is given.
// `--field` (issue 1751) picks the value of a Yahoo series: adjclose (the
// default, `<symbol>.csv`), close or volume, each its own series and file
// (`yahoo:^GSPC.volume` is `yahoo/%5EGSPC.volume.csv`). It needs every id to be
// a Yahoo one.
//
// Every id is checked before the first request. A series that fails (provider
// error, no observations, existing file) is reported and the others still run.
//
// Exit status: 0 when every series was written, 2 for a usage error, 1 when any
// series failed.
import pkg from "../package.json" with { type: "json" };
import { fetchSupplementary, SUPPLEMENTARY_PROVIDERS, supplementarySeriesId, type SupplementaryField } from "../src/extract/supplementary.ts";
import { DEFAULT_SUPPLEMENTARY_START, splitSourceId, supplementaryPaths } from "../src/input/supplementary.ts";
import { parseArgs, resolveFromCaller, UsageError } from "./args.ts";
import { assertSupplementaryDir, writeSupplementary } from "./supplementary-dir.ts";

const USAGE = "usage: bun run fetch --into <supplementary dir> [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--field adjclose|close|volume] [--replace] <source id>...";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function fail(e: unknown, code: number): never {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  if (code === 2) console.error(USAGE);
  process.exit(code);
}

let args;
let window: { start: string; end: string };
let field: SupplementaryField | undefined;
try {
  args = parseArgs(process.argv.slice(2), { flags: ["--replace"], values: ["--into", "--start", "--end", "--field"], maxPositionals: Infinity });
  if (!args.values.has("--into")) throw new UsageError("--into is required");
  if (args.positionals.length === 0) throw new UsageError("name at least one source id, for example yahoo:GC=F or fred:DTB3");
  window = { start: args.values.get("--start") ?? DEFAULT_SUPPLEMENTARY_START, end: args.values.get("--end") ?? new Date().toISOString().slice(0, 10) };
  for (const [k, v] of Object.entries(window)) if (!ISO_DAY.test(v)) throw new UsageError(`--${k} must be YYYY-MM-DD, got ${JSON.stringify(v)}`);
  if (window.start > window.end) throw new UsageError(`--start ${window.start} is after --end ${window.end}`);
  field = args.values.get("--field") as SupplementaryField | undefined;
  for (const id of args.positionals) {
    const { provider } = splitSourceId(id);
    if (!(SUPPLEMENTARY_PROVIDERS as readonly string[]).includes(provider)) {
      throw new UsageError(`${id}: no source client for provider ${provider}; the SDK fetches ${SUPPLEMENTARY_PROVIDERS.join(" and ")}`);
    }
    try {
      supplementarySeriesId(id, field);
    } catch (e) {
      throw new UsageError(`--field: ${(e as Error).message}`);
    }
  }
} catch (e) {
  fail(e, 2);
}

const dir = resolveFromCaller(args.values.get("--into")!, "fetch");
try {
  assertSupplementaryDir(dir);
} catch (e) {
  fail(e, 1);
}

let failed = 0;
for (const id of args.positionals) {
  try {
    const got = await fetchSupplementary(id, window, { field });
    const stored = supplementarySeriesId(id, field);
    const m = writeSupplementary(
      dir,
      stored,
      got.points,
      { field: got.field, fetched_at: new Date().toISOString(), fetched_by: `analyst-sdk ${pkg.version} fetch, ${got.endpoint}` },
      { replace: args.flags.has("--replace") },
    );
    console.error(`${id}: ${m.row_count} rows, ${m.first_date} .. ${m.last_date} -> ${supplementaryPaths(stored).file}`);
  } catch (e) {
    failed++;
    console.error(`${id}: FAILED ${(e as Error).name}: ${(e as Error).message}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
