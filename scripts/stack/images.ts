// AC-ID-05 — "ARTIFACTS ARE BUILT ON `pinza`". The frontend's half of the route
// core already uses (QA checklist C-5): build the six images on `pinza` at the
// RC tag, ship them with `docker save | ssh <host> docker load`, and run compose
// on the staging host against an override that names those exact refs with
// `--no-build`. The staging host compiles nothing.
//
// WHAT WAS THERE BEFORE. Nothing. `bun run smoke` on `rm-frontend-stage-1` ran
// `docker compose build` and compiled all six images on the staging host
// (`phase1-rc2/1.9-boot-attempt-2-SUCCESS.log` lines 15-22). D-A5 authorised
// that route, but AC-ID-05's evidence column says built on `pinza` and a
// BLOCKER has no scope-exception path — so it was recorded FAIL, not glossed.
//
// PURE, like scripts/stack/config.ts and for the same reason: every command
// shape here is a total function over its arguments, so the whole plan is
// testable without a daemon, without a network and without a staging host.
// scripts/stack/ship-images.ts is the impure shell that runs it.
//
// THE IMAGE REFS ARE LOCAL-ONLY BY CONSTRUCTION. `robotmoney-frontend/api:<tag>`
// has a namespace and no registry host, so Docker would resolve it to
// `docker.io/robotmoney-frontend/api` if it ever tried to pull — there is no
// such repository, and a pull is the one remaining way a host could acquire an
// image nobody shipped to it. `pull_policy: never` in the override refuses that
// outright rather than relying on the push never having happened.

/**
 * The SIX images this repo builds, in the order `docker compose build` is asked
 * for them. Five come from `backend/Dockerfile` (api + the three worker lanes +
 * the independent analytics producer); `member-agent` is profile-gated and
 * built from `scripts/lib/member-agent/Dockerfile`, and it is a RUNTIME
 * prerequisite of a full stack even though it never appears in `servicesFor`
 * (see config.ts's buildServicesFor) — leaving it unshipped would make the
 * staging host cold-build it the first time a swarm session launched a member,
 * which is precisely the thing AC-ID-05 forbids.
 *
 * `postgres` is deliberately absent: it is `postgres:17-alpine`, an upstream
 * image pulled from a registry, not an artifact this repo builds.
 */
export const SHIPPED_IMAGE_SERVICES = [
  "api",
  "worker-swarm",
  "worker-analytics",
  "worker-research",
  "analytics-producer",
  "member-agent",
] as const;

export type ShippedImageService = (typeof SHIPPED_IMAGE_SERVICES)[number];

/** The local-only namespace every shipped ref carries. */
export const IMAGE_NAMESPACE = "robotmoney-frontend";

/** The operator surface, spelled once. */
export const IMAGES_OVERRIDE_FLAG = "--images-override";
export const IMAGES_OVERRIDE_ENV = "RM_IMAGES_OVERRIDE";

/**
 * Where the override lives on `rm-frontend-stage-1`: OUTSIDE the pinned
 * checkout. AC-ID-05 also requires `git status --porcelain` to be empty in the
 * deploy checkout, and a generated file written inside it — even an ignored one
 * — is a file the next evaluator has to reason about. Keeping it in its own
 * directory means the checkout stays a verbatim `git checkout <tag>`.
 */
export const HOST_IMAGES_OVERRIDE_DIR = "/home/stage-server/fusion-stage";
export const HOST_IMAGES_OVERRIDE_PATH = `${HOST_IMAGES_OVERRIDE_DIR}/images.override.yaml`;
export const HOST_IMAGES_MANIFEST_PATH = `${HOST_IMAGES_OVERRIDE_DIR}/images.manifest.json`;

