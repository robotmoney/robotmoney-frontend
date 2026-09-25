// `bun smoke:web` — deploy the static website on its own (D54; smoke spec §13.2,
// issue #1026 W7).
//
// The site is its own release unit. This module switches the site an instance's
// `website-server` serves and touches nothing else: no `api` or worker
// container is created, stopped or restarted, and the stack's deployment
// journal (§1.3) is never written. What it does, in order:
//
//   1. takes the instance's deployment lock (smoke-state.ts), so it cannot race
//      a `bun smoke` of the same instance;
//   2. builds the site (scripts/static-assembly.sh) into a temporary directory
//      inside the instance's `web/`;
//   3. reads the running API's version (GET /api/version) and refuses when it
//      is outside the new site's `apiRange` (scripts/lib/api-range.ts). A site
//      with no declared range is outside every range (D54). A refusal switches
//      nothing and removes the build it made. Otherwise the build is renamed to
//      `web/<version>-<commit>/` (smoke-site.ts installSite);
//   4. switches `web/current` to the new directory by a symlink rename,
//      recording the old one as `web/previous` (smoke-site.ts switchSite), and
//      reloads nginx (`nginx -s reload` is a graceful reload: new workers take
//      new connections, old workers finish the requests they hold);
//   5. writes its own journal (`web/journal.jsonl`, append-only) and receipt
//      (`web/receipt.json`) beside the stack's own.
//
// `--rollback` switches `current` back to `previous`, with the same range
// check, reload, journal and receipt. It refuses when there is no previous
// site, or when `previous` already equals `current` (an interrupted switch).
//
// THE RANGE CHECK APPLIES TO A ROLLBACK TOO. §13.2 names it for a deploy; the
// W7 rolling gate says a page is never served against an API outside its range,
// and an old site is exactly the one most likely to predate the running API.
//
// THE PLAN ID is a content hash, like `bun smoke`'s (§1.2), over the instance,
// the action and the site's source identity: the Git tree hash of every input
// the assembly reads (WEB_SOURCE_CONTEXTS), from the working tree, so a dirty
// edit moves it. A rollback hashes the site ids it moves between. No secret
// reaches the plan, the journal or the receipt: none is read.
//
// Every side effect outside the web directory (the build, the API read, the
// reload, the post-reload check) is an injected {@link WebReleaseDeps}, so the
// unit tests drive the real filesystem and lock with no Docker.
// scripts/smoke-web.ts wires the real ones.

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { apiVersionInRange, readSiteApiRange } from "./api-range.ts";
import { installSite, currentSite, previousSite, switchSite } from "./smoke-site.ts";
import { acquireDeploymentLock, instancePaths, PRODUCTION_INSTANCE, type InstancePaths } from "./smoke-state.ts";
import type { StackEnvironment } from "../stack/naming.ts";

/**
 * Every repository path the assembled site is built from: the client itself and
 * the scripts static-assembly.sh runs. Their Git tree hashes are the site's
 * source identity, hashed into the plan id.
 */
export const WEB_SOURCE_CONTEXTS = [
  "frontend",
  "scripts/static-assembly.sh",
  "scripts/prerender.ts",
  "scripts/lib/prerender-view.ts",
  "scripts/lib/agent-endpoints.ts",
  "scripts/web-client",
  "scripts/static-manifest.ts",
  "scripts/lib/static-manifest.ts",
] as const;

/** The prefix of the temporary directory a deploy assembles into, inside the web directory. */
export const BUILD_DIR_PREFIX = ".build-";

/** The journal's file name inside the instance's web directory. */
export const WEB_JOURNAL_FILE = "journal.jsonl";
/** The receipt's file name inside the instance's web directory. */
export const WEB_RECEIPT_FILE = "receipt.json";

export type WebAction = "deploy" | "rollback";

/** One journal line. The journal is append-only: a run adds lines, never rewrites one. */
export interface WebJournalEntry {
  readonly at: string;
  readonly planId: string;
  readonly action: WebAction;
  readonly step: "begin" | "built" | "range-checked" | "switched" | "reloaded" | "done" | "refused" | "failed";
  readonly detail: Readonly<Record<string, unknown>>;
}

