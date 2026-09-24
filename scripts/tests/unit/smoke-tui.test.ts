// Unit specification for scripts/smoke-tui.ts — the standalone, READ-ONLY
// observer of docs/technical/smoke-production-spec.md §1: "`bun smoke:status`
// and `bun smoke:tui` observe a running stack from another terminal;
// `bun smoke` never draws a TUI".
//
// TDD RED PHASE (issue #1026, W1 step 2). Every function under test currently
// throws `NOT IMPLEMENTED`; every test here fails today by design.
//
// THE PROPERTY UNDER TEST IS THAT WATCHING IS NOT OWNING. The observer must not
// mint an instance, must not persist a name, must not take the deployment lock
// and must not write anything under the state directory — so the selection tests
// below assert on the FILESYSTEM after each call, not only on the return value.
// A selector that fell through to `smoke-state.ts`'s last two precedence rules
// would create state for a deployment that does not exist, and would quietly
// watch a different deployment than the operator meant.
//
// Acceptance gates served (spec §10, W1): "Sessions and participants survive the
// invoking terminal's exit" (this command is how that is observed without
// re-acquiring the deployment) and "Receipt read by `smoke:status`", whose
// reading path — receipt when present, journal when not (§1.4) — this shares.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instancePaths, type InstancePaths } from "./../../lib/smoke-state.ts";
import {
  computePlanId,
  openJournal,
  writeReceipt,
  type DeploymentPlan,
  type Receipt,
  type StateExpectations,
} from "./../../lib/smoke-journal.ts";
import { observe, parseTuiArgs, renderFrame, resolveObservedInstance, type ObservedStack } from "./../../smoke-tui.ts";

const DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "rm-smoke-tui-"));
}

const SOURCE = "1111111111111111111111111111111111111111";

const plan: DeploymentPlan = {
  instance: "alpha",
  target: { kind: "remote", rmEnv: "stage", identity: "rehearsal", host: "db.example.invalid", port: 25060, dbname: "robotmoney" },
  images: { api: { source: SOURCE, digest: DIGEST } },
  roster: {
    agents: [{ name: "athena", role: "member", keyFingerprint: "fp:0000000000000001" }],
    judges: [{ name: "themis", role: "judge", keyFingerprint: "fp:0000000000000002" }],
  },
  configuration: {},
  mutations: [],
};

const expectations: StateExpectations = {
  ledger: ["0054_rm_worker_allowlist.sql"],
  manifestHash: "manifest-aaa",
  identity: "rehearsal",
  participants: ["athena"],
  services: { api: DIGEST },
  spoofGeneration: null,
};

describe("parseTuiArgs — §1, the retired spellings have no alias", () => {
  test("bare argv yields a watch of the host's instance with a redraw interval and no one-shot", () => {
    const options = parseTuiArgs([]);
    expect(options.instance).toBeUndefined();
    expect(options.once).toBe(false);
    expect(options.intervalMs).toBeGreaterThanOrEqual(1000);
  });

  test("`--instance <name>` selects the instance to watch", () => {
    expect(parseTuiArgs(["--instance", "alpha"]).instance).toBe("alpha");
  });

  test("`--once` renders a single frame, for a non-interactive terminal or a CI log", () => {
    expect(parseTuiArgs(["--once"]).once).toBe(true);
  });

  test("`--interval` sets the redraw interval in milliseconds", () => {
    expect(parseTuiArgs(["--interval", "2000"]).intervalMs).toBe(2000);
  });

  test("an unknown flag refuses, naming it", () => {
    expect(() => parseTuiArgs(["--follow"])).toThrow(/--follow/);
  });

  test("the retired `--no-tui` refuses and points at smoke:status, because the operator's intent is knowable", () => {
    expect(() => parseTuiArgs(["--no-tui"])).toThrow(/smoke:status/);
  });

  for (const retired of ["--agents", "--smoke", "--db", "--pg-data", "--twin"]) {
    test(`the retired ${retired} refuses rather than being silently ignored`, () => {
      expect(() => parseTuiArgs([retired])).toThrow(new RegExp(retired.replace(/-/g, "\\-")));
    });
  }

  test("a non-numeric interval refuses", () => {
    expect(() => parseTuiArgs(["--interval", "soon"])).toThrow(/interval/i);
  });

  test("a sub-second interval refuses: it turns an observer into a load source on the host it observes", () => {
    expect(() => parseTuiArgs(["--interval", "100"])).toThrow(/interval/i);
  });

  test("there is no flag that could stop or restart anything — `--down` is unknown", () => {
    expect(() => parseTuiArgs(["--down"])).toThrow(/--down/);
  });
});

