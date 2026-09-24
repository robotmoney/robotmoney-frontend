// THE DATA PATH a smoke boot runs against, as data.
//
// Smoke-production-spec §5 names the whole surface:
//
//   (no flag)            the REMOTE database whose address is in `$HOME/.env`
//   --local blank        a local container smoke owns, empty and bootstrapped
//   --local dump[=<dir>] a local container restored from a production dump
//   --local volume[=<n>] a local container reattached to a previous run's volume
//
// Internally those still land on the three `DbMode`s the boot has always
// branched on: `blank` and `volume` are the compose postgres service
// (`ephemeral`), `dump` is the restored smoke-twin container, and no flag is
// `external`. Wave 3 of issue #1026 replaces those internals; this module is
// where the operator's spelling becomes one of them, and the only place.
//
// THE MODE IS REQUIRED. A bare `--local`, or `--local <path>`, used to read the
// token after it as a bind-mount path, so `--local blank` silently booted a
// postgres data directory bound to a relative folder called `blank`. An enum
// with no default is what makes the spec's own spelling mean what it says.
//
// Two questions with one bit each: WHERE postgres lives (a compose service vs.
// a URL) and WHO OWNS the data (this boot vs. somebody else). A dump needs the
// first half of the remote behaviour and the exact OPPOSITE of the second: it
// dials a URL exactly as the remote does, but every write lands in a copy this
// boot created. They are two exported predicates, ownsData() and
// usesComposePostgres(), because for a dump they disagree.
//
// WHY THE VALIDATOR LIVES HERE TOO. `process.argv.includes()` used to be the
// entire parser, so `--fixed-ports` (a flag that has never existed) was
// SILENTLY IGNORED: the boot came up green on the wrong port. The allowlist and
// the retired-flag refusals ship with the enum, so a mistyped or retired
// spelling can never fall back to a default.
//
// SIDE-EFFECT FREE, apart from the single readFileSync that
// smoke-external-pg.ts's resolver performs for the remote database. Every local
// mode resolves without reading `$HOME/.env` at all ("any `--local` mode makes
// smoke ignore every remote connection value", spec §3), so no remote address
// can reach a local boot. scripts/tests/unit/smoke-db-mode.test.ts drives every
// branch directly.
import {
  externalPgOverlayYaml,
  redactPostgresUrl,
  resolveExternalPg,
} from "./smoke-external-pg.ts";
import type { SmokeCadenceProfile } from "./smoke-cadence.ts";
import type { TargetConnection } from "./smoke-env-policy.ts";

export { redactPostgresUrl };

/** The three data paths the boot branches on internally (see the header). */
export type DbMode = "ephemeral" | "external" | "smoke-twin";

/** The flag that selects a local database, and the three modes it accepts. */
export const LOCAL_FLAG = "--local";
export type LocalMode = "blank" | "dump" | "volume";
export const LOCAL_MODES: readonly LocalMode[] = Object.freeze(["blank", "dump", "volume"]);

/** The flag that EXPLICITLY picks the cadence profile, overriding the one the invocation implies. */
export const CADENCE_FLAG = "--cadence";

/**
 * Run the migrate step this once.
 *
 * NEVER IMPLIED by any `--local` mode (spec §4.3, §8.5): a boot migrates a
 * database only when it was told to. On the remote database smoke-main.ts
 * prompts for the owner password at the terminal, never from an env var or
 * `.env`; see scripts/lib/smoke-external-migrate.ts.
 */
export const MIGRATE_FLAG = "--migrate";

/**
 * Create demo data on a blank database (spec §5): the simulation initializer
 * plus the db-preflight classification that guards it. Explicit, refused on a
 * populated database, and never implied by any mode. `dump` and `volume` are
 * populated by construction and refuse it at parse time.
 */
export const SEED_FLAG = "--seed";

/**
 * Flags spec §1 retires "with no alias", plus two spellings that only ever
 * aliased one of them. Each is REFUSED by name, with the spelling that replaced
 * it: not merely warned about, and not reported as an unknown flag. An operator
 * who typed one of these had a reason, and the refusal owes them the current way
 * to say it. `arity` lets the validator consume a retired flag's value, so
 * `--db external` produces one error rather than one plus a stray positional.
 */
