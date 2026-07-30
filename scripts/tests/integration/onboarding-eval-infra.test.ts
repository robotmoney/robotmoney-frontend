// Inference-OFF rails check for the real-inference onboarding eval
// (scripts/lib/onboarding-eval.ts, docs/architecture.md §11 R8, Stage 5 of
// docs/plans/onboarding-ic-workflow.md). This is a rails check, NOT a
// substitute for the eval: it proves every piece the eval rides on works — the
// member-agent image builds and starts, it can reach the committee REST API
// over the compose network, and a signed apply built with the real `rmpc`
// release binary (driven DIRECTLY by this test, never by an agent) lands
// end-to-end through POST /api/committee/apply — all without spending a single
// model token. (D21: the MCP transport is retired; the agent and this rails
// check use the REST API.) It is wired as an early fail-fast step ahead of the
// real-inference gate in .github/workflows/e2e.yml.
//
// The bring-up is the SHARED scripts/stack module on its `core` profile
// (postgres + api — docs/architecture.md §11.3 E5, docs/decisions.md D22):
// this file used to carry a forked `bringUpInfra()` because demo-main.ts does
// its setup at module scope and could not be imported. That fork is gone.
//
// Cost class `integration` (docs/architecture.md §3 L1, docs/decisions.md D23):
// a Docker daemon and network egress are hard dependencies, which is why this
// half lives here and its pure half lives in
// scripts/tests/unit/onboarding-eval-helpers.test.ts. Both halves still run on
// every PR — the split buys CI path-selectability, not less coverage.
//
// Loud-skip-never (test-coverage-policy): Docker, network egress to GitHub
// Releases (the `rmpc` binary, same as
// scripts/tests/integration/rmpc-canonical-apply.test.ts), and network egress
// to pull/build base images are all hard dependencies of the describe block
// below — same policy as
// scripts/tests/integration/demo-compose-config.test.ts. A missing or unusable
// Docker daemon THROWS out of `stack.up()`'s `assertDockerAvailable()` (which
// returns void or throws — there is no boolean a caller could turn into a
// skip), which fails every test in the block loudly; nothing here quietly
// skips.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  canonicalizeApplication,
  canonicalizeClaimChallenge,
  path as routePath,
  ROUTES,
} from "@robotmoney/contract";
import { fetchRmpc } from "../../lib/rmpc-fetch.ts";
import {
  buildMemberAgentArgv,
  KEYSTORE_PASSPHRASE_ENV,
  LOCAL_COMMITTEE_ONBOARDING_SKILL_PATH,
} from "../../lib/onboarding-eval.ts";
import {
  ensureMemberVolume,
  memberHomeVolumeName,
  runMemberAgent,
  type MemberAgentModel,
} from "../../agent/member-agent.ts";
import {
  buildMemberSessionRuntime,
  CLIENT_ENTRY,
  ensureMemberIdentity,
  memberSessionMounts,
} from "../../lib/committee/agent.ts";
import {
  createStack,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_STACK_DATABASE,
  generateStackCredentials,
  resolveStackEnvironment,
  stackProjectName,
  type Stack,
  type StackCredentials,
  type StackEnvironment,
} from "../../stack/index.ts";
import { makeDockerRunner, purgeDemoEvalContainers } from "../../lib/demo-volumes.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dir, "..", "..", "..");

// EVERY pure assertion this file used to carry alongside its Docker-backed
// half now lives in its cost-class sibling, scripts/tests/unit/onboarding-eval-helpers.test.ts
// (D23). #284 wrote that half but left the originals here, so the two copies
// asserted the SAME permission set and the SAME argv from two files — exactly
// the shape in which a fix lands in one and not the other. This file is now
// Docker-only, as its own header has claimed since #284; nothing was dropped.
// ── Docker-backed rails check ────────────────────────────────────────────────
const SETUP_TIMEOUT_MS = 5 * 60_000;
const TEST_TIMEOUT_MS = 2 * 60_000;

