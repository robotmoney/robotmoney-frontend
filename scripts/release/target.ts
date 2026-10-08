// scripts/release/target.ts — the release target file (D61 rule 2).
//
// A target file names WHERE a release run acts: the host, the checkout, the
// instance, the policy (`RM_ENV`), the home directory whose `~/.env` the
// commands read, the capture host, the legacy stack it replaces and the
// database the writes must confirm. It never names WHAT runs: the step list
// (./steps.ts) is one list for every target. Stage and production differ only
// in their target file, which is what makes a stage run a rehearsal of the
// production run.
//
// The schema is closed: an unknown key refuses. A key nobody reads is a value
// an operator believes changes the run while it changes nothing.
//
// Pure apart from loadTarget's one readFileSync, so every refusal is a unit
// test (scripts/tests/unit/release-run.test.ts).
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** The value a target file carries until the operator fills in the real database. */
export const CONFIRM_TARGET_PLACEHOLDER = "FILL-ME:host:port/database-from-the-host-env";

/** `host:port/database`, the form `--confirm-target` takes (D61, the confirmation). */
export const CONFIRM_TARGET_RE = /^[A-Za-z0-9.-]+:[0-9]{1,5}\/[A-Za-z0-9_.-]+$/;

/**
 * Non-secret settings the boot exports to the containers (runbook R6.2a, issue
 * 1113). A secret never goes here: the values reach a process argument, and
 * D61 keeps every secret out of process arguments. `BASE_RPC_URL` is left out
 * for that reason, because a private RPC URL carries its key.
 */
export const BOOT_ENV_KEYS: readonly string[] = Object.freeze([
  "WEBAUTHN_ORIGIN",
  "WEBAUTHN_RP_ID",
  "BASE_RPC_MAX_CALLS_PER_SEC",
  "BASE_RPC_RATE_BURST",
  "WALLET_BACKFILL_MAX_DAYS_PER_RUN",
  "WALLET_BACKFILL_MAX_ATTEMPTS_PER_DAY",
  "GECKO_OHLCV_MIN_INTERVAL_MS",
  "PG_NAMESPACE_GUARD_TIMEOUT_MS",
]);

export interface LegacyStack {
  /** The old checkout. Section 8 renames it after the migrate. */
  readonly checkout: string;
  /** The tmux session that drives the old stack. */
  readonly tmuxSession: string;
  /** The old stack's compose project name. */
  readonly composeProject: string;
  /** Compose files, relative to the old checkout, when `-p` alone is not enough. */
  readonly composeFiles: readonly string[];
  /** How the old stack was started, for the plan and the report. */
  readonly startedBy: string;
  /** The release the old checkout runs; the rename suffix is `.<version>-retired`. */
  readonly version: string;
}

export interface CaptureHost {
  readonly host: string;
  /** HOME on the capture host: its `~/.env` holds `rm_readonly` against production's replica. */
  readonly home: string;
  /** A checkout on the capture host at the same commit. */
  readonly checkout: string;
}

export interface ReleaseTarget {
  /** From the file name: `targets/<name>.json`. */
  readonly name: string;
  readonly release: string;
  /** Full 40-hex SHA. Required unless `tag` is given. */
  readonly commit?: string;
  /** A tag that must resolve to `commit` when both are given. */
  readonly tag?: string;
  readonly rmEnv: "stage" | "prod";
  /** The ssh host alias. */
  readonly host: string;
  readonly checkout: string;
  /** HOME on the host for every command. Its `.env` is the target's credential file. */
  readonly home: string;
  readonly instance: string;
  /** The public origin, for the identity check (R7.1). */
  readonly publicOrigin: string;
  readonly capture: CaptureHost;
  readonly legacy: LegacyStack;
  /** `host:port/database`; every write's `--confirm-target`. */
  readonly confirmTarget: string;
  readonly bootEnv: Readonly<Record<string, string>>;
}

const TOP_KEYS = ["release", "commit", "tag", "rmEnv", "host", "checkout", "home", "instance", "publicOrigin", "capture", "legacy", "confirmTarget", "bootEnv", "$comment"];
const CAPTURE_KEYS = ["host", "home", "checkout"];
const LEGACY_KEYS = ["checkout", "tmuxSession", "composeProject", "composeFiles", "startedBy", "version"];

const SHA_RE = /^[0-9a-f]{40}$/;
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ABS_PATH_RE = /^\/[A-Za-z0-9._\/-]*$/;
const TMUX_RE = /^[A-Za-z0-9_.-]+$/;