/** What a finished `bun smoke:web` leaves in `web/receipt.json`. */
export interface WebReceipt {
  readonly schema: 1;
  readonly instance: string;
  readonly action: WebAction;
  readonly planId: string;
  /** The site `current` names after this run. */
  readonly siteId: string;
  /** The site `current` named before this run, or null. */
  readonly previous: string | null;
  /** False when the site was already current: nothing was switched or reloaded. */
  readonly swapped: boolean;
  readonly reloaded: boolean;
  /** The served site's content digest (`.rm-static-manifest.json`). */
  readonly digest: string | null;
  /** The running API's version when the switch was checked. */
  readonly apiVersion: string;
  /** The served site's declared range. */
  readonly apiRange: string;
  /** Deploy only: the source identity the plan id hashes. */
  readonly sources: Readonly<Record<string, string>> | null;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** The side effects a release needs from outside the web directory. */
export interface WebReleaseDeps {
  /** Assemble the site into `outDir` (an empty directory that exists). Throws on failure. */
  build(outDir: string): Promise<void>;
  /** The running API's version from GET /api/version. Throws when it cannot be read. */
  apiVersion(): Promise<string>;
  /** Reload website-server's nginx. Throws on failure. */
  reload(): Promise<void>;
  /** Deploy only: the site's source identity, path → Git tree hash. */
  sourceIdentity(): Readonly<Record<string, string>>;
  /**
   * After the reload: confirm website-server now serves `site` (its
   * /version.json). Optional; throws when it does not.
   */
  verifyServed?(site: { readonly version: string; readonly commit: string }): Promise<void>;
  now?(): Date;
  log?(line: string): void;
}

/**
 * smoke-state.ts's LOCAL_POINTER: the state-root file naming the instance a
 * previous local `bun smoke` persisted. Not exported there; pinned equal by
 * scripts/tests/unit/smoke-web.test.ts, which resolves one instance both ways.
 */
const LOCAL_INSTANCE_POINTER = "local-instance";

/**
 * The instance `bun smoke:web` deploys to: `bun smoke`'s precedence (spec
 * §1.1) — `--instance`, then `rm_prod` under `RM_ENV=prod`, then the CI job's
 * identity, then the name a previous local run persisted — without its last
 * rule. A site is deployed onto a stack, so this never mints a fresh name.
 *
 * Refuses: the same `--instance`/policy mismatches resolveInstance refuses; a
 * CI class with no identity hash; no persisted local instance; an instance
 * with no state directory.
 */
export function resolveWebInstance(input: {
  readonly flag: string | undefined;
  readonly rmEnv: "prod" | "stage";
  readonly environment: StackEnvironment;
  readonly stateRoot: string;
}): InstancePaths {
  let name: string;
  if (input.flag !== undefined) {
    if (input.rmEnv === "prod" && input.flag !== PRODUCTION_INSTANCE) {
      throw new Error(`Refusing: RM_ENV=prod acts on ${PRODUCTION_INSTANCE}, not \`${input.flag}\`.`);
    }
    if (input.rmEnv !== "prod" && input.flag === PRODUCTION_INSTANCE) {
      throw new Error(`Refusing: naming ${PRODUCTION_INSTANCE} under a stage policy would contend for production's lock.`);
    }
    name = input.flag;
  } else if (input.rmEnv === "prod") {
    name = PRODUCTION_INSTANCE;
  } else if (input.environment.class === "ci") {
    const hash = input.environment.hash.trim().toLowerCase();
    if (hash === "") throw new Error("Refusing: CI class with an empty identity hash — the run's identity vars were absent.");
    name = `rm_ci_${hash}`;
  } else {
    const pointer = join(input.stateRoot, LOCAL_INSTANCE_POINTER);
    if (!existsSync(pointer)) {
      throw new Error(`Refusing: no local instance has been deployed from this host (${pointer} is absent); name one with \`--instance\`.`);
    }
    name = readFileSync(pointer, "utf8").trim();
  }
  const paths = instancePaths(input.stateRoot, name);
  if (!existsSync(paths.dir)) {
    throw new Error(`Refusing: instance ${name} has no state under ${input.stateRoot}, so it has no stack to deploy a site to.`);
  }
  return paths;
}

/** The web directory's journal and receipt paths for an instance. */
export function webReleaseFiles(paths: InstancePaths): { readonly journalFile: string; readonly receiptFile: string } {
  return { journalFile: join(paths.webDir, WEB_JOURNAL_FILE), receiptFile: join(paths.webDir, WEB_RECEIPT_FILE) };
}

/** The plan id: sha256 over the sorted JSON of exactly the fields it names. */
export function webPlanId(material: {
  readonly instance: string;
  readonly action: WebAction;
  readonly sources?: Readonly<Record<string, string>>;
  readonly from?: string | null;
  readonly to?: string;
}): string {
  const sorted = (value: unknown): unknown =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, sorted((value as Record<string, unknown>)[k])]))
      : value;
  return `web:${createHash("sha256").update(JSON.stringify(sorted(material))).digest("hex").slice(0, 32)}`;
}

/** Every journal entry, oldest first; `[]` when there is no journal yet. */
export function readWebJournal(paths: InstancePaths): WebJournalEntry[] {
  const { journalFile } = webReleaseFiles(paths);
  if (!existsSync(journalFile)) return [];
  return readFileSync(journalFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as WebJournalEntry);
}

