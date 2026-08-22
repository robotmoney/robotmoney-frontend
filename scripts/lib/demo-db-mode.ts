// THE DATA PATH a demo/smoke boot runs against, as data.
//
// WHAT IT IS. Three named modes behind one flag, replacing the `--external-pg`
// boolean:
//
//   --db ephemeral   the demo's own postgres container (the default; unchanged)
//   --db external    a managed server whose address comes from `.env`
//   --db twin        a local throwaway container restored from a production dump
//
// WHY AN ENUM AND NOT ANOTHER BOOLEAN. `--external-pg` answered two different
// questions with one bit: WHERE postgres lives (a compose service vs. a URL)
// and WHO OWNS the data (this boot vs. somebody else). A digital twin needs the
// first half of external's behaviour and the exact OPPOSITE of the second — it
// dials a URL exactly as external does, but every write lands in a copy this
// boot created and may reclaim. Adding a second boolean would have made the two
// mutually exclusive only by convention, and would have left `--external-pg`'s
// banner ("nothing in demo:down or demo:clean can undo that") printing over a
// database that is, in fact, this run's to delete. A union makes the invalid
// combinations unrepresentable and turns the hand-written FATAL pairs in
// demo-main.ts into exhaustiveness.
//
// The two questions are now two exported predicates — ownsData() and
// usesComposePostgres() — because the codebase branches on BOTH today under the
// single name `externalPg.enabled`, and for a twin they disagree.
//
// WHY A CLI ARGUMENT, NOT AN ENV VAR. Unchanged from `--external-pg` and
// `--pg-data` (see demo-external-pg.ts's header and demo-main.ts's): pointing a
// boot at a real — or a production-DERIVED — database is a property of ONE
// deliberate invocation, never of a shell that happens to have something
// exported. The flag opts in; `.env` only ever supplies an address.
//
// WHY THE VALIDATOR LIVES HERE TOO. Until this module existed,
// `process.argv.includes()` was the entire parser, so `--fixed-ports` (a flag
// that has never existed) or a typo'd `--db twni` was SILENTLY IGNORED: the boot
// came up green on the wrong database. An enum flag makes that worse, not
// better — a mistyped value must not fall back to the default — so the
// allowlist ships in the same commit as the enum.
//
// SIDE-EFFECT FREE, apart from the single readFileSync that
// demo-external-pg.ts's resolver performs for `--db external`. Everything here
// is a DECISION, so scripts/tests/unit/demo-db-mode.test.ts drives every branch
// directly instead of grepping it out of a boot. Deprecation warnings are
// RETURNED rather than printed for the same reason.
import {
  assertReachableFromContainer,
  EXTERNAL_PG_FLAG,
  externalPgOverlayYaml,
  redactPostgresUrl,
  resolveExternalPg,
} from "./demo-external-pg.ts";

export { EXTERNAL_PG_FLAG, redactPostgresUrl };

/** The flag that selects a data path, and the three values it accepts. */
export const DB_FLAG = "--db";
export type DbMode = "ephemeral" | "external" | "twin";
export const DB_MODES: readonly DbMode[] = Object.freeze(["ephemeral", "external", "twin"]);

/** Where a `--db twin` boot looks for its encrypted dump, when not the default. */
export const BACKUP_DIR_FLAG = "--backup-dir";
/** The scenario flag a twin REQUIRES. Owned by smoke-mode.ts; named here to explain a refusal. */
const SMOKE_FLAG = "--smoke";
const PG_DATA_FLAG = "--pg-data";