describe("resolveObservedInstance — §1.1, the observer selects; it never mints", () => {
  function available(root: string, names: readonly string[]): { name: string; paths: InstancePaths }[] {
    return names.map((name) => ({ name, paths: instancePaths(root, name, { create: true }) }));
  }

  test("a single instance with state on the host is selected without an `--instance` argument", () => {
    const root = freshRoot();
    const entries = available(root, ["alpha"]);
    expect(resolveObservedInstance(undefined, entries).dir).toBe(entries[0]!.paths.dir);
  });

  test("`--instance` selects the named instance when several have state", () => {
    const root = freshRoot();
    const entries = available(root, ["alpha", "beta"]);
    expect(resolveObservedInstance("beta", entries).dir).toBe(entries[1]!.paths.dir);
  });

  test("no instance with state refuses, rather than drawing an empty screen that reads like a dead stack", () => {
    expect(() => resolveObservedInstance(undefined, [])).toThrow(/no instance|nothing has been deployed/i);
  });

  test("refusing on an empty host mints NOTHING: no directory, no persisted name, no lock", () => {
    const root = freshRoot();
    expect(() => resolveObservedInstance(undefined, [])).toThrow(/nothing has been deployed|no instance/i);
    expect(readdirSync(root)).toEqual([]);
  });

  test("an `--instance` naming an unknown instance refuses and lists the names that do exist", () => {
    const root = freshRoot();
    const entries = available(root, ["alpha", "beta"]);
    let message = "";
    try {
      resolveObservedInstance("gamma", entries);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("gamma");
    expect(message).toContain("alpha");
    expect(message).toContain("beta");
  });

  test("an unknown `--instance` does not create it — an observer never creates state for a deployment that does not exist", () => {
    const root = freshRoot();
    const entries = available(root, ["alpha"]);
    try {
      resolveObservedInstance("gamma", entries);
    } catch {
      /* expected */
    }
    expect(readdirSync(root).sort()).toEqual(["alpha"]);
    expect(entries.length).toBe(1);
  });

  test("an omitted `--instance` with several instances refuses and lists them — guessing watches CI while production burns", () => {
    const root = freshRoot();
    const entries = available(root, ["alpha", "beta"]);
    let message = "";
    try {
      resolveObservedInstance(undefined, entries);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("alpha");
    expect(message).toContain("beta");
  });
});

describe("observe — §1.4, receipt when present, journal when not", () => {
  test("a run that has not reached readiness is observed from the journal, labelled in progress", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "alpha", { create: true });
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan);
    await writer.beginPhase("preflight", null, expectations);

    const frame = await observe(paths);
    expect(frame.source).toBe("journal");
    expect(frame.instance).toBe("alpha");
    expect(frame.phase).toBe("preflight");
  });

  test("a run that wrote a receipt is observed from the receipt", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "alpha", { create: true });
    openJournal(paths, { kind: "fresh-start", reason: "none" }, plan);
    const receipt: Receipt = {
      planId: computePlanId(plan),
      plan,
      instance: "alpha",
      writtenAt: "2026-09-23T10:00:00.000Z",
      images: { api: DIGEST },
      schema: { manifestHash: "manifest-aaa", migrations: ["0054_rm_worker_allowlist.sql"] },
      preflight: [{ check: "roles authenticate", pass: true, detail: "4/4" }],
      readiness: [{ check: "enabled schedules advanced", pass: true, detail: "5/5" }],
    };
    await writeReceipt(paths, receipt);

    const frame = await observe(paths);
    expect(frame.source).toBe("receipt");
  });

  test("observing writes nothing under the instance's state directory", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "alpha", { create: true });
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan);
    await writer.beginPhase("preflight", null, expectations);
    const before = readdirSync(paths.dir).sort();

    await observe(paths);
    await observe(paths);

    expect(readdirSync(paths.dir).sort()).toEqual(before);
  });

  test("observing never takes the deployment lock — a live run must stay lockable alongside an observer", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "alpha", { create: true });
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan);
    await writer.beginPhase("preflight", null, expectations);

    await observe(paths);
    const { acquireDeploymentLock } = await import("./../../lib/smoke-state.ts");
    const lock = acquireDeploymentLock(paths, computePlanId(plan));
    expect(lock.holderPid).toBe(process.pid);
    lock.release();
  });

  test("a live deployment lock is reported as a run in progress", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "alpha", { create: true });
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan);
    await writer.beginPhase("preflight", null, expectations);

    const { acquireDeploymentLock } = await import("./../../lib/smoke-state.ts");
    const lock = acquireDeploymentLock(paths, computePlanId(plan));
    try {
      const frame = await observe(paths);
      expect(frame.runInProgress).toBe(true);
    } finally {
      lock.release();
    }
  });

  test("a malformed journal propagates the refusal instead of rendering a blank screen", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "alpha", { create: true });
    writeFileSync(paths.journalFile, "{ truncated");
    await expect(observe(paths)).rejects.toThrow(/journal|malformed|parse/i);
  });

  test("docker being unreachable is a note in the frame, not a throw — the journal is still worth showing", async () => {
    const root = freshRoot();
    const paths = instancePaths(root, "alpha", { create: true });
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan);
    await writer.beginPhase("preflight", null, expectations);

    const frame = await observe(paths);
    expect(Array.isArray(frame.notes)).toBe(true);
    expect(frame.phase).toBe("preflight");
  });
});

