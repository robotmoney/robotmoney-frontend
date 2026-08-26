// PURE, Docker-free unit tests for the onboarding-eval harness's helpers
// (scripts/lib/onboarding-eval.ts, scripts/agent/member-agent.ts) — identity
// and prompt building, the REGISTRY-BASED model/credential resolution (D22
// rule 1 as amended 2026-07-28: AGENT_MODEL → scripts/lib/model-registry.ts,
// funded via OPENCODE_API_KEY, `free` still available), step-state derivation,
// the GOLDEN member-agent argv for both the funded and the keyless case, and
// runOnboardingEvalWithRetry's retry DECISION via its injectable `runOnce`
// seam.
//
// PROVENANCE. The pure half of the old
// scripts/tests/integration/onboarding-eval-infra.test.ts lived alongside its
// Docker-backed half; that file is now Docker-only, and every pure assertion it
// carried lives here unchanged in meaning. Nothing was dropped in the move.
//
// WHAT CHANGED WITH THE D22 AMENDMENT. An earlier revision of this file
// asserted that `EVAL_MODEL` was an in-code constant, that no `-e` flag could
// ever appear in the argv, and that ambient env could not influence the eval.
// #292 amended D22 rule 1 and those assertions became false BY DESIGN — the
// eval now runs a funded, registry-selected model and must inject exactly one
// credential. They are replaced (not deleted) by their successors: the argv
// carries AT MOST ONE `-e`, under the env NAME the registry chose, and only
// when the resolved model needs credit.
//
// Cost class `unit` (docs/architecture.md §3 L1, docs/decisions.md D23): needs
// nothing but bun and the checkout — no Docker, no network — so it runs in
// `bun run test:unit` on every PR. The Docker-backed rails half lives in its
// cost-class sibling, scripts/tests/integration/onboarding-eval-infra.test.ts.
//
// The injectable `runOnce` seam exercised here is legitimate BECAUSE nothing in
// this file claims to be an eval: it is an inference-OFF rails check. §11.3 E2
// forbids such a seam on an eval's own path, which is under evals/ — enforced
// separately by scripts/checks/check-model-selection.sh.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildAgentOpencodeConfig,
  buildAgentPrompt,
  buildEvalOnboardingPrompt,
  buildMemberAgentArgv,
  classifyOutcome,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_INFERENCE_MODEL,
  deriveSteps,
  generateIdentity,
  isFullyOnboarded,
  KEYSTORE_PASSPHRASE_ENV,
  LOCAL_SWARM_ONBOARDING_SKILL_PATH,
  looksRateLimited,
  type MemberAgentModel,
  memberAgentContainerName,
  memberAgentSpawnEnv,
  ONBOARDING_STEPS,
  type OnboardingEvalResult,
  createObserverPollTracker,
  redactSecrets,
  resolveModelConfig,
  retryIdentity,
  runOnboardingEvalWithRetry,
} from "../../lib/onboarding-eval.ts";
import {
  buildOnboardingPrompt,
  SWARM_ONBOARDING_SKILL_URL,
  ONBOARDING_PROMPT,
} from "@robotmoney/contract";
import { isKeylessModel, MODEL_FAMILIES, resolveAgentModel } from "../../lib/model-registry.ts";
import { boundedExitAfterTerminate, inspectThenCleanup } from "../../agent/member-agent.ts";