export const RETIRED_FLAGS: readonly { readonly flag: string; readonly arity: 0 | 1; readonly instead: string }[] =
  Object.freeze(
    [
      { flag: "--twin", arity: 0 as const, instead: "use `--local dump`" },
      { flag: "--agents", arity: 1 as const, instead: "the participant roster is the credential file (RM_CREDENTIALS, spec §6.1)" },
      { flag: "--no-tui", arity: 0 as const, instead: "`bun smoke` never draws a TUI; observe with `bun smoke:status` or `bun smoke:tui`" },
      { flag: "--db", arity: 1 as const, instead: "use `--local blank|dump|volume`, or no flag for the remote database" },
      { flag: "--pg-data", arity: 1 as const, instead: "use `--local volume` to reattach a previous run's data" },
      { flag: "--smoke", arity: 0 as const, instead: "a `--local dump` boot is production-shaped by its data; no flag selects it" },
      { flag: "--backup-dir", arity: 1 as const, instead: "use `--local dump=<dir>`" },
      { flag: "--stage", arity: 0 as const, instead: "use `--static-port`" },
    ].map((f) => Object.freeze(f)),
  );

/**
 * The environment variable spec §1 retires with no alias. The compose project
 * is derived from the environment (scripts/stack/naming.ts), never from an
 * exported name, so a shell that still sets it is refused rather than silently
 * obeyed or silently ignored.
 */
export const RETIRED_ENV = "SMOKE_PROJECT";

/**
 * The refusal for the retired environment variable, or null when the
 * environment is clean. Pure: the caller passes its env in and does the exit.
 */
export function refuseRetiredEnv(env: Record<string, string | undefined>): string | null {
  const value = env[RETIRED_ENV];
  if (value === undefined) return null;
  return (
    `${RETIRED_ENV} is retired with no alias (smoke-production-spec §1) and is set to "${value}". ` +
    "The compose project comes from the environment's own identity, never from an exported name. " +
    `Unset it (\`unset ${RETIRED_ENV}\`) and re-run.`
  );
}

/**
 * The data path as REQUESTED at parse time.
 *
 * A dump carries no URL yet: no container exists until the restore runs, which
 * is deliberately not this module's job. `ResolvedDataPath` is the post-restore
 * form. `reattach` marks `--local volume`: the compose postgres service, bound
 * to a volume a previous run left behind instead of a fresh one. Its name is
 * optional here because the default (the last volume this checkout's smoke
 * recorded) lives in the state file, which this pure module does not read.
 */
export type DataPathRequest =
  | { kind: "ephemeral"; reattach?: { volume?: string } }
  | {
      kind: "external";
      url: string;
      redactedUrl: string;
      host: string;
      source: "DATABASE_URL" | "discrete keys";
    }
  | { kind: "smoke-twin"; backupDir?: string };

/**
 * The data path once a dump's container exists. A reattached volume's name is
 * filled in by smoke-main.ts from the last state file before this point, and a
 * boot that cannot name one refuses there.
 */
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
  /**
   * The cadence override this argv carries (`--cadence fast|realistic`), decoded
   * here with the same argv a smoke-main boots, so a bad value is one more
   * invalid invocation that fails in this one try/catch, before any container
   * work. Absent, it is undefined and the cadence resolver picks the profile the
   * invocation shape implies (scripts/lib/smoke-cadence.ts).
   */
  cadence: SmokeCadenceProfile | undefined;
}

/**
 * Can this boot's teardown undo what it wrote?
 *
 * ephemeral ✓ (its own container) · smoke-twin ✓ (a copy it created) · external ✗
 */
export function ownsData(dp: { kind: DbMode }): boolean {
  return dp.kind !== "external";
}

/**
 * Does compose start a `postgres` service for this boot?
 *
 * ephemeral ✓ · smoke-twin ✗ (its container is started outside compose) · external ✗
 *
 * NOT the same question as ownsData(); the dump is the case that proves it.
 */
