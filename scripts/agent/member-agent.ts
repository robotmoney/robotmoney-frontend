// The member-agent container PRIMITIVE (docs/architecture.md §11.3 E5,
// docs/decisions.md D22 "shared components").
//
// One place that knows how to launch a vanilla OpenCode agent container: the
// per-run tmpdir and mounted `opencode.json`, the deterministic container name,
// the `docker compose run` argv, draining BOTH pipes, killing the CLI, and
// removing the container. Extracted verbatim from
// scripts/lib/onboarding-eval.ts's runOnboardingEval so the eval's layers and
// the demo's single admission launch containers the SAME way.
//
// ── Model and credential: RESOLVED BY THE CALLER, never by this module ──────
// (docs/decisions.md D22 rule 1 AS AMENDED 2026-07-28, docs/architecture.md
// §11.3 E1 as amended.)
//
// This module reads NO environment variable and holds no model id. It takes a
// `MemberAgentModel` — exactly the record `resolveModelConfig()` in
// scripts/lib/onboarding-eval.ts produces from `resolveAgentModel()` /
// `isKeylessModel()` against scripts/lib/model-registry.ts — and does what that
// record says. There is deliberately no second selection path here: no default
// model, no fallback, no `process.env` read, no in-code constant. Handing this
// primitive a model is the ONLY way it gets one.
//
// An earlier revision of this file asserted that the argv "can never carry a
// `-e` flag — there is no parameter, no branch, and no ambient value". That
// invariant is GONE and the assertion with it: D22 rule 1's keyless mandate was
// amended because `opencode/big-pickle`, the free model it pinned, is saturated
// upstream with no paid sibling to escape to. The eval now runs a funded,
// registry-selected model billed to OPENCODE_API_KEY, and a container inherits
// nothing — so an explicit `-e` injection at `docker compose run` time is the
// only way the credential can reach it.
//
// What survives from that invariant, and is enforced here: AT MOST ONE MODEL
// CREDENTIAL `-e` flag, carrying exactly the env NAME the registry chose
// (`apiKeyEnv`), and ONLY when the resolved model actually needs credit. A
// keyless selection (`AGENT_MODEL=free`, `isKeylessModel(model) === true`)
// yields `apiKeyEnv: null` and the argv carries no credential `-e` at all — the
// keyless path is still a real, fully-supported path, it is simply no longer
// the only one.
//
// The ONE other source of `-e` flags is the caller's explicit `ownerEnv`: the
// half of the session environment a real applicant's HUMAN would have exported
// before launching their agent (the onboarding eval's single use is the
// keystore passphrase the published swarm-onboarding skill tells the agent
// to ask its owner for). It is an explicit parameter, never an ambient read,
// and every value in it is redacted out of the returned transcript.
//
// It also has no inference-off affordance: the `observe`/`inspect` hooks watch
// a real run, they can never stand in for one (E2).
//
// Cleanup is BRACKETED, not a caller obligation: removal happens in the same
// `finally` regardless of how the run ends, so a kept container cannot leak.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeArgs, DEFAULT_COMPOSE_FILES } from "../stack/config.ts";
import {
  createOnboardingTelemetry,
  drainRedactedStream,
  redactTelemetryText,
  type OnboardingEventSink,
  type OnboardingTelemetry,
  type RedactionSecret,
} from "../lib/onboarding-telemetry.ts";

/**
 * The model + credential this primitive runs with, resolved by the caller.
 *
 * Structurally identical to `ModelConfig` in scripts/lib/onboarding-eval.ts
 * (`resolveModelConfig`'s return), which is what every real caller passes —
 * declared here rather than imported so the low-level primitive does not depend
 * on the higher-level harness, and deliberately NOT re-derived from anything:
 * whatever the registry resolved is what runs.
 *
 * `apiKeyEnv === null` ⇔ keyless: no `-e` flag is emitted at all.
 */
export interface MemberAgentModel {
  /** Full `opencode/<id>`, from resolveAgentModel(). */
  model: string;
  /** Env var name the credential is injected under, or null when keyless. */
  apiKeyEnv: string | null;
  /** The credential value, or null when keyless. */
  apiKey: string | null;
}

