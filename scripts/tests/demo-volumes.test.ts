// Unit tests for the demo-volume clean library (scripts/lib/demo-volumes.ts) —
// the label-based discovery + deletion logic that `bun run demo:clean` and the CI
// teardown share. These use an INJECTED fake docker runner against synthetic
// `docker volume` fixtures (no daemon), so they run fast and deterministically and
// still prove the exact filter args, label scoping, and in-use skip behavior.
// (The real docker round-trip — label actually lands, down keeps the volume — is
// proven separately in demo-volume-lifecycle.test.ts, which boots postgres.)
import { describe, expect, test } from "bun:test";
import {
  DEMO_VOLUME_LABEL,
  DEMO_VOLUME_PROJECT_LABEL,
  listDemoVolumes,
  parseVolumeLine,
  removeDemoVolumes,
  type DockerRunResult,
  type DockerRunner,
} from "../lib/demo-volumes.ts";

// A fixture line as `docker volume ls --format json` emits it (Labels is a flat
// comma-joined k=v string).
function volLine(name: string, labels: Record<string, string>): string {
  const Labels = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(",");
  return JSON.stringify({ Name: name, Labels, Driver: "local", Scope: "local" });
}

// Build a fake runner that records every argv it received and answers `volume ls`
// from a fixture set and `volume rm <name>` from an in-use set.
function fakeRunner(opts: {
  volumes: string[];
  inUse?: Set<string>;
  lsExit?: number;
}): { run: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: DockerRunner = (args) => {
    calls.push(args);
    if (args[0] === "volume" && args[1] === "ls") {
      const exitCode = opts.lsExit ?? 0;
      return { exitCode, stdout: exitCode === 0 ? opts.volumes.join("\n") + "\n" : "", stderr: exitCode === 0 ? "" : "daemon down" } satisfies DockerRunResult;
    }
    if (args[0] === "volume" && args[1] === "rm") {
      const name = args[2];
      if (opts.inUse?.has(name)) {
        return { exitCode: 1, stdout: "", stderr: `Error response from daemon: remove ${name}: volume is in use - [abc123]` };
      }
      return { exitCode: 0, stdout: `${name}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

describe("parseVolumeLine", () => {
  test("pulls name + the project label out of the flat Labels string", () => {
    const v = parseVolumeLine(volLine("rmdemo_ab12_pgdata", { "robotmoney.demo": "1", "robotmoney.demo.project": "rmdemo_ab12" }));
    expect(v).toEqual({ name: "rmdemo_ab12_pgdata", project: "rmdemo_ab12" });
  });
  test("project is null when the project label is absent", () => {
    const v = parseVolumeLine(volLine("x", { "robotmoney.demo": "1" }));
    expect(v).toEqual({ name: "x", project: null });
  });
  test("blank lines are ignored", () => {
    expect(parseVolumeLine("   ")).toBeNull();
  });
});

describe("listDemoVolumes", () => {
  test("filters by the robotmoney.demo=1 label and parses every row", () => {
    const { run, calls } = fakeRunner({
      volumes: [
        volLine("rmdemo_a_pgdata", { "robotmoney.demo": "1", "robotmoney.demo.project": "rmdemo_a" }),
        volLine("rmdemo_b_pgdata", { "robotmoney.demo": "1", "robotmoney.demo.project": "rmdemo_b" }),
      ],
    });
    const vols = listDemoVolumes(run);
    expect(vols.map((v) => v.name)).toEqual(["rmdemo_a_pgdata", "rmdemo_b_pgdata"]);
    // The label filter is what makes this "ours only" — assert it is actually passed.
    expect(calls[0]).toContain("--filter");
    expect(calls[0]).toContain(`label=${DEMO_VOLUME_LABEL}`);
  });

  test("scoping to a project adds the project label filter (CI reclaims only its own run)", () => {
    const { run, calls } = fakeRunner({ volumes: [volLine("rmdemo_ci_1_pgdata", { "robotmoney.demo": "1", "robotmoney.demo.project": "rmdemo_ci_1" })] });
    const vols = listDemoVolumes(run, { project: "rmdemo_ci_1" });
    expect(vols).toHaveLength(1);
    expect(calls[0]).toContain(`label=${DEMO_VOLUME_PROJECT_LABEL}=rmdemo_ci_1`);
  });

  test("a docker/daemon failure throws loudly — never a silent empty list", () => {
    const { run } = fakeRunner({ volumes: [], lsExit: 1 });
    expect(() => listDemoVolumes(run)).toThrow(/docker volume ls failed/);
  });

  test("no demo volumes → empty list (clean exit for callers)", () => {
    const { run } = fakeRunner({ volumes: [] });
    expect(listDemoVolumes(run)).toEqual([]);
  });
});

describe("removeDemoVolumes", () => {
  test("removes free volumes and LOUDLY skips in-use ones (never force-removes)", () => {
    const { run, calls } = fakeRunner({
      volumes: [],
      inUse: new Set(["rmdemo_busy_pgdata"]),
    });
    const res = removeDemoVolumes(run, ["rmdemo_free_pgdata", "rmdemo_busy_pgdata"]);
    expect(res.removed).toEqual(["rmdemo_free_pgdata"]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].name).toBe("rmdemo_busy_pgdata");
    expect(res.skipped[0].reason).toMatch(/in use/i);
    // Never a `-f`: an in-use volume is reported, not forced.
    for (const c of calls) expect(c).not.toContain("-f");
  });

  test("one in-use volume never aborts the rest", () => {
    const { run } = fakeRunner({ volumes: [], inUse: new Set(["b"]) });
    const res = removeDemoVolumes(run, ["a", "b", "c"]);
    expect(res.removed).toEqual(["a", "c"]);
    expect(res.skipped.map((s) => s.name)).toEqual(["b"]);
  });
});