export function usesComposePostgres(dp: { kind: DbMode }): boolean {
  return dp.kind === "ephemeral";
}

/** Is this database populated by something other than this boot's seed? */
export function isPrePopulated(dp: DataPathRequest | ResolvedDataPath): boolean {
  return dp.kind !== "ephemeral" || dp.reattach !== undefined;
}

/**
 * How spec §4.3's matrix sees this data path (scripts/lib/smoke-env-policy.ts).
 *
 * Every `--local` mode is a local connection and nothing else: the remote
 * address in `$HOME/.env` is not merely outranked, it is never read (spec §3).
 */
export function targetConnection(dp: DataPathRequest | ResolvedDataPath): TargetConnection {
  if (dp.kind === "external") return "remote";
  if (dp.kind === "smoke-twin") return "local-dump";
  return dp.reattach ? "local-volume" : "local-blank";
}

// --- argv --------------------------------------------------------------------

export interface FlagSpec {
  flag: string;
  /** 0 = bare switch, 1 = takes the following token (or `--flag=value`). */
  arity: 0 | 1;
}

/**
 * EVERY flag `bun smoke` accepts. Nothing else may appear.
 *
 * `--rm`, `--no-deps`, `--tail`, `--no-color` and `--transport` also appear in
 * scripts/lib/smoke-main.ts, but as arguments it passes OUT to docker compose
 * and to child scripts. They are not accepted here: adding them would let a
 * real typo through.
 */
export const DEMO_FLAGS: readonly FlagSpec[] = Object.freeze([
  Object.freeze({ flag: LOCAL_FLAG, arity: 1 as const }),
  Object.freeze({ flag: MIGRATE_FLAG, arity: 0 as const }),
  Object.freeze({ flag: SEED_FLAG, arity: 0 as const }),
  Object.freeze({ flag: CADENCE_FLAG, arity: 1 as const }),
  Object.freeze({ flag: "--static-port", arity: 0 as const }),
  // AC-ID-05: a path to a compose overlay pinning every image to an artifact
  // built on pinza and shipped here. Its value is a path, so arity 1.
  Object.freeze({ flag: "--images-override", arity: 1 as const }),
]);

/** Levenshtein, bounded; only ever asked about short flag values. */
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

/** The refusal text for one retired flag. */
function retiredMessage(r: { flag: string; instead: string }): string {
  return `${r.flag} is retired with no alias (smoke-production-spec §1): ${r.instead}.`;
}

/**
 * Every complaint about this argv, or [] when it is clean.
 *
 * LOUD, NEVER SILENT is the whole point: before this existed, an unknown flag
 * was ignored and the boot proceeded on the DEFAULT data path. A retired flag
 * is refused by NAME, with its replacement, rather than as an unknown flag.
 *
 * Reports ALL problems rather than the first, so a mistyped invocation is fixed
 * in one round trip.
 */
export function validateArgv(argv: readonly string[]): string[] {
  const errors: string[] = [];
  const known = new Map(DEMO_FLAGS.map((f) => [f.flag, f]));
  const retired = new Map(RETIRED_FLAGS.map((f) => [f.flag, f]));
  const names = DEMO_FLAGS.map((f) => f.flag);

  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      errors.push(`unexpected argument "${token}": this command takes flags only, no positional arguments.`);
      continue;
    }
    const inline = splitInline(token);
    const flag = inline ? inline.flag : token;
    const gone = retired.get(flag);
    if (gone) {
      errors.push(retiredMessage(gone));
      const next = argv[i + 1];
      if (gone.arity === 1 && !inline && next !== undefined && !next.startsWith("--")) i++;
      continue;
    }
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
        errors.push(
          flag === LOCAL_FLAG
            ? `${LOCAL_FLAG} requires a mode: one of ${LOCAL_MODES.join(" | ")} (spec §5).`
            : `${flag} requires a value (e.g. \`${flag} <value>\`).`,
        );
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
 * Decode one `--local` value: `blank`, `dump`, `dump=<dir>`, `volume` or
 * `volume=<name>`.
 *
 * THROWS on anything else, and in particular on a path, which is what the
 * retired `--local <path>` spelling took and which must never be read as a mode.
 */