// WHAT `--pg-data <host-dir>` MEANS, and why it rides on the ephemeral variant.
//
// It bind-mounts the postgres data directory to <host-dir> so a rebooted demo
// restarts from where it left off. A CLI ARGUMENT, never an env var (hard user
// preference, 2026-07-21: no per-property env config) — the resolved value is
// recorded in demo-state.json instead.
//
// Reuse constraints (also in docs/architecture.md): the same postgres major and
// the same baked-in demo credentials; migrate + seed are idempotent
// (backend/src/db/seed.ts uses ON CONFLICT DO NOTHING), so re-booting on old
// data converges rather than duplicating rows.
//
// Bind mounts were verified EMPIRICALLY on this Linux host: the postgres image's
// entrypoint chowns the bind dir to its own container user and inits / resumes
// cleanly, so the documented named-volume fallback was NOT needed. The data dir
// ends up postgres-owned on the host — manage it with your own tooling;
// demo:clean never touches --pg-data host dirs (they are not docker volumes).
//
// Absent the flag, every run keeps today's fresh-per-run behaviour: a named
// volume <project>_pgdata (labelled robotmoney.demo=1 by docker-compose.demo.yml).
//
// It is a PAYLOAD ON `ephemeral`, not a flag of its own, because it only means
// anything when there IS a compose postgres container to bind. Pairing it with
// external or twin is therefore unrepresentable rather than rejected by a
// hand-written precedence check — which is what demo-main.ts used to carry.

/**
 * The data path as REQUESTED at parse time.
 *
 * A twin carries no URL yet: no container exists until the restore runs, which
 * is deliberately not this module's job. `ResolvedDataPath` is the post-restore
 * form.
 */
export type DataPathRequest =
  | { kind: "ephemeral"; pgDataDir?: string }
  | {
      kind: "external";
      url: string;
      redactedUrl: string;
      host: string;
      source: "DATABASE_URL" | "discrete keys";
    }
  | { kind: "twin"; backupDir?: string };

/** The data path once a twin's container exists. Only `twin` gains anything. */
export type ResolvedDataPath =
  | Extract<DataPathRequest, { kind: "ephemeral" }>
  | Extract<DataPathRequest, { kind: "external" }>
  | {
      kind: "twin";
      backupDir?: string;
      url: string;
      redactedUrl: string;
      container: string;
      volume: string;
      stamp: string;
    };

export interface ParsedDataPath {
  dataPath: DataPathRequest;
  /** Deprecation notices for the caller to print. Never printed from here. */
  warnings: string[];
}

/**
 * Can this boot's teardown undo what it wrote?
 *
 * ephemeral ✓ (its own container) · twin ✓ (a copy it created) · external ✗
 *
 * This is the question `demo:down`'s "the EXTERNAL database is untouched" and
 * `printResumeHint()`'s reclaim advice are really asking.
 */
export function ownsData(dp: { kind: DbMode }): boolean {
  return dp.kind !== "external";
}

/**
 * Does compose start a `postgres` service for this boot?
 *
 * ephemeral ✓ · twin ✗ (its container is started outside compose) · external ✗
 *
 * This is the question the overlay, the `pgPort` field, the container tile and
 * the db-preflight step are really asking. It is NOT the same question as
 * ownsData(), and conflating the two is what `externalPg.enabled` did.
 */
export function usesComposePostgres(dp: { kind: DbMode }): boolean {
  return dp.kind === "ephemeral";
}

/** Is this mode's database populated by something other than this boot's seed? */
export function isPrePopulated(dp: { kind: DbMode }): boolean {
  return dp.kind !== "ephemeral";
}

// --- argv --------------------------------------------------------------------

export interface FlagSpec {
  flag: string;
  /** 0 = bare switch, 1 = takes the following token (or `--flag=value`). */
  arity: 0 | 1;
}

/**
 * EVERY flag `bun run demo` / `bun smoke` accepts. Nothing else may appear.
 *
 * Verified against every `process.argv` read in scripts/lib/demo-main.ts
 * (`:141`, `:143-144`, `:220`, `:327-328`, `:504`) — note that `--rm`,
 * `--no-deps`, `--tail`, `--no-color`, `--transport` and `--already-migrated`
 * also appear in that file but are arguments demo-main passes OUT to docker
 * compose and to child scripts; they are not accepted here, and adding them
 * would let a real typo through.
 */
export const DEMO_FLAGS: readonly FlagSpec[] = Object.freeze([
  Object.freeze({ flag: DB_FLAG, arity: 1 as const }),
  Object.freeze({ flag: BACKUP_DIR_FLAG, arity: 1 as const }),
  Object.freeze({ flag: PG_DATA_FLAG, arity: 1 as const }),
  Object.freeze({ flag: SMOKE_FLAG, arity: 0 as const }),
  Object.freeze({ flag: "--static-port", arity: 0 as const }),
  Object.freeze({ flag: "--stage", arity: 0 as const }),
  Object.freeze({ flag: EXTERNAL_PG_FLAG, arity: 0 as const }),
  Object.freeze({ flag: "--no-tui", arity: 0 as const }),
]);

