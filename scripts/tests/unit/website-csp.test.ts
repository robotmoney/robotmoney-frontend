// The site's Content-Security-Policy, per directive (issues 1434, 1615).
//
// The policy lives in three places that must agree: scripts/lib/website-image.ts
// (WEBSITE_CSP, what `bun smoke:web` and the route table check, and what the
// deposit wallet browser spec serves), website-server/Caddyfile (the immutable
// website-server, issue 1627) and website-server/nginx.conf. Each directive is
// held to its exact source list, so a new external origin is a reviewed edit
// here, never a side effect.
//
// The Reown sources (1615) are what the deposit page's wallet kit
// (assets/js/vendor/rm-appkit-*.min.js) needs with email, socials, onramp,
// swaps and analytics off: its RPC and project config, the WalletConnect
// relay, the Verify frame, its fonts, and blob: wallet icons. mainnet.base.org
// is the kit's own fallback transport when Reown's RPC refuses a read.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WEBSITE_CSP } from "../../lib/website-image.ts";

const repo = join(import.meta.dir, "..", "..", "..");
const nginx = readFileSync(join(repo, "website-server", "nginx.conf"), "utf8");
const caddy = readFileSync(join(repo, "website-server", "Caddyfile"), "utf8");

const nginxHeaders = nginx.match(/add_header\s+Content-Security-Policy\s+"([^"]*)"/g) ?? [];
const caddyHeaders = caddy.match(/^\s*Content-Security-Policy\s+"([^"]*)"/gm) ?? [];

/** A policy string as directive → sources. */
export function directives(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) out[name] = vals;
  }
  return out;
}

const REOWN_CONNECT = [
  "https://rpc.walletconnect.org",
  "https://rpc.walletconnect.com",
  "https://api.web3modal.org",
  "https://api.web3modal.com",
  "wss://relay.walletconnect.org",
  "wss://relay.walletconnect.com",
  "https://mainnet.base.org",
];

/** Every directive's approved sources. Anything else fails. */
export const APPROVED: Record<string, string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-eval'", "https://challenges.cloudflare.com"],
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  "img-src": ["'self'", "data:", "blob:", "https:"],
  "font-src": ["'self'", "data:", "https://fonts.gstatic.com", "https://fonts.reown.com"],
  "frame-src": [
    "https://challenges.cloudflare.com",
    "https://verify.walletconnect.org",
    "https://verify.walletconnect.com",
  ],
  "connect-src": [
    "'self'",
    "https://script.google.com",
    "https://script.googleusercontent.com",
    ...REOWN_CONNECT,
  ],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'self'"],
};

/** Directives whose sources differ from APPROVED, as readable lines. Empty means the policy is approved. */
export function unapproved(policy: string): string[] {
  const d = directives(policy);
  const out: string[] = [];
  for (const name of new Set([...Object.keys(APPROVED), ...Object.keys(d)])) {
    const want = APPROVED[name];
    const got = d[name];
    if (!want) out.push(`${name}: not an approved directive`);
    else if (!got) out.push(`${name}: missing`);
    else if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${name}: ${got.join(" ")} (approved: ${want.join(" ")})`);
  }
  return out;
}

describe("website CSP", () => {
  test("nginx.conf and the Caddyfile each send exactly one policy", () => {
    expect(nginxHeaders.length).toBe(1);
    expect(caddyHeaders.length).toBe(1);
  });

  test("the three copies are the same policy", () => {
    const fromNginx = /"([^"]*)"/.exec(nginxHeaders[0] ?? "")?.[1];
    const fromCaddy = /"([^"]*)"/.exec(caddyHeaders[0] ?? "")?.[1];
    expect(fromNginx).toBe(WEBSITE_CSP);
    expect(fromCaddy).toBe(WEBSITE_CSP);
  });

  test("every directive holds exactly its approved sources", () => {
    expect(unapproved(WEBSITE_CSP)).toEqual([]);
  });

  test("the deposit wallet kit's Reown sources are in place (1615)", () => {
    const d = directives(WEBSITE_CSP);
    for (const src of REOWN_CONNECT) expect(d["connect-src"]).toContain(src);
    expect(d["frame-src"]).toContain("https://verify.walletconnect.org");
    expect(d["font-src"]).toContain("https://fonts.reown.com");
    // The kit's email and social login are off: its secure frame is not approved.
    expect(d["frame-src"]).not.toContain("https://secure.walletconnect.org");
  });

  test("an unapproved external origin fails the check (planted control)", () => {
    const planted = WEBSITE_CSP.replace("connect-src 'self'", "connect-src 'self' https://example.com");
    expect(planted).not.toBe(WEBSITE_CSP);
    expect(unapproved(planted)).toEqual([
      expect.stringContaining("connect-src: 'self' https://example.com"),
    ]);
    const extraDirective = `${WEBSITE_CSP}; worker-src https://example.com`;
    expect(unapproved(extraDirective)).toEqual(["worker-src: not an approved directive"]);
  });
});
