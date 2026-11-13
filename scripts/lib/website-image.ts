// The immutable website-server image and container (issue 1627,
// docs/technical/web-serving-architecture.md §3.2).
//
// The image is built by website-server/Dockerfile.bundle: the platform's server
// image (website-server/Dockerfile.caddy) plus exactly one bundle, verified in
// a build stage. Its run flags live in docker-compose.website-image.yml. This
// module holds what a caller needs to read one back: the label names, the
// served root, the run flags as `docker run` arguments, and the boot check
// that a running container's served root still equals its image.
//
// Nothing here deploys. The swap that uses it is P5 (issue 1628).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WEBSITE_IMAGE_COMPOSE_FILE } from "../stack/config.ts";

/** The labels every website-server image carries (§3.2, R5). */
export const WEBSITE_IMAGE_LABELS = {
  /** The web release tag, `web-vA.B.C`. */
  tag: "robotmoney.web.tag",
  /** The commit the bundle was built from. */
  commit: "robotmoney.web.commit",
  /** The bundle tarball's sha256. */
  bundleSha256: "robotmoney.web.bundle-sha256",
  /** The platform commit the server image was built from. Set by the server image. */
  serverCommit: "robotmoney.web.server-commit",
} as const;

/** Where the image holds the site. `current` is the served root. */
export const WEBSITE_SERVED_ROOT = "/srv/web";

/** The website-server settings the overlay declares. */
export interface WebsiteImageService {
  image?: string;
  read_only?: boolean;
  user?: string;
  cap_drop?: string[];
  security_opt?: string[];
  tmpfs?: string[];
  volumes?: unknown[];
}

/** The overlay's website-server service, as written. */
export function readWebsiteImageService(repoRoot: string): WebsiteImageService {
  const doc = Bun.YAML.parse(readFileSync(join(repoRoot, WEBSITE_IMAGE_COMPOSE_FILE), "utf8")) as {
    services?: Record<string, WebsiteImageService>;
  };
  const svc = doc.services?.["website-server"];
  if (!svc) throw new Error(`${WEBSITE_IMAGE_COMPOSE_FILE} declares no website-server service`);
  return svc;
}

/**
 * PURE. The overlay's isolation settings as `docker run` arguments, so a
 * container started outside compose (a check copy, a test) runs exactly as
 * compose would run it. Refuses a service that mounts a volume.
 */
export function websiteImageRunFlags(svc: WebsiteImageService): string[] {
  if (svc.volumes && svc.volumes.length > 0) throw new Error("website-server must mount no volume");
  const flags: string[] = [];
  if (svc.read_only) flags.push("--read-only");
  if (svc.user) flags.push("--user", svc.user);
  for (const cap of svc.cap_drop ?? []) flags.push("--cap-drop", cap);
  for (const opt of svc.security_opt ?? []) flags.push("--security-opt", opt);
  for (const t of svc.tmpfs ?? []) flags.push("--tmpfs", t);
  return flags;
}

/** PURE. The `docker diff` lines (`C /path`, `A /path`, `D /path`) at or under the served root. */
export function servedRootChanges(diff: string): string[] {
  return diff
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      const path = l.replace(/^[ACD]\s+/, "");
      return path === WEBSITE_SERVED_ROOT || path.startsWith(`${WEBSITE_SERVED_ROOT}/`);
    });
}

/**
 * The boot check (R4): a running website-server's served root equals its
 * image. `docker` runs one docker command and returns its stdout. Throws with
 * every changed path when it does not.
 */
export function assertServedRootUnchanged(docker: (args: string[]) => string, container: string): void {
  const changes = servedRootChanges(docker(["diff", container]));
  if (changes.length > 0) {
    throw new Error(`website-server ${container}: the served root differs from its image:\n${changes.join("\n")}`);
  }
}
