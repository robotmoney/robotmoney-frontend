// EXECUTED coverage of the rolling replace in scripts/stack/stack.ts `up()`
// (owner, 2026-10-14: the website never goes down; every release, stage and
// prod, is a rolling upgrade). A fake StackRuntime records every docker call;
// the sequencing asserted below is the real `up()`.
import { describe, expect, test } from "bun:test";
import { createStack, dryRunRecreates, parseConfigHash, rollingReplaceOrder, WEBSITE_NGINX_CONF, type StackRuntime } from "../../stack/stack.ts";
import { API_CONTAINER_PORT, type StackConfig } from "../../stack/config.ts";

const config: StackConfig = {
  repoRoot: "/nonexistent-by-design",
  project: "stack_rolling_test",
  profile: "core",
  composeFiles: ["docker-compose.yml"],
  database: { user: "u", password: "p", name: "d" },
  environment: { class: "ci", hash: "0123456789" },
};

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** A runtime where website-server runs (or not), compose's dry run answers `dryRun`, and the config hashes are given. */
function runtime(calls: string[], opts: { websiteRunning: boolean; dryRun: string; wantHash?: string; haveHash?: string; nginxTest?: number }): StackRuntime {
  return {
    runSync(argv) {
      const line = argv.join(" ");
      if (argv.includes("port")) {
        return { exitCode: 0, stdout: `0.0.0.0:${argv.includes(String(API_CONTAINER_PORT)) ? "40001" : "40002"}\n`, stderr: "" };
      }
      if (line.includes("ps -q --status running website-server")) return { exitCode: 0, stdout: opts.websiteRunning ? "abc123\n" : "", stderr: "" };
      if (line.includes("--dry-run")) {
        calls.push(`dry-run ${line.slice(line.indexOf(" up "))}`);
        return { exitCode: 0, stdout: "", stderr: opts.dryRun };
      }
      if (line.includes("config --hash website-server")) return { exitCode: 0, stdout: `website-server ${opts.wantHash ?? HASH_A}\n`, stderr: "" };
      if (argv[0] === "docker" && argv[1] === "inspect") return { exitCode: 0, stdout: `${opts.haveHash ?? HASH_A}\n`, stderr: "" };
      if (line.includes(" exec ") || line.includes(" cp ")) {
        calls.push(line.slice(line.search(/ (exec|cp) /) + 1));
        if (line.endsWith("nginx -t")) return { exitCode: opts.nginxTest ?? 0, stdout: "", stderr: opts.nginxTest ? "emerg" : "ok" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async run(argv) {
      const line = argv.join(" ");
      if (line.includes(" up ")) calls.push(line.slice(line.indexOf(" up ") + 1));
      return { exitCode: 0, outputTail: "" };
    },
    async probe() {
      return { ok: true, detail: "ok" };
    },
  };
}

const ups = (calls: readonly string[]) => calls.filter((c) => c.startsWith("up "));

describe("a rolling boot over a running website-server", () => {
  test("replaces the api alone, waits for it, and never brings website-server up", async () => {
    const calls: string[] = [];
    await createStack(config, { runtime: runtime(calls, { websiteRunning: true, dryRun: " DRY-RUN MODE -  Container x-website-server-1  Running\n" }) }).up({ rolling: true });
    const services = ups(calls).filter((c) => !c.includes("postgres"));
    expect(services).toEqual(["up -d --wait --wait-timeout 300 api --no-deps"]);
    expect(services.some((c) => c.includes("website-server"))).toBe(false);
    expect(calls.some((c) => c.startsWith("dry-run") && c.includes("website-server"))).toBe(true);
  });

  const recreate = " DRY-RUN MODE -  Container x-website-server-1  Recreate\n DRY-RUN MODE -  Container x-website-server-1  Recreated\n";

  test("an image-only website-server change (nginx.conf) ships by graceful reload, then the api is replaced; never a recreate", async () => {
    const calls: string[] = [];
    await createStack(config, { runtime: runtime(calls, { websiteRunning: true, dryRun: recreate }) }).up({ rolling: true });
    const { target } = WEBSITE_NGINX_CONF;
    const reload = calls.filter((c) => c.includes("website-server") && (c.startsWith("exec") || c.startsWith("cp")));
    expect(reload).toEqual([
      `exec -T website-server cp ${target} ${target}.prev`,
      `cp ${config.repoRoot}/website-server/nginx.conf website-server:${target}`,
      "exec -T website-server nginx -t",
      "exec -T website-server nginx -s reload",
    ]);
    expect(ups(calls).filter((c) => !c.includes("postgres"))).toEqual(["up -d --wait --wait-timeout 300 api --no-deps"]);
  });

  test("refuses before replacing anything when website-server's compose configuration changed", async () => {
    const calls: string[] = [];
    const boot = createStack(config, { runtime: runtime(calls, { websiteRunning: true, dryRun: recreate, haveHash: HASH_B }) }).up({ rolling: true });
    await expect(boot).rejects.toThrow("website-server's compose configuration changed");
    expect(ups(calls).filter((c) => !c.includes("postgres"))).toEqual([]);
    expect(calls.some((c) => c.startsWith("cp"))).toBe(false);
  });

  test("a new nginx.conf that fails nginx -t is put back, nothing reloads, and the boot refuses before the api", async () => {
    const calls: string[] = [];
    const boot = createStack(config, { runtime: runtime(calls, { websiteRunning: true, dryRun: recreate, nginxTest: 1 }) }).up({ rolling: true });
    await expect(boot).rejects.toThrow("fails nginx -t");
    const { target } = WEBSITE_NGINX_CONF;
    expect(calls).toContain(`exec -T website-server cp ${target}.prev ${target}`);
    expect(calls.some((c) => c.includes("nginx -s reload"))).toBe(false);
    expect(ups(calls).filter((c) => !c.includes("postgres"))).toEqual([]);
  });
});

describe("the non-rolling paths are unchanged", () => {
  test("rolling with no website-server running starts the services together", async () => {
    const calls: string[] = [];
    await createStack(config, { runtime: runtime(calls, { websiteRunning: false, dryRun: "" }) }).up({ rolling: true });
    expect(ups(calls).filter((c) => !c.includes("postgres"))).toEqual(["up -d api website-server"]);
    expect(calls.some((c) => c.startsWith("dry-run"))).toBe(false);
  });

  test("a boot without rolling starts the services together even over a running site", async () => {
    const calls: string[] = [];
    await createStack(config, { runtime: runtime(calls, { websiteRunning: true, dryRun: "" }) }).up();
    expect(ups(calls).filter((c) => !c.includes("postgres"))).toEqual(["up -d api website-server"]);
  });
});

describe("the pure helpers", () => {
  test("the order is api, the lanes, the clock, the producer; never website-server or postgres", () => {
    expect(rollingReplaceOrder(["postgres", "website-server", "system-scheduler", "worker-analytics", "api", "analytics-producer"]))
      .toEqual(["api", "worker-analytics", "system-scheduler", "analytics-producer"]);
    expect(rollingReplaceOrder(["website-server", "extra", "api"])).toEqual(["api", "extra"]);
  });

  test("the config hash is read for the named service only", () => {
    expect(parseConfigHash(`api ${HASH_B}\nwebsite-server ${HASH_A}\n`, "website-server")).toBe(HASH_A);
    expect(parseConfigHash(`api ${HASH_B}\n`, "website-server")).toBeUndefined();
    expect(parseConfigHash("website-server nothex", "website-server")).toBeUndefined();
  });

  test("a dry run that recreates or creates is caught; one that keeps the container is not", () => {
    expect(dryRunRecreates(" DRY-RUN MODE -  Container rm-website-server-1  Recreate")).toBe(true);
    expect(dryRunRecreates(" DRY-RUN MODE -  Container rm-website-server-1  Create")).toBe(true);
    expect(dryRunRecreates(" DRY-RUN MODE -  Container rm-website-server-1  Running")).toBe(false);
    expect(dryRunRecreates(" DRY-RUN MODE -  Container rm-website-server-1  Recreated")).toBe(false);
  });
});

// Issue 1378: the compose model a start or a rolling boot runs on.
//
// Pure parsing (Bun.YAML resolves the anchors and merge keys), so it runs in
// the unit job, which has no Docker. The rolling boot refuses when
// website-server would be recreated, so its block is pinned whole: any change
// to it changes `docker compose config --hash website-server` and fails here
// first. The hash itself (fad32a67… plain, c93432f5… with the stage overlay,
// dummy RM_INSTANCE and RM_INSTANCE_STATE_DIR) was checked unchanged by hand
// when this test was added.
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

type Service = {
  init?: boolean;
  stop_grace_period?: string;
  depends_on?: string[] | Record<string, { condition?: string }>;
} & Record<string, unknown>;

async function services(): Promise<Record<string, Service>> {
  const text = await Bun.file(join(repoRoot, "docker-compose.yml")).text();
  return (Bun.YAML.parse(text) as { services: Record<string, Service> }).services;
}

function seconds(duration: string | undefined): number {
  const m = /^(\d+)s$/.exec(duration ?? "");
  if (!m) throw new Error(`unparsed stop_grace_period: ${duration}`);
  return Number(m[1]);
}

test("worker-analytics waits for a healthy api and outlasts its 30 s release window on stop", async () => {
  const w = (await services())["worker-analytics"]!;
  // The worker holds no database credential (issue 1034, D75): it waits for the
  // api alone, and never for postgres directly.
  expect(w.depends_on).toEqual({ api: { condition: "service_healthy" } });
  expect(seconds(w.stop_grace_period)).toBeGreaterThan(30);
});

test("the four bun services run under an init and carry a stop grace period", async () => {
  const s = await services();
  for (const name of ["api", "worker-analytics", "system-scheduler", "analytics-producer"]) {
    expect({ name, init: s[name]!.init }).toEqual({ name, init: true });
    expect(seconds(s[name]!.stop_grace_period)).toBeGreaterThan(10);
  }
});

test("website-server's compose block is unchanged, so a rolling boot never recreates it", async () => {
  const ws = (await services())["website-server"];
  expect(ws).toEqual({
    build: { context: "./website-server", dockerfile: "Dockerfile" },
    labels: {
      "robotmoney.env.hash": "${RM_STACK_ENV_HASH:-}",
      "robotmoney.env": "${RM_STACK_ENV_CLASS:-}",
      "robotmoney.smoke.project": "${SMOKE_PROJECT:-}",
      "robotmoney.instance": "${RM_INSTANCE:?RM_INSTANCE is required; bun smoke sets it from the resolved instance}",
    },
    volumes: [
      "${RM_INSTANCE_STATE_DIR:?RM_INSTANCE_STATE_DIR is required; bun smoke sets it to the instance's state directory}/web:/srv/web:ro",
    ],
    ports: ["8080"],
    depends_on: ["api"],
    restart: "unless-stopped",
    logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
    healthcheck: {
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"],
      interval: "15s",
      timeout: "5s",
      retries: 3,
      start_period: "10s",
    },
  });
});
