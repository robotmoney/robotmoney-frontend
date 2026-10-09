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
// A target never names the release commit. The operator's go file is the one
// source of the commit (./go.ts, owner decision 2026-10-08): a `commit` or
// `tag` here would be a second pin that drifts from the go with every QA fix.
//
// Pure apart from loadTarget's one readFileSync, so every refusal is a unit
// test (scripts/tests/unit/release-run.test.ts).
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { STAGE_TARGET } from "./stage-target-lib.ts";
import { DEFAULT_WATCH_HOURS, WATCH_SESSIONS, type WatchSessions } from "./watch.ts";

/**
 * The capture checkout convention (owner decision 2026-10-08). The capture
 * checkout is a dedicated folder the release runner owns: R1.4 clones it when
 * it is missing, then fetches and detaches it at the commit. It is the same
 * folder for every target. It is never a release checkout: the stage target
 * (./stage-target.ts) removes its own checkout on every `down`, and a capture
 * checkout that was the stage checkout vanished with it (the v0.6.0 production
 * preflight's R1.4 failure, 2026-10-08). stage-target never creates or removes
 * this folder.
 */
export const CAPTURE_CHECKOUT = Object.freeze({ host: "rm-frontend-stage-2", checkout: "/home/stage-server/rm-capture" });

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
  /** The commit the old checkout runs (full SHA), for the plan and the report. */
  readonly commit?: string;
  /** The old driver's tee'd log, for the plan and the report. */
  readonly log?: string;
}

export interface CaptureHost {
  readonly host: string;
  /** HOME on the capture host: its `~/.env` holds `rm_readonly` against production's replica. */
  readonly home: string;
  /**
   * The runner-owned checkout on the capture host (CAPTURE_CHECKOUT). R1.4
   * clones it when missing. Never the stage target's checkout, never this
   * target's own checkout on the same host.
   */
  readonly checkout: string;
}

export interface ReleaseTarget {
  /** From the file name: `targets/<name>.json`. */
  readonly name: string;
  readonly release: string;
  readonly rmEnv: "stage" | "prod";
  /** The ssh host alias. */
  readonly host: string;
  readonly checkout: string;
  /** HOME on the host for every command. Its `.env` is the target's credential file. */
  readonly home: string;
  readonly instance: string;
  /** The public origin, for the identity check (R7.1). */
  readonly publicOrigin: string;
  /**
   * W1's `prod:gate --min-attendance`: the share of active members a good session needs.
   * Default 0.5, the gate's own default. A target where some active members cannot file
   * (stage: the external members run against production, never the stage database)
   * sets it lower in its file, with the reason in `$comment`.
   */
  readonly watchMinAttendance: number;
  /**
   * Hours after READY (R6.9's end) before the watch steps W1 and R7.4a run.
   * Default DEFAULT_WATCH_HOURS (./watch.ts): the longest first epoch plus its
   * judging and publish grace, so every subject can publish once. Production,
   * and any target that grades sessions, may set it longer, never shorter. A
   * stage target that defers sessions may set any positive value (owner
   * decision 2026-10-08: stage watches 15 minutes).
   */
  readonly watchHours: number;
  /**
   * Whether the watch grades sessions (W1 check 7, R7.4a's in-flight publish
   * check) or defers them. Rendered into W1 and R7.4a as
   * `--sessions {watchSessions}`, so the step list stays one list. Default
   * "graded"; production is always graded. Stage sets "deferred": a 15-minute
   * watch cannot see a 24 h epoch close.
   */
  readonly watchSessions: WatchSessions;
  readonly capture: CaptureHost;
  readonly legacy: LegacyStack;
  /** `host:port/database`; every write's `--confirm-target`. */
  readonly confirmTarget: string;
  readonly bootEnv: Readonly<Record<string, string>>;
}