export function parseLocalMode(raw: string): { mode: LocalMode; value?: string } {
  const eq = raw.indexOf("=");
  const name = eq >= 0 ? raw.slice(0, eq) : raw;
  const value = eq >= 0 ? raw.slice(eq + 1) : undefined;
  if (!(LOCAL_MODES as readonly string[]).includes(name)) {
    throw new Error(
      `${LOCAL_FLAG} ${raw}: not a local mode.${didYouMean(name, LOCAL_MODES)} ` +
        `Valid modes: ${LOCAL_MODES.join(" | ")} (spec §5). A path is not a mode; ` +
        `reattach a previous run's data with \`${LOCAL_FLAG} volume\`.`,
    );
  }
  const mode = name as LocalMode;
  if (value !== undefined) {
    if (mode === "blank") throw new Error(`${LOCAL_FLAG} blank takes no value (got "${value}").`);
    if (value === "") throw new Error(`${LOCAL_FLAG} ${mode}= requires a value.`);
  }
  return value === undefined ? { mode } : { mode, value };
}

/**
 * The cadence override this argv asks for, or undefined when absent.
 *
 * THROWS on a value that is not a cadence profile: an unknown `--cadence` value
 * must not fall back to the default any more than a mistyped mode may.
 */
export function cadenceOverride(argv: readonly string[]): SmokeCadenceProfile | undefined {
  const value = valueOf(argv, CADENCE_FLAG);
  if (value === undefined) return undefined;
  if (value === "fast" || value === "realistic") return value;
  throw new Error(`--cadence accepts "fast" or "realistic", got "${value}".`);
}

/**
 * Does this argv ask for `--local dump`?
 *
 * Pure, argv-only and NON-THROWING, so a decision that must be made before the
 * full parse can be: the cadence profile is resolved at the top of
 * smoke-main.ts, long before a restore container exists. An invalid `--local`
 * value answers false here and is refused by parseDataPath() moments later.
 */
export function requestsDump(argv: readonly string[]): boolean {
  const raw = valueOf(argv, LOCAL_FLAG);
  if (raw === undefined) return false;
  try {
    return parseLocalMode(raw).mode === "dump";
  } catch {
    return false;
  }
}

/** Does this argv ask to run the migrate step? A bare switch, never implied. */
export function requestsMigrate(argv: readonly string[]): boolean {
  return argv.slice(2).includes(MIGRATE_FLAG);
}

/** Does this argv ask to seed demo data? A bare switch, never implied. */
export function requestsSeed(argv: readonly string[]): boolean {
  return argv.slice(2).includes(SEED_FLAG);
}

/**
 * Does this boot run the demo initializer and the db-preflight that guards it?
 *
 * Only when `--seed` was given. No mode implies it (spec §5: "`--seed` … is
 * explicit … and is never implied by any mode"). A dump used to seed
 * automatically, which is exactly the implication the spec forbids.
 */
export function shouldSeed(argv: readonly string[]): boolean {
  return requestsSeed(argv);
}

/** What the boot's read-only preflight runs, between postgres and migrate(). */
export interface BootPreflightPlan {
  /** scripts/db-preflight.ts: classifies a database `--seed` is about to write. */
  classify: boolean;
  /** backend/scripts/schema-current.ts: refuses a schema this code is ahead of. */
  schemaCurrent: boolean;
}

/**
 * Decide the boot's preflight from the data path and the two mutation flags.
 *
 * SCHEMA CURRENCY ON EVERY PATH THAT SKIPS MIGRATE. No mode implies `--migrate`
 * (spec §4.3, §5), so a boot without it runs on whatever schema the database
 * already holds. Spec §7 check 3 asks, "against any database", whether the
 * booting code supports that schema, and refuses if not. A restored dump is on
 * production's schema from when it was taken, and a reattached volume is on
 * whatever the last boot left: both are usually behind this checkout. Keying
 * the check on the remote path alone (as it once was) let a stale dump boot
 * current code on an old schema, with no refusal. A blank database has no
 * schema at all until the snapshot bootstrap lands, so it refuses too.
 *
 * The classify step is unchanged: it guards `--seed`, and only a database this
 * boot did not create itself needs classifying.
 */
