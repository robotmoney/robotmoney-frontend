// THE JUDGE REALLY DOES RUN IN ITS OWN CONTAINER (issue #1012).
//
// Every other test of this change is about SHAPE — the argv the rail builds, the
// reason a failure classifies as, the compose topology. This one is about the
// thing none of those can prove: that a real container starts on a real Docker
// daemon, reaches a real HTTP endpoint, writes one real line back, and is GONE
// afterwards on every exit path there is.
//
// THE FOUR EXIT PATHS, each asserted with a leak check:
//
//   success        — the endpoint answers 200 with a completion
//   vendor refusal — the endpoint answers 402; the container relays it, and the
//                    host's credit/credential taxonomy still classifies it
//   malformed      — the endpoint answers 200 with no assistant text
//   hang           — the endpoint never answers and the container is killed at
//                    its ceiling
//
// "No leaked containers" is checked by NAME against the daemon after each case,
// because that is the property runMemberAgent()'s finally-bracketed kill +
// `docker rm -f` exists to hold and the one an acceptance criterion names. A
// container left running here is a container left running on the staging box
// every time a judging times out.
//
// THE STUB ZEN ENDPOINT RUNS ON THE HOST and is reached over the container's
// default gateway — discovered by asking a container, not assumed. That is what
// makes this an end-to-end check of the rail rather than of a mock: the prompt
// really is written to a file, really is mounted, really is read inside the
// container, and the answer really does come back over stdout.
//
// Loud-skip-never (test-coverage policy): a Docker daemon, the member-agent
// image build (network egress to GitHub Releases for the pinned bun/opencode
// artifacts) and container-to-host networking are all hard dependencies of this
// describe block — the same class as onboarding-eval-infra.test.ts. Every one of
// them THROWS out of the beforeAll; nothing here skips.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJudgeAgent, type JudgeAgentRail } from "../../agent/judge-agent.ts";
import {
  createStack,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_STACK_DATABASE,
  generateStackCredentials,
  resolveStackEnvironment,
  stackProjectName,
  type Stack,
} from "../../stack/index.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

const SETUP_TIMEOUT_MS = 10 * 60_000;
const CASE_TIMEOUT_MS = 4 * 60_000;

// judgeContainerTimeoutMs() subtracts its margin and floors at 5s, so every
// value here lands on the floor: the shortest ceiling the rail will give a
// container. That is deliberate — the hang case has to wait it out.
const REQUESTED_TIMEOUT_MS = 20_000;

let stack: Stack | null = null;
let rail: JudgeAgentRail | null = null;
let stub: ReturnType<typeof Bun.serve> | null = null;
let spoolDir: string | null = null;
/** What the stub answers next. Set per case. */
let respond: (req: Request) => Response | Promise<Response> = () => new Response("unset", { status: 500 });
/** Every prompt the stub actually received, so the mount can be proven to work. */
let receivedPrompts: string[] = [];