/** Levenshtein, bounded — only ever asked about short flag values. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

function didYouMean(value: string, candidates: readonly string[]): string {
  const best = candidates
    .map((c) => ({ c, d: editDistance(value.toLowerCase(), c) }))
    .sort((x, y) => x.d - y.d)[0];
  return best && best.d <= 3 ? ` Did you mean "${best.c}"?` : "";
}

/** Split `--flag=value` into its halves; returns undefined for a bare token. */
function splitInline(token: string): { flag: string; value: string } | undefined {
  const eq = token.indexOf("=");
  return eq > 2 ? { flag: token.slice(0, eq), value: token.slice(eq + 1) } : undefined;
}

/**
 * Every complaint about this argv, or [] when it is clean.
 *
 * LOUD, NEVER SILENT is the whole point: before this existed, an unknown flag
 * was ignored and the boot proceeded on the DEFAULT data path. `--fixed-ports`
 * is the real-world case — it looks like it pins the tunnel port, it never
 * existed, and the boot came up green on a Docker-assigned port with cloudflared
 * pointing at nothing.
 *
 * Reports ALL problems rather than the first, so a mistyped invocation is fixed
 * in one round trip.
 */
export function validateArgv(argv: readonly string[]): string[] {
  const errors: string[] = [];
  const known = new Map(DEMO_FLAGS.map((f) => [f.flag, f]));
  const names = DEMO_FLAGS.map((f) => f.flag);

  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      errors.push(
        `unexpected argument "${token}": this command takes flags only, no positional arguments.`,
      );
      continue;
    }
    const inline = splitInline(token);
    const flag = inline ? inline.flag : token;
    const spec = known.get(flag);
    if (!spec) {
      errors.push(`unknown flag "${flag}".${didYouMean(flag, names)} Known flags: ${names.join(" ")}`);
      continue;
    }
    if (spec.arity === 0 && inline) {
      errors.push(`${flag} is a switch and takes no value (got "${inline.value}").`);
      continue;
    }
    if (spec.arity === 1) {
      if (inline) {
        if (!inline.value) errors.push(`${flag}= requires a value.`);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        errors.push(`${flag} requires a value (e.g. \`${flag} <value>\`).`);
        continue;
      }
      i++; // consume the value so it is not read as a stray positional
    }
  }
  return errors;
}

/** The value of an arity-1 flag, in either `--flag value` or `--flag=value` form. */
function valueOf(argv: readonly string[], flag: string): string | undefined {
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]!;
    const inline = splitInline(token);
    if (inline?.flag === flag) return inline.value || undefined;
    if (token === flag) {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith("--") ? next : undefined;
    }
  }
  return undefined;
}

function has(argv: readonly string[], flag: string): boolean {
  return argv.slice(2).some((t) => t === flag || splitInline(t)?.flag === flag);
}

/**
 * Resolve the data path this argv asks for.
 *
 * THROWS with an actionable message rather than falling back — the same rule
 * resolveExternalPg() follows, and for the same reason: silently booting a
 * throwaway database when the operator asked for a real one (or vice versa)
 * looks healthy while being completely wrong.
 *
 * Every rejection happens HERE, before any I/O beyond reading `.env`. That
 * ordering is load-bearing for the twin: discovering `--db twin` is invalid
 * after a gpg decrypt and a multi-minute pg_restore wastes the window the
 * rehearsal exists to protect.
 */