export function bootPreflightPlan(opts: { composePostgres: boolean; seeds: boolean; migrates: boolean }): BootPreflightPlan {
  return {
    classify: opts.seeds && !opts.composePostgres,
    schemaCurrent: !opts.migrates,
  };
}

/** The `--local` mode a resolved data path came from, or null for the remote database. */
export function localModeOf(dp: DataPathRequest | ResolvedDataPath): LocalMode | null {
  if (dp.kind === "smoke-twin") return "dump";
  if (dp.kind === "ephemeral") return dp.reattach ? "volume" : "blank";
  return null;
}

/** One running container that mounts a volume: `docker ps --filter volume=…`. */
export interface VolumeHolder {
  container: string;
  /** The `com.docker.compose.project` label, empty when the container has none. */
  project: string;
}

/** Parse `docker ps --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}'`. */
export function parseVolumeHolders(stdout: string): VolumeHolder[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const [container = "", project = ""] = l.split("\t");
      return { container: container.trim(), project: project.trim() };
    });
}

/**
 * Refuse `--local volume` while a running container still mounts the volume.
 *
 * The saved volume is usually the LAST boot's, and that boot is usually still
 * up: the state file is rewritten by every boot, not by teardown. A second
 * postgres on the same data directory is two writers on one cluster. Both run
 * postgres as PID 1 in their own PID namespace, so postmaster.pid does not
 * reliably stop the second one. Refused, with the holder named, before any
 * overlay is written or container created.
 */
export function refuseVolumeInUse(volume: string, holders: readonly VolumeHolder[]): string | null {
  if (holders.length === 0) return null;
  const named = holders
    .map((h) => (h.project ? `${h.container} (project ${h.project})` : h.container))
    .join(", ");
  const projects = [...new Set(holders.map((h) => h.project).filter((p) => p.length > 0))];
  const other = projects.length > 0
    ? projects.map((p) => `\`docker compose -p ${p} down\``).join(" / ")
    : "`docker stop <container>`";
  return (
    `${LOCAL_FLAG} volume=${volume}: the volume is still mounted by a running container: ${named}. ` +
    `A second postgres on the same data directory is two writers on one cluster. Stop the holder first: ` +
    `\`bun smoke:down\` if it is the boot this checkout last recorded, otherwise ${other} ` +
    `(never with -v, which deletes the volume). Then re-run.`
  );
}

/**
 * Resolve the data path this argv asks for.
 *
 * THROWS with an actionable message rather than falling back: silently booting
 * a throwaway database when the operator asked for a real one (or the reverse)
 * looks healthy while being completely wrong. Every rejection happens HERE,
 * before any I/O beyond reading `$HOME/.env` for the remote database, so a dump
 * never discovers its own invalidity after a multi-minute restore.
 */
export function parseDataPath(argv: readonly string[], opts: { envFilePath: string }): ParsedDataPath {
  const argErrors = validateArgv(argv);
  if (argErrors.length > 0) {
    throw new Error(
      `invalid arguments:\n  - ${argErrors.join("\n  - ")}\n` +
        `Nothing was started. (Unknown flags used to be ignored, which booted the DEFAULT ` +
        `data path while looking like the one you asked for.)`,
    );
  }
  const cadence = cadenceOverride(argv);

  if (!has(argv, LOCAL_FLAG)) {
    // The default: the remote database in $HOME/.env. Delegate to the resolver,
    // which throws for every bad-.env case, handing it a canonical argv.
    const ext = resolveExternalPg(["--db", "external"], { envFilePath: opts.envFilePath });
    return {
      dataPath: {
        kind: "external",
        url: ext.url!,
        redactedUrl: ext.redactedUrl!,
        host: ext.host!,
        source: ext.source!,
      },
      cadence,
    };
  }

  // A local mode. `$HOME/.env` is NOT read below this line: every remote
  // connection value is ignored, not merely outranked (spec §3).
  const local = parseLocalMode(valueOf(argv, LOCAL_FLAG)!);
  if (local.mode !== "blank" && has(argv, SEED_FLAG)) {
    throw new Error(
      `${SEED_FLAG} cannot be used with ${LOCAL_FLAG} ${local.mode}: it refuses a populated database, ` +
        `and a ${local.mode === "dump" ? "restored dump" : "reattached volume"} is populated (spec §5).`,
    );
  }
  if (local.mode === "dump") {
    return { dataPath: { kind: "smoke-twin", ...(local.value ? { backupDir: local.value } : {}) }, cadence };
  }
  if (local.mode === "volume") {
    return { dataPath: { kind: "ephemeral", reattach: local.value ? { volume: local.value } : {} }, cadence };
  }
  return { dataPath: { kind: "ephemeral" }, cadence };
}

