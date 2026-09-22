// THE DATA PATH a smoke/smoke boot runs against, as data.
//
// boolean:
//
//   --db ephemeral   the smoke's own postgres container (the default; unchanged)
//   --db external    a managed server whose address comes from `.env`
//   --db smoke-twin        a local throwaway container restored from a production dump
//
// questions with one bit: WHERE postgres lives (a compose service vs. a URL)
// and WHO OWNS the data (this boot vs. somebody else). A digital smoke-twin needs the
// first half of external's behaviour and the exact OPPOSITE of the second — it
// dials a URL exactly as external does, but every write lands in a copy this
// boot created and may reclaim. Adding a second boolean would have made the two
// banner ("nothing in smoke:down or smoke:clean can undo that") printing over a
// database that is, in fact, this run's to delete. A union makes the invalid
// combinations unrepresentable and turns the hand-written FATAL pairs in
// smoke-main.ts into exhaustiveness.
//
// The two questions are now two exported predicates — ownsData() and
// usesComposePostgres() — because the codebase branches on BOTH today under the
// single name `externalPg.enabled`, and for a smoke-twin they disagree.
//
// `--pg-data` (see smoke-external-pg.ts's header and smoke-main.ts's): pointing a
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
// smoke-external-pg.ts's resolver performs for `--db external`. Everything here
// is a DECISION, so scripts/tests/unit/smoke-db-mode.test.ts drives every branch
// directly instead of grepping it out of a boot. Deprecation warnings are
// RETURNED rather than printed for the same reason.
import {
  assertReachableFromContainer,
  externalPgOverlayYaml,
  redactPostgresUrl,
  resolveExternalPg,
} from "./smoke-external-pg.ts";

export { redactPostgresUrl };

/** The flag that selects a data path, and the three values it accepts. */
export const DB_FLAG = "--db";
export type DbMode = "ephemeral" | "external" | "smoke-twin";
export const DB_MODES: readonly DbMode[] = Object.freeze(["ephemeral", "external", "smoke-twin"]);

/** Where a `--db smoke-twin` boot looks for its encrypted dump, when not the default. */
export const BACKUP_DIR_FLAG = "--backup-dir";
/** The scenario flag a smoke-twin REQUIRES. Owned by smoke-mode.ts; named here to explain a refusal. */
const SMOKE_FLAG = "--smoke";
const PG_DATA_FLAG = "--pg-data";

/**
 * Opts an `--db external` boot into running migrations this once.
 *
 * Absent (the default), `up()` skips migrate() outright for external: rm_app
 * cannot `SET LOCAL ROLE rm_owner` (backend/src/db/migrate.ts), so an unopted
 * boot against a production server with pending migrations would otherwise
 * die mid-boot instead of just serving today's schema. Present, smoke-main.ts
 * prompts for the doadmin password at the terminal — never an env var, never
 * `.env` — and runs migrate() with it for this run only. See
 * scripts/lib/smoke-external-migrate.ts for why it prompts rather than reads.
 */
export const MIGRATE_FLAG = "--migrate";

/**
 * Opts an `--db external` boot into SEEDING (initializing) the database.
 *
 * "Seeding" here is the scenario initializer — the archive restore/adopt
 * (`prod-bootstrap.ts`) for a `--smoke` boot, or the simulation fixture seed
 * otherwise — plus the db-preflight classification that guards it
 * (`scripts/lib/smoke-external-pg.ts`'s `dbPreflightArgv`). It is NOT the tiny
 * `seed()` of job-schedule rows inside `migrate()`; that one rides with
 * `--migrate`, because it only makes sense once the schema is current.
 *
 * Absent (the default), an external boot runs NEITHER the initializer nor its
 * preflight: it just brings the services up against the database exactly as it
 * is. That is what a restart is, and it is why a bare `--db external` boot no
 * longer refuses a populated production database — there is nothing trying to
 * write fixtures for the preflight to refuse.
 *
 * Present, the initializer and its preflight run as they always have. On an
 * EMPTY external database both `--migrate` and `--seed` are needed (migrate
 * creates the schema, seed fills it); on a populated one a restart needs
 * neither. The two are independent flags because those are independent
 * decisions — symmetric to `--migrate`, and for the same reason `up()` never
 * writes to a database it does not own without being told to.
 *
 * `ephemeral` and `smoke-twin` own their data and always seed; the flag is
 * refused on them (parseDataPath), exactly as `--migrate` is.
 */
