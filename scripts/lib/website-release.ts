// `bun smoke:web` — deploy the static website on its own (D54; smoke spec §13.2,
// issue #1026 W7), as one signed bundle in one immutable container (issue 1628,
// docs/technical/web-serving-architecture.md §4).
//
// The site is its own release unit. This module swaps the site image an
// instance's `website-server` runs and touches nothing else: no `api` or
// worker container is created, stopped or restarted, and the stack's
// deployment journal (§1.3) is never written.
//
// The directory mode that switched `web/current` and reloaded nginx is retired
// (issue 1631). nginx still serves a host before its first swap, and every CI
// stack, from the site `bun smoke` places (scripts/lib/smoke-site.ts); the
// first-rollout rule below keeps that container as a rollback target.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { apiVersionInRange, readSiteApiRange } from "./api-range.ts";
import { MAINTENANCE_FILE } from "./maintenance-file.ts";
import { verifyBundle } from "./web-bundle.ts";
import { parseBundleFileName } from "./web-bundle-manifest.ts";
import { shellQuote, type HostResult, type WebHost } from "./website-host.ts";
import {
  readWebsiteImageService,
  WEBSITE_ASSET_CACHE,
  WEBSITE_HTML_CACHE,
  WEBSITE_IMAGE_LABELS,
  WEBSITE_MAINTENANCE_DIR,
  WEBSITE_SECURITY_HEADERS,
  WEBSITE_SERVED_ROOT,
  websiteImageRunFlags,
} from "./website-image.ts";

/**
 * Every repository path the assembled site is built from: the client itself,
 * the scripts static-assembly.sh runs, and every relative import they reach
 * (scripts/tests/unit/web-content-paths.test.ts walks that graph). The
 * same list is the web content release line's eligibility rule (D81,
 * scripts/release/web-release-lib.ts classifyContentDiff): a release whose
 * tree differs from production's API commit only inside these paths may ship
 * through `bun run release:web`.
 */
export const WEB_CONTENT_PATHS = [
  "frontend",
  "scripts/static-assembly.sh",
  "scripts/prerender.ts",
  "scripts/lib/prerender-view.ts",
  "scripts/lib/agent-endpoints.ts",
  "scripts/web-client",
  "scripts/static-manifest.ts",
  "scripts/lib/static-manifest.ts",
  "scripts/stamp-assets.ts",
  "scripts/lib/stamp-assets.ts",
  "scripts/lib/regime-snapshot.ts",
  "scripts/lib/contract-freshness.ts",
] as const;

export type WebAction = "deploy" | "rollback";

// ===========================================================================
// IMAGE MODE: one signed bundle in one immutable container, swapped on the
// public port (issue 1628; docs/technical/web-serving-architecture.md §4, §4.1).
//
// Selected by `bun smoke:web --host <ssh-dest|local>`, its only mode.
//
// It runs on the control machine and drives the host through a WebHost
// (website-host.ts): every host effect is a command in its recorded list, and
// every read of the site is an HTTP read of a port the host publishes. For a
// named bundle it runs §4's seven steps:
//
//   1. verify the bundle here (web-bundle.ts: name, digest, signature,
//      manifest, version.json) and refuse an apiRange that excludes the
//      running API's /api/version. Then send it to the host and verify it
//      THERE, with the server image's own verifier and allowed-signers file.
//      A bundle that fails either is never built;
//   2. build the site image on the host FROM the server image's id, pinned by
//      a tag named for that id, and confirm the result's layers start with
//      the server image's (BuildKit cannot take a bare image id as FROM);
//   3. PRE-CHECK, while the old container keeps serving: create a copy of the
//      image the way the final container is created (precheckCreateArgs: same
//      image, overlay flags, healthcheck, log settings and networks; a spare
//      loopback port, no labels, aliases or restart policy), start it, time its
//      cold start, run the live check set on it (liveProblems), and kill it. A
//      failure, or a cold start that with the retire bound could not fit
//      GAP_LIMIT_MS, never touches the old container or the public port. It
//      cannot prove the public port binds; step 6 answers that;
//   4. retire the running container (SIGTERM, forced stop after
//      STOP_GRACE_SECONDS: retireArgs) and start the new one, created
//      beforehand with the old one's port, networks, aliases, labels, restart
//      policy, log and health settings plus the overlay's isolation flags. The
//      stop, the start and a fallback start of the old one are ONE host command
//      (handoverScript) whose body survives a dropped SSH link. The gap runs
//      from the stop to the first answer on the public port that names the
//      release, and must be at most GAP_LIMIT_MS;
//   5. check that /version.json, read through the public origin, names the
//      release, and repeat step 3's live check set on the host's public port;
//   6. on any failure or throw after the stop, remove the new container,
//      start the old one again (it was only stopped), put back the tags step 7
//      moved, and exit non-zero, with the revert's own gap;
//   7. on a pass, park the old container's name, give the new one its name,
//      keep the old image as the one previous image, and remove the old
//      container: except on the first swap from nginx, whose container is
//      kept stopped as `<name>-first-rollout` (the first-rollout rule, §4).
//
// THE ONE PREVIOUS IMAGE. Every site image this builds carries the label
// `robotmoney.web.instance=<instance>`. After a swap, `<repo>:<instance>-current`
// names the serving image and `<repo>:<instance>-previous` the one that served
// before it, whatever caused the swap. Every other labelled image of the
// instance is removed, and a failed run never removes the image `-current` or
// `-previous` names. `--rollback` swaps to the previous image with steps 3 to
// 7, after the same apiRange refusal. With no previous image it starts the
// kept first-rollout container again; with nothing running it starts the
// stopped container that served last.
//
// MAINTENANCE. The immutable container reads maintenance.json from a tmpfs,
// which a stop wipes. An active file in the old container is read before the
// stop and written into whichever container serves after it.
//
// THE HOST LOCK is a Docker network named for the instance: creating a name
// that exists fails, so two runs never overlap. A lock older than
// HOST_LOCK_STALE_MS is a crashed run's, and is taken over.
//
// THE RECEIPT is written on the control machine on every outcome, refusals
// included: the bundle, the old and new container ids, each check's result,
// and the gap in milliseconds.
// ===========================================================================

/** A swap's gap may not exceed this (§4.1). */
export const GAP_LIMIT_MS = 3_000;
/**
 * How a serving container is retired (§4.1): SIGTERM, then SIGKILL after
 * STOP_GRACE_SECONDS. nginx's own StopSignal is SIGQUIT, which closes its
 * listeners at once and then waits for every open connection (the site is dark
 * for the whole wait). SIGTERM is nginx's fast shutdown and Caddy's graceful
 * one (bounded by the Caddyfile's grace_period). The forced kill after one
 * second is the hard bound: it, the start of the new container and its first
 * answer must fit in GAP_LIMIT_MS.
 */
export const STOP_SIGNAL = "SIGTERM";
/** `docker stop --signal` exists from Docker 25. */
export const MIN_DOCKER_MAJOR = 25;
export const STOP_GRACE_SECONDS = 1;

/** PURE. The `docker stop` argv that retires `id`: the signal, then a forced stop after `graceSeconds`. */
export function retireArgs(id: string, graceSeconds: number = STOP_GRACE_SECONDS): string[] {
  return ["stop", "--signal", STOP_SIGNAL, "-t", String(graceSeconds), id];
}
/** The repository every site image of an instance is tagged in. */
export const SITE_IMAGE_REPO = "robotmoney-website";
/** The repository a server image id is pinned in for a build (a tag named for the id). */
export const SERVER_PIN_REPO = "robotmoney-website-server-pin";
/** Every site image `smoke:web` builds carries this label with the instance's name. */
export const SITE_IMAGE_INSTANCE_LABEL = "robotmoney.web.instance";
/**
 * PURE. The content of the one regular file in a tar stream as text (what `docker cp <c>:<file> -`
 * prints), or "" when it holds none. PAX and GNU long-name headers before it are skipped. The text is
 * cut at its first NUL, the tar padding, so a header size counted in bytes never splits a character.
 */
