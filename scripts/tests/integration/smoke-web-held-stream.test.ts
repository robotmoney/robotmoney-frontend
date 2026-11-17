// The first production rollout of the signed container (run 20261116T143356Z)
// stopped the old nginx container with `docker stop -t 10`. nginx's StopSignal
// is SIGQUIT: it closes its listeners at once and waits for every open
// connection. An external judge client held an event stream through it, so
// docker killed nginx at 10.0 s and the gap was 10938 ms against a 3000 ms
// limit. Stage never showed it: nothing there holds a connection.
//
// This test holds such a stream on real Docker (this machine), then retires
// the serving container two ways:
//
//   OLD logic  `docker stop -t 10` (the image's own StopSignal): the red
//              control. It must take at least 10 s, for nginx and for a Caddy
//              whose Caddyfile has no grace_period (the default is eternal).
//   NEW logic  retireArgs() (SIGTERM, forced stop after STOP_GRACE_SECONDS):
//              it must finish inside the bound, for nginx and for the shipped
//              Caddyfile, which sets grace_period 500ms so Caddy exits by itself
//              (exit code 0, not the 137 of docker's kill).
//
// LOUD, NEVER SKIPPED: Docker and ssh-keygen are hard dependencies.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deployImage, GAP_LIMIT_MS, readImageReceipt, retireArgs, rollbackImage, STOP_GRACE_SECONDS } from "../../lib/website-release.ts";
import { createImageHost, docker, waitServed, type ImageHost } from "./smoke-web-image-harness.ts";

const V0 = { version: "0.9.0", commit: "0000aaa" };
const CADDYFILE_IN_IMAGE = ["", "etc", "caddy", "Caddyfile"].join("/");

/** Hold an event stream through the host's public port until `close()`. Resolves once the response headers arrived (nginx buffers the body). */
async function holdStream(port: number): Promise<{ close(): void }> {
  const abort = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: abort.signal });
  if (!res.ok || res.body === null) throw new Error(`the stream answered ${res.status}`);
  const reader = res.body.getReader();
  // Keep reading in the background so the connection stays live, as a client does.
  void (async () => {
    try {
      for (;;) if ((await reader.read()).done) return;
    } catch {
      /* closed by the stop */
    }
  })();
  return { close: () => abort.abort() };
}

