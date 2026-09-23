#!/usr/bin/env bun
// AC-ID-05 — BUILD ON `pinza`, SHIP THE IMAGES, BUILD NOTHING ON STAGING.
//
//   bun scripts/stack/ship-images.ts --tag v0.5.0-rc.3 --host rm-frontend-stage-1
//
// The frontend half of the route core has used since the rc.7 repin (QA
// checklist C-5). Four steps, in this order, each one refusing rather than
// continuing when its precondition does not hold:
//
//   1. VERIFY THE SOURCE. This repo, at the tag, with an empty porcelain. An
//      image built from a modified tree is not the candidate, and the identity
//      baked into it would say so (`<sha>+dirty`) far too late.
//   2. BUILD, with the same Dockerfiles and the same compose model the stack
//      runs — `docker compose build` over docker-compose.yml +
//      docker-compose.smoke.yml with an images override that names the tagged
//      refs, so what is built and what is later started cannot drift apart.
//      Nothing is re-derived from a second copy of the topology.
//   3. SHIP, `docker save <six refs> | ssh <host> docker load`. One stream, no
//      registry, no intermediate file on either host.
//   4. INSTALL, writing the override and the manifest to
//      /home/stage-server/fusion-stage/ — OUTSIDE the pinned checkout, which
//      AC-ID-05 also requires to stay at porcelain 0 — then reading back each
//      image id on the target and comparing it to what was built here. The
//      comparison is the evidence: equal ids mean the containers that start
//      there come from the artifact this machine produced.
//
// It does not deploy. Bringing the stack up is a separate, recorded step (see
// fusion-evidence/.../F6/SHIP-PROCEDURE.md), because shipping is repeatable and
// restarting a stage stack is not.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeArgs } from "./config.ts";
import {
  HOST_IMAGES_MANIFEST_PATH,
  HOST_IMAGES_OVERRIDE_DIR,
  HOST_IMAGES_OVERRIDE_PATH,
  SHIPPED_IMAGE_SERVICES,
  assertValidTag,
  buildImagesManifest,
  imageRefsFor,
  imagesOverrideYaml,
  inspectArgs,
  type ShippedImageRecord,
} from "./images.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Args {
  tag: string;
  host: string;
  /** Skip the porcelain/tag check — recorded, never silent. */
  allowDirty: boolean;
  /** Build and record locally; ship nothing. */
  buildOnly: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const out: Args = { tag: "", host: "", allowDirty: false, buildOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--tag") out.tag = argv[++i] ?? "";
    else if (a === "--host") out.host = argv[++i] ?? "";
    else if (a === "--allow-dirty") out.allowDirty = true;
    else if (a === "--build-only") out.buildOnly = true;
    else throw new Error(`unknown argument ${JSON.stringify(a)}. Usage: ship-images.ts --tag <tag> --host <host> [--build-only] [--allow-dirty]`);
  }
  if (!out.tag) throw new Error("--tag <rc tag> is required: it is both what is checked out here and how every image is named");
  assertValidTag(out.tag);
  if (!out.host && !out.buildOnly) throw new Error("--host <ssh target> is required (or --build-only to build and record without shipping)");
  return out;
}

function run(argv: string[], opts: { cwd?: string; capture?: boolean } = {}): string {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    cwd: opts.cwd ?? repoRoot,
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`${argv.join(" ")} exited ${r.status ?? "signal " + r.signal}${r.stderr ? `: ${r.stderr.trim()}` : ""}`);
  }
  return (r.stdout ?? "").trim();
}

function step(n: number, what: string): void {
  console.log(`\n[ship-images] ${n}/4 ${what}`);
}