/**
 * The compose overlay that reattaches `--local volume`'s saved volume.
 *
 * GENERATED, never committed: it encodes one invocation's choice. The service
 * mount is replaced by target path (compose merges service volumes by target),
 * and the top-level entry is `external`, so no later `docker compose down -v`
 * from this project can delete the data it points at.
 */
export function reattachOverlayYaml(volume: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume)) {
    throw new Error(`${LOCAL_FLAG} volume=${volume}: not a Docker volume name.`);
  }
  return (
    `# GENERATED by scripts/lib/smoke-main.ts for \`bun smoke ${LOCAL_FLAG} volume\`.\n` +
    `# Reattaches the saved volume ${volume}; safe to delete when no smoke uses it.\n` +
    `services:\n  postgres:\n    volumes:\n      - rm_reattached_pgdata:/var/lib/postgresql/data\n` +
    `volumes:\n  rm_reattached_pgdata:\n    external: true\n    name: ${volume}\n`
  );
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
      ? `# ${LOCAL_FLAG} dump: the stack talks to a LOCAL THROWAWAY container holding a\n` +
        `# restored copy of production. Container ${dp.container}, volume ${dp.volume}.\n`
      : "";
  return header + externalPgOverlayYaml(dp.redactedUrl);
}

/**
 * What teardown kept, if anything — the parenthetical in "postgres data kept (…)".
 *
 * `undefined` for external, which is the case that was WRONG before the union:
 * reported keeping a volume it had never created, and pointed smoke:clean at
 * storage that does not exist. Only a blank or reattached boot has a compose
 * volume; only a dump has its own; the remote database has neither.
 */
export function keptDataDescription(dp: ResolvedDataPath, project: string): string | undefined {
  if (dp.kind === "external") return undefined;
  if (dp.kind === "smoke-twin") return `dump volume ${dp.volume}`;
  return `volume ${dp.reattach?.volume ?? `${project}_pgdata`}`;
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
    return dp.reattach
      ? `[smoke] ${LOCAL_FLAG} volume: reattaching the saved volume ${dp.reattach.volume ?? "(unnamed)"} (data survives teardown).`
      : `[smoke] ${LOCAL_FLAG} blank: the smoke's own postgres container (data kept in a named volume).`;
  }
  if (dp.kind === "external") {
    return [
      rule,
      `[smoke] # remote database: NO postgres container will be started.`,
      `[smoke] # target: ${dp.redactedUrl}`,
      `[smoke] # source: $HOME/.env (${dp.source})`,
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
    `[smoke] # ${LOCAL_FLAG} dump: a LOCAL THROWAWAY COPY of production data.`,
    `[smoke] # restored from: backup ${dp.stamp}`,
    `[smoke] # container: ${dp.container}   volume: ${dp.volume}`,
    `[smoke] # There is NO network path from this boot to production. Every write`,
    `[smoke] # lands in the copy.`,
    `[smoke] #`,
    `[smoke] # THE COPY OUTLIVES THIS BOOT. Teardown removes the container and`,
    `[smoke] # KEEPS the volume, exactly as a blank boot keeps its pgdata.`,
    `[smoke] # It holds real credential material — admin password hashes, session`,
    `[smoke] # tokens, member access keys, member emails. Reclaim it with`,
    `[smoke] #   bun run smoke:clean`,
    rule,
  ].join("\n");
}
