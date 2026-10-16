// THE CONFIGURED CREDENTIAL FILE DISAPPEARS WHILE PARTICIPANTS RUN — spec
// §6.1 and the §10 W3 gate "Configured credential file disappears while
// participants run: refuse, participants untouched" (criterion 138, the
// runtime half of credential-file.test.ts's module cases).
//
//   "A missing file is never an instruction. A configured path that is
//    missing, unreadable, or malformed refuses and leaves running participants
//    untouched."
//
// Everything is real: `bun smoke` boots a `--local blank` instance, two
// members are seated through the running API's admin route with the
// operator's token (the one path that mints a member and its bearer), their
// entries are written into a credential file, and a second `bun smoke --local
// volume --credentials <file>` starts them as standing participant containers
// that authenticate to the API. Then the file is deleted and `bun smoke` runs
// again against the same path. It must refuse naming the path, and every
// participant container must keep its id and its start time: not stopped, not
// recreated, not restarted.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import { readReceipt } from "../../lib/smoke-journal.ts";
import { readStackState } from "../../lib/smoke-state.ts";
import { listRunningParticipants, type DockerRun } from "../../lib/participant-compose.ts";
import type { CredentialEntry } from "../../lib/swarm/credential-file.ts";
import { BOOT_TIMEOUT_MS, bootFailureReport, containerIdentity, harness, spawnBoot, teardown } from "./smoke-boot-harness.ts";
import { credentialEntry } from "./participant-fixture.ts";

const h = harness("credfile");
afterAll(() => teardown(h), 300_000);