// DECLARATION ONLY at module scope — no port bound, no secret generated, no
// compose call — so merely importing this file costs nothing. All of it happens
// in the beforeAll below.
let stack: Stack | null = null;
let stackCredentials: StackCredentials | null = null;

// This file's environment identity (scripts/stack/naming.ts) — `ci`/<job hash>
// under Actions, `local`/<random> otherwise. Computed inside a FUNCTION, not at
// module scope, to hold the "declaration only at module scope" rule below.
function infraEnvironment(): StackEnvironment {
  return resolveStackEnvironment(process.env);
}

// A stack pointed at a daemon that cannot exist. Constructing it is free
// (createStack spawns nothing); only assertDockerAvailable() touches Docker.
// It still gets a real environment-scoped name so nothing in this repo mints an
// unlabelled ad-hoc project name, and a `_unreachable` suffix so it can never
// be confused with the real bring-up below inside one CI job (where the env
// hash is by design identical for both).
function unreachableDaemonStack(): Stack {
  const environment = infraEnvironment();
  return createStack(
    {
      repoRoot,
      project: `${stackProjectName("infra", environment)}_unreachable`,
      profile: "core",
      composeFiles: DEFAULT_COMPOSE_FILES,
      database: DEFAULT_STACK_DATABASE,
      credentials: generateStackCredentials(),
      environment,
    },
    { hostEnv: { PATH: process.env.PATH, DOCKER_HOST: "tcp://127.0.0.1:1" } },
  );
}