// ── Pure helper unit tests (no Docker) ──────────────────────────────────────
describe("onboarding-eval pure helpers", () => {
  test("generateIdentity produces a fresh, matching name/contact pair each call", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(a.runId).not.toBe(b.runId);
    expect(a.contact).toContain(a.runId);
    expect(a.name).toContain(a.runId);
  });

  test("the canonical prompt carries no fill-in-the-blank placeholders for the harness to substitute", () => {
    // Real testers pasted the prompt verbatim and submitted "<display name>" as
    // a live application. Placeholders are gone for good: the prompt asks the
    // operator for identity, and the harness answers in its note instead. If a
    // future edit reintroduces a blank, this goes red before an eval run can
    // quietly go back to rewriting the canonical text.
    expect(ONBOARDING_PROMPT).not.toContain("<display name>");
    expect(ONBOARDING_PROMPT).not.toContain("<email>");
    expect(ONBOARDING_PROMPT.toLowerCase()).toContain("ask me for");
  });

  test("the eval prompt changes only the canonical prompt's skill URL", () => {
    const localSkillUrl = `http://api:8787${LOCAL_SWARM_ONBOARDING_SKILL_PATH}`;
    const evalPrompt = buildEvalOnboardingPrompt();
    expect(evalPrompt).toBe(buildOnboardingPrompt(localSkillUrl));
    expect(evalPrompt).toBe(ONBOARDING_PROMPT.replace(SWARM_ONBOARDING_SKILL_URL, localSkillUrl));
    expect(evalPrompt).toContain(localSkillUrl);
    expect(evalPrompt).not.toContain(SWARM_ONBOARDING_SKILL_URL);
  });

  test("buildAgentPrompt supplies identity in a separate note after the locally parameterized canonical prompt", () => {
    // The whole point of this eval is that it exercises the prompt operators
    // actually copy, changing only where the skill is fetched. Assert that
    // exact prompt is the prefix, not merely "contained somewhere".
    const identity = generateIdentity("fixed-run");
    const prompt = buildAgentPrompt(identity);
    expect(prompt.startsWith(buildEvalOnboardingPrompt())).toBe(true);
    expect(prompt).toContain(identity.name);
    expect(prompt).toContain(identity.contact);
    expect(prompt).toContain("Demo harness note"); // clearly delimited, not blended in
  });

  test("buildAgentPrompt tells the agent its owner is absent and their secrets are already exported", () => {
    // The repo-owned swarm-onboarding skill instructs the agent to ask its
    // human owner to export the keystore passphrase and to WAIT for them ("Tell
    // me once it's set"). A headless container has no owner to answer, so
    // WITHOUT this the correct behaviour IS to stop — which is exactly what CI
    // run 30395466780 recorded: exit 0, every onboarding step still pending.
    // This is the harness playing the owner, the same role it already plays by
    // answering the prompt's own request for a display name and contact
    // (§11 R1/R4, §11.3 E7).
    const prompt = buildAgentPrompt(generateIdentity("fixed-run"));
    expect(prompt).toMatch(/not at the keyboard/i);
    expect(prompt).toMatch(/already exported into this environment every secret/i);
  });

  test("buildAgentPrompt's harness note names no tool, endpoint, payload or onboarding step", () => {
    // The note is environment info. The moment it starts describing WHAT to do,
    // the eval stops measuring our published instructions and starts measuring
    // the harness's own crib sheet (§11 R8 — observe only). In particular it
    // must NOT name the env var the passphrase arrives in: finding it is part
    // of what the skill is being measured on.
    const identity = generateIdentity("fixed-run");
    const evalPrompt = buildEvalOnboardingPrompt();
    const note = buildAgentPrompt(identity).slice(evalPrompt.length);
    expect(note.length).toBeGreaterThan(0);
    for (const leak of ["rmpc", "ed25519", "sign", "keygen", "canonical", "/api/", "POST", "public key", "bearer", KEYSTORE_PASSPHRASE_ENV])
      expect(note.toLowerCase()).not.toContain(leak.toLowerCase());
  });

  // ── Transcript redaction ──────────────────────────────────────────────────
  // A failed run's transcript is printed WHOLE into CI logs and the smoke
  // console. The container is handed its secrets by `-e`, and a curious agent
  // runs `env` — observed verbatim in a local run.
  test("redactSecrets scrubs every injected secret from a transcript, and leaves the evidence intact", () => {
    const key = "sk-2hGebKV9SH8Od7psxwGyoim40wu6Tq6eSIDQJIK2";
    const passphrase = "3e4bab64-5469-457f-9e79-25bdf5537430";
    const transcript = `AGENT=1\nOPENCODE_API_KEY=${key}\n${KEYSTORE_PASSPHRASE_ENV}=${passphrase}\ncurl -H "auth: ${key}"`;
    const out = redactSecrets(transcript, [
      [key, "<OPENCODE_API_KEY redacted>"],
      [passphrase, `<${KEYSTORE_PASSPHRASE_ENV} redacted>`],
    ]);
    expect(out).not.toContain(key);
    expect(out).not.toContain(passphrase);
    expect(out).toContain("<OPENCODE_API_KEY redacted>");
    expect(out).toContain("AGENT=1"); // the surrounding evidence survives
    expect(out.split("<OPENCODE_API_KEY redacted>")).toHaveLength(3); // EVERY occurrence
  });

  test("redactSecrets never mass-replaces an absent, empty or trivially short secret", () => {
    // A keyless run has apiKey === null; a naive replace of "" would shred the
    // whole transcript into placeholders.
    const t = "a transcript with no secrets in it";
    expect(redactSecrets(t, [[null, "<x>"], [undefined, "<x>"], ["", "<x>"], ["a", "<x>"]])).toBe(t);
  });

  test("resolveModelConfig defaults to the funded registry default when AGENT_MODEL is unset", () => {
    const cfg = resolveModelConfig({ OPENCODE_API_KEY: "sk-zen" });
    expect(cfg.model).toBe(DEFAULT_INFERENCE_MODEL);
    expect(cfg.model).toBe("opencode/deepseek-v4-flash");
    expect(cfg).toEqual({ model: DEFAULT_INFERENCE_MODEL, apiKeyEnv: "OPENCODE_API_KEY", apiKey: "sk-zen", keyless: false });
  });

  test("resolveModelConfig throws loudly when a paid model is selected with no funded key — never a silent substitution", () => {
    // Caught here rather than ~20 minutes later at the far end of a stack boot.
    expect(() => resolveModelConfig({})).toThrow(/OPENCODE_API_KEY is not set/);
  });

  test("resolveModelConfig keeps a `free` selection genuinely keyless, even with a key present", () => {
    // A key set for an unrelated reason must never get pulled into a keyless run.
    const cfg = resolveModelConfig({ AGENT_MODEL: "free", OPENCODE_API_KEY: "sk-zen" });
    expect(cfg).toEqual({ model: "opencode/nemotron-3-ultra-free", apiKeyEnv: null, apiKey: null, keyless: true });
  });

  test("resolveModelConfig switches family by name and pins an exact member with family/model", () => {
    expect(resolveModelConfig({ AGENT_MODEL: "kimi", OPENCODE_API_KEY: "k" }).model).toBe("opencode/kimi-k2.7-code");
    expect(resolveModelConfig({ AGENT_MODEL: "kimi/k2.6", OPENCODE_API_KEY: "k" }).model).toBe("opencode/kimi-k2.6");
  });

  test("resolveAgentModel refuses an unknown family or member rather than falling back to the default", () => {
    // A run must use the model it was asked for; a silent fallback turns a
    // benchmark result into a lie about which agent produced it.
    expect(() => resolveAgentModel({ AGENT_MODEL: "notafamily" })).toThrow(/unknown model family/);
    expect(() => resolveAgentModel({ AGENT_MODEL: "kimi/notamodel" })).toThrow(/unknown model "notamodel"/);
    expect(() => resolveAgentModel({ AGENT_MODEL: "a/b/c" })).toThrow(/malformed/);
  });

  test("resolveAgentModel passes a fully-qualified opencode/<id> through unmapped (escape hatch)", () => {
    expect(resolveAgentModel({ AGENT_MODEL: "opencode/some-brand-new-model" })).toBe("opencode/some-brand-new-model");
  });

  test("every registry family default names a real member of that family", () => {
    // Guards the one typo that would make a whole family unusable.
    for (const [name, family] of Object.entries(MODEL_FAMILIES)) {
      expect(family.models[family.default], `${name}.default`).toBeDefined();
      expect(resolveAgentModel({ AGENT_MODEL: name })).toBe(`opencode/${family.models[family.default]}`);
    }
  });

  test("isKeylessModel is derived from the registry, and big-pickle stays reachable but is not the default", () => {
    expect(isKeylessModel("opencode/nemotron-3-ultra-free")).toBe(true);
    expect(isKeylessModel("opencode/big-pickle")).toBe(true);
    expect(isKeylessModel("opencode/deepseek-v4-flash")).toBe(false);
    // Saturated upstream with no paid tier — deliberately no longer the default.
    expect(DEFAULT_INFERENCE_MODEL).not.toBe("opencode/big-pickle");
  });

  test("buildAgentOpencodeConfig carries NO onboarding-specific knowledge and no Robot Money connectivity (D21 — REST via bash, no MCP client)", () => {
    const cfg = buildAgentOpencodeConfig("opencode/some-model") as any;
    expect(cfg.model).toBe("opencode/some-model");
    expect(cfg.mcp).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toMatch(/rmpc|apply|swarm|robotmoney/i);
    // The model is a PARAMETER: this builder invents nothing and has no default.
    expect((buildAgentOpencodeConfig("opencode/another") as any).model).toBe("opencode/another");
  });

  // REGRESSION PIN for the 2026-07-27 layer-4 sweep and CI run 30395466780.
  //
  // The permission set was `{"*": "deny", bash: "allow", external_directory:
  // "allow"}`. opencode merges config rules with its built-ins LAST-MATCH-WINS,
  // so the blanket deny also overrode the built-in allowances: the agent lost
  // `read`/`write`/`edit`/`webfetch` outright and a plain `cat` of a file it had
  // just cloned was refused with "The user has specified a rule which prevents
  // you from using this specific tool call". It burned minutes rediscovering
  // `grep -n "."` as a `cat` substitute and never reached the API.
  //
  // The `external_directory` line was the previous, narrower attempt at the same
  // diagnosis (opencode's defaults carry `external_directory: {"*": "ask", …}`,
  // and in a non-interactive `opencode run` an "ask" has nobody to ask, so it
  // resolves to a REJECTION — an agent that cloned the swarm-onboarding
  // skill into /tmp could `ls` its way to SKILL.md and never read a byte). That
  // property is preserved by the general form asserted here: nothing is denied
  // and nothing stops to ask.
  //
  // §11 R8: the container is a VANILLA install and the eval measures our
  // INSTRUCTIONS. A harness that denies the agent its own tools measures the
  // harness.
  test("the container agent runs a VANILLA permission set — the harness never denies it its own tools", () => {
    const cfg = buildAgentOpencodeConfig("opencode/some-model") as any;
    expect(cfg.permission).toEqual({ "*": "allow" });
    expect(JSON.stringify(cfg.permission)).not.toContain("deny");
    expect(JSON.stringify(cfg.permission)).not.toContain("ask");
  });

  test("deriveSteps: no member observed yet ⇒ every step pending", () => {
    const steps = deriveSteps({ memberId: null, applyState: null, onActiveRoster: false });
    expect(steps.every((s) => s.status === "pending")).toBe(true);
    expect(steps.map((s) => s.step)).toEqual([...ONBOARDING_STEPS]);
  });

  test("deriveSteps: a member row exists ⇒ connect/discover/toolchain/apply done, rest pending", () => {
    const steps = deriveSteps({ memberId: "m1", applyState: "applied", onActiveRoster: false });
    const byStep = Object.fromEntries(steps.map((s) => [s.step, s.status]));
    expect(byStep).toEqual({
      connect: "done", discover: "done", toolchain: "done", apply: "done",
      approve: "pending", claim: "pending", session: "pending",
    });
  });

  test("deriveSteps: approved and active-roster but not yet claimed keeps claim/session pending", () => {
    const byStep = Object.fromEntries(
      deriveSteps({ memberId: "m1", applyState: "approved", onActiveRoster: true }).map((s) => [s.step, s.status]),
    );
    expect(byStep.approve).toBe("done");
    expect(byStep.claim).toBe("pending");
    expect(byStep.session).toBe("pending");
  });

  test("deriveSteps: claimed and on the active roster ⇒ every step done", () => {
    const steps = deriveSteps({ memberId: "m1", applyState: "claimed", onActiveRoster: true });
    expect(steps.every((s) => s.status === "done")).toBe(true);
  });

  test("full-onboarding success requires claimed state, claimedAt, and active roster independently", () => {
    expect(isFullyOnboarded({ memberId: "m1", applyState: "approved", claimedAt: null, onActiveRoster: true })).toBe(false);
    expect(isFullyOnboarded({ memberId: "m1", applyState: "claimed", claimedAt: null, onActiveRoster: true })).toBe(false);
    expect(isFullyOnboarded({ memberId: "m1", applyState: "claimed", claimedAt: "2026-07-29T00:00:00Z", onActiveRoster: false })).toBe(false);
    expect(isFullyOnboarded({ memberId: "m1", applyState: "claimed", claimedAt: "2026-07-29T00:00:00Z", onActiveRoster: true })).toBe(true);
  });

  test("observer polling logs failure/recovery transitions and retains only persistent failures", async () => {
    const events: string[] = [];
    const tracker = createObserverPollTracker((message) => events.push(message));

    expect(await tracker.poll("admin.members", async () => { throw new Error("HTTP 503"); })).toEqual({ ok: false });
    expect(await tracker.poll("admin.members", async () => { throw new Error("HTTP 503"); })).toEqual({ ok: false });
    expect(tracker.persistentError()).toBe("admin.members: HTTP 503");
    expect(await tracker.poll("admin.members", async () => "member-1")).toEqual({ ok: true, value: "member-1" });
    expect(tracker.persistentError()).toBeNull();
    expect(events).toEqual([
      "observer.poll.failed endpoint=admin.members error=HTTP 503",
      "observer.poll.recovered endpoint=admin.members",
    ]);
  });
});

