// website-server/nginx.conf is the half of client-ip resolution that
// backend/tests/api/client-ip.test.ts cannot see (issue #1095, PR #1109 review):
// the api trusts CF-Connecting-IP from its one peer, nginx, so nginx must only
// forward Cloudflare's value when the request really came from Cloudflare (its
// published edge ranges) or from this host (the cloudflared tunnel reaches nginx
// from the docker gateway), and must overwrite it with the peer address from
// anyone else. Without that, a client that reaches the published website-server
// port directly picks its own identity for the rate limiters and the ip_hash
// audit field, and a stack with no Cloudflare in front collapses every client to
// nginx's address. Checkout-only: this reads the file; the integration tier
// (scripts/tests/integration/website-server-image.test.ts) builds the image,
// where `nginx -t` would reject a malformed block.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const conf = readFileSync(join(import.meta.dir, "../../../website-server/nginx.conf"), "utf8");
const stripped = conf.replace(/^\s*#.*$/gm, "");

function block(name: RegExp): string {
  const m = stripped.match(name);
  if (!m) throw new Error(`no ${name} block in nginx.conf`);
  return m[0];
}

describe("website-server/nginx.conf: CF-Connecting-IP is nginx's account of the client", () => {
  const geo = block(/geo\s+\$cf_trusted_peer\s*\{[^}]*\}/);
  const map = block(/map\s+"\$cf_trusted_peer:\$http_cf_connecting_ip"\s+\$client_ip\s*\{[^}]*\}/);

  test("the api location sets CF-Connecting-IP from the map on every proxied request", () => {
    const api = block(/location\s+\^~\s+\/api\/\s*\{[^}]*\}/);
    expect(api).toMatch(/proxy_set_header\s+CF-Connecting-IP\s+\$client_ip;/);
    // The header is SET (overwritten), never passed through conditionally.
    expect(api).not.toMatch(/proxy_pass_request_headers|\$http_cf_connecting_ip/);
  });

  test("untrusted peers default to 0 and the map falls back to the peer address", () => {
    expect(geo).toMatch(/default\s+0;/);
    expect(map).toMatch(/default\s+\$remote_addr;/);
    // Only a trusted peer WITH a non-empty header gets Cloudflare's value.
    expect(map).toMatch(/"~\^1:\.\+\$"\s+\$http_cf_connecting_ip;/);
  });

  test("trusted peers are loopback, this host's private ranges, and Cloudflare's published ranges", () => {
    for (const cidr of ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]) {
      expect(geo).toContain(`${cidr} 1;`);
    }
    // https://www.cloudflare.com/ips-v4 and /ips-v6 as of 2026-10-05.
    const v4 = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"];
    const v6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];
    for (const cidr of [...v4, ...v6]) expect(geo).toContain(`${cidr} 1;`);
    // And nothing public beyond those: every trusted entry is one of the above.
    const entries = [...geo.matchAll(/^\s*([0-9a-f.:/]+)\s+1;/gim)].map((m) => m[1]!);
    expect(entries.sort()).toEqual(["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", ...v4, ...v6].sort());
  });

  test("geo and map sit outside the server block (http context, where nginx requires them)", () => {
    expect(stripped.indexOf("geo $cf_trusted_peer")).toBeLessThan(stripped.indexOf("server {"));
    expect(stripped.indexOf("map \"$cf_trusted_peer")).toBeLessThan(stripped.indexOf("server {"));
  });
});