// opencode.json written per-run, mounted read-only into the container (never
// baked into the image). Carries NO onboarding-specific knowledge and no
// Robot Money connectivity config — the agent reaches the swarm REST API
// with plain HTTP (bash), using the base URL carried in the prompt's harness
// note (D21: the MCP transport is retired, so there is no MCP client to wire).
//
// The model arrives as a PARAMETER, resolved by the caller from the registry —
// this function invents nothing.
//
// ── Why EVERY tool is allowed (this used to be `{"*": "deny", bash: "allow"}`)
// §11 R8 says the container is a VANILLA OpenCode install and the eval measures
// OUR INSTRUCTIONS. A deny-by-default ruleset measured our own permission
// gauntlet instead — and it measured it wrong. opencode merges this config with
// its own built-in rules and evaluates them LAST-MATCH-WINS, so a blanket
// `"*": "deny"` silently overrode the built-in allowances too. Measured live in
// CI run 30395466780 the agent lost `read`, `write`, `edit` and `webfetch`
// outright, and even a plain `cat` of a file it had just cloned was refused:
//
//   $ cat /tmp/opencode/robotmoney-core/BOOTSTRAP.md
//   The user has specified a rule which prevents you from using this specific
//   tool call. Here are some of the relevant rules [… {"permission":
//   "external_directory","pattern":"/tmp/opencode/*","action":"allow"},
//   {"permission":"*","action":"deny","pattern":"*"} …]
//
// It burned minutes of its budget rediscovering `grep -n "." <file>` as a `cat`
// substitute and never reached the API. None of that is a fact about our
// onboarding instructions, which is the only thing this eval is allowed to
// report on.
//
// The 2026-07-27 revision tried to patch that one symptom at a time: it added
// `external_directory: "allow"` because opencode's defaults contain
// `external_directory: { "*": "ask", … }` and an "ask" in a non-interactive
// `opencode run` has nobody to ask, so it RESOLVES TO A REJECTION rather than a
// wait — an agent that cloned the swarm-onboarding skill into /tmp could
// `ls` its way to SKILL.md and never read a byte of it. That diagnosis was
// right and its fix survives here in the general form: nothing in this
// container stops to ask, and nothing is denied.
//
// An operator who pastes the canonical prompt into their own agent runs it with
// their own permissions — headlessly, that means auto-approve — so allow-all is
// the faithful analogue, and the blast radius is one disposable container on an
// ephemeral compose network. `--auto` (buildMemberAgentArgv) auto-approves
// everything not explicitly denied; this config denies nothing, so the two
// agree instead of fighting.
//
// The model arrives as a PARAMETER, resolved by the caller from the registry —
// this function invents nothing.
export function buildAgentOpencodeConfig(model: string): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    model,
    autoupdate: false,
    permission: { "*": "allow" },
  };
}

// ── Secret redaction ────────────────────────────────────────────────────────
// A failed run's transcript is printed WHOLE into CI logs and the demo's
// console (scripts/lib/demo-main.ts). This primitive hands the container its
// secrets by `-e`, and a curious agent runs `env` — observed verbatim in a
// local run:
//
//   $ env | sort
//   RMPC_COMMITTEE_IDENTITY_PASSPHRASE=3e4bab64-…
//   OPENCODE_API_KEY=sk-…
//
// GitHub masks registered repository secrets, but nothing masks them in a local
// `bun run demo`, on Stage, or in a transcript pasted into an issue. So redact
// AT THE SOURCE — here, where the injection happens and where the exact values
// are known — never on a pattern guess, which would either miss a rotated key
// shape or scrub unrelated text out of the evidence.
export function redactSecrets(text: string, secrets: Array<[string | null | undefined, string]>): string {
  return redactTelemetryText(
    text,
    secrets.map(([value, placeholder]) => ({ value, placeholder })),
  );
}

export async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

