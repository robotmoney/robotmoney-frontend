// Q41a-web-bundle-edge (stage only, no production twin; owner decision 2026-11-15, issue 1647): what the
// PUBLIC Cloudflare address serves is the signed bundle, byte for byte, with one explicit exception:
// `/robots.txt`, to which Cloudflare's Managed robots.txt may prepend its own block. Any other file that
// differs through Cloudflare fails the step (for example email obfuscation in an HTML page, which the
// site's pages avoid by carrying no email address, PR 1648).
//
// Q41-web-bundle reads the website-server's own port, upstream of Cloudflare, and is the release's
// byte-for-byte evidence on both targets. This check runs on the control machine with the same code
// (./web-bundle.ts checkServedBundle): the bundle /version.json names, verified against the release
// commit's allowed-signers, every manifest file fetched through the public origin with a one-off query.
// Read-only. The excepted file is still fetched, must answer 200, and its match is recorded in
// `found.excepted`.
import type { VersionCheck } from "../../version-check.ts";
import { checkServedBundle } from "./web-bundle.ts";

/** The bundle paths Cloudflare may rewrite at the edge: only robots.txt (its Managed robots.txt). */
export const EDGE_EXCEPTIONS: ReadonlySet<string> = new Set(["robots.txt"]);

export default (async (ctx) => checkServedBundle(ctx, ctx.origin, `the public origin ${ctx.origin} (through Cloudflare)`, EDGE_EXCEPTIONS)) satisfies VersionCheck;