// A Docker tag: no slashes, no colons, no spaces, and never empty. Validated
// rather than interpolated blindly because this string is pasted into an image
// reference AND into a YAML file; a tag containing `:` silently re-points every
// service at a different repository.
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export function assertValidTag(tag: string): void {
  if (!TAG_RE.test(tag)) {
    throw new Error(
      `invalid image tag ${JSON.stringify(tag)}: expected a Docker tag (e.g. v0.5.0-rc.3) matching ${TAG_RE}`,
    );
  }
}

/** `robotmoney-frontend/<service>:<tag>` — the one place a ref is spelled. */
export function imageRefFor(service: ShippedImageService, tag: string): string {
  if (!(SHIPPED_IMAGE_SERVICES as readonly string[]).includes(service)) {
    throw new Error(
      `${service} is not a shipped image service (this stack builds: ${SHIPPED_IMAGE_SERVICES.join(", ")}; ` +
        `postgres is an upstream image and is pulled, not shipped)`,
    );
  }
  assertValidTag(tag);
  return `${IMAGE_NAMESPACE}/${service}:${tag}`;
}

export function imageRefsFor(tag: string, services: readonly ShippedImageService[] = SHIPPED_IMAGE_SERVICES): string[] {
  return services.map((s) => imageRefFor(s, tag));
}

/**
 * The compose overlay, generated on `pinza` and copied to the staging host.
 *
 * It sets `image:` on services that also declare `build:`. That is the
 * supported compose shape: with `--no-build` the declared image is used as-is
 * and the build section is never consulted. The build section is deliberately
 * NOT deleted — the same file would then be unusable for a `docker compose
 * build` on pinza, and a second, divergent copy of the topology is exactly the
 * drift this repo removes elsewhere.
 */
export function imagesOverrideYaml(
  tag: string,
  opts: { services?: readonly ShippedImageService[]; sourceCommit?: string; generatedAt?: string } = {},
): string {
  const services = opts.services ?? SHIPPED_IMAGE_SERVICES;
  assertValidTag(tag);
  const header =
    `# GENERATED by scripts/stack/ship-images.ts — DO NOT EDIT, DO NOT COMMIT.\n` +
    `#\n` +
    `# Pins every image this repo builds to an artifact built on pinza at ${tag}\n` +
    `# and shipped here with \`docker save | ssh <host> docker load\` (AC-ID-05).\n` +
    `# Compose is run with --no-build, so nothing is compiled on this host; a\n` +
    `# missing image stops the boot by name instead of being rebuilt silently.\n` +
    (opts.sourceCommit ? `#\n# source commit: ${opts.sourceCommit}\n` : "") +
    (opts.generatedAt ? `# generated at:  ${opts.generatedAt}\n` : "") +
    `services:\n`;
  return (
    header +
    services
      .map((s) => `  ${s}:\n    image: ${imageRefFor(s, tag)}\n    pull_policy: never\n`)
      .join("")
  );
}

/**
 * The refs an override file pins, read back from the file itself.
 *
 * Deliberately a line scan over `image:` and not a YAML parse: this is the
 * check that runs on the staging host before `up`, and it must agree with the
 * FILE compose was handed rather than with a tag someone re-derived. A parser
 * dependency here would also be a second way to read the same bytes.
 */
export function parseImagesOverrideRefs(text: string): string[] {
  const refs: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s+image:\s*(\S+)\s*$/.exec(line);
    if (m) refs.push(m[1]!);
  }
  return refs;
}

/**
 * The override must not live inside the pinned checkout (AC-ID-05 keeps that
 * tree at `porcelain 0`). Compares RESOLVED paths, so `<root>/../<root>/x` is
 * caught as well as the obvious spelling.
 */