// A deterministic, explicit container name — NOT left to `docker compose
// run`'s auto-generated one — so cleanup can target the real container
// directly. This matters because `proc.kill()` below only signals the local
// `docker` CLI process; `docker compose run` is a client of the Docker daemon,
// and the CONTAINER it starts is NOT a child process of that CLI. Killing the
// CLI does not reliably stop the container (a well-known Docker gotcha,
// confirmed live: a "timed out" eval's container kept running and reasoning
// for 10+ minutes after the harness gave up on it and a RETRY launched a
// second container concurrently with the still-running first one).
//
// The name inherits its environment scope from `project`, which is the compose
// project (scripts/stack/naming.ts: `rm_ci_stack_<job hash>` /
// `rm_demo_eval_<random>` / …). So an eval container is attributable to the
// environment that spawned it by NAME, and — since `docker compose run` applies
// docker-compose.demo.yml's member-agent labels — by robotmoney.env /
// robotmoney.env.hash LABEL as well.
export function memberAgentContainerName(project: string, runId: string): string {
  return `${project}-member-agent-eval-${runId}`;
}

/** One additional `-v` mount: a host path (bind) or a named volume. */
export interface MemberAgentMount {
  /** Host path (absolute) or docker named-volume name. */
  source: string;
  /** Absolute path inside the container. */
  target: string;
  readonly?: boolean;
}

export interface MemberAgentArgvOptions {
  composeProject: string;
  composeFiles?: string[];
  containerName: string;
  opencodeConfigPath?: string;
  title?: string;
  prompt?: string;
  /** Resolved by the caller from scripts/lib/model-registry.ts. Required. */
  modelConfig: MemberAgentModel;
  /**
   * SESSION-PARTICIPATION MODE (issue #361 Phase 2). When set, the container
   * runs `--entrypoint <entrypoint>` with `command` as its argv instead of the
   * default `opencode run …` tail — this is how a SITTING member's container
   * runs the member's own deterministic session client (the member's "own
   * software", mounted by its owner via `mounts`) rather than a prompt-driven
   * vanilla agent. Everything else about the rail — the explicit single model
   * credential `-e`, the ownerEnv injection + redaction, the deterministic
   * container name, launch watcher, kill + `docker rm -f` — is IDENTICAL in
   * both modes; there is deliberately no second launch path.
   */
  entrypoint?: string;
  command?: string[];
  /**
   * Additional read-only facts the container needs that are NOT secrets
   * (API base URL, member id, session date, resolved model id …), emitted as
   * sorted `-e` pairs. NEVER put a secret here — values are NOT redacted from
   * the returned transcript; secrets belong in `ownerEnv` (or the model
   * credential in `modelConfig`), whose values are redacted at the source.
   */
  extraEnv?: Record<string, string>;
  /**
   * Additional mounts: the member's own minimal client artifact (a read-only
   * single-file bind, never the repository/worktree) and the member's
   * persistent keystore/home volume (issue #361 Phase 3 — identity continuity
   * across sessions).
   */
  mounts?: MemberAgentMount[];
  /**
   * The OWNER's half of the session's environment — what a real applicant's
   * human would have exported into the shell they launch their agent from,
   * emitted as additional `-e NAME=VALUE` pairs in a stable, sorted order.
   *
   * NOT a general escape hatch for harness knowledge: values here are secrets
   * and machine facts the container cannot discover, never instructions. The
   * onboarding eval's single use is the keystore passphrase (see
   * scripts/lib/onboarding-eval.ts's KEYSTORE_PASSPHRASE_ENV), because the
   * published swarm-onboarding skill tells the agent to ask its owner to
   * export it and to WAIT for them — unanswerable in a headless container.
   *
   * Anything passed here is REDACTED out of the returned transcript.
   */
  ownerEnv?: Record<string, string>;
  // When true, `--rm` is omitted so the STOPPED container survives long enough
  // to be inspected (eval layers 1-3 read its filesystem). Nothing else about
  // the argv changes.
  keep?: boolean;
}

/**
 * The exact `docker compose run` argv. Pure — no env read, no I/O.
 *
 * CREDENTIAL INJECTION is the only conditional part: exactly one `-e
 * <apiKeyEnv>=<apiKey>` when the resolved model needs credit, and nothing at
 * all when it does not. A container inherits no ambient environment, so this
 * explicit injection is the only route in — and because the NAME comes from
 * the resolved config rather than from a list of candidates, there is exactly
 * one MODEL credential env var the container can ever see. The only other `-e`
 * flags are the caller's explicit `ownerEnv` (see its doc comment); nothing is
 * ever sourced from the ambient environment.
 *
 * Throws when a non-keyless config arrives with no key rather than silently
 * launching an unauthenticated container that will 401 twenty minutes later.
 */