export function parseDataPath(
  argv: readonly string[],
  opts: { envFilePath: string },
): ParsedDataPath {
  const warnings: string[] = [];
  const argErrors = validateArgv(argv);
  if (argErrors.length > 0) {
    throw new Error(
      `invalid arguments:\n  - ${argErrors.join("\n  - ")}\n` +
        `Nothing was started. (Unknown flags used to be ignored, which booted the DEFAULT ` +
        `data path while looking like the one you asked for.)`,
    );
  }

  const legacyExternal = has(argv, EXTERNAL_PG_FLAG);
  const raw = valueOf(argv, DB_FLAG);
  const dbFlagPresent = has(argv, DB_FLAG);

  if (dbFlagPresent && raw === undefined) {
    throw new Error(`${DB_FLAG} requires a value — one of: ${DB_MODES.join(" | ")}.`);
  }
  if (raw !== undefined && !DB_MODES.includes(raw as DbMode)) {
    throw new Error(
      `${DB_FLAG} ${raw}: unknown data path.${didYouMean(raw, DB_MODES)} ` +
        `Valid modes: ${DB_MODES.join(" | ")}.`,
    );
  }

  if (legacyExternal) {
    if (raw !== undefined && raw !== "external") {
      throw new Error(
        `${EXTERNAL_PG_FLAG} and ${DB_FLAG} ${raw} ask for different data paths. ` +
          `${EXTERNAL_PG_FLAG} is the deprecated spelling of ${DB_FLAG} external; drop it.`,
      );
    }
    warnings.push(
      `${EXTERNAL_PG_FLAG} is DEPRECATED and now means ${DB_FLAG} external — same behaviour, ` +
        `one flag for all three data paths (${DB_MODES.join(" | ")}). Update your invocation.`,
    );
  }

  const mode: DbMode = (raw as DbMode | undefined) ?? (legacyExternal ? "external" : "ephemeral");
  const pgDataDir = valueOf(argv, PG_DATA_FLAG);

  if (mode !== "ephemeral" && pgDataDir !== undefined) {
    throw new Error(
      `${PG_DATA_FLAG} and ${DB_FLAG} ${mode} are mutually exclusive. ${PG_DATA_FLAG} binds the ` +
        `data directory of the ephemeral postgres container; ${DB_FLAG} ${mode} starts no such ` +
        `container (${mode === "external" ? "the managed server owns its own storage" : "the twin owns its own volume"}).`,
    );
  }

  if (mode === "twin") {
    // A restored twin is POPULATED by definition, and db-preflight.ts refuses a
    // populated database under the `simulation` initializer because the demo's
    // fixtures overwrite by design (ON CONFLICT DO UPDATE). Rather than let that
    // surface minutes later as a preflight abort, refuse the combination here.
    // Not INFERRED into a smoke boot: inference is exactly what this flag family
    // forbids — the operator states the scenario.
    if (!has(argv, SMOKE_FLAG)) {
      throw new Error(
        `${DB_FLAG} twin requires ${SMOKE_FLAG}. A twin is a restored, POPULATED database, and the ` +
          `demo scenario's fixtures overwrite rows by design — db-preflight.ts refuses that pairing ` +
          `(see scripts/lib/demo-external-pg.ts's dbPreflightArgv). Run: bun smoke -- ${DB_FLAG} twin`,
      );
    }
    return { dataPath: { kind: "twin", backupDir: valueOf(argv, BACKUP_DIR_FLAG) }, warnings };
  }

  if (mode === "external") {
    // Delegate to the existing resolver, which already throws for every bad-.env
    // case and is what scripts/tests/unit/demo-external-pg.test.ts pins. It keys
    // off EXTERNAL_PG_FLAG, so hand it a canonical argv rather than this one.
    const r = resolveExternalPg([argv[0] ?? "bun", argv[1] ?? "demo.ts", EXTERNAL_PG_FLAG], {
      envFilePath: opts.envFilePath,
    });
    return {
      dataPath: {
        kind: "external",
        url: r.url!,
        redactedUrl: r.redactedUrl!,
        host: r.host!,
        source: r.source!,
      },
      warnings,
    };
  }

  if (valueOf(argv, BACKUP_DIR_FLAG) !== undefined) {
    throw new Error(`${BACKUP_DIR_FLAG} only applies to ${DB_FLAG} twin.`);
  }
  return { dataPath: { kind: "ephemeral", ...(pgDataDir ? { pgDataDir } : {}) }, warnings };
}

// --- what the boot says and generates ----------------------------------------