// ── GOLDEN member-agent argv (no Docker) ────────────────────────────────────
// The executed proof that extracting the container mechanics into the shared
// scripts/agent/member-agent.ts primitive did NOT change the command line the
// eval spends 20 minutes riding. Any drift here is a behaviour change to that
// gate, not a refactor.
describe("member-agent container primitive", () => {
  const FUNDED: MemberAgentModel = { model: "opencode/deepseek-v4-flash", apiKeyEnv: "OPENCODE_API_KEY", apiKey: "sk-zen" };
  const KEYLESS: MemberAgentModel = { model: "opencode/nemotron-3-ultra-free", apiKeyEnv: null, apiKey: null };

  const base = {
    composeProject: "rm_smoke_stack_abc",
    containerName: "rm_smoke_stack_abc-member-agent-eval-run1",
    opencodeConfigPath: "/tmp/wd/opencode.json",
    title: "onboarding-eval-run1",
    prompt: "PROMPT TEXT",
  };

  test("memberAgentContainerName is the exact <project>-member-agent-eval-<runId> format cleanup targets", () => {
    expect(memberAgentContainerName("rm_smoke_stack_abc", "run1")).toBe("rm_smoke_stack_abc-member-agent-eval-run1");
  });

  test("a failed diagnostic capture cannot skip container cleanup", async () => {
    const order: string[] = [];
    const result = await inspectThenCleanup({
      inspect: async () => {
        order.push("inspect");
        throw new Error("artifact disk failed with OPENCODE_API_KEY=secret");
      },
      onInspectError: () => order.push("capture-failure-recorded"),
      cleanup: () => {
        order.push("docker-rm");
        return 0;
      },
    });
    expect(order).toEqual(["inspect", "capture-failure-recorded", "docker-rm"]);
    expect(result.cleanupExitCode).toBe(0);
    expect(result.inspectError).toBeInstanceOf(Error);
  });

  test("a stuck Docker CLI cannot delay inspection and cleanup indefinitely", async () => {
    const order: string[] = [];
    const started = Date.now();
    const exitCode = await boundedExitAfterTerminate({
      exited: new Promise<number>(() => {}),
      kill: (signal) => order.push(`signal-${signal}`),
      termGraceMs: 10,
      killGraceMs: 10,
    });
    const lifecycle = await inspectThenCleanup({
      inspect: async () => { order.push("inspect"); },
      cleanup: () => { order.push("docker-rm"); return 0; },
    });
    expect(Date.now() - started).toBeLessThan(250);
    expect(exitCode).toBeNull();
    expect(lifecycle.cleanupExitCode).toBe(0);
    expect(order).toEqual(["signal-9", "inspect", "docker-rm"]);
  });

  test("FUNDED: the argv is byte-for-byte what the eval spawns, with exactly one -e credential", () => {
    expect(buildMemberAgentArgv({ ...base, modelConfig: FUNDED })).toEqual([
      "docker",
      "compose", "-p", "rm_smoke_stack_abc",
      "-f", "docker-compose.yml",
      "-f", "docker-compose.smoke.yml",
      "run",
      "--rm",
      "--no-deps",
      "--name", "rm_smoke_stack_abc-member-agent-eval-run1",
      "-v", "/tmp/wd/opencode.json:/home/agent/opencode.json:ro",
      "-e", "OPENCODE_API_KEY=sk-zen",
      "member-agent",
      "run",
      "--model", "opencode/deepseek-v4-flash",
      "--format", "json",
      "--auto",
      "--title", "onboarding-eval-run1-opencode-deepseek-v4-flash",
      "--print-logs",
      "--log-level", "DEBUG",
      "--dir", "/home/agent",
      "PROMPT TEXT",
    ]);
  });

  test("the auto-approve flag is opencode's REAL one, never the flag that never existed", () => {
    // `--dangerously-skip-permissions` is not an opencode flag — v1.18.1's
    // `run` offers `--auto` — and yargs swallows unknown `--flags` in SILENCE.
    // So the harness believed permissions were disabled through four red runs
    // of the required gate while every `ask` rule stayed armed and, in a
    // headless container, unanswerable. This assertion pins the spelling; the
    // Docker-backed sibling (scripts/tests/integration/onboarding-eval-infra.test.ts)
    // is what proves the spelling is real, by checking every flag emitted here
    // against the pinned binary's own `--help`.
    const argv = buildMemberAgentArgv({ ...base, modelConfig: FUNDED });
    expect(argv).toContain("--auto");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv.at(-1)).toBe("PROMPT TEXT"); // the prompt stays the trailing positional
  });

  // ── ownerEnv: the human owner's half of the session environment ────────────
  // The published swarm-onboarding skill tells the agent to ask its owner
  // to export the keystore passphrase and to WAIT for them ("Tell me once it's
  // set"), and forbids accepting the value in conversation. A headless
  // container has no owner to answer, so an agent that follows the skill
  // CORRECTLY stops there — the exact shape of CI run 30395466780 (exit 0,
  // every step still pending). The harness plays the owner (§11.3 E7).
  test("ownerEnv is injected as -e pairs, in a deterministic order, alongside the model credential", () => {
    const argv = buildMemberAgentArgv({
      ...base,
      modelConfig: FUNDED,
      ownerEnv: { Z_LAST: "z", RMPC_COMMITTEE_IDENTITY_PASSPHRASE: "pass-phrase-xyz" },
    });
    expect(argv).toContain("RMPC_COMMITTEE_IDENTITY_PASSPHRASE=pass-phrase-xyz");
    expect(argv).toContain("OPENCODE_API_KEY=sk-zen");
    // Sorted, so the argv is diffable and a golden stays stable.
    expect(argv.indexOf("RMPC_COMMITTEE_IDENTITY_PASSPHRASE=pass-phrase-xyz")).toBeLessThan(argv.indexOf("Z_LAST=z"));
    // Every injected pair sits BEFORE the service name — after it, argv belongs
    // to `opencode run`, where a stray `-e` would be read as a flag.
    for (const v of ["OPENCODE_API_KEY=sk-zen", "RMPC_COMMITTEE_IDENTITY_PASSPHRASE=pass-phrase-xyz", "Z_LAST=z"])
      expect(argv.indexOf(v)).toBeLessThan(argv.indexOf("member-agent"));
  });

  test("a KEYLESS model still gets its owner's secrets — a passphrase is not a model credential", () => {
    const argv = buildMemberAgentArgv({
      ...base,
      modelConfig: KEYLESS,
      ownerEnv: { RMPC_COMMITTEE_IDENTITY_PASSPHRASE: "pass-phrase-xyz" },
    });
    expect(argv.join(" ")).not.toMatch(/_API_KEY/);
    expect(argv).toContain("RMPC_COMMITTEE_IDENTITY_PASSPHRASE=pass-phrase-xyz");
    expect(argv.filter((a) => a === "-e")).toHaveLength(1);
  });

  test("no ownerEnv ⇒ the argv is exactly what it was — this is an opt-in, not an ambient read", () => {
    expect(buildMemberAgentArgv({ ...base, modelConfig: FUNDED, ownerEnv: {} })).toEqual(
      buildMemberAgentArgv({ ...base, modelConfig: FUNDED }),
    );
  });

  test("KEYLESS: the SAME argv minus the -e pair — AGENT_MODEL=free is still a real, key-free path", () => {
    const keyless = buildMemberAgentArgv({ ...base, modelConfig: KEYLESS });
    expect(keyless).not.toContain("-e");
    expect(keyless.join(" ")).not.toMatch(/_API_KEY/);
    const funded = buildMemberAgentArgv({ ...base, modelConfig: FUNDED });
    // Structurally the same argv once the credential pair and the model id are
    // removed: the keyless path is not a second, divergent code path.
    const strip = (a: string[]) => a.filter((x, i) =>
      x !== "-e" && a[i - 1] !== "-e" && !x.startsWith("opencode/") &&
      !x.startsWith("onboarding-eval-run1-opencode-"));
    expect(strip(keyless)).toEqual(strip(funded));
  });

  test("exactly ONE credential can ever be injected, under the env name the REGISTRY chose", () => {
    // The pre-amendment design forbade `-e` outright. The property that
    // survives is narrower and is the one that matters: one flag, one name,
    // and that name comes from resolveModelConfig(), not from a candidate list.
    for (const keep of [false, true]) {
      const argv = buildMemberAgentArgv({ ...base, modelConfig: FUNDED, keep });
      expect(argv.filter((a) => a === "-e")).toHaveLength(1);
      const i = argv.indexOf("-e");
      expect(argv[i + 1]).toBe("OPENCODE_API_KEY=sk-zen");
      // No OTHER provider key name reaches the container.
      expect(argv.join(" ")).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|MOONSHOT_API_KEY|OPENCODE_MODEL/);
    }
  });

  test("the injected name follows the registry's choice — it is not hardcoded here", () => {
    const argv = buildMemberAgentArgv({
      ...base,
      modelConfig: { model: "opencode/x", apiKeyEnv: "SOME_OTHER_KEY_ENV", apiKey: "v" },
    });
    expect(argv[argv.indexOf("-e") + 1]).toBe("SOME_OTHER_KEY_ENV=v");
  });

  test("a funded config with no key value THROWS — never a silent unauthenticated launch", () => {
    expect(() =>
      buildMemberAgentArgv({ ...base, modelConfig: { model: "opencode/x", apiKeyEnv: "OPENCODE_API_KEY", apiKey: null } }),
    ).toThrow(/carries no value/);
  });

  test("the model on argv is exactly the resolved one — the primitive has no model of its own", () => {
    const argv = buildMemberAgentArgv({ ...base, modelConfig: { ...FUNDED, model: "opencode/kimi-k2.6" } });
    expect(argv[argv.indexOf("--model") + 1]).toBe("opencode/kimi-k2.6");
    expect(() => buildMemberAgentArgv({ ...base, modelConfig: { ...FUNDED, model: "" } })).toThrow(/model is required/);
  });

  test("keep:true omits --rm (so a stopped container survives inspection) and changes nothing else", () => {
    const normal = buildMemberAgentArgv({ ...base, modelConfig: FUNDED });
    const kept = buildMemberAgentArgv({ ...base, modelConfig: FUNDED, keep: true });
    expect(normal.filter((a) => a !== "--rm")).toEqual(kept);
    expect(kept).not.toContain("--rm");
  });

  test("composeFiles default to the single shared DEFAULT_COMPOSE_FILES definition", () => {
    const argv = buildMemberAgentArgv({ ...base, modelConfig: FUNDED });
    for (const f of DEFAULT_COMPOSE_FILES) expect(argv).toContain(f);
  });

  // ── The compose child's environment (2026-07-27) ──────────────────────────
  // `docker compose run` re-resolves the WHOLE project, and docker-compose.smoke.yml
  // labels the pgdata volume with ${SMOKE_PROJECT}. A child without it hashes a
  // different volume definition than `stack.up()` recorded, and compose then
  // asks — interactively — whether to recreate the live database. Reproduced on
  // this repo's own compose files with compose 2.40.3; with a terminal on stdin
  // the invocation never returns.
  describe("memberAgentSpawnEnv", () => {
    test("always carries SMOKE_PROJECT, and it is exactly the compose project name", () => {
      expect(memberAgentSpawnEnv("rm_smoke_eval_abc", {}).SMOKE_PROJECT).toBe("rm_smoke_eval_abc");
    });

    test("a host value can never shadow it — the compose model must match the project it runs against", () => {
      const env = memberAgentSpawnEnv("rm_smoke_eval_abc", { SMOKE_PROJECT: "rm_smoke_stack_someone_else" });
      expect(env.SMOKE_PROJECT).toBe("rm_smoke_eval_abc");
    });

    test("docker-client plumbing from the host survives (a child that cannot find the daemon runs nothing)", () => {
      const env = memberAgentSpawnEnv("p", { PATH: "/usr/bin", DOCKER_HOST: "unix:///var/run/docker.sock", GONE: undefined });
      expect(env.PATH).toBe("/usr/bin");
      expect(env.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
      expect("GONE" in env).toBe(false);
    });

    test("the generated stack label environment survives into member-agent Compose resolution", () => {
      const env = memberAgentSpawnEnv("rm_smoke_eval_abc", {
        PATH: "/usr/bin",
        RM_STACK_ENV_CLASS: "local",
        RM_STACK_ENV_HASH: "abc123",
        SMOKE_PROJECT: "from-stack",
      });
      expect(env).toMatchObject({
        RM_STACK_ENV_CLASS: "local",
        RM_STACK_ENV_HASH: "abc123",
        SMOKE_PROJECT: "rm_smoke_eval_abc",
      });
    });
  });
});

