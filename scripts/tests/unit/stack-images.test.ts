// R12 / AC-ID-05 — "ARTIFACTS ARE BUILT ON `pinza`", asserted of the bring-up
// rather than of a runbook sentence.
//
// WHAT WAS WRONG. The frontend stack had no image-shipping path at all: every
// `bun run smoke` on `rm-frontend-stage-1` ran `docker compose build` and
// compiled all six images ON THE STAGING HOST
// (`phase1-rc2/1.9-boot-attempt-2-SUCCESS.log` lines 15-22, "building compose
// images…"), which is the AC-ID-05 FAIL recorded in `ac-results.json`. Core
// already builds on `pinza` and ships with `docker save | ssh docker load`
// (C-5); this is that route for the frontend.
//
// THE GUARANTEE THESE TESTS PIN, in the only form that is worth anything: with
// an images-override in effect the stack must EXECUTE no build — not "prefer
// not to", not "pass a flag that usually means no". So the stack is driven with
// a recording runtime and the assertion is over the argv it actually spawned.
// A `--no-build` that never reached the daemon, or a `build` that slipped in
// ahead of it, both fail here.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMAGE_NAMESPACE,
  IMAGES_OVERRIDE_ENV,
  IMAGES_OVERRIDE_FLAG,
  SHIPPED_IMAGE_SERVICES,
  assertOverrideOutsideCheckout,
  imageRefFor,
  imagesOverrideYaml,
  missingImageRefs,
  parseImagesOverrideRefs,
  saveArgs,
} from "../../stack/images.ts";
import { decideImagesOverride } from "../../lib/smoke-images-override.ts";
import { upArgs, DEFAULT_STACK_DATABASE, generateStackCredentials, type StackConfig } from "../../stack/config.ts";
import { createStack, type StackRuntime } from "../../stack/stack.ts";

const TAG = "v0.5.0-rc.3";

describe("shipped image plan (pure)", () => {
  test("names exactly the seven services this repo builds", () => {
    expect([...SHIPPED_IMAGE_SERVICES]).toEqual([
      "api",
      "worker-swarm",
      "worker-analytics",
      "worker-research",
      "analytics-producer",
      "member-agent",
      // Issue #1012. Unshipped, a staging host cannot judge at all: every
      // judging starts its container through this service.
      "agent-launcher",
    ]);
  });

  test("an image ref is namespace/service:tag and the tag is validated", () => {
    expect(imageRefFor("api", TAG)).toBe(`${IMAGE_NAMESPACE}/api:${TAG}`);
    expect(() => imageRefFor("api", "")).toThrow(/tag/i);
    expect(() => imageRefFor("api", "not a tag")).toThrow(/tag/i);
    expect(() => imageRefFor("postgres" as never, TAG)).toThrow(/postgres/);
  });

  test("the override pins every shipped service to a local ref that can never be pulled", () => {
    const yaml = imagesOverrideYaml(TAG);
    for (const svc of SHIPPED_IMAGE_SERVICES) expect(yaml).toContain(`image: ${imageRefFor(svc, TAG)}`);
    // A ref with a namespace and no registry host resolves to docker.io/… — a
    // pull is the one way a host could still acquire an image that was not
    // shipped to it, so it is refused in the file itself.
    expect(yaml.match(/pull_policy: never/g) ?? []).toHaveLength(SHIPPED_IMAGE_SERVICES.length);
    expect(parseImagesOverrideRefs(yaml)).toEqual(SHIPPED_IMAGE_SERVICES.map((s) => imageRefFor(s, TAG)));
  });

  test("the override file must live OUTSIDE the pinned checkout (AC-ID-05: porcelain 0)", () => {
    const root = "/home/stage-server/robotmoney-frontend";
    expect(() => assertOverrideOutsideCheckout("/home/stage-server/fusion-stage/images.override.yaml", root)).not.toThrow();
    expect(() => assertOverrideOutsideCheckout(`${root}/images.override.yaml`, root)).toThrow(/outside/i);
    expect(() => assertOverrideOutsideCheckout(`${root}/../robotmoney-frontend/x.yaml`, root)).toThrow(/outside/i);
  });

  test("save argv carries every ref in one stream", () => {
    const refs = SHIPPED_IMAGE_SERVICES.map((s) => imageRefFor(s, TAG));
    expect(saveArgs(refs)).toEqual(["docker", "save", ...refs]);
    expect(() => saveArgs([])).toThrow();
  });

  test("missingImageRefs reports what the host does not have, by name", () => {
    const present = new Set([imageRefFor("api", TAG)]);
    const refs = SHIPPED_IMAGE_SERVICES.map((s) => imageRefFor(s, TAG));
    expect(missingImageRefs(refs, (ref) => present.has(ref))).toEqual(refs.slice(1));
    expect(missingImageRefs(refs, () => true)).toEqual([]);
  });
});