export function fileOfTar(tar: string): string {
  let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.slice(at, at + 512);
    if (/^\0*$/.test(header)) return "";
    const size = Number.parseInt(header.slice(124, 136).replace(/[\0 ]/g, ""), 8) || 0;
    const type = header[156];
    if (type === "0" || type === "\0") {
      const body = tar.slice(at + 512);
      const end = body.indexOf("\0");
      return end === -1 ? body : body.slice(0, end);
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return "";
}

/** docker-compose.yml labels website-server with its instance and its service. */
export const INSTANCE_LABEL = "robotmoney.instance";
export const SERVICE_LABEL = "com.docker.compose.service";
export const WEBSITE_SERVICE = "website-server";
const LOCK_LABEL = "robotmoney.web.lock";
const LOCK_AT_LABEL = "robotmoney.web.lock.at";
/** A host lock older than this belongs to a run that died. */
export const HOST_LOCK_STALE_MS = 30 * 60_000;
/** The served root's version.json inside a site image. */
const IMAGE_VERSION_JSON = `${WEBSITE_SERVED_ROOT}/current/version.json`;
/** Where the host-side verifier extracts to, inside its own throwaway container. */
const HOST_VERIFY_OUT = "/tmp/rm-verified";

/** The receipt's file name in the receipt directory; every receipt is also a journal line. */
export const IMAGE_RECEIPT_FILE = "receipt.json";
export const IMAGE_JOURNAL_FILE = "journal.jsonl";

export type ImageSlot = "current" | "previous" | "candidate";

/** PURE. `robotmoney-website:<instance>-<slot>`. */
export function siteImageTag(instance: string, slot: ImageSlot): string {
  return `${SITE_IMAGE_REPO}:${instance}-${slot}`;
}

/** PURE. The host lock's network name. */
export function hostLockName(instance: string): string {
  return `robotmoney-web-lock-${instance}`;
}

/** PURE. Refuses an instance name that cannot be a Docker tag or a label value as given. */
export function assertImageInstance(instance: string): void {
  if (!/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(instance)) {
    throw new Error(`Refusing: instance ${JSON.stringify(instance)} must be lower-case letters, digits, '_', '.' or '-'.`);
  }
}

/** What one signed bundle, or one site image, serves. */
export interface SiteRelease {
  /** `web-vA.B.C`. */
  readonly tag: string;
  readonly version: string;
  readonly commit: string;
  readonly sha256: string;
  readonly apiRange: string | null;
}

export interface ImageCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SwapGap {
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** From the stop to the first good answer on the public port; null when none came. */
  readonly ms: number | null;
}

/** The pre-check container's cold start: `docker start` to the first good answer, on the spare port. */
export interface PrecheckTiming {
  /** Measured start time. */
  readonly coldStartMs: number;
  /** The retire bound: STOP_GRACE_SECONDS in ms. The worst case of the old container's stop. */
  readonly retireBoundMs: number;
  readonly gapLimitMs: number;
}

export type ImageOutcome = "swapped" | "unchanged" | "refused" | "reverted" | "failed";

/** What one image-mode run leaves in `receipt.json` (and appends to `journal.jsonl`). */
export interface ImageReceipt {
  readonly schema: 2;
  readonly mode: "image";
  readonly instance: string;
  readonly host: string;
  readonly action: WebAction;
  readonly outcome: ImageOutcome;
  readonly release: SiteRelease | null;
  readonly apiVersion: string | null;
  readonly oldContainer: { readonly id: string; readonly image: string } | null;
  readonly newContainer: { readonly id: string; readonly image: string } | null;
  readonly publicPort: number | null;
  readonly copyPort: number | null;
  readonly checks: readonly ImageCheck[];
  readonly gap: SwapGap | null;
  readonly revertGap: SwapGap | null;
  /** The pre-check container's cold start and the bound it was gated by; absent when no pre-check ran. */
  readonly precheck?: PrecheckTiming | null;
  /** The host's Docker server version, read before anything was created (`docker stop --signal` needs 25). */
  readonly dockerVersion?: string | null;
  /** The images `-current` and `-previous` name after the run. */
  readonly currentImage: string | null;
  readonly previousImage: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface ImageReleaseDeps {
  readonly host: WebHost;
  readonly instance: string;
  /** Where the receipt and journal go, on the control machine. */
  readonly receiptDir: string;
  /** The checkout whose website-server/Dockerfile.bundle and overlay flags the host uses. */
  readonly repoRoot: string;
  /** The control machine's trust root (default: the committed website-server/allowed-signers). */
  readonly allowedSigners?: string;
  /** Step 5's origin. Default: the public port on the host. */
  readonly publicOrigin?: string;
  readonly gapLimitMs?: number;
  /** How long a started container may take to answer. */
  readonly readyTimeoutMs?: number;
  /** Seconds the old container gets after SIGTERM before SIGKILL (default STOP_GRACE_SECONDS). */
  readonly stopTimeoutSeconds?: number;
  /** Download a `web-vA.B.C` release's bundle, digest and signature into `dir`. */
  fetchRelease?(tag: string, dir: string): Promise<void>;
  now?(): Date;
  log?(line: string): void;
}

export interface DeployImageOptions {
  /** A bundle tarball on this machine, or a `web-vA.B.C` release name. */
  readonly bundle: string;
  /** The host's server image (a tag or an id), which the site image is built FROM. */
  readonly serverImage: string;
  /**
   * `--bundle serving`: the sha256 the serving container's label names. A fetched bundle with any other
   * digest is refused before anything reaches the host, so a tag name reused for other bytes never deploys.
   */
  readonly expectSha256?: string;
}

/** The parts of `docker inspect <container>` a swap reads. */
export interface ContainerInspect {
  Id: string;
  Name: string;
  Image: string;
  State?: { Running?: boolean };
  Config: {
    Labels: Record<string, string> | null;
    Healthcheck?: { Test?: string[]; Interval?: number; Timeout?: number; Retries?: number; StartPeriod?: number } | null;
  };
  HostConfig: {
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number } | null;
    LogConfig?: { Type?: string; Config?: Record<string, string> | null } | null;
    PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
  };
  NetworkSettings: {
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
    Networks?: Record<string, { Aliases?: string[] | null }> | null;
  };
}

/** Thrown for a refusal before anything on the public port changed. */
export class WebRefusal extends Error {}

/** PURE. A healthcheck from `docker inspect` as `docker create` flags. */
export function healthFlags(hc: ContainerInspect["Config"]["Healthcheck"]): string[] {
  if (!hc?.Test || hc.Test.length === 0) return [];
  const [kind, ...rest] = hc.Test;
  if (kind === "NONE") return ["--no-healthcheck"];
  const cmd = kind === "CMD-SHELL" ? (rest[0] ?? "") : rest.map(shellQuote).join(" ");
  const out = ["--health-cmd", cmd];
  const dur = (flag: string, ns: number | undefined) => {
    if (ns && ns > 0) out.push(flag, `${Math.round(ns / 1e6)}ms`);
  };
  dur("--health-interval", hc.Interval);
  dur("--health-timeout", hc.Timeout);
  dur("--health-start-period", hc.StartPeriod);
  if (hc.Retries && hc.Retries > 0) out.push("--health-retries", String(hc.Retries));
  return out;
}

/** PURE. The old container's public binding of port 8080: the bound host port, as `-p` arguments. */
export function publicPortBinding(old: Pick<ContainerInspect, "HostConfig" | "NetworkSettings">): { port: number; args: string[] } {
  const bound = (old.NetworkSettings.Ports?.["8080/tcp"] ?? []).map((b) => Number(b.HostPort)).filter((p) => Number.isInteger(p) && p > 0);
  if (bound.length === 0) throw new WebRefusal("Refusing: the running website-server publishes no host port for 8080.");
  const port = bound[0]!;
  const declared = old.HostConfig.PortBindings?.["8080/tcp"]?.[0]?.HostIp ?? "";
  return { port, args: ["-p", declared === "" ? `${port}:8080` : `${declared}:${port}:8080`] };
}

/**
 * PURE. The `docker create` argv for the container that replaces `old`: its
 * compose and instance labels (never an image's `robotmoney.web.*` label,
 * which the new image sets), its restart, log and health settings, the
 * overlay's isolation flags, the same public port and its networks with their
 * aliases. Networks after the first are joined by `docker network connect`.
 */
export function replacementCreateArgs(old: ContainerInspect, name: string, image: string, overlayFlags: readonly string[]): { create: string[]; connect: string[][] } {
  const args = ["create", "--name", name];
  for (const [k, v] of Object.entries(old.Config.Labels ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (k.startsWith("robotmoney.web.")) continue;
    if (k.startsWith("com.docker.compose.") || k.startsWith("robotmoney.")) args.push("--label", `${k}=${v}`);
  }
  const restart = old.HostConfig.RestartPolicy;
  if (restart?.Name && restart.Name !== "no") {
    args.push("--restart", restart.Name === "on-failure" && restart.MaximumRetryCount ? `on-failure:${restart.MaximumRetryCount}` : restart.Name);
  }
  const log = old.HostConfig.LogConfig;
  if (log?.Type) {
    args.push("--log-driver", log.Type);
    for (const [k, v] of Object.entries(log.Config ?? {})) args.push("--log-opt", `${k}=${v}`);
  }
  args.push(...healthFlags(old.Config.Healthcheck), ...overlayFlags, ...publicPortBinding(old).args);
  const shortId = old.Id.slice(0, 12);
  const aliasesOf = (net: { Aliases?: string[] | null }) => (net.Aliases ?? []).filter((a) => a !== shortId && a !== old.Id);
  const connect: string[][] = [];
  Object.entries(old.NetworkSettings.Networks ?? {}).forEach(([net, cfg], i) => {
    if (i === 0) {
      args.push("--network", net);
      for (const a of aliasesOf(cfg)) args.push("--network-alias", a);
    } else {
      connect.push(["network", "connect", ...aliasesOf(cfg).flatMap((a) => ["--alias", a]), net, name]);
    }
  });
  args.push(image);
  return { create: args, connect };
}

/**
 * PURE. The `docker create` argv of the pre-check container (§4 step 3): what
 * `replacementCreateArgs` gives the final container, except what would make it
 * a second website-server or a second owner of the public port. IDENTICAL: the
 * image (so the Caddyfile, the baked bundle and its verification), the overlay's
 * run flags (read-only, user, dropped capabilities, tmpfs), the healthcheck, the
 * log driver and its options, and the old container's networks. DIFFERENT: the
 * published port (an ephemeral loopback port, never the public one), the name,
 * no compose or instance labels (the instance's listing must still find one
 * website-server), no network aliases (nothing resolves the copy as
 * `website-server`) and no restart policy (it is removed after the check).
 */
export function precheckCreateArgs(old: ContainerInspect, name: string, image: string, overlayFlags: readonly string[]): { create: string[]; connect: string[][] } {
  const args = ["create", "--name", name];
  const log = old.HostConfig.LogConfig;
  if (log?.Type) {
    args.push("--log-driver", log.Type);
    for (const [k, v] of Object.entries(log.Config ?? {})) args.push("--log-opt", `${k}=${v}`);
  }
  args.push(...healthFlags(old.Config.Healthcheck), ...overlayFlags);
  const connect: string[][] = [];
  Object.keys(old.NetworkSettings.Networks ?? {}).forEach((net, i) => {
    if (i === 0) args.push("--network", net);
    else connect.push(["network", "connect", net, name]);
  });
  args.push("-p", "127.0.0.1::8080", image);
  return { create: args, connect };
}

/** PURE. The argv tail that runs a container's healthcheck once with `docker exec`, or null when it declares none. */
export function healthExecArgs(hc: ContainerInspect["Config"]["Healthcheck"]): string[] | null {
  if (!hc?.Test || hc.Test.length === 0) return null;
  const [kind, ...rest] = hc.Test;
  if (kind === "NONE") return null;
  return kind === "CMD-SHELL" ? ["sh", "-c", rest[0] ?? "true"] : rest;
}

/**
 * The name suffix of a first rollout's rollback target (§4, the first-rollout
 * rule): the nginx container that served before a host's first image swap,
 * kept stopped under `<its name>-first-rollout` until a swap from one site
 * image to another succeeds.
 */
export const FIRST_ROLLOUT_SUFFIX = "-first-rollout";

/** PURE. Whether a container runs a site image (its labels name a web release). An nginx container does not. */
export function runsSiteImage(c: Pick<ContainerInspect, "Config">): boolean {
  return Boolean((c.Config.Labels ?? {})[WEBSITE_IMAGE_LABELS.tag]);
}

/** What a swap puts on the public port: a new container of a site image, or a kept container started again. */
export type SwapTarget = { readonly kind: "image"; readonly image: string } | { readonly kind: "kept"; readonly container: ContainerInspect };

/**
 * PURE. One host command that runs `docker <first…>`, then `docker start
 * <start>`, and on a failed start `docker start <fallback>`. The body runs in a
 * background subshell that ignores SIGHUP and SIGPIPE, and the command waits
 * for it: a dropped SSH link ends the wait, never the body, so the host is
 * never left with the old container stopped and nothing started. It prints
 * `started`, or `failed: <docker's error>` followed by what the earlier
 * commands (the stop) wrote to stderr. One docker command per line.
 */
export function handoverScript(first: readonly (readonly string[])[], start: string, fallback: string | null): string {
  const docker = (args: readonly string[]) => ["docker", ...args].map(shellQuote).join(" ");
  return [
    "trap '' HUP PIPE",
    "(",
    "trap '' HUP PIPE",
    // The stop's own stderr is kept (never discarded): it reaches the failure message.
    'se=""',
    ...first.map((args) => `se="$se$(${docker(args)} 2>&1 >/dev/null)"`),
    `if err=$(${docker(["start", start])} 2>&1 >/dev/null); then echo started; else ${fallback === null ? "" : `${docker(["start", fallback])} >/dev/null 2>&1; `}echo "failed: $err\${se:+ (the stop said: $se)}"; fi`,
    ") </dev/null &",
    "wait $!",
  ].join("\n");
}

/** One answer from `${origin}/version.json`, or null. */
async function servedIdentity(origin: string, timeoutMs = 1_000): Promise<{ version: string; commit: string } | null> {
  try {
    const res = await fetch(`${origin}/version.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown; commit?: unknown };
    return typeof body.version === "string" && typeof body.commit === "string" ? { version: body.version, commit: body.commit } : null;
  } catch {
    return null;
  }
}

const sameIdentity = (a: { version: string; commit: string } | null, b: { version: string; commit: string } | null) =>
  a !== null && b !== null && a.version === b.version && a.commit === b.commit;

/**
 * Step 3's check of a site served at `origin`: the rows of the route and
 * header table (scripts/tests/support/website-routes-table.ts) that hold for
 * any bundle. /version.json names the release; a page, a client route that
 * falls back and a missing asset answer as §3.3 says, with the security
 * headers and Cache-Control values the server config sets, and no encoding.
 * The table's fixture rows (named files, the echo api) stay in the
 * integration tests. Returns every problem; empty means it passes.
 */
export async function checkServedSite(origin: string, release: Pick<SiteRelease, "version" | "commit">): Promise<string[]> {
  const problems: string[] = [];
  const get = async (path: string) => {
    const init = { headers: { "Accept-Encoding": "gzip, br" }, redirect: "manual", decompress: false, signal: AbortSignal.timeout(5_000) };
    const res = await fetch(new URL(path, origin), init as RequestInit);
    return { res, body: await res.text() };
  };
  const expectHeaders = (path: string, res: Response, want: Readonly<Record<string, string | null>>) => {
    for (const [name, value] of Object.entries(want)) {
      const got = res.headers.get(name);
      if (got !== value) problems.push(`${path}: header ${name} ${JSON.stringify(got)}, want ${JSON.stringify(value)}`);
    }
  };
  try {
    const v = await get("/version.json");
    if (v.res.status !== 200) problems.push(`/version.json: status ${v.res.status}, want 200`);
    let id: { version?: unknown; commit?: unknown } = {};
    try {
      id = JSON.parse(v.body) as typeof id;
    } catch {
      problems.push("/version.json: not JSON");
    }
    if (id.version !== release.version || id.commit !== release.commit) {
      problems.push(`/version.json names ${String(id.version)} at ${String(id.commit)}, want ${release.version} at ${release.commit}`);
    }
    expectHeaders("/version.json", v.res, { "cache-control": WEBSITE_ASSET_CACHE });
    for (const path of ["/", "/__rm-smoke-web-check/client-route"]) {
      const page = await get(path);
      if (page.res.status !== 200) problems.push(`${path}: status ${page.res.status}, want 200`);
      expectHeaders(path, page.res, { ...WEBSITE_SECURITY_HEADERS, "cache-control": WEBSITE_HTML_CACHE, "content-encoding": null });
    }
    const missing = await get("/__rm-smoke-web-check/missing.js");
    if (missing.res.status !== 404) problems.push(`/__rm-smoke-web-check/missing.js: status ${missing.res.status}, want 404`);
  } catch (error) {
    problems.push(`request failed: ${(error as Error).message}`);
  }
  return problems;
}

/** The host's Docker, through the recorded command channel. */
class HostDocker {
  constructor(private readonly host: WebHost) {}

  /** Run `docker <args>`; throw with its output on a non-zero exit. */
  async ok(args: readonly string[], what: string, stdin?: string | Uint8Array): Promise<string> {
    const r = await this.host.run(["docker", ...args], stdin);
    if (r.code !== 0) throw new Error(`${what} failed (docker ${args[0]} exited ${r.code}): ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  try(args: readonly string[], stdin?: string | Uint8Array): Promise<HostResult> {
    return this.host.run(["docker", ...args], stdin);
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    return (JSON.parse(await this.ok(["inspect", id], `inspecting container ${id}`)) as ContainerInspect[])[0]!;
  }

  async imageId(ref: string): Promise<string | null> {
    const r = await this.try(["image", "inspect", "--format", "{{.Id}}", ref]);
    return r.code === 0 && r.stdout !== "" ? r.stdout : null;
  }

  async imageLabels(ref: string): Promise<Record<string, string>> {
    return (JSON.parse(await this.ok(["image", "inspect", "--format", "{{json .Config.Labels}}", ref], `reading ${ref}'s labels`)) ?? {}) as Record<string, string>;
  }

  async imageLayers(ref: string): Promise<string[]> {
    return JSON.parse(await this.ok(["image", "inspect", "--format", "{{json .RootFS.Layers}}", ref], `reading ${ref}'s layers`)) as string[];
  }
}

/** One image-mode run: its receipt, its clock, its host. */
class ImageRun {
  readonly startedAt: string;
  readonly docker: HostDocker;
  readonly checks: ImageCheck[] = [];
  release: SiteRelease | null = null;
  apiVersion: string | null = null;
  oldContainer: { id: string; image: string } | null = null;
  newContainer: { id: string; image: string } | null = null;
  publicPort: number | null = null;
  copyPort: number | null = null;
  gap: SwapGap | null = null;
  revertGap: SwapGap | null = null;
  precheck: PrecheckTiming | null = null;
  dockerVersion: string | null = null;
  currentImage: string | null = null;
  previousImage: string | null = null;

  constructor(
    readonly action: WebAction,
    readonly deps: ImageReleaseDeps,
  ) {
    assertImageInstance(deps.instance);
    this.docker = new HostDocker(deps.host);
    this.startedAt = this.now();
  }

  now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  log(line: string): void {
    this.deps.log?.(line);
  }

  check(name: string, ok: boolean, detail: string): void {
    this.checks.push({ name, ok, detail });
    this.log(`${ok ? "pass" : "FAIL"} ${name}: ${detail}`);
  }

  private writeReceipt(outcome: ImageOutcome, error: string | null): ImageReceipt {
    const receipt: ImageReceipt = {
      schema: 2,
      mode: "image",
      instance: this.deps.instance,
      host: this.deps.host.name,
      action: this.action,
      outcome,
      release: this.release,
      apiVersion: this.apiVersion,
      oldContainer: this.oldContainer,
      newContainer: this.newContainer,
      publicPort: this.publicPort,
      copyPort: this.copyPort,
      checks: this.checks,
      gap: this.gap,
      revertGap: this.revertGap,
      precheck: this.precheck,
      dockerVersion: this.dockerVersion,
      currentImage: this.currentImage,
      previousImage: this.previousImage,
      error,
      startedAt: this.startedAt,
      finishedAt: this.now(),
    };
    mkdirSync(this.deps.receiptDir, { recursive: true, mode: 0o755 });
    const temporary = join(this.deps.receiptDir, `.receipt-${randomBytes(4).toString("hex")}`);
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
    renameSync(temporary, join(this.deps.receiptDir, IMAGE_RECEIPT_FILE));
    appendFileSync(join(this.deps.receiptDir, IMAGE_JOURNAL_FILE), `${JSON.stringify(receipt)}\n`, { mode: 0o644 });
    return receipt;
  }

  /** Take the host lock, run `body`, release the lock, and write the receipt on every outcome. */
  async locked(body: () => Promise<ImageOutcome>): Promise<ImageReceipt> {
    let outcome: ImageOutcome = "failed";
    let error: Error | null = null;
    let lockHeld = false;
    try {
      await this.lock();
      lockHeld = true;
      await this.removeStaleChecks();
      outcome = await body();
    } catch (e) {
      error = e as Error;
      outcome = e instanceof WebRefusal ? "refused" : this.revertGap !== null ? "reverted" : "failed";
    } finally {
      if (lockHeld) await this.docker.try(["network", "rm", hostLockName(this.deps.instance)]);
    }
    const receipt = this.writeReceipt(outcome, error?.message ?? null);
    if (error) throw error;
    return receipt;
  }

  /**
   * A pre-check container left by a run that died (the control machine lost
   * between its create and its kill). Under the host lock no other run of this
   * instance is making one. The name filter is anchored and fixed to this
   * instance's name and the 8 hex digits of checkCopy's suffix, so another
   * instance whose name starts with this one's is never matched.
   */
  async removeStaleChecks(): Promise<void> {
    const escaped = this.deps.instance.replace(/[.]/g, "\\.");
    const r = await this.docker.try(["ps", "-aq", "--no-trunc", "--filter", `name=^robotmoney-web-check-${escaped}-[0-9a-f]{8}$`]);
    if (r.code !== 0) return;
    for (const id of r.stdout.split("\n").filter((l) => l !== "")) {
      this.log(`removing the stale pre-check container ${id.slice(0, 12)} of an earlier run`);
      await this.docker.try(["rm", "-f", id]);
    }
  }

  /**
   * Refuse a host whose Docker cannot do the bounded stop (`docker stop
   * --signal`, Docker 25). Read before the pre-check copy is created and
   * before the old container is touched. Recorded in the receipt.
   */
  async checkDocker(): Promise<void> {
    const r = await this.docker.try(["version", "--format", "{{.Server.Version}}"]);
    const version = r.stdout.trim();
    if (r.code === 0 && version !== "") this.dockerVersion = version;
    const major = Number(/^(\d+)\./.exec(version)?.[1]);
    const ok = r.code === 0 && Number.isInteger(major) && major >= MIN_DOCKER_MAJOR;
    this.check("docker-version", ok, ok ? `Docker ${version} supports stop --signal` : `Docker ${version === "" ? `version unreadable (${r.stderr || r.stdout || `exit ${r.code}`})` : version}`);
    if (!ok) {
      throw new WebRefusal(
        `Refusing: docker too old for stop --signal: need ${MIN_DOCKER_MAJOR}, host has ${version === "" ? `an unreadable version (${r.stderr || r.stdout || `exit ${r.code}`})` : version}. Nothing was changed.`,
      );
    }
  }

  private async lock(): Promise<void> {
    const name = hostLockName(this.deps.instance);
    const create = ["network", "create", "--internal", "--label", `${LOCK_LABEL}=${this.deps.instance}`, "--label", `${LOCK_AT_LABEL}=${this.startedAt}`, name];
    let r = await this.docker.try(create);
    if (r.code === 0) return;
    const held = await this.docker.try(["network", "inspect", "--format", `{{index .Labels "${LOCK_AT_LABEL}"}}`, name]);
    const since = Date.parse(held.stdout);
    if (held.code === 0 && Number.isFinite(since) && Date.parse(this.startedAt) - since > HOST_LOCK_STALE_MS) {
      this.log(`taking over the stale host lock ${name}, held since ${held.stdout}`);
      await this.docker.try(["network", "rm", name]);
      r = await this.docker.try(create);
      if (r.code === 0) return;
    }
    throw new WebRefusal(
      `Refusing: ${this.deps.host.name} holds the web release lock for ${this.deps.instance} (${name}${held.code === 0 ? `, since ${held.stdout}` : `: ${r.stderr}`}). Another smoke:web is running.`,
    );
  }

  /** The one running website-server of the instance. */
  async serving(): Promise<ContainerInspect> {
    const ids = (await this.docker.ok(
      ["ps", "-q", "--no-trunc", "--filter", `label=${INSTANCE_LABEL}=${this.deps.instance}`, "--filter", `label=${SERVICE_LABEL}=${WEBSITE_SERVICE}`],
      "listing the running website-server",
    ))
      .split("\n")
      .filter((l) => l !== "");
    if (ids.length !== 1) {
      throw new WebRefusal(`Refusing: ${this.deps.host.name} runs ${ids.length} website-server containers for instance ${this.deps.instance}, not one.`);
    }
    const old = await this.docker.inspectContainer(ids[0]!);
    this.oldContainer = { id: old.Id, image: old.Image };
    this.publicPort = publicPortBinding(old).port;
    return old;
  }

  /** Step 1's range rule: the running API's version (read through the public port) is inside `release`'s range. */
  async checkApiRange(release: SiteRelease): Promise<void> {
    const local = await this.deps.host.openPort(this.publicPort!);
    let api: string;
    try {
      const res = await fetch(`${local.origin}/api/version`, { signal: AbortSignal.timeout(10_000) });
      const body = (await res.json()) as { api?: unknown };
      if (!res.ok || typeof body.api !== "string") throw new Error(`GET /api/version answered ${res.status} with no api version`);
      api = body.api;
    } catch (e) {
      this.check("api-range", false, `the running API's version could not be read: ${(e as Error).message}`);
      throw new WebRefusal(`Refusing: the running API's version could not be read (${(e as Error).message}), so ${release.tag}'s range cannot be checked. Nothing was changed.`);
    } finally {
      local.close();
    }
    this.apiVersion = api;
    if (!apiVersionInRange(api, release.apiRange)) {
      const range = release.apiRange === null ? "no declared range (outside every range, D54)" : `range ${release.apiRange}`;
      this.check("api-range", false, `API ${api} is outside ${range}`);
      throw new WebRefusal(`Refusing: the running API is ${api}, outside ${release.tag}'s ${range}. Nothing was changed.`);
    }
    this.check("api-range", true, `API ${api} is inside ${release.apiRange}`);
  }

  /**
   * The live check set of a site image, one function for both the pre-check
   * (on the spare port) and the post-switch check (on the public port), so the
   * second is a repeat of a check that already passed: the route and header
   * table, /version.json naming the release, the bundle's sha256 on the
   * container's labels (set by the image build from the verified bundle), the
   * API reached through the server's proxy naming the running API's version,
   * and the container's healthcheck command run once inside it. Returns every
   * problem; empty means it passes.
   */
  private async liveProblems(origin: string, release: SiteRelease, containerId: string, healthcheck: ContainerInspect["Config"]["Healthcheck"]): Promise<string[]> {
    const problems = await checkServedSite(origin, release);
    try {
      const labels = (await this.docker.inspectContainer(containerId)).Config.Labels ?? {};
      const sha = labels[WEBSITE_IMAGE_LABELS.bundleSha256];
      if (sha !== release.sha256) problems.push(`the container's bundle sha256 is ${String(sha)}, want ${release.sha256}`);
    } catch (e) {
      problems.push(`the container could not be inspected: ${(e as Error).message}`);
    }
    if (this.apiVersion !== null) {
      try {
        const res = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(5_000) });
        const body = (await res.json()) as { api?: unknown };
        if (!res.ok || body.api !== this.apiVersion) problems.push(`/api/version through the server answered ${res.status} naming ${String(body.api)}, want ${this.apiVersion}`);
      } catch (e) {
        problems.push(`/api/version through the server failed: ${(e as Error).message}`);
      }
    }
    const exec = healthExecArgs(healthcheck);
    if (exec !== null) {
      const r = await this.docker.try(["exec", containerId, ...exec]);
      if (r.code !== 0) problems.push(`the healthcheck command failed inside the container: ${r.stderr || r.stdout}`);
    }
    return problems;
  }

  /**
   * Step 3: the pre-check. A copy of `image` is created the way the final
   * container will be (precheckCreateArgs), started on an ephemeral loopback
   * port, timed from `docker start` to its first good answer (the cold start),
   * given the whole live check set, and killed. Nothing here touches the public
   * port or the old container. Refuses, before the old container is touched,
   * when the cold start plus the retire bound could not fit in the gap limit.
   *
   * It cannot prove the public port binds (a port conflict, a dangling
   * docker-proxy): only the swap itself finds that, and its revert answers it.
   */
  async checkCopy(image: string, release: SiteRelease, old: ContainerInspect): Promise<void> {
    const name = `robotmoney-web-check-${this.deps.instance}-${randomBytes(4).toString("hex")}`;
    const { create, connect } = precheckCreateArgs(old, name, image, websiteImageRunFlags(readWebsiteImageService(this.deps.repoRoot)));
    await this.docker.ok(create, "creating the pre-check container");
    try {
      for (const c of connect) await this.docker.ok(c, "connecting the pre-check container to its networks");
      const startedAt = Date.now();
      await this.docker.ok(["start", name], "starting the pre-check container");
      const port = Number((await this.docker.ok(["port", name, "8080/tcp"], "reading the pre-check container's port")).split("\n")[0]!.split(":").pop());
      this.copyPort = port;
      if (port === this.publicPort) throw new Error(`the pre-check container was given the public port ${port}`);
      const forward = await this.deps.host.openPort(port);
      try {
        const goodAt = await this.firstGoodAnswer(forward.origin, release);
        if (goodAt === null) {
          this.check("copy", false, `the pre-check container on port ${port} never named ${release.tag}`);
          throw new WebRefusal(`Refusing: the pre-check container of ${release.tag} never answered. The public port was not touched.`);
        }
        const limit = this.deps.gapLimitMs ?? GAP_LIMIT_MS;
        const timing: PrecheckTiming = { coldStartMs: goodAt - startedAt, retireBoundMs: (this.deps.stopTimeoutSeconds ?? STOP_GRACE_SECONDS) * 1000, gapLimitMs: limit };
        this.precheck = timing;
        const fits = timing.coldStartMs + timing.retireBoundMs <= limit;
        this.check(
          "cold-start",
          fits,
          `${timing.coldStartMs} ms from start to first good answer on the spare port, plus ${timing.retireBoundMs} ms retire bound, against the ${limit} ms gap limit`,
        );
        if (!fits) {
          throw new WebRefusal(
            `Refusing: ${release.tag} starts in ${timing.coldStartMs} ms, and with the ${timing.retireBoundMs} ms retire bound the gap could exceed ${limit} ms. The old container was not touched.`,
          );
        }
        const problems = await this.liveProblems(forward.origin, release, name, old.Config.Healthcheck);
        const ok = problems.length === 0;
        this.check("copy", ok, ok ? `the pre-check container on port ${port} passes the live check set for ${release.tag}` : problems.join("; "));
        if (!ok) throw new WebRefusal(`Refusing: the pre-check container of ${release.tag} failed: ${problems.join("; ")}. The public port was not touched.`);
      } finally {
        forward.close();
      }
    } finally {
      await this.docker.try(["rm", "-f", name]);
    }
  }

  /** Poll `origin` until it names `want` (or answers at all, for null); the time of that answer, or null at the deadline. */
  private async firstGoodAnswer(origin: string, want: { version: string; commit: string } | null): Promise<number | null> {
    const deadline = Date.now() + (this.deps.readyTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const got = await servedIdentity(origin, 500);
      if (want === null ? got !== null : sameIdentity(got, want)) return Date.now();
      await Bun.sleep(25);
    }
    return null;
  }

  private gapOf(start: number, end: number | null): SwapGap {
    const iso = (ms: number) => new Date(ms).toISOString();
    return { startedAt: iso(start), endedAt: end === null ? null : iso(end), ms: end === null ? null : end - start };
  }

  /** An active maintenance.json in the old container, read before a stop wipes its tmpfs. */
  private async readMaintenance(id: string): Promise<string | null> {
    // The immutable container's tmpfs first, then the nginx container's web/ mount.
    for (const path of [`${WEBSITE_MAINTENANCE_DIR}/${MAINTENANCE_FILE}`, `${WEBSITE_SERVED_ROOT}/${MAINTENANCE_FILE}`]) {
      const r = await this.docker.try(["exec", id, "cat", path]);
      if (r.code === 0 && r.stdout !== "") return r.stdout;
    }
    return null;
  }

  /**
   * Carry an active maintenance.json into the container that serves now. Never
   * throws: a file that cannot be carried is logged and recorded, and never
   * masks the swap's own result. Only a site image reads it from its tmpfs; a
   * first-rollout nginx container reads it from its web/ mount, which a stop
   * does not wipe, so nothing is written there.
   */
  private async writeMaintenance(target: { id: string; site: boolean }, body: string | null): Promise<void> {
    if (body === null || !target.site) return;
    const r = await this.docker.try(["exec", "-i", target.id, "sh", "-c", `cat > ${WEBSITE_MAINTENANCE_DIR}/${MAINTENANCE_FILE}`], body);
    if (r.code === 0) {
      this.log("carried the active maintenance.json into the serving container");
    } else {
      this.check("maintenance", false, `the active maintenance.json was not carried into ${target.id.slice(0, 12)}: ${r.stderr || r.stdout}`);
    }
  }

  /**
   * Run `script` (handoverScript) on the host as one command. Its body runs in
   * a background subshell that ignores SIGHUP and SIGPIPE, so a dropped SSH
   * link cannot stop it halfway. Returns `started`, or why the start failed.
   */
  private async handover(script: string): Promise<string> {
    const r = await this.deps.host.run(["sh", "-c", script]);
    const out = r.stdout.trim();
    return out === "started" ? out : out.replace(/^failed: /, "") || r.stderr || `the host command exited ${r.code}`;
  }

  /** The images `-current` and `-previous` name now, so a revert can put them back. */
  private async siteTags(): Promise<{ current: string | null; previous: string | null }> {
    const instance = this.deps.instance;
    return { current: await this.docker.imageId(siteImageTag(instance, "current")), previous: await this.docker.imageId(siteImageTag(instance, "previous")) };
  }

  private async restoreTags(tags: { current: string | null; previous: string | null }): Promise<void> {
    for (const slot of ["current", "previous"] as const) {
      const id = tags[slot];
      await this.docker.try(id === null ? ["rmi", siteImageTag(this.deps.instance, slot)] : ["tag", id, siteImageTag(this.deps.instance, slot)]);
    }
  }

  /**
   * Steps 4 to 7: replace `old` with `target` on the same public port. The
   * target is a new container of a site image, or a kept container started
   * again (the first-rollout rule's nginx, §4). Throws, after reverting to
   * `old`, when the target never answers, the gap is over the limit, the
   * public origin does not name `want`, or any later step throws.
   *
   * The stop, the start and the fallback to `old` are one host command, so a
   * dropped link never leaves the port with nothing behind it. Every error
   * after that command goes through the revert.
   */
  async swap(old: ContainerInspect, target: SwapTarget, want: SiteRelease): Promise<void> {
    const local = await this.deps.host.openPort(this.publicPort!);
    try {
      const publicOrigin = this.deps.publicOrigin ?? local.origin;
      const before = await servedIdentity(local.origin);
      const maintenance = await this.readMaintenance(old.Id);
      const oldName = old.Name.replace(/^\//, "");
      const suffix = randomBytes(3).toString("hex");
      const grace = this.deps.stopTimeoutSeconds ?? STOP_GRACE_SECONDS;
      let newId: string;
      let keptName: string | null = null;
      if (target.kind === "image") {
        const { create, connect } = replacementCreateArgs(old, `${oldName}-next-${suffix}`, target.image, websiteImageRunFlags(readWebsiteImageService(this.deps.repoRoot)));
        newId = await this.docker.ok(create, "creating the new website-server");
        this.newContainer = { id: newId, image: target.image };
        try {
          for (const c of connect) await this.docker.ok(c, "connecting the new website-server to its networks");
        } catch (e) {
          await this.docker.try(["rm", "-f", newId]);
          throw e;
        }
      } else {
        newId = target.container.Id;
        keptName = target.container.Name.replace(/^\//, "");
        this.newContainer = { id: newId, image: target.container.Image };
      }
      const priorTags = await this.siteTags();
      const limit = this.deps.gapLimitMs ?? GAP_LIMIT_MS;
      const oldIsSite = runsSiteImage(old);
      let failure: string | null = null;
      let retagged = false;
      const stopAt = Date.now();
      try {
        const started = await this.handover(handoverScript([retireArgs(old.Id, grace)], newId, old.Id));
        if (started !== "started") failure = `the new website-server did not start: ${started}`;
        const goodAt = failure === null ? await this.firstGoodAnswer(local.origin, want) : null;
        this.gap = this.gapOf(stopAt, goodAt);
        if (failure === null && goodAt === null) failure = `the public port never named ${want.tag}`;
        if (failure === null) {
          await this.writeMaintenance({ id: newId, site: target.kind === "image" }, maintenance);
          const ok = this.gap.ms! <= limit;
          this.check("gap", ok, `${this.gap.ms} ms from the stop to the first good answer (limit ${limit} ms)`);
          if (!ok) failure = `the gap was ${this.gap.ms} ms, over the ${limit} ms limit`;
        } else {
          this.check("gap", false, failure);
        }
        if (failure === null) {
          let served: { version: string; commit: string } | null = null;
          const deadline = Date.now() + 5_000;
          for (;;) {
            served = await servedIdentity(publicOrigin, 2_000);
            if (sameIdentity(served, want) || Date.now() > deadline) break;
            await Bun.sleep(200);
          }
          const ok = sameIdentity(served, want);
          this.check("public", ok, `${publicOrigin}/version.json names ${served ? `${served.version} at ${served.commit}` : "nothing"}`);
          if (!ok) failure = `${publicOrigin}/version.json does not name ${want.tag}`;
        }
        if (failure === null && target.kind === "image") {
          // The post-switch check repeats the pre-check's whole set, on the host's own public port.
          const problems = await this.liveProblems(local.origin, want, newId, old.Config.Healthcheck);
          this.check("live", problems.length === 0, problems.length === 0 ? `the public port passes the live check set for ${want.tag}` : problems.join("; "));
          if (problems.length > 0) failure = `the live check set failed on the public port: ${problems.join("; ")}`;
        }
        if (failure === null) {
          // Step 7. The old container is parked under another name first, so
          // every step here can still be undone by the revert.
          await this.docker.ok(["rename", old.Id, `${oldName}-old-${suffix}`], "parking the old website-server's name");
          await this.docker.ok(["rename", newId, oldName], "naming the new website-server");
          retagged = true;
          if (target.kind === "image") await this.retag(target.image, old);
          else await this.retagBackToKept(target.container, old);
          if (oldIsSite) {
            await this.docker.ok(["rm", old.Id], "removing the old website-server");
          } else {
            // The first-rollout rule (§4): the nginx container that served before
            // the first image swap is kept, stopped, as the rollback target.
            await this.docker.ok(["rename", old.Id, `${oldName}${FIRST_ROLLOUT_SUFFIX}`], "keeping the first-rollout container as the rollback target");
            this.log(`kept ${oldName}${FIRST_ROLLOUT_SUFFIX} (${old.Image}), stopped, as the first rollout's rollback target`);
          }
        }
      } catch (e) {
        failure = `${failure === null ? "" : `${failure}; then `}${(e as Error).message}`;
      }

      if (failure !== null) {
        // Step 6: the old container was only stopped. Start it again, by one host command.
        const revertAt = Date.now();
        const undo: string[][] =
          target.kind === "image"
            ? [["rm", "-f", newId]]
            : [retireArgs(newId, grace), ["rename", newId, keptName!]];
        const back = await this.handover(handoverScript([...undo, ["rename", old.Id, oldName]], old.Id, null));
        const backAt = back === "started" ? await this.firstGoodAnswer(local.origin, before) : null;
        this.revertGap = this.gapOf(revertAt, backAt);
        if (retagged) await this.restoreTags(priorTags);
        await this.writeMaintenance({ id: old.Id, site: oldIsSite }, maintenance);
        const revertOk = backAt !== null && this.revertGap.ms! <= limit;
        this.check(
          "revert",
          revertOk,
          back !== "started" ? `the previous website-server did not start: ${back}` : backAt === null ? "the previous site never answered again" : `${this.revertGap.ms} ms from the revert to the previous site's first good answer`,
        );
        this.currentImage = old.Image;
        this.previousImage = priorTags.previous;
        throw new Error(`The swap to ${want.tag} failed: ${failure}. The previous website-server was started again${backAt === null ? ", but it has not answered yet" : ""}.`);
      }
      await this.prune(target.kind === "image" && oldIsSite);
    } finally {
      local.close();
    }
  }

  /** Step 7 for a site image: `-current` names it, `-previous` the image that served before, if that was a site image (§4). */
  private async retag(current: string, old: ContainerInspect): Promise<void> {
    const instance = this.deps.instance;
    await this.docker.ok(["tag", current, siteImageTag(instance, "current")], "tagging the current image");
    if (runsSiteImage(old)) {
      await this.docker.ok(["tag", old.Image, siteImageTag(instance, "previous")], "tagging the previous image");
      this.previousImage = old.Image;
    } else {
      // The first swap from nginx: no previous image yet. The kept nginx container is the rollback target.
      await this.docker.try(["rmi", siteImageTag(instance, "previous")]);
      this.previousImage = null;
    }
    this.currentImage = current;
  }

  /**
   * Step 7 for a rollback to the first-rollout container: no site image
   * serves, so there is no `-current` and platform boots run nginx again. The
   * site image that served before is the one previous image.
   */
  private async retagBackToKept(kept: ContainerInspect, old: ContainerInspect): Promise<void> {
    const instance = this.deps.instance;
    await this.docker.ok(["tag", old.Image, siteImageTag(instance, "previous")], "tagging the previous image");
    await this.docker.ok(["rmi", siteImageTag(instance, "current")], "untagging the current image");
    this.previousImage = old.Image;
    this.currentImage = kept.Image;
  }

  /**
   * After a swap, never undone and never failing it: drop the candidate tag
   * and every other image of the instance, so the host holds exactly one
   * previous image. After a swap from a site image to a site image, the
   * first-rollout container has served its purpose and is removed too.
   */
  private async prune(normalRule: boolean): Promise<void> {
    const instance = this.deps.instance;
    await this.docker.try(["rmi", siteImageTag(instance, "candidate")]);
    const keep = new Set([this.currentImage, this.previousImage]);
    const labelled = await this.docker.try(["images", "-q", "--no-trunc", "--filter", `label=${SITE_IMAGE_INSTANCE_LABEL}=${instance}`]);
    for (const id of new Set(labelled.stdout.split("\n").filter((l) => l !== ""))) if (!keep.has(id)) await this.docker.try(["rmi", "-f", id]);
    if (normalRule) for (const id of await this.firstRolloutIds()) await this.docker.try(["rm", "-f", id]);
  }

  /** The ids of the instance's kept first-rollout containers. */
  async firstRolloutIds(): Promise<string[]> {
    const r = await this.docker.try([
      "ps", "-aq", "--no-trunc", "--filter", `label=${INSTANCE_LABEL}=${this.deps.instance}`, "--filter", `label=${SERVICE_LABEL}=${WEBSITE_SERVICE}`,
      "--filter", `name=${FIRST_ROLLOUT_SUFFIX}$`,
    ]);
    return r.code === 0 ? r.stdout.split("\n").filter((l) => l !== "") : [];
  }

  /**
   * What a kept first-rollout container serves: its web/ mount's version.json, read without starting it.
   * `docker cp` reads it from the stopped container itself. Its image may be gone: on Docker's containerd
   * image store a rebuild that moves the compose tag (the rolling boot rebuilds website-server's nginx
   * image and keeps the container) drops the old image although a container still uses it, so a
   * `docker run` of `kept.Image` fails "No such image" (stage run 20261115T034457Z, Q24c).
   */
  async releaseOfKept(kept: ContainerInspect): Promise<SiteRelease> {
    const tar = await this.docker.ok(["cp", "-L", `${kept.Id}:${IMAGE_VERSION_JSON}`, "-"], `reading the first-rollout container's version.json`);
    const text = fileOfTar(tar);
    let v: { version?: unknown; commit?: unknown } = {};
    try {
      v = JSON.parse(text) as typeof v;
    } catch {
      throw new WebRefusal("Refusing: the first-rollout container's version.json is not JSON.");
    }
    if (typeof v.version !== "string" || typeof v.commit !== "string") throw new WebRefusal("Refusing: the first-rollout container's version.json names no version and commit.");
    return { tag: `web-v${v.version}`, version: v.version, commit: v.commit, sha256: "", apiRange: readSiteApiRange(v) };
  }

  /**
   * `--rollback` with nothing running (a run that died between its stop and
   * its start): start the stopped container that served last, the one
   * `-current` names, or else the first-rollout container. Returns false when
   * a website-server runs.
   */
  async restartStopped(): Promise<boolean> {
    const filters = ["--filter", `label=${INSTANCE_LABEL}=${this.deps.instance}`, "--filter", `label=${SERVICE_LABEL}=${WEBSITE_SERVICE}`];
    const running = (await this.docker.ok(["ps", "-q", "--no-trunc", ...filters], "listing the running website-server")).split("\n").filter((l) => l !== "");
    if (running.length > 0) return false;
    const all = (await this.docker.ok(["ps", "-aq", "--no-trunc", ...filters], "listing the stopped website-servers")).split("\n").filter((l) => l !== "");
    if (all.length === 0) return false;
    const current = await this.docker.imageId(siteImageTag(this.deps.instance, "current"));
    const stopped = await Promise.all(all.map((id) => this.docker.inspectContainer(id)));
    // With no -current image (a first swap whose revert could not restart nginx, which then stays stopped
    // under its own name), the instance's only stopped website-server is what served last.
    const pick = stopped.find((c) => current !== null && c.Image === current && !c.Name.endsWith(FIRST_ROLLOUT_SUFFIX))
      ?? stopped.find((c) => c.Name.endsWith(FIRST_ROLLOUT_SUFFIX))
      ?? (current === null && stopped.length === 1 ? stopped[0] : undefined);
    if (!pick) throw new WebRefusal(`Refusing: no website-server runs for ${this.deps.instance}, and no stopped one is the current image, the first-rollout container, or (with no -current image) the only stopped website-server.`);
    this.oldContainer = { id: pick.Id, image: pick.Image };
    const started = await this.handover(handoverScript([], pick.Id, null));
    if (started !== "started") {
      this.check("restart", false, started);
      throw new Error(`Nothing served, and the stopped website-server ${pick.Id.slice(0, 12)} did not start: ${started}`);
    }
    const now = await this.docker.inspectContainer(pick.Id);
    if (pick.Name.endsWith(FIRST_ROLLOUT_SUFFIX)) await this.docker.try(["rename", pick.Id, pick.Name.replace(/^\//, "").slice(0, -FIRST_ROLLOUT_SUFFIX.length)]);
    this.newContainer = { id: pick.Id, image: pick.Image };
    this.publicPort = publicPortBinding(now).port;
    const forward = await this.deps.host.openPort(this.publicPort);
    try {
      const at = Date.now();
      const goodAt = await this.firstGoodAnswer(forward.origin, null);
      this.gap = this.gapOf(at, goodAt);
      this.check("restart", goodAt !== null, goodAt === null ? `${pick.Id.slice(0, 12)} started but never answered` : `started the stopped ${pick.Id.slice(0, 12)} (${pick.Image})`);
      if (goodAt === null) throw new Error(`The stopped website-server ${pick.Id.slice(0, 12)} started but never answered on port ${this.publicPort}.`);
    } finally {
      forward.close();
    }
    this.currentImage = pick.Image;
    return true;
  }

  /** Whether `image`'s layers start with `serverId`'s: the site image was built FROM that server image. */
  async builtFrom(image: string, serverId: string): Promise<boolean> {
    const [server, site] = await Promise.all([this.docker.imageLayers(serverId), this.docker.imageLayers(image)]);
    return server.length > 0 && server.every((l, i) => site[i] === l);
  }

  /** What a site image serves: its labels, and its version.json's identity and range. */
  async releaseOfImage(image: string): Promise<SiteRelease> {
    const labels = await this.docker.imageLabels(image);
    const text = await this.docker.ok(["run", "--rm", "--network", "none", "--entrypoint", "cat", image, IMAGE_VERSION_JSON], `reading ${image}'s version.json`);
    let versionJson: { version?: unknown; commit?: unknown } = {};
    try {
      versionJson = JSON.parse(text) as typeof versionJson;
    } catch {
      throw new WebRefusal(`Refusing: ${image}'s version.json is not JSON.`);
    }
    const release: SiteRelease = {
      tag: labels[WEBSITE_IMAGE_LABELS.tag] ?? "",
      commit: labels[WEBSITE_IMAGE_LABELS.commit] ?? "",
      sha256: labels[WEBSITE_IMAGE_LABELS.bundleSha256] ?? "",
      version: typeof versionJson.version === "string" ? versionJson.version : "",
      apiRange: readSiteApiRange(versionJson),
    };
    if (release.tag !== `web-v${release.version}` || release.commit !== versionJson.commit) {
      throw new WebRefusal(`Refusing: ${image}'s labels (${release.tag} at ${release.commit}) do not match its version.json.`);
    }
    return release;
  }
}

/** The one bundle tarball in `dir`. */
function onlyBundleIn(dir: string): string {
  const found = readdirSync(dir).filter((n) => parseBundleFileName(n) !== null);
  if (found.length !== 1) throw new WebRefusal(`Refusing: ${dir} holds ${found.length} web bundles, not one.`);
  return join(dir, found[0]!);
}

/** PURE. Whether `--bundle` names a release (`web-vA.B.C`) rather than a file. */
export function isReleaseName(bundle: string): boolean {
  return /^web-v\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(bundle);
}

/**
 * `bun smoke:web --host <h> --bundle <b> --server-image <s>`: deploy one
 * signed bundle as the instance's website-server (§4 steps 1 to 7).
 * Returns the receipt; throws (after writing it) on a refusal or a failure.
 */
export async function deployImage(opts: DeployImageOptions, deps: ImageReleaseDeps): Promise<ImageReceipt> {
  const run = new ImageRun("deploy", deps);
  const work = mkdtempSync(join(tmpdir(), "rm-smoke-web-image-"));
  try {
    return await run.locked(async () => {
      // Step 1, here: the bundle by path, or fetched from its release by name.
      let bundlePath = opts.bundle;
      if (isReleaseName(opts.bundle)) {
        if (!deps.fetchRelease) throw new WebRefusal(`Refusing: no way to fetch release ${opts.bundle}.`);
        const dir = join(work, "release");
        mkdirSync(dir);
        await deps.fetchRelease(opts.bundle, dir);
        bundlePath = onlyBundleIn(dir);
      }
      const extracted = join(work, "site");
      const verified = verifyBundle(bundlePath, extracted, { allowedSigners: deps.allowedSigners });
      if (!verified.ok) {
        run.check("verify-local", false, verified.reason);
        throw new WebRefusal(`Refusing: ${basename(bundlePath)} failed verification: ${verified.reason}. Nothing was sent to the host.`);
      }
      const release: SiteRelease = {
        tag: `web-v${verified.version}`,
        version: verified.version,
        commit: verified.commit,
        sha256: verified.sha256,
        apiRange: readSiteApiRange(JSON.parse(readFileSync(join(extracted, "version.json"), "utf8"))),
      };
      run.release = release;
      if (isReleaseName(opts.bundle) && opts.bundle !== release.tag) {
        throw new WebRefusal(`Refusing: release ${opts.bundle} carries a bundle for ${release.tag}.`);
      }
      if (opts.expectSha256 !== undefined && verified.sha256 !== opts.expectSha256) {
        run.check("verify-local", false, `sha256 ${verified.sha256}, the serving label names ${opts.expectSha256}`);
        throw new WebRefusal(`Refusing: ${basename(bundlePath)} hashes to ${verified.sha256}, but the serving container's ${WEBSITE_IMAGE_LABELS.bundleSha256} label names ${opts.expectSha256}: ${release.tag} names other bytes than those serving. Nothing was sent to the host.`);
      }
      run.check("verify-local", true, `${basename(bundlePath)} signed by ${verified.principal}, sha256 ${verified.sha256}`);

      const old = await run.serving();
      await run.checkDocker();
      await run.checkApiRange(release);
      if ((old.Config.Labels ?? {})[WEBSITE_IMAGE_LABELS.bundleSha256] === release.sha256) {
        // The same bundle on the same server image is already serving. On
        // another server image (a platform release that changes it, §5.3) the
        // same bundle is rebuilt and swapped in with every check.
        const serverId = await run.docker.imageId(opts.serverImage);
        if (serverId !== null && (await run.builtFrom(old.Image, serverId))) {
          run.currentImage = old.Image;
          run.log(`${release.tag} (sha256 ${release.sha256}) is already serving on server image ${serverId}; nothing to swap`);
          return "unchanged";
        }
        run.log(`${release.tag} (sha256 ${release.sha256}) serves on another server image; rebuilding it FROM ${opts.serverImage}`);
      }

      // Step 1, on the host, then step 2.
      const image = await buildOnHost(run, bundlePath, release, opts.serverImage);
      try {
        await run.checkCopy(image, release, old);
        await run.swap(old, { kind: "image", image }, release);
      } catch (e) {
        // A candidate that never kept the port is not kept: the host holds exactly one previous image.
        // A build can reproduce an image the host already keeps (the same bundle on the same
        // server image): that id is the current or the previous image, and is never removed.
        const kept = await run.docker.imageId(siteImageTag(deps.instance, "current"));
        const previous = await run.docker.imageId(siteImageTag(deps.instance, "previous"));
        if (image !== kept && image !== previous && image !== old.Image) await run.docker.try(["rmi", "-f", image]);
        throw e;
      }
      return "swapped";
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Send the bundle to the host, verify it there, and build its image FROM the server image's id. Returns the image id. */
async function buildOnHost(run: ImageRun, bundlePath: string, release: SiteRelease, serverImage: string): Promise<string> {
  const { docker, deps } = run;
  const mk = await deps.host.run(["mktemp", "-d"]);
  if (mk.code !== 0 || mk.stdout === "") throw new Error(`mktemp -d on the host failed: ${mk.stderr}`);
  const dir = mk.stdout;
  try {
    const put = async (path: string, data: Uint8Array) => {
      const r = await deps.host.run(["sh", "-c", `cat > ${shellQuote(path)}`], data);
      if (r.code !== 0) throw new Error(`writing ${path} on the host failed: ${r.stderr}`);
    };
    const made = await deps.host.run(["mkdir", `${dir}/bundle`, `${dir}/ctx`]);
    if (made.code !== 0) throw new Error(`mkdir on the host failed: ${made.stderr}`);
    const name = basename(bundlePath);
    for (const suffix of ["", ".sha256", ".sha256.sig"]) await put(`${dir}/bundle/${name}${suffix}`, readFileSync(`${bundlePath}${suffix}`));
    await put(`${dir}/Dockerfile.bundle`, readFileSync(join(deps.repoRoot, "website-server", "Dockerfile.bundle")));

    const serverId = await docker.imageId(serverImage);
    if (serverId === null) throw new WebRefusal(`Refusing: ${deps.host.name} has no server image ${serverImage}.`);
    // BuildKit refuses a bare image id as FROM, so the id is pinned by a tag named for it.
    const pin = `${SERVER_PIN_REPO}:${serverId.replace(/^sha256:/, "")}`;
    await docker.ok(["tag", serverId, pin], "pinning the server image by id");

    // On the host, by the server image's own verifier, against its own allowed-signers file.
    const verify = await docker.try([
      "run", "--rm", "--network", "none", "--user", "0:0", "-v", `${dir}/bundle:/in:ro`,
      "--entrypoint", "rm-verify-web-bundle", serverId, "/in", HOST_VERIFY_OUT, release.tag, release.commit, release.sha256,
    ]);
    const verifyOut = verify.stderr || verify.stdout;
    run.check("verify-host", verify.code === 0, verifyOut);
    if (verify.code !== 0) throw new WebRefusal(`Refusing: ${name} failed verification on ${deps.host.name}: ${verifyOut}. No image was built.`);

    const candidate = siteImageTag(deps.instance, "candidate");
    const build = await docker.try([
      "build", "-q", "--label", `${SITE_IMAGE_INSTANCE_LABEL}=${deps.instance}`, "-t", candidate,
      "-f", `${dir}/Dockerfile.bundle`, "--build-context", `bundle=${dir}/bundle`,
      "--build-arg", `SERVER_IMAGE=${pin}`, "--build-arg", `WEB_TAG=${release.tag}`,
      "--build-arg", `WEB_COMMIT=${release.commit}`, "--build-arg", `BUNDLE_SHA256=${release.sha256}`,
      `${dir}/ctx`,
    ]);
    if (build.code !== 0) {
      run.check("build", false, build.stderr || build.stdout);
      throw new WebRefusal(`Refusing: the image build failed on ${deps.host.name}: ${build.stderr || build.stdout}`);
    }
    const image = await docker.imageId(candidate);
    if (image === null) throw new Error(`the build left no ${candidate}`);
    const [serverLayers, siteLayers, labels] = await Promise.all([docker.imageLayers(serverId), docker.imageLayers(image), docker.imageLabels(image)]);
    const fromServer = serverLayers.length > 0 && serverLayers.every((l, i) => siteLayers[i] === l);
    const labelled =
      labels[WEBSITE_IMAGE_LABELS.tag] === release.tag && labels[WEBSITE_IMAGE_LABELS.commit] === release.commit && labels[WEBSITE_IMAGE_LABELS.bundleSha256] === release.sha256;
    const detail = `${image} from server image ${serverId}${fromServer ? "" : " (its layers do not start with the server image's)"}${labelled ? "" : " (its labels do not name the bundle)"}`;
    run.check("build", fromServer && labelled, detail);
    if (!fromServer || !labelled) {
      await docker.try(["rmi", "-f", image]);
      throw new WebRefusal(`Refusing: the built image ${image} is not the server image ${serverId} plus ${release.tag}.`);
    }
    return image;
  } finally {
    await deps.host.run(["rm", "-rf", dir]);
  }
}

/**
 * `bun smoke:web --host <h> --rollback`: swap the instance back to its one
 * previous image (§4: the apiRange refusal, then steps 3 to 7).
 */
export async function rollbackImage(deps: ImageReleaseDeps): Promise<ImageReceipt> {
  const run = new ImageRun("rollback", deps);
  return run.locked(async () => {
    // A run that died between its stop and its start left nothing serving: start what served last.
    if (await run.restartStopped()) return "swapped";
    const old = await run.serving();
    await run.checkDocker();
    const previous = await run.docker.imageId(siteImageTag(deps.instance, "previous"));
    if (previous === null) {
      // The first-rollout rule (§4): until a swap from one site image to another
      // succeeds, the nginx container that served before the first swap is the
      // rollback target. It is started again as it was: its own image, its own
      // web/ mount. There is no throwaway copy of it to check.
      const [keptId] = await run.firstRolloutIds();
      if (keptId === undefined || !runsSiteImage(old)) {
        throw new WebRefusal(
          `Refusing: ${deps.host.name} holds no previous image for ${deps.instance} (${siteImageTag(deps.instance, "previous")}) and no first-rollout container.`,
        );
      }
      const kept = await run.docker.inspectContainer(keptId);
      const release = await run.releaseOfKept(kept);
      run.release = release;
      await run.checkApiRange(release);
      await run.swap(old, { kind: "kept", container: kept }, release);
      return "swapped";
    }
    if (previous === old.Image) throw new WebRefusal(`Refusing: the previous image ${previous} is the one already serving.`);
    const release = await run.releaseOfImage(previous);
    run.release = release;
    await run.checkApiRange(release);
    await run.checkCopy(previous, release, old);
    await run.swap(old, { kind: "image", image: previous }, release);
    return "swapped";
  });
}

/** The last image-mode receipt in `receiptDir`, or null. */
export function readImageReceipt(receiptDir: string): ImageReceipt | null {
  const file = join(receiptDir, IMAGE_RECEIPT_FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ImageReceipt) : null;
}