/** One problem per line; empty means the file is valid. */
export function validateTarget(name: string, raw: unknown): { target: ReleaseTarget } | { errors: string[] } {
  const errors: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!NAME_RE.test(name)) errors.push(`target name "${name}" must be lowercase letters, digits, - or _`);
  if (!isObj(raw)) return { errors: [...errors, "the target file must be a JSON object"] };

  const unknown = (obj: Record<string, unknown>, allowed: readonly string[], where: string) => {
    for (const key of Object.keys(obj)) if (!allowed.includes(key)) errors.push(`${where}: unknown key "${key}"`);
  };
  const str = (obj: Record<string, unknown>, key: string, where: string, re?: RegExp, optional = false): string | undefined => {
    const v = obj[key];
    if (v === undefined && optional) return undefined;
    if (typeof v !== "string" || v === "") { errors.push(`${where}.${key} must be a non-empty string`); return undefined; }
    if (re && !re.test(v)) errors.push(`${where}.${key} "${v}" does not match ${re}`);
    return v;
  };

  unknown(raw, TOP_KEYS, name);
  const release = str(raw, "release", name, /^v\d+\.\d+\.\d+(-rc\.\d+)?$/);
  const commit = str(raw, "commit", name, SHA_RE, true);
  const tag = str(raw, "tag", name, /^v[0-9A-Za-z.+-]+$/, true);
  if (commit === undefined && tag === undefined) errors.push(`${name}: give commit (full SHA) or tag`);
  const rmEnv = str(raw, "rmEnv", name);
  if (rmEnv !== undefined && rmEnv !== "stage" && rmEnv !== "prod") errors.push(`${name}.rmEnv must be stage or prod`);
  const host = str(raw, "host", name, HOST_RE);
  const checkout = str(raw, "checkout", name, ABS_PATH_RE);
  const home = str(raw, "home", name, ABS_PATH_RE);
  const instance = str(raw, "instance", name, NAME_RE);
  if (rmEnv === "prod" && instance !== undefined && instance !== "rm_prod") errors.push(`${name}: RM_ENV=prod acts on rm_prod only`);
  if (rmEnv === "stage" && instance === "rm_prod") errors.push(`${name}: a stage target never names rm_prod`);
  const publicOrigin = str(raw, "publicOrigin", name, /^https?:\/\/[A-Za-z0-9.:-]+$/);
  const confirmTarget = str(raw, "confirmTarget", name);
  if (confirmTarget !== undefined && confirmTarget !== CONFIRM_TARGET_PLACEHOLDER && !CONFIRM_TARGET_RE.test(confirmTarget)) {
    errors.push(`${name}.confirmTarget must be host:port/database or the placeholder`);
  }

  let capture: CaptureHost | undefined;
  if (!isObj(raw.capture)) errors.push(`${name}.capture must be an object`);
  else {
    unknown(raw.capture, CAPTURE_KEYS, `${name}.capture`);
    const h = str(raw.capture, "host", `${name}.capture`, HOST_RE);
    const ch = str(raw.capture, "home", `${name}.capture`, ABS_PATH_RE);
    const cc = str(raw.capture, "checkout", `${name}.capture`, ABS_PATH_RE);
    if (h && ch && cc) capture = { host: h, home: ch, checkout: cc };
  }

  let legacy: LegacyStack | undefined;
  if (!isObj(raw.legacy)) errors.push(`${name}.legacy must be an object`);
  else {
    const l = raw.legacy;
    unknown(l, LEGACY_KEYS, `${name}.legacy`);
    const lc = str(l, "checkout", `${name}.legacy`, ABS_PATH_RE);
    const ts = str(l, "tmuxSession", `${name}.legacy`, TMUX_RE);
    const cp = str(l, "composeProject", `${name}.legacy`, /^[a-z0-9][a-z0-9_-]*$/);
    const sb = str(l, "startedBy", `${name}.legacy`);
    const lv = str(l, "version", `${name}.legacy`, /^v\d+\.\d+\.\d+$/);
    const files = l.composeFiles ?? [];
    if (!Array.isArray(files) || files.some((f) => typeof f !== "string" || !/^[A-Za-z0-9._\/-]+$/.test(f) || f.startsWith("/"))) {
      errors.push(`${name}.legacy.composeFiles must be a list of paths relative to the old checkout`);
    }
    if (lc && checkout && lc === checkout) errors.push(`${name}: the legacy checkout cannot be the release checkout`);
    if (lc && ts && cp && sb && lv && Array.isArray(files)) {
      legacy = { checkout: lc, tmuxSession: ts, composeProject: cp, composeFiles: files as string[], startedBy: sb, version: lv };
    }
  }

  const bootEnv: Record<string, string> = {};
  if (raw.bootEnv !== undefined) {
    if (!isObj(raw.bootEnv)) errors.push(`${name}.bootEnv must be an object`);
    else {
      for (const [k, v] of Object.entries(raw.bootEnv)) {
        if (!BOOT_ENV_KEYS.includes(k)) errors.push(`${name}.bootEnv: "${k}" is not a non-secret boot setting (allowed: ${BOOT_ENV_KEYS.join(", ")})`);
        else if (typeof v !== "string" || !/^[A-Za-z0-9._:\/-]*$/.test(v)) errors.push(`${name}.bootEnv.${k} must be a plain string`);
        else bootEnv[k] = v;
      }
    }
  }

  if (errors.length > 0) return { errors };
  return {
    target: {
      name, release: release!, ...(commit ? { commit } : {}), ...(tag ? { tag } : {}),
      rmEnv: rmEnv as "stage" | "prod", host: host!, checkout: checkout!, home: home!, instance: instance!,
      publicOrigin: publicOrigin!, capture: capture!, legacy: legacy!, confirmTarget: confirmTarget!, bootEnv,
    },
  };
}

/** Read and validate `<path>`; the target's name is the file's base name. Throws with every problem listed. */
export function loadTarget(path: string): ReleaseTarget {
  const name = basename(path).replace(/\.json$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`target ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = validateTarget(name, raw);
  if ("errors" in result) throw new Error(`target ${path} is invalid:\n  - ${result.errors.join("\n  - ")}`);
  return result.target;
}

/** A target whose confirmTarget is still the placeholder can be planned and dry-run, never run. */
export function confirmTargetFilled(target: ReleaseTarget): boolean {
  return target.confirmTarget !== CONFIRM_TARGET_PLACEHOLDER && CONFIRM_TARGET_RE.test(target.confirmTarget);
}
