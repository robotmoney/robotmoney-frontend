// Client-ip resolution for rate limiting and the comments/submissions
// ip_hash audit field. Split out of api/index.ts's Bun.serve fetch handler
// (PR #954, a pre-merge review finding on issue #892) so the header-parsing
// logic — the part a misconfigured or spoofed proxy actually exercises — is
// unit-testable without booting a real HTTP server or a real nginx hop.
//
// X-Forwarded-For is client-controlled and only trustworthy behind a KNOWN
// proxy, so it is honored ONLY when `trustProxy` is true (docker-compose.yml
// sets TRUST_PROXY=1 unconditionally because website-server/nginx.conf now
// sits in front of `api` for every request in every composition — issue
// #892). Taking the LAST hop is what makes this safe even when a client
// tries to spoof the header: nginx's `$proxy_add_x_forwarded_for` APPENDS the
// real connecting peer to whatever the client sent, so the last entry is
// always the proxy's own view of its immediate peer, never something the
// client fully controls.
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
function normalizeIp(addr: string): string {
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(addr);
  return m ? m[1] : addr;
}

export function resolveClientIp(
  peerAddress: string,
  trustProxy: boolean,
  forwardedFor: string | null,
): string {
  if (!trustProxy || !forwardedFor) return normalizeIp(peerAddress);
  const hops = forwardedFor.split(",").map((s) => s.trim()).filter(Boolean);
  const last = hops.pop();
  return normalizeIp(last || peerAddress);
}