export const SEED_FLAG = "--seed";

/**
 * Use a LOCAL database container instead of the remote database in `$HOME/.env`.
 *
 * Bare (`--local`) starts a fresh container. With a value (`--local <path>` or
 * `--local=<path>`) it reuses a saved docker volume at that path, so a database
 * an earlier local run left behind can be restarted. The value is optional —
 * this is the one flag whose following token may or may not be present.
 *
 * Absent `--local` and `--twin`, a boot connects to the REMOTE database. That is
 * the default: `.env` supplies an address, and smoke assumes it unless told to
 * go local.
 */
export const LOCAL_FLAG = "--local";

/**
 * Prepare a local database from a dump of the LATEST remote database, with every
 * key rotated so the copy is safe to work with, and boot against it. A twin is a
 * local database by construction, so `--twin` is used on its own, never with
 * `--local`. It may be migrated; it cannot be seeded (it is already full).
 */
export const TWIN_FLAG = "--twin";

// WHAT `--pg-data <host-dir>` MEANS, and why it rides on the ephemeral variant.
//
// It bind-mounts the postgres data directory to <host-dir> so a rebooted smoke
// restarts from where it left off. A CLI ARGUMENT, never an env var (hard user
// preference, 2026-07-21: no per-property env config) — the resolved value is
// recorded in smoke-state.json instead.
//
// Reuse constraints (also in docs/architecture.md): the same postgres major and
// the same baked-in smoke credentials; migrate + seed are idempotent
// (backend/src/db/seed.ts uses ON CONFLICT DO NOTHING), so re-booting on old
// data converges rather than duplicating rows.
//
// Bind mounts were verified EMPIRICALLY on this Linux host: the postgres image's
// entrypoint chowns the bind dir to its own container user and inits / resumes
// cleanly, so the documented named-volume fallback was NOT needed. The data dir
// ends up postgres-owned on the host — manage it with your own tooling;
// smoke:clean never touches --pg-data host dirs (they are not docker volumes).
//
// Absent the flag, every run keeps today's fresh-per-run behaviour: a named
// volume <project>_pgdata (labelled robotmoney.smoke=1 by docker-compose.smoke.yml).
//
// It is a PAYLOAD ON `ephemeral`, not a flag of its own, because it only means
// anything when there IS a compose postgres container to bind. Pairing it with
// external or smoke-twin is therefore unrepresentable rather than rejected by a
// hand-written precedence check — which is what smoke-main.ts used to carry.

/**
 * The data path as REQUESTED at parse time.
 *
 * A smoke-twin carries no URL yet: no container exists until the restore runs, which
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
  | { kind: "smoke-twin"; backupDir?: string };

/** The data path once a smoke-twin's container exists. Only `smoke-twin` gains anything. */
export type ResolvedDataPath =
  | Extract<DataPathRequest, { kind: "ephemeral" }>
  | Extract<DataPathRequest, { kind: "external" }>
  | {
      kind: "smoke-twin";
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
 * ephemeral ✓ (its own container) · smoke-twin ✓ (a copy it created) · external ✗
 *
 * This is the question `smoke:down`'s "the EXTERNAL database is untouched" and
 * `printResumeHint()`'s reclaim advice are really asking.
 */
export function ownsData(dp: { kind: DbMode }): boolean {
  return dp.kind !== "external";
}

/**
 * Does compose start a `postgres` service for this boot?
 *
 * ephemeral ✓ · smoke-twin ✗ (its container is started outside compose) · external ✗
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
  /** 0 = bare switch, 1 = takes the following token (or `--flag=value`),
   *  "?" = OPTIONAL following token (bare, `--flag=value`, or `--flag value`). */
  arity: 0 | 1 | "?";
}