/** The last receipt, or null when no release has finished. */
export function readWebReceipt(paths: InstancePaths): WebReceipt | null {
  const { receiptFile } = webReleaseFiles(paths);
  if (!existsSync(receiptFile)) return null;
  return JSON.parse(readFileSync(receiptFile, "utf8")) as WebReceipt;
}

interface SiteFacts {
  readonly version: string;
  readonly commit: string;
  readonly apiRange: string | null;
  readonly digest: string | null;
}

/** What an assembled site says about itself: /version.json and its content manifest. */
function siteFacts(dir: string): SiteFacts {
  let versionJson: { version?: unknown; commit?: unknown } = {};
  try {
    versionJson = JSON.parse(readFileSync(join(dir, "version.json"), "utf8")) as typeof versionJson;
  } catch {
    throw new Error(`Refusing: ${join(dir, "version.json")} is missing or malformed.`);
  }
  let digest: string | null = null;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, ".rm-static-manifest.json"), "utf8")) as { digest?: unknown };
    digest = typeof manifest.digest === "string" ? manifest.digest : null;
  } catch {
    digest = null;
  }
  return {
    version: typeof versionJson.version === "string" ? versionJson.version : "",
    commit: typeof versionJson.commit === "string" ? versionJson.commit : "",
    apiRange: readSiteApiRange(versionJson),
    digest,
  };
}

/** One release in progress: its lock, its journal writer, its clock. */
class Run {
  readonly startedAt: string;
  private readonly journalFile: string;
  private readonly receiptFile: string;

  constructor(
    readonly paths: InstancePaths,
    readonly action: WebAction,
    readonly planId: string,
    readonly deps: WebReleaseDeps,
  ) {
    const files = webReleaseFiles(paths);
    this.journalFile = files.journalFile;
    this.receiptFile = files.receiptFile;
    this.startedAt = this.now();
  }

  now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  log(line: string): void {
    this.deps.log?.(line);
  }

  journal(step: WebJournalEntry["step"], detail: Record<string, unknown> = {}): void {
    const entry: WebJournalEntry = { at: this.now(), planId: this.planId, action: this.action, step, detail };
    appendFileSync(this.journalFile, `${JSON.stringify(entry)}\n`, { mode: 0o644 });
  }

  /** Written to a temporary file and renamed: a reader sees the old receipt or the new one. */
  receipt(receipt: WebReceipt): void {
    const temporary = join(this.paths.webDir, `.receipt-${randomBytes(4).toString("hex")}`);
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
    renameSync(temporary, this.receiptFile);
  }
}

/** Refuse, journalling why, when the running API is outside `site`'s range. */
async function checkRange(run: Run, siteId: string, facts: SiteFacts): Promise<string> {
  let apiVersion: string;
  try {
    apiVersion = await run.deps.apiVersion();
  } catch (error) {
    const reason = `Refusing: the running API's version could not be read (${(error as Error).message}), so site ${siteId}'s range cannot be checked. Nothing was switched.`;
    run.journal("refused", { siteId, reason });
    throw new Error(reason);
  }
  if (!apiVersionInRange(apiVersion, facts.apiRange)) {
    const range = facts.apiRange === null ? "no declared range (outside every range, D54)" : `range ${facts.apiRange}`;
    const reason = `Refusing: the running API is ${apiVersion}, outside site ${siteId}'s ${range}. Nothing was switched.`;
    run.journal("refused", { siteId, apiVersion, apiRange: facts.apiRange, reason });
    throw new Error(reason);
  }
  run.journal("range-checked", { siteId, apiVersion, apiRange: facts.apiRange });
  run.log(`API ${apiVersion} is inside site ${siteId}'s range ${facts.apiRange}`);
  return apiVersion;
}

/** Switch `current`, reload, confirm, and write the receipt. */
async function switchAndReceipt(
  run: Run,
  siteId: string,
  facts: SiteFacts,
  apiVersion: string,
  sources: Readonly<Record<string, string>> | null,
): Promise<WebReceipt> {
  const switched = switchSite(run.paths.webDir, siteId);
  run.journal("switched", { siteId, previous: switched.previous, swapped: switched.swapped });
  if (switched.swapped) {
    run.log(`web/current: ${switched.previous ?? "(none)"} -> ${siteId}`);
    try {
      await run.deps.reload();
      await run.deps.verifyServed?.({ version: facts.version, commit: facts.commit });
    } catch (error) {
      run.journal("failed", { siteId, previous: switched.previous, error: (error as Error).message });
      throw new Error(
        `web/current now names ${siteId}, but the reload or its check failed: ${(error as Error).message}. ` +
          "Return to the previous site with `bun smoke:web --rollback`.",
      );
    }
    run.journal("reloaded", { siteId });
  } else {
    run.log(`site ${siteId} is already current; nothing switched`);
  }
  const receipt: WebReceipt = {
    schema: 1,
    instance: basename(run.paths.dir),
    action: run.action,
    planId: run.planId,
    siteId,
    previous: switched.previous,
    swapped: switched.swapped,
    reloaded: switched.swapped,
    digest: facts.digest,
    apiVersion,
    apiRange: facts.apiRange ?? "",
    sources,
    startedAt: run.startedAt,
    finishedAt: run.now(),
  };
  run.receipt(receipt);
  run.journal("done", { siteId });
  return receipt;
}