/** Step 1 — the source this machine is about to build from. */
function verifySource(tag: string, allowDirty: boolean): string {
  const head = run(["git", "rev-parse", "HEAD"], { capture: true });
  const porcelain = run(["git", "status", "--porcelain"], { capture: true });
  const described = spawnSync("git", ["describe", "--tags", "--exact-match", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const exact = described.status === 0 ? described.stdout.trim() : "";
  console.log(`[ship-images] source: ${head} ${exact ? `(${exact})` : "(no exact tag)"} porcelain ${porcelain ? "DIRTY" : "0"}`);
  if (allowDirty) {
    console.warn("[ship-images] --allow-dirty: building from a tree that is NOT the tagged candidate. This is an acceptance mutation and must be recorded.");
    return head;
  }
  if (porcelain) {
    throw new Error(
      `this checkout has uncommitted changes, so what would be built is not ${tag}:\n${porcelain}\n` +
        `AC-ID-05 requires artifacts built from a pinned releases* commit. Commit or stash, or pass --allow-dirty and record it.`,
    );
  }
  if (exact !== tag) {
    throw new Error(
      `this checkout is at ${exact || "no tagged commit"}, not ${tag}. Check out the tag before building its images ` +
        `— the tag is baked into every image as RM_BUILD_TAG and is what /version will report.`,
    );
  }
  return head;
}

async function pipeSaveToLoad(refs: string[], host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const save = spawn("docker", ["save", ...refs], { stdio: ["ignore", "pipe", "inherit"] });
    const load = spawn("ssh", [host, "docker", "load"], { stdio: ["pipe", "inherit", "inherit"] });
    save.stdout.pipe(load.stdin);
    let failed: Error | undefined;
    // BOTH exit codes are checked. A `docker save` that died mid-stream leaves
    // `docker load` reporting a perfectly successful partial load of whatever
    // arrived, and a pipeline that only looked at the last process would call
    // that a shipped release.
    save.on("exit", (code) => {
      if (code !== 0) failed = new Error(`docker save exited ${code}`);
    });
    load.on("exit", (code) => {
      if (code !== 0) failed = failed ?? new Error(`ssh ${host} docker load exited ${code}`);
      failed ? reject(failed) : resolve();
    });
    save.on("error", reject);
    load.on("error", reject);
  });
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const refs = imageRefsFor(args.tag);

  step(1, `verifying this checkout is ${args.tag}`);
  const commit = verifySource(args.tag, args.allowDirty);

  step(2, `building ${refs.length} images here (pinza), tagged ${args.tag}`);
  // The override is written to a temp dir and appended to the compose file list
  // for the BUILD too: compose then tags each built image with exactly the ref
  // the staging host will look for. Without it compose names images
  // `<project>-<service>` and the ref would have to be re-derived by hand,
  // which is the kind of second spelling that drifts.
  const stagingDir = mkdtempSync(join(tmpdir(), "rm-ship-images-"));
  const overridePath = join(stagingDir, "images.override.yaml");
  const generatedAt = new Date().toISOString();
  writeFileSync(overridePath, imagesOverrideYaml(args.tag, { sourceCommit: commit, generatedAt }));
  // Built through composeArgs(), not by hand. The prefix is assembled in ONE
  // place (scripts/stack/config.ts) so every compose call in the repo carries
  // `--env-file /dev/null`. A prefix spelled out by hand here would let the
  // host checkout's deployment `.env` be auto-loaded into the build, which is
  // exactly the failure that rule exists for.
  const composeArgv = [
    "docker",
    ...composeArgs(`rm_ship_images_${args.tag.replace(/[^A-Za-z0-9]/g, "_")}`, [
      "docker-compose.yml",
      "docker-compose.smoke.yml",
      overridePath,
    ]),
  ];
  // The identity every image carries, from the tree verified in step 1 — the
  // same two build args scripts/stack/stack.ts passes, so an image built here
  // and an image built by a local `bun run smoke` report identity the same way.
  const buildEnv = { ...process.env, RM_BUILD_COMMIT: commit, RM_BUILD_TAG: args.tag };
  const build = spawnSync(composeArgv[0]!, [...composeArgv.slice(1), "build", ...SHIPPED_IMAGE_SERVICES], {
    cwd: repoRoot,
    env: buildEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (build.status !== 0) throw new Error(`docker compose build exited ${build.status}`);

  const built: ShippedImageRecord[] = SHIPPED_IMAGE_SERVICES.map((service, i) => {
    const ref = refs[i]!;
    const id = run(inspectArgs(ref), { capture: true });
    const digests = run(["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", ref], { capture: true });
    let repoDigest: string | null = null;
    try {
      const parsed = JSON.parse(digests) as string[] | null;
      repoDigest = Array.isArray(parsed) && parsed.length > 0 ? parsed[0]! : null;
    } catch {
      repoDigest = null;
    }
    console.log(`[ship-images]   ${ref}  ${id}`);
    return { service, ref, id, repo_digest: repoDigest };
  });

  const manifest = buildImagesManifest({
    tag: args.tag,
    commit,
    builtOn: run(["hostname"], { capture: true }),
    builtAt: generatedAt,
    targetHost: args.buildOnly ? "(build-only)" : args.host,
    images: built,
  });
  const localManifestPath = join(stagingDir, "images.manifest.json");
  writeFileSync(localManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[ship-images] manifest: ${localManifestPath}`);

  if (args.buildOnly) {
    step(3, "ship SKIPPED (--build-only)");
    step(4, "install SKIPPED (--build-only)");
    console.log(`[ship-images] override: ${overridePath}`);
    process.exit(0);
  }

  step(3, `shipping to ${args.host}: docker save | ssh ${args.host} docker load`);
  await pipeSaveToLoad(refs, args.host);

  step(4, `installing ${HOST_IMAGES_OVERRIDE_PATH} (outside the checkout) and verifying image ids on ${args.host}`);
  run(["ssh", args.host, "mkdir", "-p", HOST_IMAGES_OVERRIDE_DIR]);
  for (const [src, dest] of [
    [overridePath, HOST_IMAGES_OVERRIDE_PATH],
    [localManifestPath, HOST_IMAGES_MANIFEST_PATH],
  ] as const) {
    run(["scp", src, `${args.host}:${dest}`]);
  }
  // THE EVIDENCE. Equal ids mean the image the staging host will start is the
  // artifact this machine built, not a local rebuild wearing the same tag.
  const remote = run(["ssh", args.host, "docker", "image", "inspect", "--format", "{{.Id}}", ...refs], { capture: true })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const mismatched = built.filter((b, i) => remote[i] !== b.id);
  if (remote.length !== built.length || mismatched.length > 0) {
    throw new Error(
      `image ids on ${args.host} do not match what was built here: ` +
        `${mismatched.map((m) => `${m.ref} built ${m.id}`).join("; ") || `expected ${built.length} ids, got ${remote.length}`}`,
    );
  }
  console.log(`\n[ship-images] DONE. ${built.length} images built on $(hostname) at ${args.tag} and verified on ${args.host}.`);
  console.log(`[ship-images] Next: on ${args.host}, RM_IMAGES_OVERRIDE=${HOST_IMAGES_OVERRIDE_PATH} bun run smoke:stage`);
}