/** Run `docker <args>` and return how long it took, in ms. */
async function timed(args: string[]): Promise<number> {
  const at = Date.now();
  const p = Bun.spawn(["docker", ...args], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
  return Date.now() - at;
}

const exitCode = (id: string): number => Number(docker(["inspect", "--format", "{{.State.ExitCode}}", id]));

/** The retire bound plus what the docker CLI itself costs. */
const NEW_BOUND_MS = STOP_GRACE_SECONDS * 1000 + 1_000;

describe("nginx, the first rollout's old container", () => {
  let h: ImageHost;
  beforeAll(async () => {
    h = createImageHost("held-nginx", V0, { firstServer: "nginx" });
    await waitServed(h, V0);
  }, 600_000);
  afterAll(() => h?.dispose(), 120_000);

  test("RED CONTROL: `docker stop -t 10` with a held stream takes at least 10 s", async () => {
    const { id, port } = h.serving();
    const stream = await holdStream(port);
    const ms = await timed(["stop", "-t", "10", id]);
    stream.close();
    console.log(`smoke-web-held-stream nginx old logic: stop took ${ms} ms, exit code ${exitCode(id)}`);
    expect(ms).toBeGreaterThanOrEqual(10_000);
    expect(exitCode(id)).toBe(137);
  }, 60_000);

  test("retireArgs() with a held stream finishes inside the bound, well under the gap limit", async () => {
    const [id] = docker(["ps", "-aq", "--no-trunc", "--filter", `label=robotmoney.instance=${h.instance}`, "--filter", "label=com.docker.compose.service=website-server"]).split("\n");
    docker(["start", id!]);
    await waitServed(h, V0, 30_000);
    const stream = await holdStream(h.serving().port);
    const ms = await timed(retireArgs(id!));
    stream.close();
    console.log(`smoke-web-held-stream nginx new logic: stop took ${ms} ms, exit code ${exitCode(id!)}`);
    expect(ms).toBeLessThanOrEqual(NEW_BOUND_MS);
    expect(ms).toBeLessThan(GAP_LIMIT_MS);
  }, 60_000);
});

describe("Caddy, every later swap's old container", () => {
  const stripGrace = (text: string) => text.replace(/^\s*grace_period .*$/m, "");
  let before: ImageHost;
  let shipped: ImageHost;
  beforeAll(async () => {
    before = createImageHost("held-caddy-old", V0, { caddyfile: stripGrace });
    shipped = createImageHost("held-caddy", V0);
    await waitServed(before, V0);
    await waitServed(shipped, V0);
  }, 600_000);
  afterAll(() => {
    before?.dispose();
    shipped?.dispose();
  }, 120_000);

  test("the Caddyfile under test sets a grace period, and the control's does not", () => {
    expect(docker(["run", "--rm", "--entrypoint", "cat", before.serverImage, CADDYFILE_IN_IMAGE])).not.toMatch(/grace_period/);
    expect(docker(["run", "--rm", "--entrypoint", "cat", shipped.serverImage, CADDYFILE_IN_IMAGE])).toMatch(/^\s*grace_period 500ms$/m);
  });

  test("RED CONTROL: a Caddy with no grace_period, stopped with `docker stop -t 10` and a held stream, takes at least 10 s", async () => {
    const { id, port } = before.serving();
    const stream = await holdStream(port);
    const ms = await timed(["stop", "-t", "10", id]);
    stream.close();
    console.log(`smoke-web-held-stream caddy old logic: stop took ${ms} ms, exit code ${exitCode(id)}`);
    expect(ms).toBeGreaterThanOrEqual(10_000);
    expect(exitCode(id)).toBe(137);
  }, 60_000);

  test("the shipped Caddyfile with retireArgs() and a held stream exits by itself inside the bound", async () => {
    const { id, port } = shipped.serving();
    const stream = await holdStream(port);
    const ms = await timed(retireArgs(id));
    stream.close();
    console.log(`smoke-web-held-stream caddy new logic: stop took ${ms} ms, exit code ${exitCode(id)}`);
    expect(ms).toBeLessThanOrEqual(NEW_BOUND_MS);
    // Caddy closed the stream at its grace period and exited: docker's forced stop (137) was not needed.
    expect(exitCode(id)).toBe(0);
  }, 60_000);
});

describe("the whole swap, nginx to Caddy and back, with a stream held through the old container", () => {
  const V1 = { version: "1.0.0", commit: "1111aaa" };
  let h: ImageHost;
  beforeAll(async () => {
    h = createImageHost("held-swap", V0, { firstServer: "nginx" });
    await waitServed(h, V0);
  }, 600_000);
  afterAll(() => h?.dispose(), 120_000);

  test("the first rollout keeps the gap inside the limit with a stream open at the stop", async () => {
    const stream = await holdStream(h.serving().port);
    const deps = h.deps();
    try {
      const receipt = await deployImage({ bundle: h.bundle(V1), serverImage: h.serverImage }, deps);
      console.log(`smoke-web-held-stream first rollout: gap ${receipt.gap?.ms} ms, cold start ${receipt.precheck?.coldStartMs} ms`);
      expect(receipt.outcome).toBe("swapped");
      expect(receipt.gap!.ms!).toBeLessThanOrEqual(GAP_LIMIT_MS);
      // The pre-check ran on the spare port first, with the whole live check set, and was timed.
      const names = receipt.checks.map((c) => c.name);
      expect(names.indexOf("cold-start")).toBeGreaterThan(-1);
      expect(names.indexOf("cold-start")).toBeLessThan(names.indexOf("gap"));
      expect(names.indexOf("copy")).toBeLessThan(names.indexOf("gap"));
      expect(names.indexOf("live")).toBeGreaterThan(names.indexOf("public"));
      expect(receipt.checks.every((c) => c.ok)).toBe(true);
      expect(receipt.precheck!.coldStartMs + receipt.precheck!.retireBoundMs).toBeLessThanOrEqual(GAP_LIMIT_MS);
      expect(readImageReceipt(deps.receiptDir)!.precheck).toEqual(receipt.precheck);
    } finally {
      stream.close();
    }
    await waitServed(h, V1, 10_000);
  }, 300_000);

  test("--rollback to the kept nginx container keeps the gap inside the limit with a stream open at the stop", async () => {
    const stream = await holdStream(h.serving().port);
    try {
      const receipt = await rollbackImage(h.deps());
      console.log(`smoke-web-held-stream rollback: gap ${receipt.gap?.ms} ms`);
      expect(receipt.outcome).toBe("swapped");
      expect(receipt.gap!.ms!).toBeLessThanOrEqual(GAP_LIMIT_MS);
    } finally {
      stream.close();
    }
    await waitServed(h, V0, 10_000);
  }, 300_000);
});