/**
 * Build the site from this checkout and make it the instance's current one.
 *
 * Refuses (throws, `current` untouched): the deployment lock is held by a live
 * process; the build fails; the built site has no identity; the running API's
 * version cannot be read or is outside the site's range. The build directory
 * is removed on every refusal.
 */
export async function deploySite(paths: InstancePaths, deps: WebReleaseDeps): Promise<WebReceipt> {
  const sources = deps.sourceIdentity();
  const planId = webPlanId({ instance: basename(paths.dir), action: "deploy", sources });
  const lock = acquireDeploymentLock(paths, planId);
  try {
    mkdirSync(paths.webDir, { recursive: true, mode: 0o755 });
    // A build directory left by a run that died mid-build: this run holds the
    // lock, so no live run owns one.
    for (const name of readdirSync(paths.webDir)) {
      if (name.startsWith(BUILD_DIR_PREFIX)) rmSync(join(paths.webDir, name), { recursive: true, force: true });
    }
    const run = new Run(paths, "deploy", planId, deps);
    run.journal("begin", { sources });
    // Inside web/ so the rename into place is atomic; dot-named so it is never a site id.
    const buildDir = join(paths.webDir, `${BUILD_DIR_PREFIX}${randomBytes(6).toString("hex")}`);
    mkdirSync(buildDir, { mode: 0o755 });
    chmodSync(buildDir, 0o755);
    let installed: string | null = null;
    try {
      try {
        await deps.build(buildDir);
      } catch (error) {
        run.journal("failed", { step: "build", error: (error as Error).message });
        throw error;
      }
      const facts = siteFacts(buildDir);
      const apiVersion = await checkRange(run, `${facts.version}-${facts.commit}`, facts);
      const site = installSite(paths.webDir, buildDir, { move: true });
      installed = site.siteId;
      run.journal("built", { siteId: site.siteId, digest: facts.digest, installed: site.copied });
      run.log(`site ${site.siteId}: ${site.copied ? "installed" : "already installed"} at ${site.dir}`);
      return await switchAndReceipt(run, site.siteId, facts, apiVersion, sources);
    } finally {
      if (installed === null) rmSync(buildDir, { recursive: true, force: true });
    }
  } finally {
    lock.release();
  }
}

/**
 * Return the instance to the site `current` named before its last switch.
 *
 * Refuses (throws, `current` untouched): the lock is held; there is no
 * previous site; `previous` equals `current`; the previous directory is gone;
 * the running API is outside the previous site's range.
 */
export async function rollbackSite(paths: InstancePaths, deps: WebReleaseDeps): Promise<WebReceipt> {
  const from = currentSite(paths.webDir);
  const to = previousSite(paths.webDir);
  if (to === null) {
    throw new Error(`Refusing: instance ${basename(paths.dir)} has no previous site to roll back to (${join(paths.webDir, "previous")} is absent).`);
  }
  const planId = webPlanId({ instance: basename(paths.dir), action: "rollback", from, to });
  const lock = acquireDeploymentLock(paths, planId);
  try {
    // Re-read under the lock: a run that finished between the read and the lock moved them.
    if (currentSite(paths.webDir) !== from || previousSite(paths.webDir) !== to) {
      throw new Error("Refusing: the served site changed while the rollback was taking the lock. Nothing was switched; run it again.");
    }
    if (to === from) {
      throw new Error(`Refusing: previous and current both name ${to} (an interrupted switch), so there is nothing to roll back to.`);
    }
    if (!existsSync(join(paths.webDir, to))) {
      throw new Error(`Refusing: the previous site's directory ${join(paths.webDir, to)} is gone.`);
    }
    const run = new Run(paths, "rollback", planId, deps);
    run.journal("begin", { from, to });
    const facts = siteFacts(join(paths.webDir, to));
    const apiVersion = await checkRange(run, to, facts);
    return await switchAndReceipt(run, to, facts, apiVersion, null);
  } finally {
    lock.release();
  }
}
