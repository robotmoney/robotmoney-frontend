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
