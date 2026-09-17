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
import { expect, test } from "bun:test";
import { resolveClientIp } from "../../src/api/client-ip.ts";

const PEER = "172.20.0.7"; // stand-in for website-server's own docker-network address

test("trustProxy false: always the raw peer, even with a forwarded header present", () => {
  expect(resolveClientIp(PEER, false, "203.0.113.9")).toBe(PEER);
  expect(resolveClientIp(PEER, false, null)).toBe(PEER);
});

test("trustProxy true, no forwarded header: falls back to the raw peer", () => {
  expect(resolveClientIp(PEER, true, null)).toBe(PEER);
  expect(resolveClientIp(PEER, true, "")).toBe(PEER);
});

test("trustProxy true, single-hop header: the forwarded address wins over the peer", () => {
  // This is the exact regression: the peer here is website-server's own
  // address, and the real client (203.0.113.9) must win once trusted.
  expect(resolveClientIp(PEER, true, "203.0.113.9")).toBe("203.0.113.9");
});

test("trustProxy true, multi-hop header: takes the LAST hop (the proxy's own view of its immediate peer)", () => {
  // nginx's $proxy_add_x_forwarded_for APPENDS the real connecting peer to
  // whatever arrived, so a client-supplied prefix can never win — only the
  // proxy's own appended entry (the last one) is trusted.
  expect(resolveClientIp(PEER, true, "1.1.1.1, 2.2.2.2, 203.0.113.9")).toBe("203.0.113.9");
});

test("trustProxy true: a client trying to spoof its own X-Forwarded-For cannot claim an arbitrary identity", () => {
  // An attacker sends "X-Forwarded-For: 9.9.9.9" directly; nginx appends the
  // attacker's real peer as seen at nginx's own socket, so the header nginx
  // forwards to api is "9.9.9.9, <attacker's real address as seen by nginx>"
  // — the last hop, not the attacker's claimed 9.9.9.9, is what must be used.
  expect(resolveClientIp(PEER, true, "9.9.9.9, 198.51.100.4")).toBe("198.51.100.4");
});

test("trustProxy true, header with stray whitespace and empty segments: trims and skips them", () => {
  expect(resolveClientIp(PEER, true, " 1.1.1.1 ,  , 203.0.113.9  ")).toBe("203.0.113.9");
});

test("trustProxy true, header of only whitespace/commas: falls back to the peer", () => {
  expect(resolveClientIp(PEER, true, " , , ")).toBe(PEER);
});

// Discovered by live reproduction (see client-ip.ts's comment): Bun's raw
// peer comes back IPv4-mapped ("::ffff:x.x.x.x"), nginx's X-Forwarded-For
// writes plain dotted-quad — same address, and it must hash the same either
// way, or the same real client splits into two identities depending on
// whether it happened to hit the raw-peer fallback or the trusted header.
test("an IPv4-mapped-IPv6 peer normalizes to plain dotted-quad on the raw-peer fallback", () => {
  expect(resolveClientIp("::ffff:172.18.0.1", false, null)).toBe("172.18.0.1");
  expect(resolveClientIp("::ffff:172.18.0.1", true, null)).toBe("172.18.0.1");
});

test("the SAME address hashes identically whether it arrives as the raw peer or as the trusted forwarded header", () => {
  const direct = resolveClientIp("::ffff:172.18.0.1", false, null);
  const viaProxy = resolveClientIp("::ffff:172.20.0.4", true, "172.18.0.1");
  expect(viaProxy).toBe(direct);
});

test("a genuine IPv6 peer (no IPv4-mapped prefix) passes through untouched", () => {
  expect(resolveClientIp("2001:db8::1", false, null)).toBe("2001:db8::1");
  expect(resolveClientIp(PEER, true, "2001:db8::1")).toBe("2001:db8::1");
});