describe("renderFrame — §1, the source label and the redaction promise", () => {
  const frame: ObservedStack = {
    instance: "alpha",
    source: "journal",
    phase: "replace",
    runInProgress: true,
    services: [
      { name: "api", state: "running", version: "new" },
      { name: "worker", state: "running", version: "old" },
    ],
    participants: [{ name: "athena", kind: "agent", state: "running" }],
    notes: ["lock held by pid 4242"],
  };

  test("a journal-sourced frame is labelled as in progress, unmissably", () => {
    expect(renderFrame(frame, 100).toLowerCase()).toContain("journal");
  });

  test("a receipt-sourced frame is labelled as finished, so nobody has to guess whether it is happening now", () => {
    expect(renderFrame({ ...frame, source: "receipt", runInProgress: false }, 100).toLowerCase()).toContain("receipt");
  });

  test("services are reported as new versus old, which §1.4 requires after replacement began", () => {
    const text = renderFrame(frame, 100);
    expect(text).toContain("api");
    expect(text).toContain("worker");
    expect(text.toLowerCase()).toContain("new");
    expect(text.toLowerCase()).toContain("old");
  });

  test("participants are reported without being touched", () => {
    expect(renderFrame(frame, 100)).toContain("athena");
  });

  test("the frame is redacted: it is a screenshot an operator pastes into an incident thread", () => {
    const leaky: ObservedStack = { ...frame, notes: ["postgres://rm_app:hunter2@db.example.invalid/robotmoney"] };
    expect(renderFrame(leaky, 100)).not.toContain("hunter2");
  });

  test("rendering is deterministic for one snapshot, so the `--once` capture and the redraw cannot disagree", () => {
    expect(renderFrame(frame, 100)).toBe(renderFrame(frame, 100));
  });

  test("no line exceeds the width it was given", () => {
    for (const line of renderFrame(frame, 60).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });
});