/**
 * EVERY flag `bun run smoke` / `bun smoke` accepts. Nothing else may appear.
 *
 * Verified against every `process.argv` read in scripts/lib/smoke-main.ts
 * (`:141`, `:143-144`, `:220`, `:327-328`, `:504`) — note that `--rm`,
 * `--no-deps`, `--tail`, `--no-color`, `--transport` and `--already-migrated`
 * also appear in that file but are arguments smoke-main passes OUT to docker
 * compose and to child scripts; they are not accepted here, and adding them
 * would let a real typo through.
 */
export const DEMO_FLAGS: readonly FlagSpec[] = Object.freeze([
  Object.freeze({ flag: LOCAL_FLAG, arity: "?" as const }),
  Object.freeze({ flag: TWIN_FLAG, arity: 0 as const }),
  Object.freeze({ flag: MIGRATE_FLAG, arity: 0 as const }),
  Object.freeze({ flag: SEED_FLAG, arity: 0 as const }),
  Object.freeze({ flag: BACKUP_DIR_FLAG, arity: 1 as const }),
  Object.freeze({ flag: "--static-port", arity: 0 as const }),
  Object.freeze({ flag: "--stage", arity: 0 as const }),
  Object.freeze({ flag: "--no-tui", arity: 0 as const }),
  // Deprecated spellings, still accepted (with a warning) — see parseDataPath.
  Object.freeze({ flag: DB_FLAG, arity: 1 as const }),
  Object.freeze({ flag: PG_DATA_FLAG, arity: 1 as const }),
  Object.freeze({ flag: SMOKE_FLAG, arity: 0 as const }),
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
    if (spec.arity === "?") {
      // Optional value: bare is fine, `--flag=value` is fine, and a following
      // non-flag token is consumed as the value so it is not flagged as a stray
      // positional. Nothing is ever an error here.
      if (inline) continue;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) i++;
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
 * ordering is load-bearing for the smoke-twin: discovering `--db smoke-twin` is invalid
 * after a gpg decrypt and a multi-minute pg_restore wastes the window the
 * rehearsal exists to protect.
 */
/**
 * Does this argv ask for the smoke-twin data path?
 *
 * Pure and argv-only, so a decision that must be made BEFORE the full parse can
 * be — the cadence profile is resolved at the top of smoke-main.ts, long before
 * a restore container exists. Deliberately not a second parser: it answers one
 * boolean and leaves every other question to parseDataPath().
 */
export function requestsTwin(argv: readonly string[]): boolean {
  if (has(argv, TWIN_FLAG)) return true;
  const i = argv.indexOf(DB_FLAG); // deprecated spelling
  return i >= 0 && argv[i + 1] === "smoke-twin";
}

/** Does this argv opt an external boot into running migrations? A bare switch,
 *  so — unlike requestsTwin() — there is no value to look up. */
export function requestsMigrate(argv: readonly string[]): boolean {
  return argv.slice(2).includes(MIGRATE_FLAG);
}

/** Does this argv opt an external boot into seeding (the scenario initializer
 *  and its preflight)? A bare switch, like requestsMigrate(). Orthogonal to the
 *  scenario: `--seed` runs whatever `--smoke` selected (archive) or did not
 *  (the simulation/demo seed of a blank database). */
export function requestsSeed(argv: readonly string[]): boolean {
  return argv.slice(2).includes(SEED_FLAG);
}

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

  // ── Resolve the database from the flags ───────────────────────────────────
  // Default is REMOTE (the server in $HOME/.env). `--local [path]` picks a local
  // container; `--twin` a dump-derived local database. The old spelling — `--db
  // <mode>`, `--pg-data`, `--smoke` — is still accepted, with a deprecation
  // warning, and maps onto the same internal DbMode.
  const wantsTwin = has(argv, TWIN_FLAG);
  const wantsLocal = has(argv, LOCAL_FLAG);
  const localPath = valueOf(argv, LOCAL_FLAG) ?? valueOf(argv, PG_DATA_FLAG);

  const rawDb = valueOf(argv, DB_FLAG);
  const dbFlagPresent = has(argv, DB_FLAG);
  if (dbFlagPresent && rawDb === undefined) {
    throw new Error(`${DB_FLAG} requires a value — one of: ${DB_MODES.join(" | ")}.`);
  }
  if (rawDb !== undefined && !DB_MODES.includes(rawDb as DbMode)) {
    throw new Error(
      `${DB_FLAG} ${rawDb}: unknown data path.${didYouMean(rawDb, DB_MODES)} Valid modes: ${DB_MODES.join(" | ")}.`,
    );
  }

  if (dbFlagPresent)
    warnings.push(`${DB_FLAG} is deprecated — use ${LOCAL_FLAG} (local), ${TWIN_FLAG} (twin), or omit it for the remote database.`);
  if (has(argv, PG_DATA_FLAG)) warnings.push(`${PG_DATA_FLAG} is deprecated — use \`${LOCAL_FLAG} <path>\`.`);
  if (has(argv, SMOKE_FLAG)) warnings.push(`${SMOKE_FLAG} is deprecated and no longer needed — ${TWIN_FLAG} and ${SEED_FLAG} say what to do.`);

  const explicitTwin = wantsTwin || rawDb === "smoke-twin";
  const explicitExternal = rawDb === "external";

  if (wantsTwin && wantsLocal) {
    throw new Error(`${TWIN_FLAG} and ${LOCAL_FLAG} are mutually exclusive — a twin IS a local database.`);
  }
  if (localPath !== undefined && (explicitTwin || explicitExternal)) {
    throw new Error(
      `a database path (\`${LOCAL_FLAG} <path>\`) only applies to a local database; ` +
        `${explicitExternal ? "the remote server owns its own storage" : "a twin owns its own volume"}.`,
    );
  }

  let mode: DbMode;
  if (explicitTwin) mode = "smoke-twin";
  else if (wantsLocal || localPath !== undefined || rawDb === "ephemeral") mode = "ephemeral";
  else mode = "external"; // the default: the remote database in $HOME/.env

  const pgDataDir = mode === "ephemeral" ? localPath : undefined;

  if (mode === "smoke-twin" && has(argv, SEED_FLAG)) {
    throw new Error(`${SEED_FLAG} cannot be used with ${TWIN_FLAG} — a twin is restored full, so there is nothing to seed.`);
  }

  if (mode !== "smoke-twin" && valueOf(argv, BACKUP_DIR_FLAG) !== undefined) {
    throw new Error(`${BACKUP_DIR_FLAG} only applies to ${TWIN_FLAG} — it names the dump a twin restores from.`);
  }

  if (mode === "smoke-twin") {
    // A restored smoke-twin is POPULATED by definition, and db-preflight.ts refuses a
    // A twin implies its own scenario — it is a restored, POPULATED database, so
    // the boot never runs the simulation seed against it (that is what the
    // `--seed`-with-`--twin` refusal above enforces). `--twin` no longer needs a
    // separate scenario flag to say so.
    return { dataPath: { kind: "smoke-twin", backupDir: valueOf(argv, BACKUP_DIR_FLAG) }, warnings };
  }

  if (mode === "external") {
    // Delegate to the existing resolver, which already throws for every bad-.env
    // case and is what  pins. It keys
    // off so hand it a canonical argv rather than this one.
    const ext = resolveExternalPg(["--db", "external"], {
      envFilePath: opts.envFilePath,
    });
    return {
      dataPath: {
        kind: "external",
        url: ext.url!,
        redactedUrl: ext.redactedUrl!,
        host: ext.host!,
        source: ext.source!,
      },
      warnings,
    };
  }

  if (valueOf(argv, BACKUP_DIR_FLAG) !== undefined) {
    throw new Error(`${BACKUP_DIR_FLAG} only applies to ${DB_FLAG} smoke-twin.`);
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
 *  already pins.
 */
export function dataPathOverlayYaml(dp: ResolvedDataPath): string {
  // Narrowed on `kind` rather than via usesComposePostgres() so the compiler —
  // not just the reader — knows the remaining variants carry a redactedUrl.
  if (dp.kind === "ephemeral") {
    throw new Error(`${dp.kind} boots the compose postgres service — it needs no overlay.`);
  }
  const header =
    dp.kind === "smoke-twin"
      ? `# ${DB_FLAG} smoke-twin: the stack talks to a LOCAL THROWAWAY container holding a\n` +
        `# restored copy of production. Container ${dp.container}, volume ${dp.volume}.\n`
      : "";
  return header + externalPgOverlayYaml(dp.redactedUrl);
}

/**
 * What teardown kept, if anything — the parenthetical in "postgres data kept (…)".
 *
 * `undefined` for external, which is the case that was WRONG before the union:
 * reported keeping a volume it had never created, and pointed smoke:clean at
 * storage that does not exist. Only ephemeral has a compose volume or a bind
 * dir; only smoke-twin has its own; external has neither.
 */
export function keptDataDescription(
  dp: ResolvedDataPath,
  project: string,
  pgDataDir?: string,
): string | undefined {
  if (dp.kind === "external") return undefined;
  if (dp.kind === "smoke-twin") return `smoke-twin volume ${dp.volume}`;
  return pgDataDir ? `--pg-data dir ${pgDataDir}` : `volume ${project}_pgdata`;
}

/**
 * The boot banner, stated once and loudly.
 *
 * Each mode's banner names the consequence an operator would otherwise discover
 * afterwards, and they are deliberately NOT variations on one sentence: what is
 * true of external is false of smoke-twin and vice versa.
 */
export function bannerFor(dp: ResolvedDataPath): string {
  const rule = "[smoke] ############################################################";
  if (dp.kind === "ephemeral") {
    return dp.pgDataDir
      ? `[smoke] ${PG_DATA_FLAG}: postgres data is bound to ${dp.pgDataDir} and survives teardown.`
      : `[smoke] ${DB_FLAG} ephemeral: the smoke's own postgres container (data kept in a named volume).`;
  }
  if (dp.kind === "external") {
    return [
      rule,
      `[smoke] # ${DB_FLAG} external: NO postgres container will be started.`,
      `[smoke] # target: ${dp.redactedUrl}`,
      `[smoke] # source: .env (${dp.source})`,
      `[smoke] # This database is SOMEONE ELSE'S. This boot RUNS MIGRATIONS AND`,
      `[smoke] # SEEDS against that server, and its workers write to it until the`,
      `[smoke] # smoke is stopped. Nothing in smoke:down or smoke:clean can undo`,
      `[smoke] # that — those only ever touch containers and Docker volumes, and`,
      `[smoke] # there are none here.`,
      rule,
    ].join("\n");
  }
  return [
    rule,
    `[smoke] # ${DB_FLAG} smoke-twin: a LOCAL THROWAWAY COPY of production data.`,
    `[smoke] # restored from: backup ${dp.stamp}`,
    `[smoke] # container: ${dp.container}   volume: ${dp.volume}`,
    `[smoke] # There is NO network path from this boot to production. Every write`,
    `[smoke] # lands in the copy.`,
    `[smoke] #`,
    `[smoke] # THE COPY OUTLIVES THIS BOOT. Teardown removes the container and`,
    `[smoke] # KEEPS the volume, exactly as an ephemeral boot keeps its pgdata.`,
    `[smoke] # It holds real credential material — admin password hashes, session`,
    `[smoke] # tokens, member access keys, member emails. Reclaim it with`,
    `[smoke] #   bun run smoke:clean`,
    rule,
  ].join("\n");
}