export function assertOverrideOutsideCheckout(overridePath: string, repoRoot: string): void {
  const norm = (p: string): string => {
    const out: string[] = [];
    for (const seg of p.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    return "/" + out.join("/");
  };
  const root = norm(repoRoot);
  const file = norm(overridePath);
  if (file === root || file.startsWith(`${root}/`)) {
    throw new Error(
      `the images override must live OUTSIDE the pinned checkout, and ${overridePath} is inside ${repoRoot}. ` +
        `AC-ID-05 requires the deploy checkout to stay byte-identical to the tag (porcelain 0); ` +
        `use ${HOST_IMAGES_OVERRIDE_PATH}.`,
    );
  }
}

/** `docker save <ref>…` — one stream for all six, piped straight into ssh. */
export function saveArgs(refs: readonly string[]): string[] {
  if (refs.length === 0) throw new Error("docker save needs at least one image reference");
  return ["docker", "save", ...refs];
}

/** The remote side of the pipe: `ssh <host> docker load`. */
export function loadArgs(host: string): string[] {
  if (!host.trim()) throw new Error("a target host is required to ship images");
  return ["ssh", host, "docker", "load"];
}

/** `docker image inspect <ref>` — the presence probe, as argv. */
export function inspectArgs(ref: string): string[] {
  return ["docker", "image", "inspect", "--format", "{{.Id}}", ref];
}

/**
 * Which of `refs` the host does not have. Returns NAMES, not a boolean: the
 * failure an operator has to act on is "worker-research was not shipped", and a
 * bare false makes them go and find that out themselves.
 */
export function missingImageRefs(refs: readonly string[], present: (ref: string) => boolean): string[] {
  return refs.filter((r) => !present(r));
}

export interface ShippedImageRecord {
  service: string;
  ref: string;
  /** `docker image inspect --format {{.Id}}` — the local content id. */
  id: string;
  /** `{{index .RepoDigests 0}}` when the image has one; null for never-pushed local builds. */
  repo_digest: string | null;
}

export interface ImagesManifest {
  schema: 1;
  tag: string;
  commit: string | null;
  built_on: string;
  built_at: string;
  target_host: string;
  images: ShippedImageRecord[];
}

/**
 * The record of WHAT WAS SHIPPED — written beside the override on both hosts.
 *
 * Image ids are what makes the claim checkable after the fact: `docker image
 * inspect` on the staging host must return the id this file records, which is
 * the evidence that the running container came from the artifact pinza built
 * rather than from a local rebuild that happens to carry the same tag.
 */
export function buildImagesManifest(input: {
  tag: string;
  commit: string | null;
  builtOn: string;
  builtAt: string;
  targetHost: string;
  images: readonly ShippedImageRecord[];
}): ImagesManifest {
  assertValidTag(input.tag);
  if (input.images.length === 0) throw new Error("an images manifest with no images records nothing");
  for (const i of input.images) {
    if (!i.id) throw new Error(`image ${i.ref} has no id — \`docker image inspect\` did not answer for it`);
  }
  return {
    schema: 1,
    tag: input.tag,
    commit: input.commit && input.commit.length > 0 ? input.commit : null,
    built_on: input.builtOn,
    built_at: input.builtAt,
    target_host: input.targetHost,
    images: [...input.images],
  };
}

/**
 * Where a boot gets its override from: the FLAG first, then the environment.
 *
 * The flag wins because it is the more specific statement — an operator who
 * typed a path meant that path, even on a host whose profile exports another.
 * Returns `undefined` when neither says anything, which is the normal case
 * everywhere except the staging host. A flag with no value is an ERROR rather
 * than a silent fallback to the environment: `--images-override` alone reads as
 * "use the shipped images" and would otherwise quietly build them instead.
 */
export function resolveImagesOverride(argv: readonly string[], envValue: string | undefined): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === IMAGES_OVERRIDE_FLAG) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${IMAGES_OVERRIDE_FLAG} requires a path to the compose overlay written by scripts/stack/ship-images.ts`);
      }
      return value;
    }
    if (a.startsWith(`${IMAGES_OVERRIDE_FLAG}=`)) {
      const value = a.slice(IMAGES_OVERRIDE_FLAG.length + 1);
      if (!value) throw new Error(`${IMAGES_OVERRIDE_FLAG}= requires a value.`);
      return value;
    }
  }
  const env = envValue?.trim();
  return env ? env : undefined;
}