export function buildMemberAgentArgv(a: MemberAgentArgvOptions): string[] {
  const { model, apiKeyEnv, apiKey } = a.modelConfig;
  if (!model) throw new Error("buildMemberAgentArgv: modelConfig.model is required — resolve it via resolveAgentModel()");
  if (apiKeyEnv && !apiKey) {
    throw new Error(
      `buildMemberAgentArgv: modelConfig names credential env ${apiKeyEnv} but carries no value — ` +
        "resolveModelConfig() throws on that case; do not construct one by hand.",
    );
  }
  const commandMode = a.command !== undefined;
  if (commandMode && (!a.entrypoint || a.command!.length === 0)) {
    throw new Error("buildMemberAgentArgv: session-participation mode requires both `entrypoint` and a non-empty `command`");
  }
  if (!commandMode && (!a.opencodeConfigPath || a.title === undefined || a.prompt === undefined)) {
    throw new Error("buildMemberAgentArgv: opencode mode requires opencodeConfigPath, title, and prompt");
  }
  const sortedEnvPairs = (env: Record<string, string> | undefined) =>
    Object.entries(env ?? {})
      .sort(([l], [r]) => (l < r ? -1 : l > r ? 1 : 0))
      .flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return [
    "docker",
    ...composeArgs(a.composeProject, a.composeFiles ?? DEFAULT_COMPOSE_FILES),
    "run",
    ...(a.keep ? [] : ["--rm"]),
    "--no-deps",
    ...(commandMode ? ["--entrypoint", a.entrypoint!] : []),
    "--name",
    a.containerName,
    ...(commandMode ? [] : ["-v", `${a.opencodeConfigPath}:/home/agent/opencode.json:ro`]),
    // The caller's explicit additional mounts (minimal member client artifact
    // + persistent keystore volume), in caller order.
    ...(a.mounts ?? []).flatMap((m) => ["-v", `${m.source}:${m.target}${m.readonly ? ":ro" : ""}`]),
    // AT MOST ONE MODEL credential `-e`, under the env name the registry chose,
    // and only when the resolved model is funded. A keyless model gets no flag
    // at all.
    ...(apiKeyEnv ? ["-e", `${apiKeyEnv}=${apiKey}`] : []),
    // Non-secret configuration facts (never redacted — see extraEnv's doc).
    ...sortedEnvPairs(a.extraEnv),
    // The owner's half of the session environment, sorted so the argv is
    // deterministic and diffable.
    ...sortedEnvPairs(a.ownerEnv),
    "member-agent",
    ...(commandMode ? a.command! : buildOpencodeRunTail(a)),
  ];
}

// The default (opencode) command tail, extracted verbatim so the two modes
// share one argv builder above it.
function buildOpencodeRunTail(a: MemberAgentArgvOptions): string[] {
  return [
    "run",
    "--model",
    a.modelConfig.model,
    "--format",
    "json",
    // opencode's REAL "the operator is not at the keyboard" flag: auto-approve
    // every permission that is not explicitly denied, and buildAgentOpencodeConfig
    // denies none.
    //
    // This used to be `--dangerously-skip-permissions`, which opencode has
    // never had — `opencode run --help` in the pinned v1.18.1 image offers
    // `--auto`. yargs accepts unknown `--flags` SILENTLY, so nothing failed and
    // nothing warned while every permission `ask` stayed armed and, in a
    // headless container, unanswerable. That cost four consecutive red runs of
    // the required gate. The Docker-backed rails check
    // (scripts/tests/integration/onboarding-eval-infra.test.ts) now asserts
    // every flag emitted here against the pinned binary's own `--help`, because
    // an assertion on our own argv could never have caught it.
    "--auto",
    "--title",
    a.title!,
    "--dir",
    "/home/agent",
    a.prompt!,
  ];
}

