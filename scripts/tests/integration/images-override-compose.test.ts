// AC-ID-05, against REAL `docker compose` — the half a hand-rolled YAML string
// and a hand-rolled parser can never prove.
//
// scripts/tests/unit/stack-images.test.ts pins what the override SAYS and what
// the stack DOES with it. Neither knows whether compose agrees: that the
// `image:` keys merge over services that also declare `build:`, that every
// service resolves to the shipped ref rather than to the default
// `<project>-<service>` name, and that `--no-build` is a flag this compose
// version has. Those are properties of the tool, so they are asked of the tool.
//
// Offline: `config` is pure interpolation, no daemon-side state, no containers.
// Docker is a hard dependency of this repo's harness — a missing CLI fails
// loudly here, never a silent skip (test-coverage policy).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHIPPED_IMAGE_SERVICES, imageRefFor, imagesOverrideYaml } from "../../stack/images.ts";

const repoRoot = join(import.meta.dir, "../../..");
const TAG = "v0.0.0-test";

function overridePath(): string {
  const p = join(mkdtempSync(join(tmpdir(), "rm-images-override-it-")), "images.override.yaml");
  writeFileSync(p, imagesOverrideYaml(TAG, { sourceCommit: "0".repeat(40), generatedAt: "2026-09-14T00:00:00.000Z" }));
  return p;
}

function composeConfig(extraFiles: string[], args: string[]): { stdout: string; exitCode: number } {
  const r = Bun.spawnSync(
    // `member-agent` is compose-profile gated (it is launched one-shot per
    // swarm member), so `config` omits it entirely unless the profile is
    // named — and it is one of the six images that must be shipped, because a
    // host that lacks it cold-builds it the first time a session runs.
    ["docker", "compose", "-p", "rm_images_override_it", "--profile", "member-agent",
      "-f", "docker-compose.yml", "-f", "docker-compose.smoke.yml",
      ...extraFiles.flatMap((f) => ["-f", f]), ...args],
    // RM_INSTANCE / RM_INSTANCE_STATE_DIR: docker-compose.yml requires both (no checkout fallback,
    // smoke spec §1.1); `config` mounts nothing, so any absolute path renders.
    { cwd: repoRoot, env: { ...process.env, DATABASE_URL: "postgres://x:y@postgres:5432/z", RM_INSTANCE: "rm_local_images", RM_INSTANCE_STATE_DIR: "/var/empty/rm_local_images" }, stdout: "pipe", stderr: "pipe" },
  );
  return { stdout: new TextDecoder().decode(r.stdout), exitCode: r.exitCode ?? -1 };
}

describe("the images override, resolved by docker compose itself", () => {
  test("every built service resolves to the shipped ref", () => {
    const r = composeConfig([overridePath()], ["config", "--format", "json"]);
    expect(r.exitCode).toBe(0);
    const cfg = JSON.parse(r.stdout) as { services: Record<string, { image?: string; build?: unknown; pull_policy?: string }> };
    for (const svc of SHIPPED_IMAGE_SERVICES) {
      expect(cfg.services[svc]?.image, `${svc} image`).toBe(imageRefFor(svc, TAG));
      // The build section SURVIVES the merge — the same file must stay usable
      // for `docker compose build` on pinza, which is how the image gets made.
      expect(cfg.services[svc]?.build, `${svc} build section`).toBeTruthy();
      // A namespaced ref with no registry host resolves to docker.io/…; a pull
      // is the one way a host could acquire an image nobody shipped to it.
      expect(cfg.services[svc]?.pull_policy, `${svc} pull_policy`).toBe("never");
    }
    // postgres is upstream, pulled, and must NOT be re-pointed at a local ref.
    expect(cfg.services.postgres?.image).toBe("postgres:17-alpine");
  });

  // NEGATIVE SELF-TEST (C-21): without the override the same services resolve
  // to compose's default project-scoped names, so the assertion above is
  // reporting the override's effect and not a coincidence.
  test("NEGATIVE — without the override nothing is pinned to a shipped ref", () => {
    const r = composeConfig([], ["config", "--format", "json"]);
    expect(r.exitCode).toBe(0);
    const cfg = JSON.parse(r.stdout) as { services: Record<string, { image?: string }> };
    for (const svc of SHIPPED_IMAGE_SERVICES) {
      expect(cfg.services[svc]?.image ?? "").not.toBe(imageRefFor(svc, TAG));
    }
  });

  test("`up --no-build` is a flag THIS compose version has", () => {
    const r = Bun.spawnSync(["docker", "compose", "up", "--help"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode(r.stdout)).toContain("--no-build");
  });
});