const docker: DockerRun = (args) => {
  const r = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

// The judge runs the pinned paid model (a judge refuses the keyless family),
// so the boots select it; the key the boot's inference preflight asks for is a
// placeholder that reaches no container (no-model-key-outside-participants),
// and each participant's model key is its own entry's.
const BOOT_ENV = { AGENT_MODEL: "deepseek", OPENCODE_API_KEY: "sk-placeholder-never-forwarded" };

/** Seat one member through the admin route; returns its credential-file entry and handle. */
async function seat(apiUrl: string, operatorToken: string, name: string, role: "member" | "judge" = "member"): Promise<{ handle: string; entry: CredentialEntry }> {
  const entry = credentialEntry(name.toLowerCase());
  const res = await fetch(`${apiUrl}${ROUTES.swarm.admin.members}`, {
    method: "POST",
    headers: { "X-Automation-Token": operatorToken, "Content-Type": "application/json" },
    body: JSON.stringify({ name, publicKey: entry.publicKeyB64 }),
  });
  const body = (await res.json()) as { member?: { id?: string; handle?: string }; token?: string; error?: string };
  if (res.status !== 201 || !body.member?.id || !body.token) throw new Error(`seating ${name} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  if (role === "judge") {
    const version = (body.member as { version?: number }).version ?? 1;
    const r = await fetch(`${apiUrl}${ROUTES.swarm.admin.members}/${encodeURIComponent(body.member.id)}/role`, {
      method: "POST",
      headers: { "X-Automation-Token": operatorToken, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "judge", expectedVersion: version }),
    });
    if (!r.ok) throw new Error(`making ${name} a judge failed: HTTP ${r.status} ${await r.text()}`);
  }
  return { handle: body.member.handle ?? body.member.id, entry: { ...entry, memberId: body.member.id, bearer: body.token } };
}

describe("a configured credential file that disappears refuses the boot and leaves every participant running (criterion 138)", () => {
  test("real boots: participants started from the file, the file deleted, the rerun refuses naming the path, and no participant is touched", async () => {
    // Boot 1: the instance, with an explicit empty roster.
    const first = spawnBoot(h, [], { env: BOOT_ENV });
    const firstCode = await first.exited;
    if (firstCode !== 0) throw new Error(`the first boot exited ${firstCode}:\n${bootFailureReport(first)}`);

    // Two members, seated by the running API, and the file that holds them.
    const state = readStackState(h.paths)!;
    const apiUrl = `http://127.0.0.1:${state.apiPort}`;
    const operatorToken = readFileSync(h.paths.tokenFiles.operator, "utf8").trim();
    const seated = [await seat(apiUrl, operatorToken, "Athena Runtime"), await seat(apiUrl, operatorToken, "Boreas Runtime")];
    const judge = await seat(apiUrl, operatorToken, "Themis Runtime", "judge");
    const credentialPath = join(h.root, `credential-${h.instance}-live.json`);
    writeFileSync(
      credentialPath,
      JSON.stringify({ agents: Object.fromEntries(seated.map((s) => [s.handle, s.entry])), judges: { [judge.handle]: judge.entry } }, null, 2),
      { mode: 0o600 },
    );

    // Boot 2: the same instance's data, with the file: the participants start.
    const second = spawnBoot(h, ["--credentials", credentialPath], { local: "volume", migrate: false, env: BOOT_ENV });
    const secondCode = await second.exited;
    if (secondCode !== 0) throw new Error(`the boot with the credential file exited ${secondCode}:\n${bootFailureReport(second)}`);
    const running = listRunningParticipants(h.project, docker);
    const expectedTags = [...seated.map((s) => `agent:${s.handle}`), `judge:${judge.handle}`].sort();
    expect(running.map((p) => `${p.kind}:${p.name}`).sort()).toEqual(expectedTags);
    // The receipt records the reconciled participants (criterion 10's piece).
    expect((readReceipt(h.paths)?.participants ?? []).map((p) => `${p.kind}:${p.name}:${p.action}`).sort())
      .toEqual(expectedTags.map((t) => `${t}:started`).sort());

    // They are healthy standing participants: authenticated, polling, not crash-looping.
    const participantIdentity = () =>
      Object.fromEntries(Object.entries(containerIdentity(h.project)).filter(([service]) => service.startsWith("participant-")));
    await Bun.sleep(15_000);
    const before = participantIdentity();
    expect(Object.keys(before).sort()).toEqual([...seated.map((s) => `participant-agent-${s.handle}`), `participant-judge-${judge.handle}`].sort());
    // The JUDGE is a participant over HTTP (criteria 103, 123): its container
    // passed the HTTP diagnostic with its own bearer and opened the judge
    // subscription on the API; the agents are polling.
    const logsOf = (container: string) => { const r = docker(["logs", container]); return `${r.stdout}${r.stderr}`; };
    const judgeContainer = running.find((p) => p.kind === "judge")!.containerName;
    expect(logsOf(judgeContainer)).toContain(`[judge:${judge.handle}] subscribed`);
    for (const [service, c] of Object.entries(before)) expect(`${service}:${c.state}`).toBe(`${service}:running`);
    const restarts = docker(["inspect", "--format", "{{.RestartCount}}", ...running.map((p) => p.containerName)]).stdout.trim().split("\n");
    expect(restarts.every((n) => n === "0")).toBe(true);
    const everythingBefore = containerIdentity(h.project);

    // The configured file disappears.
    rmSync(credentialPath);
    const third = spawnBoot(h, ["--credentials", credentialPath], { local: "volume", migrate: false, env: BOOT_ENV });
    const thirdCode = await third.exited;
    const out = third.output();
    expect(thirdCode).toBe(1);
    expect(out).toContain(`credential file ${credentialPath} does not exist`);
    expect(out).toContain("a missing file is never an instruction to stop participants");
    expect(out).toContain("(path set by --credentials)");
    // It refused before its plan: nothing of the deployment began.
    expect(out).not.toContain("phase: plan");

    // Every participant keeps its container and its start time, and runs.
    const after = participantIdentity();
    expect(after).toEqual(before);
    // …and so does every other container of the instance: the refusal touched nothing.
    expect(containerIdentity(h.project)).toEqual(everythingBefore);
  }, BOOT_TIMEOUT_MS * 3);
});
