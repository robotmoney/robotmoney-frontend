// Client-ip resolution for rate limiting and the comments/submissions
// ip_hash audit field. Split out of api/index.ts's Bun.serve fetch handler
// (PR #954, a pre-merge review finding on issue #892) so the header-parsing
// logic — the part a misconfigured or spoofed proxy actually exercises — is
// unit-testable without booting a real HTTP server or a real nginx hop.
//
// Forwarded-client headers are client-controlled and only trustworthy behind a
// KNOWN proxy, so they are honored ONLY when `trustProxy` is true
// (docker-compose.yml sets TRUST_PROXY=1 unconditionally because
// website-server/nginx.conf sits in front of `api` for every request in every
// composition — issue #892). Two headers, in this order (issue #1095):
//   1. CF-Connecting-IP — what Cloudflare (D13) puts on every request it
//      proxies, and what nginx passes through untouched. It is the real client
//      whatever the number of hops between Cloudflare and this process.
//   2. X-Forwarded-For, LAST hop — but ONLY from a loopback peer. A proxy on
//      the same host is the one place the header is the proxy's own account of
//      its peer. From any other peer (a docker-network address, a LAN host, the
//      open internet if the port is ever published) the header is whatever the
//      sender wrote, and taking its last hop let that sender pick the identity
//      the rate limiter and the ip_hash audit field see. nginx's
//      `$proxy_add_x_forwarded_for` APPENDS the real peer, so the last entry is
//      the proxy's own view of its immediate peer, never something the client
//      fully controls: that held only while the sender really was nginx.
// The api port is unreachable except through the Cloudflare to nginx path (D58),
// so CF-Connecting-IP is always the value Cloudflare wrote.
// A trusted-proxy request with neither usable header is the raw peer.
//
// Bun's `server.requestIP(req).address` reports an IPv4 peer in its
// IPv4-mapped-IPv6 form ("::ffff:172.18.0.1"), while nginx's
// `$proxy_add_x_forwarded_for` (and any real client) writes plain dotted-quad
// ("172.18.0.1") into X-Forwarded-For. Verified live against a real
// `docker compose up postgres api website-server` + a real nginx hop
// (PR #954's fix commit): the SAME docker-gateway address round-tripped as
// two DIFFERENT ip_hash values — one direct-to-api, one via website-server —
// purely from this formatting mismatch, which would have silently split one
// real identity's rate-limit bucket/audit trail in two. normalizeIp() strips
// the "::ffff:" prefix so both paths hash identically for the same address.
import { isIP } from "node:net";

function normalizeIp(addr: string): string {
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(addr);
  return m ? m[1] : addr;
}

function isLoopback(addr: string): boolean {
  return addr === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

export function resolveClientIp(
  peerAddress: string,
  trustProxy: boolean,
  forwardedFor: string | null,
  cfConnectingIp: string | null = null,
): string {
  const peer = normalizeIp(peerAddress);
  if (!trustProxy) return peer;
  const cf = cfConnectingIp?.trim();
  if (cf && isIP(cf) !== 0) return normalizeIp(cf);
  if (forwardedFor && isLoopback(peer)) {
    const hops = forwardedFor.split(",").map((s) => s.trim()).filter(Boolean);
    const last = hops.pop();
    if (last) return normalizeIp(last);
  }
  return peer;
}