const TOP_KEYS = ["release", "rmEnv", "host", "checkout", "home", "instance", "publicOrigin", "watchMinAttendance", "watchHours", "watchSessions", "capture", "legacy", "confirmTarget", "bootEnv", "$comment"];
const CAPTURE_KEYS = ["host", "home", "checkout"];
const LEGACY_KEYS = ["checkout", "tmuxSession", "composeProject", "composeFiles", "startedBy", "version", "commit", "log"];

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

  unknown(raw, TOP_KEYS.concat("commit", "tag"), name);
  const release = str(raw, "release", name, /^v\d+\.\d+\.\d+(-rc\.\d+)?$/);
  for (const key of ["commit", "tag"]) {
    if (key in raw) errors.push(`${name}: "${key}" is not a target key; the release commit comes from the go file's commit: line`);
  }
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
    if (h && ch && cc) {
      capture = { host: h, home: ch, checkout: cc };
      errors.push(...captureCheckoutProblems(name, capture, host, checkout));
    }
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
    const lcommit = str(l, "commit", `${name}.legacy`, SHA_RE, true);
    const llog = str(l, "log", `${name}.legacy`, ABS_PATH_RE, true);
    const files = l.composeFiles ?? [];
    if (!Array.isArray(files) || files.some((f) => typeof f !== "string" || !/^[A-Za-z0-9._\/-]+$/.test(f) || f.startsWith("/"))) {
      errors.push(`${name}.legacy.composeFiles must be a list of paths relative to the old checkout`);
    }
    if (lc && checkout && lc === checkout) errors.push(`${name}: the legacy checkout cannot be the release checkout`);
    if (lc && ts && cp && sb && lv && Array.isArray(files)) {
      legacy = { checkout: lc, tmuxSession: ts, composeProject: cp, composeFiles: files as string[], startedBy: sb, version: lv, ...(lcommit ? { commit: lcommit } : {}), ...(llog ? { log: llog } : {}) };
    }
  }

  let watchMinAttendance = 0.5;
  if (raw.watchMinAttendance !== undefined) {
    const v = raw.watchMinAttendance;
    if (typeof v !== "number" || !(v > 0 && v <= 1)) errors.push(`${name}.watchMinAttendance must be a number in (0, 1]`);
    else watchMinAttendance = v;
  }
  let watchSessions: WatchSessions = "graded";
  if (raw.watchSessions !== undefined) {
    const v = raw.watchSessions;
    if (typeof v !== "string" || !(WATCH_SESSIONS as readonly string[]).includes(v)) errors.push(`${name}.watchSessions must be ${WATCH_SESSIONS.join(" or ")}`);
    else watchSessions = v as WatchSessions;
  }
  if (rmEnv === "prod" && watchSessions !== "graded") errors.push(`${name}: production grades sessions in its watch (watchSessions must be graded)`);
  let watchHours = DEFAULT_WATCH_HOURS;
  if (raw.watchHours !== undefined) {
    const v = raw.watchHours;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) errors.push(`${name}.watchHours must be a positive number of hours`);
    else watchHours = v;
  }
  // A graded watch must last until the slowest subject's first publish after
  // READY. Production is always graded, so production never watches less than
  // the derived bound. Only a deferred (stage) watch may be shorter.
  if (watchHours < DEFAULT_WATCH_HOURS && (rmEnv === "prod" || watchSessions === "graded")) {
    errors.push(`${name}.watchHours must be at least ${DEFAULT_WATCH_HOURS} (the slowest subject's first publish after READY) on ${rmEnv === "prod" ? "production" : "a target that grades sessions"}`);
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
      name, release: release!,
      rmEnv: rmEnv as "stage" | "prod", host: host!, checkout: checkout!, home: home!, instance: instance!,
      publicOrigin: publicOrigin!, watchMinAttendance, watchHours, watchSessions, capture: capture!, legacy: legacy!, confirmTarget: confirmTarget!, bootEnv,
    },
  };
}

/**
 * PURE. The capture checkout rule: the capture checkout is the release
 * runner's own folder. It may not be the stage target's checkout on the stage
 * host (`stage-target down` removes that folder), and it may not be this
 * target's own `checkout` on the same host (R1.1 and R1.4 would share one
 * folder, so stage would never rehearse the capture checkout steps).
 */
export function captureCheckoutProblems(name: string, capture: CaptureHost, host: string | undefined, checkout: string | undefined): string[] {
  const out: string[] = [];
  const rule = "the capture checkout is a dedicated folder the release runner owns " +
    `(convention: ${CAPTURE_CHECKOUT.host}:${CAPTURE_CHECKOUT.checkout}), never a release checkout`;
  if (capture.host === STAGE_TARGET.host && capture.checkout === STAGE_TARGET.checkout) {
    out.push(`${name}.capture.checkout ${capture.checkout} is the stage target's checkout, which stage-target down removes: ${rule}`);
  }
  if (host !== undefined && checkout !== undefined && capture.host === host && capture.checkout === checkout) {
    out.push(`${name}.capture.checkout ${capture.checkout} is this target's own checkout on ${host}: ${rule}`);
  }
  return out;
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