/**
 * The compose overlay for a boot that starts no `postgres` service.
 *
 * Both non-ephemeral modes need the identical structural edit — remove the
 * service, remove the volume, drop every `depends_on` edge — so this reuses
 * externalPgOverlayYaml() rather than growing a second generator that could
 * drift from it. Only the leading comment differs, and it is prepended rather
 * than substituted so the generated body stays byte-identical to the form
 * scripts/tests/unit/demo-external-pg.test.ts already pins.
 */
export function dataPathOverlayYaml(dp: ResolvedDataPath): string {
  // Narrowed on `kind` rather than via usesComposePostgres() so the compiler —
  // not just the reader — knows the remaining variants carry a redactedUrl.
  if (dp.kind === "ephemeral") {
    throw new Error(`${dp.kind} boots the compose postgres service — it needs no overlay.`);
  }
  const header =
    dp.kind === "twin"
      ? `# ${DB_FLAG} twin: the stack talks to a LOCAL THROWAWAY container holding a\n` +
        `# restored copy of production. Container ${dp.container}, volume ${dp.volume}.\n`
      : "";
  return header + externalPgOverlayYaml(dp.redactedUrl);
}

/**
 * What teardown kept, if anything — the parenthetical in "postgres data kept (…)".
 *
 * `undefined` for external, which is the case that was WRONG before the union:
 * cleanup() named `<project>_pgdata` unconditionally, so an --external-pg boot
 * reported keeping a volume it had never created, and pointed demo:clean at
 * storage that does not exist. Only ephemeral has a compose volume or a bind
 * dir; only twin has its own; external has neither.
 */
export function keptDataDescription(
  dp: ResolvedDataPath,
  project: string,
  pgDataDir?: string,
): string | undefined {
  if (dp.kind === "external") return undefined;
  if (dp.kind === "twin") return `twin volume ${dp.volume}`;
  return pgDataDir ? `--pg-data dir ${pgDataDir}` : `volume ${project}_pgdata`;
}

/**
 * The boot banner, stated once and loudly.
 *
 * Each mode's banner names the consequence an operator would otherwise discover
 * afterwards, and they are deliberately NOT variations on one sentence: what is
 * true of external is false of twin and vice versa.
 */
export function bannerFor(dp: ResolvedDataPath): string {
  const rule = "[demo] ############################################################";
  if (dp.kind === "ephemeral") {
    return dp.pgDataDir
      ? `[demo] ${PG_DATA_FLAG}: postgres data is bound to ${dp.pgDataDir} and survives teardown.`
      : `[demo] ${DB_FLAG} ephemeral: the demo's own postgres container (data kept in a named volume).`;
  }
  if (dp.kind === "external") {
    return [
      rule,
      `[demo] # ${DB_FLAG} external: NO postgres container will be started.`,
      `[demo] # target: ${dp.redactedUrl}`,
      `[demo] # source: .env (${dp.source})`,
      `[demo] # This database is SOMEONE ELSE'S. This boot RUNS MIGRATIONS AND`,
      `[demo] # SEEDS against that server, and its workers write to it until the`,
      `[demo] # demo is stopped. Nothing in demo:down or demo:clean can undo`,
      `[demo] # that — those only ever touch containers and Docker volumes, and`,
      `[demo] # there are none here.`,
      rule,
    ].join("\n");
  }
  return [
    rule,
    `[demo] # ${DB_FLAG} twin: a LOCAL THROWAWAY COPY of production data.`,
    `[demo] # restored from: backup ${dp.stamp}`,
    `[demo] # container: ${dp.container}   volume: ${dp.volume}`,
    `[demo] # There is NO network path from this boot to production. Every write`,
    `[demo] # lands in the copy.`,
    `[demo] #`,
    `[demo] # THE COPY OUTLIVES THIS BOOT. Teardown removes the container and`,
    `[demo] # KEEPS the volume, exactly as an ephemeral boot keeps its pgdata.`,
    `[demo] # It holds real credential material — admin password hashes, session`,
    `[demo] # tokens, member access keys, member emails. Reclaim it with`,
    `[demo] #   bun run demo:clean`,
    rule,
  ].join("\n");
}