// beforeAll/afterAll are declared INSIDE the describe block below (not at
// module scope) — bun:test applies module-scope lifecycle hooks to every
// describe block in the file, so keeping them scoped is what lets a future
// Docker-free block be added here without paying this bring-up.
describe("onboarding eval infra rails (Docker, no inference)", () => {
  beforeAll(async () => {
    // Minimal stack: the shared module's `core` profile — postgres (api's
    // dependency) + api, and NOTHING else. No worker lanes: applying/
    // activating a committee membership is pure Postgres CRUD + crypto
    // verification, never touches the job queue, so booting the worker images
    // would only slow this "fast, cheap" check down for nothing. (D21: no mcp
    // service — the committee surface is the api's REST API.)
    const environment = infraEnvironment();
    stackCredentials = generateStackCredentials();
    stack = createStack(
      {
        repoRoot,
        // Environment-scoped (rm_ci_infra_<job hash> / rm_demo_infra_<random>)
        // so a container this check leaks on the shared self-hosted runner is
        // attributable to the job that leaked it, by label as well as by name.
        project: stackProjectName("infra", environment),
        profile: "core",
        composeFiles: DEFAULT_COMPOSE_FILES,
        database: DEFAULT_STACK_DATABASE,
        credentials: stackCredentials,
        environment,
      },
      { hostEnv: process.env, io: { stdout: "pipe", stderr: "pipe" } },
    );
    // Throws (never skips) when Docker is missing/unusable, when postgres
    // never becomes ready, when migrations fail, or when /health never
    // answers.
    await stack.up();
    await stack.waitForHttp(`${stack.backendUrl}${ROUTES.committee.members}`, 30_000);

    // Build (never run yet — that's the inference-off "container starts" test
    // below) the member-agent image now so its cost is paid once in beforeAll,
    // not inside a single test's own timeout budget.
    await stack.build(["member-agent"]);
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    if (!stack) return;
    try {
      purgeDemoEvalContainers(makeDockerRunner(stack.spawnEnv), { project: stack.config.project });
    } catch {}
    // The session-rail check's member home volume is created OUTSIDE the
    // compose model (docker volume create), so `down --volumes` does not know
    // it — remove it explicitly, loudly on failure.
    const volumeCleanup = Bun.spawnSync(
      [
        "docker", "volume", "rm", "-f",
        memberHomeVolumeName(stack.config.project, "rails-check"),
        memberHomeVolumeName(stack.config.project, "rmpc-continuity"),
      ],
      { env: stack.spawnEnv, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    if (volumeCleanup.exitCode !== 0) {
      console.error(
        `[onboarding-eval-infra] member home volume cleanup failed (exit ${volumeCleanup.exitCode}): ` +
          new TextDecoder().decode(volumeCleanup.stderr as Uint8Array),
      );
    }
    const r = stack.down({ removeVolumes: true, removeOrphans: true });
    if (r.exitCode !== 0) {
      // Never mask an earlier test failure by throwing here — but a failed
      // teardown leaves real docker resources behind, so it must be LOUD.
      console.error(
        `[onboarding-eval-infra] teardown for project ${stack.config.project} failed (exit ${r.exitCode}): ${r.stderr}`,
      );
    }
  }, SETUP_TIMEOUT_MS);

  test("assertDockerAvailable THROWS on an unusable daemon — it can never degrade into a skip", () => {
    expect(() => unreachableDaemonStack().assertDockerAvailable()).toThrow(/docker is required/);
  });

  test(
    "member-agent container starts — no Robot Money tooling, no model call needed",
    () => {
      // ENTRYPOINT is `opencode`; `--version` never touches a model or needs a
      // key, proving the image builds and the binary runs without spending any
      // inference budget.
      const r = stack!.compose(["run", "--rm", "--no-deps", "member-agent", "--version"]);
      expect(r.exitCode).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "every CLI flag the harness passes actually EXISTS in the pinned opencode build",
    () => {
      // The bug this exists for: buildMemberAgentArgv passed
      // `--dangerously-skip-permissions`, which opencode has never had. yargs
      // accepts unknown `--flags` silently, so nothing failed, nothing warned,
      // and four consecutive runs of this required gate went red with the
      // agent's permission prompts still armed and unanswerable. An assertion
      // over our own argv could never catch that — only the binary's own help
      // can, so this reads it out of the image the eval actually runs.
      const help = stack!.compose(["run", "--rm", "--no-deps", "member-agent", "run", "--help"]);
      expect(help.exitCode).toBe(0);
      // yargs writes `--help` to stdout interactively but the CLI redirects it
      // under a pipe, so read both streams rather than assuming one.
      const helpText = `${help.stdout}\n${help.stderr}`;
      expect(helpText).toContain("opencode run"); // proves we got the help, not silence
      const flags = new Set(Array.from(helpText.matchAll(/(--[a-z][a-z-]+)/g), (m) => m[1]!));
      const argv = buildMemberAgentArgv({
        composeProject: "rmtest_proj",
        containerName: "rmtest_proj-member-agent-eval-abc",
        opencodeConfigPath: "/tmp/x/opencode.json",
        title: "onboarding-eval-abc",
        prompt: "the injected prompt",
        modelConfig: { model: "opencode/deepseek-v4-flash", apiKeyEnv: "OPENCODE_API_KEY", apiKey: "sk-zen" },
        ownerEnv: { [KEYSTORE_PASSPHRASE_ENV]: "pass-phrase-xyz" },
      });
      // Only the flags AFTER the `run` subcommand belong to `opencode run`;
      // everything before it is `docker compose run`'s own.
      const opencodeFlags = argv.slice(argv.lastIndexOf("run") + 1).filter((a) => a.startsWith("--"));
      expect(opencodeFlags.length).toBeGreaterThan(0);
      for (const flag of opencodeFlags) expect(flags, `${flag} is not a flag of the pinned opencode build`).toContain(flag);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the container's HOME agrees with the writable PATH dir the repo-owned skill installs rmpc into",
    () => {
      // scripts/lib/member-agent/Dockerfile puts /home/agent/.local/bin on PATH,
      // but the container runs as root — so without an explicit HOME, `~`
      // resolves to /root and the committee-onboarding skill's own copy-paste
      // line, `install -m 755 rmpc ~/.local/bin/rmpc`, lands where PATH does
      // not look. Observed live: the agent ran exactly that line and then got
      // `rmpc: command not found`. That friction belongs to this image, not to
      // our documentation, and the eval is only allowed to report on the latter.
      const r = stack!.compose([
        "run", "--rm", "--no-deps", "--entrypoint", "sh", "member-agent",
        "-c", 'printf "%s\\n%s\\n" "$HOME" "$PATH"',
      ]);
      expect(r.exitCode).toBe(0);
      const [home, path] = r.stdout.trim().split("\n");
      expect(home).toBe("/home/agent");
      expect(path!.split(":")).toContain(`${home}/.local/bin`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "member-agent reaches the api service's /health from INSIDE the compose network",
    () => {
      const r = stack!.compose(["run", "--rm", "--no-deps", "--entrypoint", "curl", "member-agent", "-fsS", "http://api:8787/health"]);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ status: "ok" });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "member-agent fetches the repo-owned onboarding skill and participation guide as exact static files",
    () => {
      const assets = [
        {
          path: LOCAL_COMMITTEE_ONBOARDING_SKILL_PATH,
          marker: "name: committee-onboarding",
        },
        {
          path: "/views/docs/investment-committee/participation.html",
          marker: "<h1>Participation</h1>",
        },
      ];

      for (const asset of assets) {
        const r = stack!.compose([
          "run", "--rm", "--no-deps", "--entrypoint", "curl", "member-agent",
          "-fsS", `http://api:8787${asset.path}`,
        ]);
        expect(r.exitCode, `${asset.path}: ${r.stderr}`).toBe(0);
        expect(r.stdout).toContain(asset.marker);
        expect(r.stdout).not.toContain("<title>Robot Money — Autonomous Treasury for the Agent Economy</title>");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "IDENTITY CONTINUITY (issue #361 AC3): one REAL RMPC-onboarded member keeps its persisted key through admission and a later verified session take",
    async () => {
      // Inference-OFF, but NOT identity/submission-off: a deterministic
      // opencode transcript supplies prose only. The real release rmpc binary
      // creates and holds the key inside a persistent member HOME, signs the
      // application and claim in separate containers, then the production
      // member-session client launches in a later container with that exact
      // HOME and signs/submits over the real REST boundary. The public receipt
      // recomputes verification against the registered key. No JS keygen,
      // privileged register, mocked keystore, mocked REST, or mocked signature
      // verifier exists anywhere in this path.
      const rmpcPath = await fetchRmpc();
      const workDir = mkdtempSync(join(tmpdir(), "onboarding-eval-infra-"));
      const volume = memberHomeVolumeName(stack!.config.project, "rmpc-continuity");
      ensureMemberVolume(volume, stack!.config.project, stack!.spawnEnv);
      const keyless: MemberAgentModel = { model: "opencode/fixture-prose-only", apiKeyEnv: null, apiKey: null };
      const passphrase = crypto.randomUUID();
      const rmpcOwnerEnv = { RMPC_COMMITTEE_IDENTITY_PASSPHRASE: passphrase };
      const runInMemberHome = (opts: {
        runId: string;
        entrypoint: string;
        command: string[];
        mounts?: Array<{ source: string; target: string; readonly?: boolean }>;
        extraEnv?: Record<string, string>;
        ownerEnv?: Record<string, string>;
      }) => runMemberAgent({
        repoRoot,
        composeProject: stack!.config.project,
        composeFiles: DEFAULT_COMPOSE_FILES,
        runId: opts.runId,
        entrypoint: opts.entrypoint,
        command: opts.command,
        mounts: [
          { source: volume, target: "/home/agent" },
          ...(opts.mounts ?? []),
        ],
        extraEnv: opts.extraEnv,
        ownerEnv: opts.ownerEnv,
        modelConfig: keyless,
        composeSpawnEnv: stack!.spawnEnv,
        timeoutMs: TEST_TIMEOUT_MS,
      });
      const parseRmpc = (stdout: string) => {
        const line = stdout.split("\n").findLast((candidate) => candidate.trim().startsWith("{"));
        expect(line, `no rmpc JSON in member stdout: ${stdout.slice(-400)}`).toBeDefined();
        return JSON.parse(line!.trim()) as { ok?: boolean; public_key?: string; signature?: string };
      };
      const signFromMemberHome = async (payloadPath: string, runId: string) => {
        const signedRun = await runInMemberHome({
          runId,
          entrypoint: "rmpc",
          command: [
            "committee-identity", "--path", "/home/agent/robotmoney-identity.json",
            "sign", "--payload-file", "/tmp/signing-payload",
          ],
          mounts: [{ source: payloadPath, target: "/tmp/signing-payload", readonly: true }],
          ownerEnv: rmpcOwnerEnv,
        });
        expect(signedRun.exitCode, signedRun.transcript).toBe(0);
        const signed = parseRmpc(signedRun.stdout);
        expect(signed.ok).toBe(true);
        expect(typeof signed.signature).toBe("string");
        return signed;
      };
      try {
        // Container 1 is the prospective member's machine. It installs the
        // real rmpc release into its durable HOME and creates the encrypted
        // keystore there. Later containers see both through the same volume.
        const createRun = await runInMemberHome({
          runId: `rmpc-create-${crypto.randomUUID().slice(0, 6)}`,
          entrypoint: "sh",
          command: [
            "-c",
            "install -m 755 /opt/rmpc /home/agent/.local/bin/rmpc && exec rmpc committee-identity --path /home/agent/robotmoney-identity.json create",
          ],
          mounts: [{ source: rmpcPath, target: "/opt/rmpc", readonly: true }],
          ownerEnv: rmpcOwnerEnv,
        });
        expect(createRun.exitCode, createRun.transcript).toBe(0);
        const created = parseRmpc(createRun.stdout);
        expect(created.ok).toBe(true);
        const publicKeyB64 = created.public_key!;
        expect(typeof publicKeyB64).toBe("string");

        const application = {
          name: "RMPC Continuity Check",
          contact: `rmpc-continuity-${crypto.randomUUID().slice(0, 8)}@example.test`,
          lens: "identity continuity",
          publicKey: publicKeyB64,
        };
        const canonical = canonicalizeApplication(application);
        const payloadFile = join(workDir, "payload.txt");
        writeFileSync(payloadFile, canonical);
        const signed = await signFromMemberHome(payloadFile, `rmpc-apply-${crypto.randomUUID().slice(0, 6)}`);
        expect(signed.public_key).toBe(publicKeyB64);

        const applyRes = await fetch(`${stack!.backendUrl}${ROUTES.committee.apply}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...application, signature: signed.signature }),
        });
        expect(applyRes.status).toBe(201);
        const body = await applyRes.json();
        expect(body.ok).toBe(true);
        expect(body.memberStatus).toBe("applied");
        expect(body.memberId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        const memberId: string = body.memberId;

        const statusPath = routePath(ROUTES.committee.applyStatus, { id: memberId });
        const statusRes = await fetch(`${stack!.backendUrl}${statusPath}`);
        expect(statusRes.status).toBe(200);
        const status = await statusRes.json();
        expect(status.state).toBe("applied");
        // Redaction: the status route never echoes contact/publicKey.
        expect(JSON.stringify(status)).not.toContain(application.contact);
        expect(JSON.stringify(status)).not.toContain(publicKeyB64);

        const approveRes = await fetch(`${stack!.backendUrl}/api/committee/admin/members/${memberId}/review`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Token": stackCredentials!.adminToken,
          },
          body: JSON.stringify({ decision: "approve" }),
        });
        expect(approveRes.status).toBe(200);

        const challengeRes = await fetch(`${stack!.backendUrl}${ROUTES.committee.claimChallenge}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memberId }),
        });
        expect(challengeRes.status).toBe(200);
        const challenge = await challengeRes.json();
        const claimPayloadFile = join(workDir, "claim-payload.txt");
        writeFileSync(claimPayloadFile, canonicalizeClaimChallenge(challenge));
        const claimSignature = await signFromMemberHome(
          claimPayloadFile,
          `rmpc-claim-${crypto.randomUUID().slice(0, 6)}`,
        );

        const claimRes = await fetch(`${stack!.backendUrl}${ROUTES.committee.claimToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...challenge, signature: claimSignature.signature }),
        });
        expect(claimRes.status).toBe(200);
        const claimed = await claimRes.json();
        expect(claimed.token).toMatch(/^tok_/);

        const claimedStatusRes = await fetch(`${stack!.backendUrl}${statusPath}`);
        expect(claimedStatusRes.status).toBe(200);
        expect(await claimedStatusRes.json()).toMatchObject({ state: "claimed", claimedAt: expect.any(String) });

        // Give the claimed bearer to the member client exactly once. This is a
        // separate container using the same HOME; enroll detects the RMPC
        // keystore (never client-native), persists the token, and verifies it
        // authenticates as the admitted server-minted member id.
        const runtime = await buildMemberSessionRuntime(repoRoot);
        try {
          const enrollRun = await runInMemberHome({
            runId: `rmpc-enroll-${crypto.randomUUID().slice(0, 6)}`,
            entrypoint: "bun",
            command: [CLIENT_ENTRY, "enroll"],
            mounts: [{ source: runtime.artifactPath, target: CLIENT_ENTRY, readonly: true }],
            extraEnv: { RM_API_URL: "http://api:8787", RM_MEMBER_ID: memberId },
            ownerEnv: {
              ...rmpcOwnerEnv,
              RM_MEMBER_TOKEN: claimed.token,
            },
          });
          expect(enrollRun.exitCode, enrollRun.transcript).toBe(0);
          const enroll = enrollRun.stdout.split("\n").find((line) => line.startsWith("RM_ENROLL "));
          expect(enroll, enrollRun.stdout).toBeDefined();
          expect(JSON.parse(enroll!.slice("RM_ENROLL ".length))).toMatchObject({
            keystoreKind: "rmpc",
            tokenValid: true,
            memberId,
          });
          expect(enrollRun.transcript).not.toContain(claimed.token);

          // Open a real collecting session. Core profile intentionally has no
          // worker, so the existing admin dispatcher drives the same domain
          // lifecycle synchronously instead of adding another service.
          const admin = async (action: string, input: Record<string, unknown>) => {
            const res = await fetch(
              `${stack!.backendUrl}${routePath(ROUTES.committee.admin.action, { action })}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Admin-Token": stackCredentials!.adminToken,
                },
                body: JSON.stringify(input),
              },
            );
            const responseBody = await res.json();
            expect(res.status, `${action}: ${JSON.stringify(responseBody)}`).toBe(200);
            return responseBody;
          };
          const date = new Date().toISOString().slice(0, 10);
          const subjectId = `continuity-${crypto.randomUUID().slice(0, 8)}`;
          await admin("subject", { id: subjectId, name: "Identity Continuity Fixture" });
          const opened = await admin("open", { date, subjectId });
          await admin("brief", { sessionId: String(opened.id), windowMinutes: 10 });

          // The only deterministic seam is external model prose. The
          // production participation client still fetches its own context,
          // posts its own memo, asks the API for canonical bytes, invokes the
          // real persisted rmpc, and submits the resulting signature itself.
          const authoredTake = [
            "**REGIME**",
            "- The live context is available inside the isolated member session.",
            "- Identity continuity is the decisive operational signal.",
            "- The persisted machine state remains intact across launches.",
            "",
            "**ALLOCATION**",
            "- Keep the allocation unchanged while the signature rail is verified.",
            "- Preserve the member-owned keystore as the controlling mechanism.",
            "- Revisit only if API verification rejects the admitted key.",
            "",
            "**SUBJECT**",
            "- The subject is evaluated through the real collecting-session API.",
            "- The principal risk is accidental identity rotation between duties.",
            "- Accept the take only under the originally admitted public key.",
            "",
            "STANCE: neutral | CONFIDENCE: 0.61",
          ].join("\n");
          const opencodeShim = join(workDir, "opencode-prose-fixture");
          writeFileSync(
            opencodeShim,
            `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ type: "text", part: { type: "text", text: authoredTake } })}'\n`,
            { mode: 0o755 },
          );
          const participateRun = await runInMemberHome({
            runId: `rmpc-participate-${crypto.randomUUID().slice(0, 6)}`,
            entrypoint: "bun",
            command: [CLIENT_ENTRY, "participate"],
            mounts: [
              { source: runtime.artifactPath, target: CLIENT_ENTRY, readonly: true },
              { source: opencodeShim, target: "/opt/opencode-prose-fixture", readonly: true },
            ],
            extraEnv: {
              RM_API_URL: "http://api:8787",
              RM_MEMBER_ID: memberId,
              RM_MEMBER_NAME: application.name,
              RM_MEMBER_LENS: application.lens,
              RM_MEMBER_BIAS: "0",
              RM_SESSION_DATE: date,
              RM_SUBJECT_ID: subjectId,
              RM_SESSION_ID: String(opened.id),
              AGENT_MODEL: keyless.model,
              OPENCODE_BIN: "/opt/opencode-prose-fixture",
            },
            // No token is re-injected: this later session proves the member's
            // credential and key both came from its persisted HOME.
            ownerEnv: rmpcOwnerEnv,
          });
          expect(participateRun.exitCode, participateRun.transcript).toBe(0);
          const result = participateRun.stdout.split("\n").find((line) => line.startsWith("RM_RESULT "));
          expect(result, participateRun.stdout).toBeDefined();
          expect(JSON.parse(result!.slice("RM_RESULT ".length))).toMatchObject({
            memberId,
            stance: "neutral",
            confidence: 0.61,
            verified: true,
          });

          // Read-time verification is deliberately stronger than trusting the
          // POST response's `verified` flag: session projection re-verifies the
          // stored payload/signature, and the public receipt exposes the exact
          // active-key fingerprint used for that verification.
          const sessionRes = await fetch(
            `${stack!.backendUrl}${routePath(ROUTES.committee.session, { date, subject: subjectId })}`,
          );
          expect(sessionRes.status).toBe(200);
          const session = await sessionRes.json();
          const take = session.takes.find((candidate: { memberId?: string }) => candidate.memberId === memberId);
          expect(take).toMatchObject({ memberId, verified: true, stance: "neutral", confidence: 0.61 });
          expect(take.id).toMatch(/^[0-9a-f-]{36}$/i);

          const receiptRes = await fetch(
            `${stack!.backendUrl}${routePath(ROUTES.committee.take, { id: take.id })}`,
          );
          expect(receiptRes.status).toBe(200);
          const receipt = await receiptRes.json();
          const admittedKeyDigest = await crypto.subtle.digest("SHA-256", Buffer.from(publicKeyB64, "base64"));
          expect(receipt).toMatchObject({
            take: { id: take.id, memberId, verified: true },
            signer: {
              id: memberId,
              publicKeyFingerprint: `sha256:${Buffer.from(admittedKeyDigest).toString("hex")}`,
            },
          });
        } finally {
          runtime.dispose();
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "SESSION RAIL (issue #361): a member container enrolls with a container-held key, the harness registers only the public key, and identity + credential persist across container runs",
    async () => {
      // Inference-OFF proof of the member-container session rail's enrollment
      // half: the client runs under the image's own bun from a read-only,
      // self-contained artifact in OS temp space — the checkout itself is NOT
      // mounted. It generates its ed25519 key INSIDE the container (persisted
      // in a labeled named volume), and the harness's only privileged act is
      // registering the PUBLIC key. The authoring/submission half (a real model
      // call) is executed and asserted by the required e2e demo gate's
      // committee sessions (assertAuthoredTakes).
      const memberId = "rails-check";
      const volume = memberHomeVolumeName(stack!.config.project, memberId);
      ensureMemberVolume(volume, stack!.config.project, stack!.spawnEnv);
      const keyless: MemberAgentModel = { model: "opencode/unused-by-enroll", apiKeyEnv: null, apiKey: null };
      const enrollRun = async (ownerEnv?: Record<string, string>) => {
        const runtime = await buildMemberSessionRuntime(repoRoot);
        try {
          return await runMemberAgent({
            repoRoot,
            composeProject: stack!.config.project,
            composeFiles: DEFAULT_COMPOSE_FILES,
            runId: `${memberId}-${crypto.randomUUID().slice(0, 6)}`,
            entrypoint: "bun",
            command: [CLIENT_ENTRY, "enroll"],
            mounts: memberSessionMounts(runtime.artifactPath, volume),
            extraEnv: { RM_API_URL: "http://api:8787", RM_MEMBER_ID: memberId },
            ownerEnv,
            modelConfig: keyless,
            composeSpawnEnv: stack!.spawnEnv,
            timeoutMs: TEST_TIMEOUT_MS,
          });
        } finally {
          runtime.dispose();
        }
      };
      const parseEnroll = (stdout: string) => {
        const line = stdout.split("\n").find((l) => l.trim().startsWith("RM_ENROLL "));
        expect(line, `no RM_ENROLL in client stdout: ${stdout.slice(-400)}`).toBeDefined();
        return JSON.parse(line!.trim().slice("RM_ENROLL ".length));
      };

      // Run 1: fresh volume → the client GENERATES its key in-container.
      const run1 = await enrollRun();
      expect(run1.exitCode).toBe(0);
      const enroll1 = parseEnroll(run1.stdout);
      expect(enroll1.keystoreKind).toBe("client");
      expect(enroll1.tokenValid).toBe(false);
      expect(typeof enroll1.publicKey).toBe("string");

      // Run 2 (a separate container, same volume): SAME key — continuity.
      const run2 = await enrollRun();
      expect(run2.exitCode).toBe(0);
      expect(parseEnroll(run2.stdout).publicKey).toBe(enroll1.publicKey);

      // The harness's one privileged act: register the container's PUBLIC key
      // (the private key never left the volume) — this is what
      // ensureMemberIdentity does for a roster member with no working token.
      const rail = {
        repoRoot,
        composeProject: stack!.config.project,
        composeFiles: [...DEFAULT_COMPOSE_FILES],
        composeSpawnEnv: stack!.spawnEnv,
        modelConfig: keyless,
        backendUrl: stack!.backendUrl,
        adminToken: stackCredentials!.adminToken,
      };
      const identity = await ensureMemberIdentity(rail, { memberId, name: "Rails Check", lens: "infra" });
      expect(typeof identity.freshToken).toBe("string");
      // The minted token authenticates as this member.
      const verify = await fetch(`${stack!.backendUrl}${ROUTES.committee.verifyToken}`, {
        headers: { Authorization: `Bearer ${identity.freshToken}` },
      });
      expect(verify.status).toBe(200);
      expect(await verify.json()).toMatchObject({ memberId });

      // Run 3: hand the token over ONCE (ownerEnv, redacted) — the client
      // persists it in its own keystore and reports it valid.
      const run3 = await enrollRun({ RM_MEMBER_TOKEN: identity.freshToken! });
      expect(run3.exitCode).toBe(0);
      expect(parseEnroll(run3.stdout)).toMatchObject({ tokenValid: true, memberId });
      // …and the token was REDACTED from the transcript at the source.
      expect(run3.transcript).not.toContain(identity.freshToken!);

      // Run 4: nothing handed over — the stored credential alone works.
      const run4 = await enrollRun();
      expect(run4.exitCode).toBe(0);
      expect(parseEnroll(run4.stdout)).toMatchObject({ tokenValid: true, memberId });
    },
    // Four container runs + one registration; each run is seconds, but a cold
    // loaded daemon can be slow.
    SETUP_TIMEOUT_MS,
  );
});
