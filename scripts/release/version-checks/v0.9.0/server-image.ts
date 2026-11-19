// Q39-server-image/C27-server-image (web serving P2 1637, P4 1639): the host holds this release's server
// image, `robotmoney-website-server:<instance>`, which every site image is built FROM and which a web
// release's W09 requires (release-runbooks.md §12, web-serving-architecture.md §3.2). Read-only: two
// throwaway containers with no network read one file and one PATH lookup from the image; nothing is built
// or tagged here (Q23a-server-image-build/C11a-server-image-build build it).
//
// WHAT IT REQUIRES:
//   - the image exists, and its label robotmoney.web.server-commit is the release commit (--commit), so the
//     server image belongs to the platform release the host runs;
//   - the allowed-signers file inside it (/etc/robotmoney/allowed-signers) holds exactly the key lines of
//     the release checkout's website-server/allowed-signers, each scoped to robotmoney-web-bundle@v1;
//   - it runs as 65534:65534 and carries no Bun or Node binary (§3.2).
// `found.signerKeys` lists the keys the host will accept. While the file still holds only the bootstrap
// entry whose private half was discarded, no bundle can be signed for it (website-server/allowed-signers).
import { readFileSync } from "node:fs";
import { HOST_ALLOWED_SIGNERS, serverImageOf } from "../../web-release-lib.ts";
import { WEBSITE_IMAGE_LABELS } from "../../../lib/website-image.ts";
import type { VersionCheck } from "../../version-check.ts";
import { linesOf } from "./_web.ts";

export interface ServerImageRead {
  /** The image's id, or null when the tag names none. */
  readonly id: string | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly user: string;
  /** The allowed-signers file inside the image, or null when it could not be read. */
  readonly signers: string | null;
  /** What `command -v bun node nodejs` printed inside the image. */
  readonly runtimes: string;
}

/** PURE. The key lines of an allowed-signers file: comments and blank lines dropped. */
export function signerLines(text: string): string[] {
  return linesOf(text).filter((l) => !l.startsWith("#"));
}

/** PURE. Why the host's server image is not this release's; empty when it is. */
export function serverImageProblems(image: string, r: ServerImageRead, commit: string, committedSigners: string): string[] {
  if (r.id === null) return [`the host holds no server image ${image}: Q23a-server-image-build/C11a-server-image-build builds it from website-server/Dockerfile.caddy`];
  const out: string[] = [];
  const built = r.labels[WEBSITE_IMAGE_LABELS.serverCommit];
  if (built !== commit) out.push(`${image}'s label ${WEBSITE_IMAGE_LABELS.serverCommit} is ${JSON.stringify(built ?? null)}, not the release commit ${commit}`);
  if (r.signers === null) out.push(`${image} holds no readable ${HOST_ALLOWED_SIGNERS}`);
  else {
    const want = signerLines(committedSigners);
    const got = signerLines(r.signers);
    if (got.join("\n") !== want.join("\n")) out.push(`${image}'s ${HOST_ALLOWED_SIGNERS} holds ${got.length} key line(s) that differ from the release's website-server/allowed-signers (${want.length})`);
    if (got.length === 0 || !got.every((l) => /namespaces="robotmoney-web-bundle@v1"/.test(l) && /\bssh-ed25519 \S+/.test(l))) out.push(`${image}'s ${HOST_ALLOWED_SIGNERS} has a line not scoped to robotmoney-web-bundle@v1, or none`);
  }
  if (r.user !== "65534:65534") out.push(`${image} runs as ${JSON.stringify(r.user)}, not 65534:65534`);
  if (r.runtimes.trim() !== "") out.push(`${image} carries a JavaScript runtime: ${linesOf(r.runtimes).join(", ")}`);
  return out;
}

export default (async (ctx) => {
  if (!ctx.commit) return { found: {}, problems: ["the step passes no --commit, so the server image's platform commit cannot be compared"] };
  const image = serverImageOf(ctx.instance);
  const inspect = ctx.docker(["image", "inspect", "--format", "{{json .}}", image]);
  let id: string | null = null;
  let labels: Record<string, string> = {};
  let user = "";
  if (inspect.code === 0) {
    const doc = JSON.parse(inspect.stdout) as { Id?: string; Config?: { Labels?: Record<string, string> | null; User?: string } };
    id = doc.Id ?? null;
    labels = doc.Config?.Labels ?? {};
    user = doc.Config?.User ?? "";
  }
  let signers: string | null = null;
  let runtimes = "";
  if (id !== null) {
    const s = ctx.docker(["run", "--rm", "--network", "none", "--entrypoint", "cat", image, HOST_ALLOWED_SIGNERS]);
    signers = s.code === 0 ? s.stdout : null;
    runtimes = ctx.docker(["run", "--rm", "--network", "none", "--entrypoint", "sh", image, "-c", "command -v bun node nodejs || true"]).stdout;
  }
  // The step runs in the release checkout, at the release commit.
  const committed = readFileSync("website-server/allowed-signers", "utf8");
  return {
    found: { image, id, serverCommit: labels[WEBSITE_IMAGE_LABELS.serverCommit] ?? null, user, signerKeys: signers === null ? null : signerLines(signers).map((l) => l.replace(/^(\S+).*\b(ssh-ed25519 \S+).*$/, "$1 $2")) },
    problems: serverImageProblems(image, { id, labels, user, signers, runtimes }, ctx.commit, committed),
  };
}) satisfies VersionCheck;
