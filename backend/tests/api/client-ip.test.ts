// PR #954 pre-merge review finding on issue #892: website-server (nginx) now
// fronts `api` for EVERY request in every composition, and TRUST_PROXY was
// never wired through docker-compose.yml — clientIp silently collapsed to
// website-server's own docker-network address for every request, breaking
// per-IP rate limiting and the comments/submissions ip_hash audit field with
// no error. These are pure-function tests of the parsing/trust logic itself
// (backend/src/api/client-ip.ts); the "does a real nginx hop actually forward
// the header, and does compose actually deliver TRUST_PROXY=1" halves are
// covered separately — the compose delivery half by
// scripts/tests/integration/smoke-compose-config.test.ts's "TRUST_PROXY
// reaches the api container" describe block, and the real-nginx-hop half was
// verified manually (see this PR's fix commit) against a live
// `docker compose up postgres api website-server` — booting a real nginx
// container inside this suite is disproportionate to what a unit test buys
// here over the manual verification already performed.
//
// Issue #1095 changed the trust rule, and the cases below follow it: under
// TRUST_PROXY=1 CF-Connecting-IP is read first, and X-Forwarded-For (last hop)
// is honored only from a LOOPBACK peer. From any other peer it is ignored, so a
// sender that is not the local proxy cannot choose the identity the shared
// public-analytics rate limiter and the ip_hash audit field see. The matching
// nginx half (CF-Connecting-IP is passed through only from a Cloudflare or
// same-host peer and overwritten with the peer address otherwise) is pinned by
// scripts/tests/unit/website-server-client-ip.test.ts.
import { expect, test } from "bun:test";
import { resolveClientIp } from "../../src/api/client-ip.ts";

const PEER = "172.20.0.7"; // stand-in for website-server's own docker-network address
const LOOPBACK = "127.0.0.1"; // a proxy on the same host

test("trustProxy false: always the raw peer, even with forwarded headers present", () => {
  expect(resolveClientIp(PEER, false, "203.0.113.9")).toBe(PEER);
  expect(resolveClientIp(PEER, false, "203.0.113.9", "198.51.100.1")).toBe(PEER);
  expect(resolveClientIp(PEER, false, null)).toBe(PEER);
});

test("trustProxy true, no forwarded header: falls back to the raw peer", () => {
  expect(resolveClientIp(PEER, true, null)).toBe(PEER);
  expect(resolveClientIp(PEER, true, "")).toBe(PEER);
  expect(resolveClientIp(LOOPBACK, true, null)).toBe(LOOPBACK);
});

test("trustProxy true: CF-Connecting-IP is the client, whatever the peer", () => {
  expect(resolveClientIp(PEER, true, null, "203.0.113.9")).toBe("203.0.113.9");
  expect(resolveClientIp(PEER, true, "1.1.1.1, 2.2.2.2", "203.0.113.9")).toBe("203.0.113.9");
  expect(resolveClientIp(LOOPBACK, true, "1.1.1.1", "203.0.113.9")).toBe("203.0.113.9");
  expect(resolveClientIp(PEER, true, null, "2001:db8::1")).toBe("2001:db8::1");
});

test("trustProxy false: CF-Connecting-IP is not read", () => {
  expect(resolveClientIp(PEER, false, null, "203.0.113.9")).toBe(PEER);
});

test("trustProxy true: a CF-Connecting-IP that is not an ip address is ignored", () => {
  expect(resolveClientIp(PEER, true, null, "not-an-ip")).toBe(PEER);
  expect(resolveClientIp(PEER, true, null, "9.9.9.9, 8.8.8.8")).toBe(PEER);
  expect(resolveClientIp(PEER, true, null, "   ")).toBe(PEER);
});

test("trustProxy true, X-Forwarded-For from a NON-loopback peer is ignored", () => {
  // The regression issue #1095 closes: any sender that reaches the api over the
  // network could write this header and pick its own identity.
  expect(resolveClientIp(PEER, true, "203.0.113.9")).toBe(PEER);
  expect(resolveClientIp(PEER, true, "9.9.9.9, 198.51.100.4")).toBe(PEER);
  expect(resolveClientIp("203.0.113.50", true, "9.9.9.9")).toBe("203.0.113.50");
  expect(resolveClientIp("2001:db8::5", true, "9.9.9.9")).toBe("2001:db8::5");
});

test("trustProxy true, X-Forwarded-For from a loopback peer: the LAST hop is the client", () => {
  expect(resolveClientIp(LOOPBACK, true, "203.0.113.9")).toBe("203.0.113.9");
  expect(resolveClientIp("::1", true, "203.0.113.9")).toBe("203.0.113.9");
  expect(resolveClientIp("::ffff:127.0.0.1", true, "203.0.113.9")).toBe("203.0.113.9");
  // The proxy APPENDS the peer it saw, so a client-supplied prefix never wins.
  expect(resolveClientIp(LOOPBACK, true, "1.1.1.1, 2.2.2.2, 203.0.113.9")).toBe("203.0.113.9");
  expect(resolveClientIp(LOOPBACK, true, "9.9.9.9, 198.51.100.4")).toBe("198.51.100.4");
});

test("trustProxy true, loopback peer, header with stray whitespace and empty segments: trims and skips them", () => {
  expect(resolveClientIp(LOOPBACK, true, " 1.1.1.1 ,  , 203.0.113.9  ")).toBe("203.0.113.9");
});

test("trustProxy true, loopback peer, header of only whitespace/commas: falls back to the peer", () => {
  expect(resolveClientIp(LOOPBACK, true, " , , ")).toBe(LOOPBACK);
});

// Discovered by live reproduction (see client-ip.ts's comment): Bun's raw
// peer comes back IPv4-mapped ("::ffff:x.x.x.x"), nginx writes plain
// dotted-quad — same address, and it must hash the same either way, or the same
// real client splits into two identities depending on which path resolved it.
test("an IPv4-mapped-IPv6 peer normalizes to plain dotted-quad on the raw-peer fallback", () => {
  expect(resolveClientIp("::ffff:172.18.0.1", false, null)).toBe("172.18.0.1");
  expect(resolveClientIp("::ffff:172.18.0.1", true, null)).toBe("172.18.0.1");
});

test("the SAME address hashes identically whether it arrives as the raw peer or as the trusted CF-Connecting-IP header", () => {
  const direct = resolveClientIp("::ffff:172.18.0.1", false, null);
  const viaProxy = resolveClientIp("::ffff:172.20.0.4", true, null, "172.18.0.1");
  expect(viaProxy).toBe(direct);
  expect(resolveClientIp("::ffff:172.20.0.4", true, null, "::ffff:172.18.0.1")).toBe(direct);
});

test("a genuine IPv6 peer (no IPv4-mapped prefix) passes through untouched", () => {
  expect(resolveClientIp("2001:db8::1", false, null)).toBe("2001:db8::1");
  expect(resolveClientIp(PEER, true, null, "2001:db8::1")).toBe("2001:db8::1");
  expect(resolveClientIp(LOOPBACK, true, "2001:db8::1")).toBe("2001:db8::1");
});