// ── Retry/backoff decision logic (no Docker, no model call — Stage 7, §11 R8)
// Exercises runOnboardingEvalWithRetry's OWN control flow via its injectable
// runOnce seam. The real admission path (runOnboardingEval itself) is proven
// separately by the Docker-backed sibling file and by the nightly's live run —
// this suite is deliberately narrow: it is testing the retry DECISION, not
// re-proving the eval.
describe("runOnboardingEvalWithRetry", () => {
  const FUNDED_ENV = { OPENCODE_API_KEY: "sk-zen" };
  const KEYLESS_ENV = { AGENT_MODEL: "free" };

  function fakeResult(overrides: Partial<OnboardingEvalResult> = {}): OnboardingEvalResult {
    return {
      identity: generateIdentity("fake"),
      memberId: null,
      steps: [],
      admitted: false,
      applyState: null,
      claimedAt: null,
      onActiveRoster: false,
      timedOut: false,
      containerExitCode: 1,
      containerLaunched: true,
      observerError: null,
      homeVolume: null,
      ...overrides,
    };
  }

  test("looksRateLimited matches known provider rate-limit/overload signals", () => {
    expect(looksRateLimited("Error: 429 Too Many Requests")).toBe(true);
    expect(looksRateLimited("anthropic rate_limit_error: slow down")).toBe(true);
    expect(looksRateLimited("upstream returned 529 overloaded_error")).toBe(true);
    expect(looksRateLimited(undefined)).toBe(false);
    expect(looksRateLimited("agent could not install the swarm-onboarding skill")).toBe(false);
  });

  test("admitted on the first attempt — never retries", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      automationToken: "t",
      env: FUNDED_ENV,
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        return fakeResult({ admitted: true });
      },
    });
    expect(result.admitted).toBe(true);
    expect(calls).toBe(1);
  });

  test("a real navigation failure is returned as-is — no retry", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      automationToken: "t",
      env: FUNDED_ENV,
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        return fakeResult({ transcript: "agent never submitted a signed application" });
      },
    });
    expect(result.admitted).toBe(false);
    expect(calls).toBe(1); // no retry — this is a real eval result
  });

  test("a rate-limited failure IS retried, and a subsequent success is returned", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      automationToken: "t",
      env: FUNDED_ENV,
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        if (calls === 1) return fakeResult({ transcript: "429 rate_limit_error from provider" });
        return fakeResult({ admitted: true });
      },
    });
    expect(result.admitted).toBe(true);
    expect(calls).toBe(2);
  });

  test("exhausts maxAttempts and returns the last (still rate-limited) failure — never retries forever", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      automationToken: "t",
      env: FUNDED_ENV,
      maxAttempts: 3,
      backoffMsSchedule: [0, 0],
      runOnce: async () => {
        calls++;
        return fakeResult({ transcript: "529 overloaded_error" });
      },
    });
    expect(result.admitted).toBe(false);
    expect(calls).toBe(3);
  });

  test("retries use a FRESH contact each attempt (never re-apply the same one)", async () => {
    const identities: string[] = [];
    await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      automationToken: "t",
      env: FUNDED_ENV,
      backoffMsSchedule: [0],
      identity: generateIdentity("first-attempt"),
      runOnce: async (opts) => {
        identities.push(opts.identity!.contact);
        return fakeResult({ transcript: "429" });
      },
    });
    expect(identities.length).toBe(2);
    expect(new Set(identities).size).toBe(2); // no reused contact across attempts
  });

  // A bare timeout is retried on EVERY tier. It used to be keyless-only, on the
  // theory that a funded model is fast enough for a timeout to mean something.
  // Measured otherwise on 2026-07-28: a funded `opencode/deepseek-v4-flash`
  // generated its key, said "Key generated! Now I need to build the canonical
  // application payload bytes", and then emitted nothing at all for ~18 minutes
  // — no tool call, no token, no error.
  //
  // The bar is not softened, and the pair of cases below is what proves it: a
  // timeout is an ABSENCE of signal, while a genuine navigation failure
  // presents as a container EXIT (CI run 30395466780: exit 0, every step
  // pending) — and that is never retried, on either tier.
  for (const [tier, env] of [
    ["keyless", KEYLESS_ENV],
    ["funded", FUNDED_ENV],
  ] as const) {
    test(`a bare timeout IS retried on a ${tier} model — a timeout is an absence of signal, not a result`, async () => {
      let calls = 0;
      const result = await runOnboardingEvalWithRetry({
        repoRoot: "/tmp",
        composeProject: "p",
        backendUrl: "http://x",
        automationToken: "t",
        env,
        backoffMsSchedule: [0],
        runOnce: async () => {
          calls++;
          if (calls === 1) return fakeResult({ timedOut: true, transcript: "" });
          return fakeResult({ admitted: true });
        },
      });
      expect(result.admitted).toBe(true);
      expect(calls).toBe(2);
    });

    test(`a container EXIT is never retried on a ${tier} model — that is how a real navigation failure presents`, async () => {
      let calls = 0;
      const result = await runOnboardingEvalWithRetry({
        repoRoot: "/tmp",
        composeProject: "p",
        backendUrl: "http://x",
        automationToken: "t",
        env,
        backoffMsSchedule: [0],
        runOnce: async () => {
          calls++;
          return fakeResult({ timedOut: false, containerExitCode: 0, transcript: "agent ended its session without applying" });
        },
      });
      expect(result.admitted).toBe(false);
      expect(calls).toBe(1);
    });
  }

  // ── Refusal is retryable (the 2026-07-25 zero-admission smoke run) ─────────
  // The classifier itself is unit-tested exhaustively (positives AND the
  // false-positive guards) in
  // scripts/tests/unit/member-agent-classify.test.ts; these cases test only
  // what THIS wrapper does with its verdict.
  const refusalTranscript =
    `--- stdout ---\n${readFileSync(join(import.meta.dir, "..", "fixtures", "member-agent-refusal.ndjson"), "utf8")}\n--- stderr ---\n`;

  test("a classified REFUSAL is retried — the agent never attempted onboarding, so it is not a real eval result", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      automationToken: "t",
      env: FUNDED_ENV, // retried on a FUNDED model too: a declination is never weather
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        // The observed shape: clean exit, no member row, no timeout.
        if (calls === 1) return fakeResult({ containerExitCode: 0, transcript: refusalTranscript });
        return fakeResult({ admitted: true });
      },
    });
    expect(result.admitted).toBe(true);
    expect(calls).toBe(2);
  });

  test("the SAME refusal text with a member row already minted is NOT retried — that is a real (navigation) result", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      automationToken: "t",
      env: FUNDED_ENV,
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        return fakeResult({ memberId: "m1", containerExitCode: 0, transcript: refusalTranscript });
      },
    });
    expect(result.admitted).toBe(false);
    expect(calls).toBe(1);
  });

  test("a `harness-error` is NEVER retried — a broken harness is broken the same way next time", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      automationToken: "t",
      env: KEYLESS_ENV, // a tier whose bare timeouts ARE retried — this still is not
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        // Positive first-party evidence the HARNESS stopped the run: the
        // container was observed not to exist and the stream carries no agent
        // event at all. The timedOut flag alone would otherwise be retried here.
        return fakeResult({ timedOut: true, containerLaunched: false, transcript: "" });
      },
    });
    expect(result.admitted).toBe(false);
    expect(calls).toBe(1);
  });

  test("a persistent observer failure is a non-retryable harness error", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      automationToken: "t",
      env: FUNDED_ENV,
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        return fakeResult({
          timedOut: true,
          observerError: "application.status: GET /api/swarm/apply/m1 -> 503",
        });
      },
    });
    expect(classifyOutcome(result)).toBe("harness-error");
    expect(calls).toBe(1);
  });

  test("a retry PRESERVES the caller's display name and only derives a fresh runId/contact", async () => {
    const planned = { runId: "ada", name: "Ada Lovelace", contact: "ada@example.test" };
    const seen: Array<{ name: string; contact: string; runId: string }> = [];
    await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      automationToken: "t",
      env: FUNDED_ENV,
      backoffMsSchedule: [0],
      identity: planned,
      runOnce: async (o) => {
        seen.push({ ...o.identity! });
        return fakeResult({ containerExitCode: 0, transcript: refusalTranscript });
      },
    });
    expect(seen.length).toBe(2);
    // The smoke announces the planned newcomer by NAME and records it in
    // e2e.MEMBERS — a retry that admitted a generated name would put a
    // different person on the swarm than the one it announced.
    expect(seen.map((s) => s.name)).toEqual(["Ada Lovelace", "Ada Lovelace"]);
    expect(seen[0]).toEqual(planned);
    expect(seen[1]!.runId).toBe("ada-r2");
    expect(seen[1]!.contact).toBe("ada-r2@example.test");
    expect(new Set(seen.map((s) => s.contact)).size).toBe(2); // never re-applies a used contact
  });

  test("retryIdentity falls back to a generated identity when the caller supplied none", () => {
    const a = retryIdentity(undefined, 1);
    const b = retryIdentity(undefined, 2);
    expect(a.contact).not.toBe(b.contact);
    expect(b.runId).toContain("ci-retry-2-");
  });

  test("a misconfigured AGENT_MODEL fails BEFORE the first attempt — never after a 20-minute run", async () => {
    let calls = 0;
    await expect(
      runOnboardingEvalWithRetry({
        repoRoot: "/tmp",
        composeProject: "p",
        backendUrl: "http://x",
        automationToken: "t",
        env: { AGENT_MODEL: "notafamily", OPENCODE_API_KEY: "sk-zen" },
        backoffMsSchedule: [0],
        runOnce: async () => {
          calls++;
          return fakeResult({ admitted: true });
        },
      }),
    ).rejects.toThrow(/unknown model family/);
    expect(calls).toBe(0);
  });
});