// ── Persistent member volumes (issue #361 Phase 3: identity continuity) ─────
// A named docker volume that carries one member's HOME (its keystore, its
// stored bearer token, its installed tooling) across container runs, so the
// key that enrolled/onboarded a member is the key that signs every later take.
// Created explicitly — never left to `docker run`'s implicit auto-create — so
// it carries the SAME reap-by-label channel every demo container and the
// pgdata volume already carry (robotmoney.demo=1 + robotmoney.demo.project):
// `bun run demo:clean` and CI's teardown can find and reclaim it by LABEL.
export function memberHomeVolumeName(project: string, slug: string): string {
  // Docker volume names must match [a-zA-Z0-9][a-zA-Z0-9_.-]*.
  const safe = slug.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return `${project}_member_home_${safe}`;
}

export function ensureMemberVolume(
  name: string,
  project: string,
  env?: Record<string, string>,
): void {
  const inspect = Bun.spawnSync(["docker", "volume", "inspect", name], {
    ...(env ? { env } : {}),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if (inspect.exitCode === 0) return;
  const create = Bun.spawnSync(
    [
      "docker", "volume", "create",
      "--label", "robotmoney.demo=1",
      "--label", `robotmoney.demo.project=${project}`,
      name,
    ],
    { ...(env ? { env } : {}), stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  if (create.exitCode !== 0) {
    throw new Error(
      `ensureMemberVolume: docker volume create ${name} failed (exit ${create.exitCode}): ` +
        `${new TextDecoder().decode(create.stderr as Uint8Array).slice(0, 300)}`,
    );
  }
}

// ── The compose child's environment and stdio (both LOAD-BEARING) ───────────
//
// ENVIRONMENT. `docker compose run` re-resolves the WHOLE compose model, not
// just the service named on the command line, and `ensureProjectVolumes` then
// compares every project volume against the `com.docker.compose.config-hash`
// label recorded when that volume was created. docker-compose.demo.yml's
// pgdata volume carries `robotmoney.demo.project: ${DEMO_PROJECT}`, so a child
// that does not carry DEMO_PROJECT hashes a volume definition whose label is
// the empty string — a DIFFERENT hash from the one `stack.up()` recorded, which
// makes compose print
//
//   Volume "<project>_pgdata" exists but doesn't match configuration in
//   compose file. Recreate (data will be lost)?
//
// and wait for an answer. Reproduced end-to-end on this repo's own compose
// files with compose 2.40.3; with a PTY on stdin the invocation BLOCKS
// indefinitely, and "yes" would delete the running stack's postgres data
// mid-run. DEMO_PROJECT is by definition the compose project name
// (scripts/stack/config.ts's buildComposeEnv sets `DEMO_PROJECT: cfg.project`),
// so it is DERIVED here rather than plumbed — a caller cannot forget it.
//
// STDIN. Every compose invocation on this path runs with stdin closed
// (`/dev/null`), so a confirmation prompt can only ever be declined
// immediately. A harness question that waits forever is how a 20-minute
// per-sample budget gets burned by the harness and then reported as a product
// timeout; there is no compose flag that answers this particular prompt
// non-interactively (`docker compose run --help`, 2.40.3, has no `--yes`), so
// closing stdin IS the mechanism.
// The ambient-environment wrapper, kept HERE rather than at the call sites, so
// an eval-side compose child never has to assemble its own env. Every compose
// child in the eval path must use it, or it re-opens the volume-hash mismatch
// memberAgentSpawnEnv exists to close.
//
// NOTE ON SCOPE: this is the environment of the local `docker` CLI process, not
// of the CONTAINER. A container inherits nothing from it; the only thing that
// ever reaches the container's environment is the single explicit `-e` flag
// buildMemberAgentArgv emits from the resolved model config.
export function composeChildEnv(composeProject: string): Record<string, string> {
  return memberAgentSpawnEnv(composeProject, process.env);
}

export function memberAgentSpawnEnv(
  composeProject: string,
  hostEnv: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(hostEnv)) if (v !== undefined) out[k] = v;
  out.DEMO_PROJECT = composeProject;
  return out;
}

// Does the named container exist right now (running, exited, or created)?
// `docker inspect` is a read-only daemon query; it is the POSITIVE evidence
// that the container the compose CLI was asked for actually came into being.
export function containerExists(containerName: string, env?: Record<string, string>): boolean {
  const r = Bun.spawnSync(["docker", "inspect", "--type", "container", containerName], {
    ...(env ? { env } : {}),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return r.exitCode === 0;
}

// How long the launch watcher below keeps looking for the container before it
// gives up and reports "unknown". Generous: a cold `docker compose run` on a
// loaded host can take tens of seconds to create the container.
export const CONTAINER_LAUNCH_WATCH_MS = 120_000;
// Tight on purpose: `--rm` removes the container as soon as it exits, so the
// only window in which a container that DID launch could be missed is one that
// lived for less than one poll interval. An opencode container takes seconds
// to boot, and a container that died faster than this carried no agent either
// way. The classifier additionally requires an EMPTY event stream before it
// will call a run "never launched" (scripts/agent/classify-outcome.ts), so a
// single missed poll cannot on its own manufacture a harness error.
const CONTAINER_LAUNCH_POLL_MS = 250;

// `docker cp`, NOT `docker exec`: exec cannot run on a STOPPED container, and
// inspecting a stopped container's filesystem is exactly how eval layers 1-3
// observe without editing the task under test (§11.3 E3).
export function containerFileExists(containerName: string, path: string): boolean {
  const r = Bun.spawnSync(["docker", "cp", `${containerName}:${path}`, "-"], { stdout: "ignore", stderr: "ignore" });
  return r.exitCode === 0;
}

export function copyFromContainer(containerName: string, containerPath: string, hostPath: string): boolean {
  const r = Bun.spawnSync(["docker", "cp", `${containerName}:${containerPath}`, hostPath], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return r.exitCode === 0;
}

// A live, non-blocking view of the running container handed to `observe`.
export interface MemberAgentHandle {
  readonly containerName: string;
  readonly exitCode: number | null;
}

export interface MemberAgentOptions {
  repoRoot: string;
  composeProject: string;
  composeFiles?: string[];
  /** Required in opencode mode; ignored in session-participation mode. */
  prompt?: string;
  runId: string;
  /** Session-participation mode — see MemberAgentArgvOptions.entrypoint. */
  entrypoint?: string;
  command?: string[];
  /** Non-secret config `-e` pairs — see MemberAgentArgvOptions.extraEnv. */
  extraEnv?: Record<string, string>;
  /** Additional mounts — see MemberAgentArgvOptions.mounts. */
  mounts?: MemberAgentMount[];
  /**
   * Model + credential, resolved by the CALLER (resolveModelConfig() →
   * resolveAgentModel()/isKeylessModel() against scripts/lib/model-registry.ts).
   * Required and never defaulted: this primitive has no model of its own.
   */
  modelConfig: MemberAgentModel;
  /**
   * The OWNER's half of the container's environment — see
   * MemberAgentArgvOptions.ownerEnv. Injected as `-e` pairs and REDACTED out
   * of every string this function returns.
   */
  ownerEnv?: Record<string, string>;
  /** Additional caller-known sensitive values (for example local contact PII). */
  redactions?: RedactionSecret[];
  /** Exact generated Compose environment for the already-running stack. */
  composeSpawnEnv?: Record<string, string>;
  title?: string;
  onEvent?: (msg: string) => void;
  /** Optional durable/live structured event consumer. Existing callers need not provide one. */
  onStructuredEvent?: OnboardingEventSink;
  /** Shared sequencer used by runOnboardingEval to merge agent and observer events. */
  telemetry?: OnboardingTelemetry;
  attempt?: number;
  // Honoured ONLY when `observe` is absent. When an observer is supplied it
  // owns ALL timing (that is how the onboarding eval keeps its own deadline
  // and post-exit grace semantics unchanged).
  timeoutMs?: number;
  keepUntilInspected?: boolean;
  observe?: (handle: MemberAgentHandle) => Promise<void>;
  inspect?: (ctx: { containerName: string; timedOut: boolean }) => Promise<void>;
}

export interface MemberAgentResult {
  containerName: string;
  exitCode: number | null;
  // All three are REDACTED of every secret this primitive injected by `-e`
  // (the model credential and each `ownerEnv` value) — see redactSecrets. They
  // are printed whole into CI logs and the demo console, so there is
  // deliberately no un-redacted variant to reach for.
  stdout: string;
  stderr: string;
  transcript: string;
  timedOut: boolean;
  durationMs: number;
  // Was the container ever OBSERVED to exist (`docker inspect` succeeded at
  // least once)? `false` means the compose CLI was asked for a container that
  // never came into being — a harness failure, not a result about the agent.
  // `null` means the watcher could not tell (it timed out looking), which is
  // deliberately NOT treated as evidence of anything.
  containerLaunched: boolean | null;
}

// Only consulted on the no-observer path; the onboarding eval passes an
// observer and applies its own DEFAULT_TIMEOUT_MS.
export const DEFAULT_MEMBER_AGENT_TIMEOUT_MS = 20 * 60_000;

export async function runMemberAgent(opts: MemberAgentOptions): Promise<MemberAgentResult> {
  const log = opts.onEvent ?? (() => {});
  const keep = opts.keepUntilInspected ?? false;
  const startedAt = Date.now();
  const containerName = memberAgentContainerName(opts.composeProject, opts.runId);
  const injected: RedactionSecret[] = [
    {
      value: opts.modelConfig.apiKey,
      placeholder: `<${opts.modelConfig.apiKeyEnv ?? "MODEL_KEY"} redacted>`,
    },
    ...Object.entries(opts.ownerEnv ?? {}).map(([k, value]) => ({ value, placeholder: `<${k} redacted>` })),
    ...(opts.redactions ?? []),
  ];
  const telemetry =
    opts.telemetry ??
    createOnboardingTelemetry(
      { composeProject: opts.composeProject, runId: opts.runId, attempt: opts.attempt },
      opts.onStructuredEvent,
      injected,
    );

  const commandMode = opts.command !== undefined;
  const workDir = mkdtempSync(join(tmpdir(), "member-agent-"));
  const opencodeConfigPath = join(workDir, "opencode.json");
  try {
    // opencode mode mounts a per-run opencode.json; session-participation mode
    // runs the member's own client (which invokes opencode itself, passing the
    // model on argv) and needs no mounted config.
    if (!commandMode) {
      writeFileSync(opencodeConfigPath, JSON.stringify(buildAgentOpencodeConfig(opts.modelConfig.model), null, 2));
    }

    // A stack created by scripts/stack carries generated label and credential
    // interpolation values. Re-resolving Compose without that exact map makes
    // its project volume hash differ and prompts to recreate live data.
    const spawnEnv = memberAgentSpawnEnv(opts.composeProject, opts.composeSpawnEnv ?? process.env);
    const proc = Bun.spawn(
      buildMemberAgentArgv({
        composeProject: opts.composeProject,
        composeFiles: opts.composeFiles,
        containerName,
        ...(commandMode
          ? { entrypoint: opts.entrypoint, command: opts.command }
          : {
              opencodeConfigPath,
              title: opts.title ?? `member-agent-${opts.runId}`,
              prompt: opts.prompt,
            }),
        extraEnv: opts.extraEnv,
        mounts: opts.mounts,
        modelConfig: opts.modelConfig,
        ownerEnv: opts.ownerEnv,
        keep,
      }),
      // `stdin: "ignore"` and the derived DEMO_PROJECT are both load-bearing —
      // see memberAgentSpawnEnv's comment. Do not "tidy" either away.
      { cwd: opts.repoRoot, env: spawnEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    telemetry.emit({ source: "agent", stream: "event", message: "member-agent process spawned", containerName });
    void proc.exited.then((code) => {
      telemetry.emit({ source: "agent", stream: "event", message: `member-agent process exited (code ${code})`, containerName });
    });
    // Actively drain both pipes for the whole run — an un-drained pipe can
    // fill its OS buffer and deadlock the child once its own transcript
    // exceeds a few tens of KB, which a real multi-tool-call session easily
    // does. Started BEFORE any await, and never moved after one.
    const stdoutPromise = drainRedactedStream(proc.stdout as ReadableStream<Uint8Array>, injected, ({ message }) => {
      telemetry.emit({ source: "agent", stream: "stdout", message, containerName });
    });
    const stderrPromise = drainRedactedStream(proc.stderr as ReadableStream<Uint8Array>, injected, ({ message }) => {
      telemetry.emit({ source: "agent", stream: "stderr", message, containerName });
    });

    // POSITIVE evidence that the container came into being, gathered while the
    // run is still in flight. Without it, "the compose CLI never started
    // anything" and "the agent started and produced nothing" are the same
    // observation — and the second is a real (if bleak) result about the run
    // while the first is a harness failure that must never enter a product
    // metric. Stops the moment the container is seen, so it costs a handful of
    // `docker inspect` calls on a healthy run and nothing thereafter.
    let containerLaunched: boolean | null = null;
    const launchWatcher = (async () => {
      const deadline = Date.now() + CONTAINER_LAUNCH_WATCH_MS;
      for (;;) {
        if (containerExists(containerName, spawnEnv)) {
          containerLaunched = true;
          telemetry.emit({ source: "agent", stream: "event", message: "member-agent container observed", containerName });
          return;
        }
        if (proc.exitCode !== null) {
          // The CLI is gone and the container was never seen. One last look
          // (it may have started and been removed between polls) and then a
          // verdict.
          containerLaunched = containerExists(containerName, spawnEnv);
          return;
        }
        if (Date.now() >= deadline) return; // stays null: "could not tell"
        await Bun.sleep(CONTAINER_LAUNCH_POLL_MS);
      }
    })();

    let timedOut = false;
    if (opts.observe) {
      await opts.observe({ containerName, get exitCode() { return proc.exitCode; } });
    } else {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_MEMBER_AGENT_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const finished = await Promise.race([proc.exited.then(() => "exited" as const), deadline]);
      if (timer !== undefined) clearTimeout(timer); // never leave a 20-minute timer holding the event loop open
      timedOut = finished === "timeout";
      if (timedOut) log(`member-agent container ${containerName} hit its ${timeoutMs}ms deadline`);
      if (timedOut) telemetry.emit({ source: "agent", stream: "event", message: `member-agent deadline reached after ${timeoutMs}ms`, containerName });
    }

    // Kill BOTH the local CLI process AND the actual container by its
    // deterministic name — killing only the CLI leaves the real container
    // running under the Docker daemon (see memberAgentContainerName's
    // comment). `docker rm -f` is a superset of `docker kill`: it stops AND
    // removes, so this is also the cleanup `--rm` would otherwise handle on a
    // normal exit. Best-effort — an already-exited container/process is not an
    // error here.
    try {
      proc.kill();
    } catch {
      /* already exited */
    }

    if (keep) {
      // Inspection reads the STOPPED container's filesystem, so wait for it to
      // stop first. (After a TIMEOUT the kill above only signalled the CLI, so
      // `timedOut` is passed through — an observer that kills on timeout may be
      // reading a still-running filesystem.)
      await proc.exited;
      if (opts.inspect) await opts.inspect({ containerName, timedOut });
    }

    let containerCleanupExitCode: number | null = null;
    try {
      const cleanup = Bun.spawnSync(["docker", "rm", "-f", containerName], { stdout: "ignore", stderr: "ignore" });
      containerCleanupExitCode = cleanup.exitCode;
    } catch {
      /* already removed */
    }
    telemetry.emit({
      source: "cleanup",
      stream: "event",
      message: `member-agent container cleanup exit=${containerCleanupExitCode ?? "already-removed"}`,
      containerName,
    });
    // LOAD-BEARING ORDERING: `docker rm -f` runs BEFORE the drains are awaited.
    // Closing the container's pipes is what lets the drains finish; awaiting
    // them first would hang. Do not "tidy" this.
    const [rawStdout, rawStderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
    await launchWatcher; // resolves as soon as the CLI is gone; never outlives the run

    // Both strings were assembled only from already-redacted stream records;
    // there is no raw transcript variant for a caller to accidentally persist.
    const stdout = rawStdout;
    const stderr = rawStderr;

    return {
      containerName,
      exitCode,
      stdout,
      stderr,
      transcript: `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      timedOut,
      durationMs: Date.now() - startedAt,
      containerLaunched,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
