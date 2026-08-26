// Container telemetry: the readings, the selection, and the pane.
//
// The behaviour under test is "a crashing lane becomes visible without
// `docker compose logs`". Every service carries `restart: unless-stopped`, so
// Docker restarts on its own exponential backoff and the old Startup pane went
// on showing the green tick the boot had earned minutes earlier.
import { describe, expect, test } from "bun:test";
import {
  isTroubled,
  parseTelemetry,
  renderTelemetryPane,
  sampleTelemetry,
  selectContainerErrors,
  telemetryDetail,
  TELEMETRY_FORMAT,
  type ContainerTelemetry,
} from "../../lib/smoke-telemetry.ts";

const STRIP_ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(STRIP_ANSI, "");

const healthy: ContainerTelemetry = {
  service: "api", running: true, restarts: 0, exitCode: 0, oomKilled: false, health: "healthy",
};

describe("parseTelemetry", () => {
  test("reads a docker inspect sweep into typed readings", () => {
    const out = parseTelemetry(
      [
        "api|true|0|0|false|healthy",
        "worker-swarm|false|7|1|false|none",
        "worker-analytics|true|2|0|true|unhealthy",
      ].join("\n"),
    );
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({
      service: "worker-swarm", running: false, restarts: 7, exitCode: 1, oomKilled: false, health: "none",
    });
    expect(out[2]!.oomKilled).toBe(true);
    expect(out[2]!.health).toBe("unhealthy");
  });

  test("skips malformed lines instead of throwing — this runs on a timer", () => {
    const out = parseTelemetry("api|true|0|0|false|healthy\ngarbage\n\n|||||\napi2|true|x|0|false|none");
    expect(out.map((t) => t.service)).toEqual(["api"]);
  });

  test("an unrecognised health string degrades to none, never undefined", () => {
    expect(parseTelemetry("api|true|0|0|false|weird")[0]!.health).toBe("none");
  });

  test("the format string asks for the compose service label, not the container name", () => {
    // Container names carry the project prefix and a replica suffix; the label
    // is what the Startup pane's tiles are keyed by.
    expect(TELEMETRY_FORMAT).toContain("com.docker.compose.service");
  });
});

describe("telemetryDetail — says something only when something is wrong", () => {
  test("a clean container reports nothing, so anything shown is a real signal", () => {
    expect(telemetryDetail(healthy)).toBeUndefined();
    expect(isTroubled(healthy)).toBe(false);
  });

  test("restarts are reported even once the container is up again", () => {
    // A lane that crashed five times and recovered is NOT the same as one that
    // never crashed; the pre-telemetry display could not tell them apart.
    const t = { ...healthy, restarts: 5 };
    expect(telemetryDetail(t)).toContain("5×restarted");
    expect(isTroubled(t)).toBe(true);
  });

  test("a non-zero exit is reported only once the container is actually down", () => {
    expect(telemetryDetail({ ...healthy, running: false, exitCode: 137 })).toContain("exit 137");
    // Still running: last exit code is stale history, not the current state.
    expect(telemetryDetail({ ...healthy, running: true, exitCode: 137 })).toBeUndefined();
  });

  test("an OOM kill is called by name — it looks like an ordinary crash otherwise", () => {
    expect(telemetryDetail({ ...healthy, oomKilled: true })).toContain("OOM-KILLED");
  });

  test("unhealthy counts as trouble; still-starting is reported but not alarming", () => {
    expect(isTroubled({ ...healthy, health: "unhealthy" })).toBe(true);
    expect(telemetryDetail({ ...healthy, health: "starting" })).toContain("health starting");
  });
});

describe("selectContainerErrors", () => {
  const LOGS = [
    "api-1  | GET /api/swarm/sessions 200",
    "worker-swarm-1  | error: connection refused reaching postgres:5432",
    "api-1  | GET /health 200",
    "worker-swarm-1  | Unhandled exception in lane swarm",
  ].join("\n");

  test("keeps the failure lines and drops routine traffic", () => {
    const picked = selectContainerErrors(LOGS);
    expect(picked).toHaveLength(2);
    expect(picked.every((p) => !p.text.includes("200"))).toBe(true);
  });

  test("attributes each line to its lane, with the replica suffix stripped", () => {
    expect(selectContainerErrors(LOGS)[0]!.service).toBe("worker-swarm");
  });

  test("caps the excerpt and keeps the NEWEST, which is the one still happening", () => {
    const many = Array.from({ length: 40 }, (_, i) => `api-1  | error number ${i}`).join("\n");
    const picked = selectContainerErrors(many, 3);
    expect(picked).toHaveLength(3);
    expect(picked.at(-1)!.text).toContain("39");
  });

  test("logs with no failures yield nothing", () => {
    expect(selectContainerErrors("api-1  | GET / 200")).toEqual([]);
  });
});

describe("sampleTelemetry", () => {
  test("lists ids, then inspects them", () => {
    const seen: string[][] = [];
    const out = sampleTelemetry((argv) => {
      seen.push([...argv]);
      if (argv.includes("ps")) return "abc123\ndef456\n";
      return "api|true|0|0|false|healthy\nworker-swarm|true|0|0|false|none";
    });
    expect(out.samples).toHaveLength(2);
    expect(seen[0]).toContain("ps");
    expect(seen[1]![0]).toBe("inspect");
    expect(seen[1]).toContain("abc123");
  });

  test("an empty project inspects nothing — `docker inspect` with no ids is an error", () => {
    const seen: string[][] = [];
    const out = sampleTelemetry((argv) => { seen.push([...argv]); return ""; });
    expect(out).toEqual({ samples: [], errors: [] });
    expect(seen).toHaveLength(1);
  });

  test("logs are only fetched when a reading is actually troubled", () => {
    const calls: string[][] = [];
    sampleTelemetry((argv) => {
      calls.push([...argv]);
      if (argv.includes("ps")) return "abc123";
      if (argv[0] === "inspect") return "api|true|0|0|false|healthy";
      return "";
    });
    expect(calls.some((c) => c.includes("logs"))).toBe(false);
  });

  test("a docker failure degrades to no sample rather than taking the boot down", () => {
    expect(sampleTelemetry(() => { throw new Error("docker daemon gone"); })).toEqual({ samples: [], errors: [] });
  });
});

describe("renderTelemetryPane", () => {
  test("renders nothing at all when every container is clean", () => {
    expect(renderTelemetryPane([healthy], [], 100)).toEqual([]);
  });

  test("shows the troubled lane, its detail, and the error line behind it", () => {
    const pane = renderTelemetryPane(
      [healthy, { ...healthy, service: "worker-swarm", running: false, restarts: 4, exitCode: 1, health: "none" }],
      [{ service: "worker-swarm", text: "error: connection refused" }],
      100,
    ).map(plain).join("\n");

    expect(pane).toContain("Containers");
    expect(pane).toContain("worker-swarm");
    expect(pane).toContain("4×restarted");
    expect(pane).toContain("exit 1");
    expect(pane).toContain("connection refused");
    expect(pane).not.toContain(" api "); // the clean lane stays out of it
  });

  test("never emits a line wider than the terminal", () => {
    const pane = renderTelemetryPane(
      [{ ...healthy, service: "worker-analytics", restarts: 12, oomKilled: true }],
      [{ service: "worker-analytics", text: "x".repeat(300) }],
      40,
    );
    for (const line of pane) expect(plain(line).length).toBeLessThanOrEqual(40);
  });
});
