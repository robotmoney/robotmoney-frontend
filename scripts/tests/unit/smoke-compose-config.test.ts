// The immutable website-server, as written (issue 1627,
// docs/technical/web-serving-architecture.md §3.2). Unit tier: no Docker. The
// compose overlay and the Dockerfiles are read as text here. The rendered
// `docker compose config` is asserted in scripts/tests/integration/
// smoke-compose-config.test.ts, and the built image is run in scripts/tests/
// integration/website-server-bundle-image.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WEBSITE_IMAGE_LABELS,
  WEBSITE_SERVED_ROOT,
  assertServedRootUnchanged,
  readWebsiteImageService,
  servedRootChanges,
  websiteImageRunFlags,
} from "../../lib/website-image.ts";

const repoRoot = join(import.meta.dir, "../../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");
const svc = readWebsiteImageService(repoRoot);

describe("docker-compose.website-image.yml runs website-server immutable", () => {
  test("read-only root, every capability dropped, no privilege escalation, a non-root user", () => {
    expect(svc.read_only).toBe(true);
    expect(svc.cap_drop).toEqual(["ALL"]);
    expect(svc.security_opt).toContain("no-new-privileges:true");
    const [uid, gid] = String(svc.user).split(":");
    expect(Number(uid)).toBeGreaterThan(0);
    expect(Number(gid)).toBeGreaterThan(0);
  });

  test("no volume, no build: the site is the image's, named by RM_WEBSITE_IMAGE", () => {
    expect(svc.volumes).toEqual([]);
    expect(svc.image).toMatch(/^\$\{RM_WEBSITE_IMAGE:\?/);
    // The image is built on the host and never pulled (issue 1628).
    expect(svc.pull_policy).toBe("never");
    // `!reset` replaces the base file's bind mount and build. A plain key would merge with them.
    const text = read("docker-compose.website-image.yml");
    expect(text).toMatch(/^ {4}volumes: !reset \[\]$/m);
    expect(text).toMatch(/^ {4}build: !reset null$/m);
  });

  test("the scratch paths are in memory, owned by the server's user, and none is under the served root", () => {
    expect(svc.tmpfs?.map((t) => t.split(":")[0])).toEqual(["/config", "/data", "/srv/maintenance"]);
    for (const t of svc.tmpfs ?? []) {
      expect(t).toEndWith(`:uid=${svc.user!.split(":")[0]},gid=${svc.user!.split(":")[1]}`);
      expect(t.startsWith(`${WEBSITE_SERVED_ROOT}/`) || t.startsWith(`${WEBSITE_SERVED_ROOT}:`)).toBe(false);
    }
  });

  test("the run flags a container started outside compose gets are exactly the overlay's", () => {
    expect(websiteImageRunFlags(svc)).toEqual([
      "--read-only",
      "--user", "65534:65534",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--tmpfs", "/config:uid=65534,gid=65534",
      "--tmpfs", "/data:uid=65534,gid=65534",
      "--tmpfs", "/srv/maintenance:uid=65534,gid=65534",
    ]);
    expect(() => websiteImageRunFlags({ ...svc, volumes: ["/host/web:/srv/web:ro"] })).toThrow("no volume");
  });

  test("the base file still runs nginx with the web/ mount: nginx serves until the swap (P5)", () => {
    const base = Bun.YAML.parse(read("docker-compose.yml")) as { services: Record<string, { build?: { dockerfile?: string }; volumes?: string[] }> };
    expect(base.services["website-server"]!.build?.dockerfile).toBe("Dockerfile");
    expect(base.services["website-server"]!.volumes?.[0]).toEndWith("/web:/srv/web:ro");
  });
});

describe("the website-server images", () => {
  const server = read("website-server/Dockerfile.caddy");
  const bundle = read("website-server/Dockerfile.bundle");
  const froms = (text: string) => [...text.matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1]!);

  test("the server image's base is pinned by digest", () => {
    const bases = froms(server);
    expect(bases.length).toBeGreaterThan(0);
    for (const b of bases) expect(b).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  test("every package the server image installs is pinned to an exact version (issue 1632)", () => {
    const adds = [...server.matchAll(/apk add\s+(?:--\S+\s+)*([^\\\n&]+)/g)].flatMap((m) => m[1]!.trim().split(/\s+/));
    expect(adds).toEqual(["openssh-keygen=10.0_p1-r11"]);
  });

  test("the website-server image is built FROM the server image only, in both stages", () => {
    expect(froms(bundle)).toEqual(["${SERVER_IMAGE}", "${SERVER_IMAGE}"]);
  });

  test("neither image installs or copies in a Bun or Node runtime", () => {
    for (const text of [server, bundle]) {
      const code = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
      expect(code).not.toMatch(/\b(bun|node|nodejs|npm|npx|oven)\b/i);
    }
  });

  test("the verify stage runs before the site reaches the final image, against the server image's allowed-signers", () => {
    const verify = bundle.indexOf("RUN rm-verify-web-bundle /in /out");
    const copy = bundle.indexOf("COPY --from=verify /out/ /srv/web/current/");
    expect(verify).toBeGreaterThan(0);
    expect(copy).toBeGreaterThan(verify);
    expect(server).toContain("COPY allowed-signers /etc/robotmoney/allowed-signers");
    expect(server).toContain("COPY verify-bundle.sh /usr/local/bin/rm-verify-web-bundle");
    expect(read("website-server/verify-bundle.sh")).toContain("/etc/robotmoney/allowed-signers");
    expect(read("website-server/verify-bundle.sh")).toContain('NAMESPACE="robotmoney-web-bundle@v1"');
  });

  test("the labels the images set are the ones scripts/lib/website-image.ts reads", () => {
    expect(server).toContain(`LABEL ${WEBSITE_IMAGE_LABELS.serverCommit}="\${PLATFORM_COMMIT}"`);
    for (const key of [WEBSITE_IMAGE_LABELS.tag, WEBSITE_IMAGE_LABELS.commit, WEBSITE_IMAGE_LABELS.bundleSha256]) {
      expect(bundle).toMatch(new RegExp(`${key.replace(/\./g, "\\.")}="\\$\\{[A-Z0-9_]+\\}"`));
    }
  });
});

describe("the boot check: the served root equals the image", () => {
  test("servedRootChanges keeps only paths at or under the served root", () => {
    const diff = ["C /srv", "C /srv/web", "A /srv/web/current/x.js", "D /srv/web/current/index.html", "A /srv/webby", "A /tmp/x", "C /srv/maintenance", ""].join("\n");
    expect(servedRootChanges(diff)).toEqual(["C /srv/web", "A /srv/web/current/x.js", "D /srv/web/current/index.html"]);
    expect(servedRootChanges("")).toEqual([]);
  });

  test("assertServedRootUnchanged passes an empty diff and names every changed path otherwise", () => {
    const calls: string[][] = [];
    assertServedRootUnchanged((args) => (calls.push(args), "A /tmp/scratch\n"), "web-1");
    expect(calls).toEqual([["diff", "web-1"]]);
    expect(() => assertServedRootUnchanged(() => "C /srv/web/current/index.html\n", "web-1")).toThrow("C /srv/web/current/index.html");
  });
});