/** The daemon's view of a container by name — the leak check's only source. */
function containerNames(project: string, env: Record<string, string>): string[] {
  const r = Bun.spawnSync(
    ["docker", "ps", "-a", "--filter", `name=${project}-member-agent-eval-judge-`, "--format", "{{.Names}}"],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) {
    throw new Error(`docker ps failed (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr as Uint8Array)}`);
  }
  return new TextDecoder().decode(r.stdout as Uint8Array).split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Volumes the daemon holds for this project — a judge must create none. */
function volumeNames(project: string, env: Record<string, string>): string[] {
  const r = Bun.spawnSync(["docker", "volume", "ls", "--filter", `name=${project}`, "--format", "{{.Name}}"], {
    env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    throw new Error(`docker volume ls failed (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr as Uint8Array)}`);
  }
  return new TextDecoder().decode(r.stdout as Uint8Array).split("\n").map((s) => s.trim()).filter(Boolean);
}

describe("judge container launch (Docker, no model spend)", () => {
  beforeAll(async () => {
    const environment = resolveStackEnvironment(process.env);
    stack = createStack(
      {
        repoRoot,
        // Environment-scoped, like every other Docker-backed check here, so a
        // container this file leaks on a shared runner is attributable to the
        // job that leaked it by name AND by label.
        project: stackProjectName("judge-launch", environment),
        // `core` is the cheapest profile that still gives this file a compose
        // project and a network. It deliberately does NOT include the
        // agent-launcher service: this test drives runJudgeAgent() in-process,
        // which is the same code path the service runs and skips building an
        // image whose only extra content is a Bun server around this call.
        profile: "core",
        composeFiles: [...DEFAULT_COMPOSE_FILES],
        database: DEFAULT_STACK_DATABASE,
        credentials: generateStackCredentials(),
        environment,
      },
      { hostEnv: process.env, io: { stdout: "pipe", stderr: "pipe" } },
    );
    // Throws (never skips) when Docker is missing or unusable.
    stack.assertDockerAvailable();
    // The image the judge container IS. Built here so its cost is paid once in
    // the setup budget rather than inside one case's.
    await stack.build(["member-agent"]);

    // The stub vendor. Bound on every interface because the container reaches
    // it from the compose network, not from loopback.
    stub = Bun.serve({
      port: 0,
      hostname: "0.0.0.0",
      fetch: async (req) => {
        const body = await req.json().catch(() => null) as { messages?: { content?: string }[] } | null;
        receivedPrompts.push(body?.messages?.[0]?.content ?? "");
        return respond(req);
      },
    });

    // The gateway ASKED FOR, not assumed. A `docker compose run` is what brings
    // this project's network into being, so one throwaway container runs first
    // and the daemon is then asked what address it gave that network's gateway.
    // Hard-coding 172.17.0.1 (the default bridge's) would be wrong for every
    // project network, which is exactly the network a judge container joins.
    const warm = stack.compose(["run", "--rm", "--no-deps", "--entrypoint", "true", "member-agent"]);
    if (warm.exitCode !== 0) throw new Error(`could not create the project network (exit ${warm.exitCode}): ${warm.stderr}`);
    const gwq = Bun.spawnSync(
      ["docker", "network", "inspect", `${stack.config.project}_default`,
       "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}"],
      { env: stack.spawnEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const gateway = new TextDecoder().decode(gwq.stdout as Uint8Array).trim();
    if (gwq.exitCode !== 0 || !/^\d+\.\d+\.\d+\.\d+$/.test(gateway)) {
      throw new Error(
        `could not read the project network gateway (exit ${gwq.exitCode}): ` +
          `${JSON.stringify(gateway)} ${new TextDecoder().decode(gwq.stderr as Uint8Array)}`,
      );
    }

    spoolDir = mkdtempSync(join(tmpdir(), "rm-judge-spool-"));
    rail = {
      repoRoot,
      composeProject: stack.config.project,
      composeFiles: [...DEFAULT_COMPOSE_FILES],
      composeSpawnEnv: stack.spawnEnv,
      // Not a real credential and never spent: the stub answers without
      // checking it. Its presence is what proves the `-e` injection path runs.
      apiKey: "sk-stub-not-a-real-key",
      baseUrl: `http://${gateway}:${stub.port}/v1`,
      spoolDir,
    };
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    stub?.stop(true);
    if (spoolDir) rmSync(spoolDir, { recursive: true, force: true });
    if (!stack) return;
    const r = stack.down({ removeVolumes: true, removeOrphans: true });
    if (r.exitCode !== 0) {
      // Never mask an earlier failure by throwing — but a failed teardown leaves
      // real Docker resources behind, so it must be LOUD.
      console.error(`[judge-container-launch] teardown for ${stack.config.project} failed (exit ${r.exitCode}): ${r.stderr}`);
    }
  }, SETUP_TIMEOUT_MS);

  test(
    "a real container answers, and the prompt reached it through the mounted file",
    async () => {
      receivedPrompts = [];
      respond = () => Response.json({
        choices: [{ message: { content: "RATIONALE: the takes agree on direction." } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
        cost: "0.00001694",
      });
      const prompt = `judge prompt for ${crypto.randomUUID()}\nwith a second line`;
      const out = await runJudgeAgent(rail!, { model: "stub-judge", prompt, timeoutMs: REQUESTED_TIMEOUT_MS });

      expect(out.line).toEqual({
        ok: true,
        text: "RATIONALE: the takes agree on direction.",
        providerUsage: { usage: { prompt_tokens: 11, completion_tokens: 7 }, cost: "0.00001694" },
      });
      // The container read the file that was mounted into it. Nothing else in
      // this repo proves the prompt survives the hop — and a prompt that
      // silently arrived empty would produce a judgement about nothing.
      expect(receivedPrompts).toEqual([prompt]);
      expect(containerNames(stack!.config.project, stack!.spawnEnv)).toEqual([]);
      // A judge remembers nothing: no `<project>_member_home_*` volume may
      // appear for it, ever (an acceptance criterion).
      expect(volumeNames(stack!.config.project, stack!.spawnEnv).filter((v) => v.includes("member_home"))).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a vendor refusal is relayed with its status, and the container is still cleaned up",
    async () => {
      respond = () => new Response('{"error":{"message":"CreditsError: Insufficient balance"}}', { status: 402 });
      const out = await runJudgeAgent(rail!, { model: "stub-judge", prompt: "p", timeoutMs: REQUESTED_TIMEOUT_MS });
      expect(out.line).toMatchObject({ ok: false, kind: "model_status", status: 402 });
      expect((out.line as any).body).toContain("Insufficient balance");
      expect(containerNames(stack!.config.project, stack!.spawnEnv)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a 200 with no assistant text is the RAIL, not a verdict, and leaks nothing",
    async () => {
      respond = () => Response.json({ choices: [] });
      const out = await runJudgeAgent(rail!, { model: "stub-judge", prompt: "p", timeoutMs: REQUESTED_TIMEOUT_MS });
      expect(out.line).toMatchObject({ ok: false, kind: "launcher", detail: "model answer carried no assistant text" });
      expect(containerNames(stack!.config.project, stack!.spawnEnv)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a container that HANGS is killed at its ceiling and removed",
    async () => {
      // The exit path that actually strands containers in production: the
      // endpoint never answers, so the shim never writes its line and the
      // process never exits on its own. runMemberAgent()'s kill + `docker rm -f`
      // is what has to end it, and the assertion below is the only place in this
      // repo that proves it does for a judge.
      respond = () => new Promise<Response>(() => {});
      const out = await runJudgeAgent(rail!, { model: "stub-judge", prompt: "p", timeoutMs: REQUESTED_TIMEOUT_MS });
      expect(out.line).toMatchObject({ ok: false, kind: "launcher" });
      expect((out.line as any).detail).toContain("exceeded its");
      expect(containerNames(stack!.config.project, stack!.spawnEnv)).toEqual([]);
      respond = () => new Response("unset", { status: 500 });
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "two judgings at once each get their own container, and both are reclaimed",
    async () => {
      // Sessions are judged concurrently on a busy day. Two containers must not
      // collide on a name, a spool directory or a mount — and the pair must
      // finish inside one container's budget, not two, because the rail is
      // parallel and a serialising regression would silently double the judge's
      // wall clock.
      receivedPrompts = [];
      respond = () => Response.json({ choices: [{ message: { content: "ok" } }] });
      const startedAt = Date.now();
      const [a, b] = await Promise.all([
        runJudgeAgent(rail!, { model: "stub-judge", prompt: "first prompt", timeoutMs: REQUESTED_TIMEOUT_MS }),
        runJudgeAgent(rail!, { model: "stub-judge", prompt: "second prompt", timeoutMs: REQUESTED_TIMEOUT_MS }),
      ]);
      expect(a.line).toMatchObject({ ok: true, text: "ok" });
      expect(b.line).toMatchObject({ ok: true, text: "ok" });
      expect(a.containerName).not.toBe(b.containerName);
      expect(receivedPrompts.sort()).toEqual(["first prompt", "second prompt"]);
      expect(Date.now() - startedAt).toBeLessThan(CASE_TIMEOUT_MS);
      expect(containerNames(stack!.config.project, stack!.spawnEnv)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "the agent-launcher image really builds, and really carries the client it needs",
    async () => {
      // The cases above drive runJudgeAgent() from this test process, which has
      // a Docker CLI because the runner does. The SERVICE has one only if its
      // Dockerfile put it there — and a launcher image missing `docker compose`
      // would answer `launcher_unavailable` to every judging in production while
      // every other test in this repo stayed green. So the image is built and
      // its two load-bearing contents are read out of it: the compose plugin,
      // and the module that serves the route.
      await stack!.build(["agent-launcher"]);
      const r = stack!.compose(["run", "--rm", "--no-deps", "agent-launcher", "docker", "compose", "version"]);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toContain("Docker Compose version");

      const health = stack!.compose([
        "run", "--rm", "--no-deps", "agent-launcher", "bun", "-e",
        'const { createLauncherFetch } = await import("/app/scripts/agent/agent-launcher.ts");' +
          'const res = await createLauncherFetch({ composeProject: "probe" } as any)' +
          '(new Request("http://launcher/internal/health"));' +
          'console.log(res.status, await res.text());',
      ]);
      expect(health.exitCode, health.stderr).toBe(0);
      expect(health.stdout).toContain('"status":"ok"');
      expect(health.stdout).toContain('"project":"probe"');
      expect(health.stdout).toContain("200 ");
    },
    SETUP_TIMEOUT_MS,
  );
});