describe("upArgs", () => {
  test("carries --no-build only when asked, and before the service list", () => {
    expect(upArgs(["api"])).toEqual(["up", "-d", "api"]);
    expect(upArgs(["api"], { noBuild: true })).toEqual(["up", "-d", "--no-build", "api"]);
  });
});

function overrideFileFor(tag: string): { path: string; repoRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), "rm-images-override-"));
  const repoRoot = join(dir, "checkout");
  mkdirSync(repoRoot, { recursive: true });
  const path = join(dir, "images.override.yaml");
  writeFileSync(path, imagesOverrideYaml(tag));
  return { path, repoRoot };
}

function recordingRuntime(opts: { inspectOk?: boolean } = {}): { runtime: StackRuntime; argv: string[][] } {
  const argv: string[][] = [];
  const runtime: StackRuntime = {
    runSync(a) {
      argv.push(a);
      if (a[1] === "image" && a[2] === "inspect") {
        return { exitCode: opts.inspectOk === false ? 1 : 0, stdout: "", stderr: "" };
      }
      // pg_isready / git / compose port
      if (a.includes("port")) return { exitCode: 0, stdout: "0.0.0.0:49999\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async run(a) {
      argv.push(a);
      return 0;
    },
    async probe() {
      return { ok: true, detail: "ok" };
    },
  };
  return { runtime, argv };
}

function configWith(imagesOverride: string, repoRoot: string): StackConfig {
  const credentials = generateStackCredentials();
  return {
    repoRoot,
    project: "rm_images_test",
    profile: "core",
    composeFiles: ["docker-compose.yml", "docker-compose.smoke.yml"],
    database: DEFAULT_STACK_DATABASE,
    credentials,
    environment: { class: "ci", hash: "deadbeef" },
    imagesOverride,
  };
}

describe("a stack with shipped images builds NOTHING on this host", () => {
  test("up() spawns no `compose build` and passes --no-build to every up", async () => {
    const { path, repoRoot } = overrideFileFor(TAG);
    const { runtime, argv } = recordingRuntime();
    const stack = createStack(configWith(path, repoRoot), { runtime });
    await stack.up();
    const compose = argv.filter((a) => a[0] === "docker" && a[1] === "compose");
    expect(compose.some((a) => a.includes("build"))).toBe(false);
    const ups = compose.filter((a) => a.includes("up"));
    expect(ups.length).toBeGreaterThan(0);
    for (const u of ups) expect(u).toContain("--no-build");
  });

  test("the override file is appended to the compose file list, last", async () => {
    const { path, repoRoot } = overrideFileFor(TAG);
    const { runtime, argv } = recordingRuntime();
    const stack = createStack(configWith(path, repoRoot), { runtime });
    await stack.up();
    const anyCompose = argv.find((a) => a[1] === "compose")!;
    const files = anyCompose.flatMap((tok, i) => (tok === "-f" ? [anyCompose[i + 1]!] : []));
    expect(files).toEqual(["docker-compose.yml", "docker-compose.smoke.yml", path]);
  });

  test("build() is REFUSED outright, not quietly skipped", async () => {
    const { path, repoRoot } = overrideFileFor(TAG);
    const { runtime } = recordingRuntime();
    const stack = createStack(configWith(path, repoRoot), { runtime });
    await expect(stack.build()).rejects.toThrow(/images-override/i);
  });

  test("a missing shipped image STOPS the boot before compose is asked to up", async () => {
    const { path, repoRoot } = overrideFileFor(TAG);
    const { runtime, argv } = recordingRuntime({ inspectOk: false });
    const stack = createStack(configWith(path, repoRoot), { runtime });
    await expect(stack.up()).rejects.toThrow(new RegExp(imageRefFor("api", TAG).replace(/[.\\]/g, "\\$&")));
    expect(argv.some((a) => a.includes("up"))).toBe(false);
  });

  // C-21 negative self-test: the assertions above must FAIL for a stack without
  // an override, or they are asserting nothing about the override at all.
  test("NEGATIVE SELF-TEST — without an override the stack still builds here", async () => {
    const { repoRoot } = overrideFileFor(TAG);
    const { runtime, argv } = recordingRuntime();
    const cfg = configWith("", repoRoot);
    const stack = createStack({ ...cfg, imagesOverride: undefined }, { runtime });
    await stack.up();
    const compose = argv.filter((a) => a[1] === "compose");
    expect(compose.some((a) => a.includes("build"))).toBe(true);
    for (const u of compose.filter((a) => a.includes("up"))) expect(u).not.toContain("--no-build");
  });
});

describe("the operator surface", () => {
  test("flag and env var are spelled once, here", () => {
    expect(IMAGES_OVERRIDE_FLAG).toBe("--images-override");
    expect(IMAGES_OVERRIDE_ENV).toBe("RM_IMAGES_OVERRIDE");
  });
});

describe("decideImagesOverride — where a boot's images come from", () => {
  test("nothing said anywhere: this boot builds its own images (the normal case)", () => {
    expect(decideImagesOverride([], {}, () => true)).toEqual({ banner: [] });
  });

  test("the flag wins over the environment, and both are absolutized", () => {
    const d = decideImagesOverride(["bun", "smoke", IMAGES_OVERRIDE_FLAG, "/a/flag.yaml"], { [IMAGES_OVERRIDE_ENV]: "/b/env.yaml" }, () => true);
    expect(d.path).toBe("/a/flag.yaml");
    expect(d.banner.join(" ")).toMatch(/BUILDS NOTHING/);
  });

  test("the environment alone is honoured — this is how the staging host says it", () => {
    expect(decideImagesOverride([], { [IMAGES_OVERRIDE_ENV]: "/b/env.yaml" }, () => true).path).toBe("/b/env.yaml");
  });

  test("`--images-override=` inline form is accepted; a valueless flag is refused", () => {
    expect(decideImagesOverride([`${IMAGES_OVERRIDE_FLAG}=/c.yaml`], {}, () => true).path).toBe("/c.yaml");
    expect(() => decideImagesOverride([IMAGES_OVERRIDE_FLAG], {}, () => true)).toThrow(/requires a path/);
    expect(() => decideImagesOverride([IMAGES_OVERRIDE_FLAG, "--no-tui"], {}, () => true)).toThrow(/requires a path/);
  });

  test("a path that does not exist is FATAL — never a quiet fallback to building here", () => {
    expect(() => decideImagesOverride([IMAGES_OVERRIDE_FLAG, "/gone.yaml"], {}, () => false)).toThrow(/AC-ID-05/);
  });

  test("an empty environment value is not a request for anything", () => {
    expect(decideImagesOverride([], { [IMAGES_OVERRIDE_ENV]: "   " }, () => true).path).toBeUndefined();
  });
});
