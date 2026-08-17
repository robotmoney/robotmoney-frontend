// Issue #325: the swarm-apply payload is deliberately minimal
// ({name, contact, lens?, publicKey}, §11 R6, D21), so there is no other
// route by which an admitted member ever acquires a tagline/mandate/biases/
// voiceMd/mode/operator/avatar. This exercises the self-service fill-in route
// the issue recommends (option B): POST /api/swarm/members/:id/profile,
// behind the member's own bearer token, both at the domain layer
// (ic.updateMemberProfile) and over the real HTTP dispatcher (handleSwarm)
// so a route-level regression (path parsing, bearer extraction, JSON body
// validation) is caught too, not just the domain function in isolation.
import { test, expect, beforeAll } from "bun:test";
import * as ic from "../src/swarm/domain.ts";
import { path as routePath, ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// Own database per file, cloned from the migrated template — the roster this
// file admits into is its own, with no reset of anyone else's rows.
useCleanDatabase(import.meta.file);

// registerMember is the privileged apply+activate shortcut (demo/E2E harness) —
// it mints an ACTIVE member with an ACTIVE key + bearer token in one shot, the
// same end state `apply → admin activate → claim` produces for a real member.
async function activeMember() {
  const id = rid("m");
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: `pk_${id}` });
  // registerMember returns {ok:false, status, error} (not a token) when the
  // roster cap is hit — fail loudly here rather than let a bogus token flow
  // downstream to a confusing auth failure far from the real cause.
  if (!("token" in r) || !r.token) throw new Error(`activeMember(): registerMember failed for ${id}: ${JSON.stringify(r)}`);
  return { id, token: r.token };
}

function postProfile(id: string, token: string | null, body: unknown) {
  const req = new Request(`http://test${routePath(ROUTES.swarm.memberProfile, { id })}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return handleSwarm(req, new URL(req.url));
}

test("updateMemberProfile writes only the fields present in the patch, leaving the rest untouched", async () => {
  const member = await activeMember();
  // Every profile field is null on a freshly-admitted member — this is
  // exactly the bug the issue describes.
  const before = await ic.getMember(member.id);
  expect(before?.tagline).toBeNull();
  expect(before?.mandate).toBeNull();
  expect(before?.biases).toBeNull();

  const first = await ic.updateMemberProfile(member.token, member.id, {
    tagline: "Risk officer. Reads the composite.",
    biases: ["pro-diversification", "anti-reflexivity"],
  });
  expect(first.status).toBe(200);
  expect((first as any).member.tagline).toBe("Risk officer. Reads the composite.");
  expect((first as any).member.biases).toEqual(["pro-diversification", "anti-reflexivity"]);
  expect((first as any).member.mandate).toBeNull(); // untouched

  // A second, disjoint patch must not clobber the first write's fields.
  const second = await ic.updateMemberProfile(member.token, member.id, {
    mandate: "Read the subject's portfolio for what breaks.",
    mode: "pull",
    operator: "robotmoney",
  });
  expect(second.status).toBe(200);
  const after = await ic.getMember(member.id);
  expect(after?.tagline).toBe("Risk officer. Reads the composite."); // still there
  expect(after?.biases).toEqual(["pro-diversification", "anti-reflexivity"]); // still there
  expect(after?.mandate).toBe("Read the subject's portfolio for what breaks.");
  expect(after?.mode).toBe("pull");
  expect(after?.operator).toBe("robotmoney");
});

test("updateMemberProfile rejects an unknown/invalid token (401) and a token/member mismatch (403)", async () => {
  const a = await activeMember();
  const b = await activeMember();

  const noToken = await ic.updateMemberProfile("not-a-real-token", a.id, { tagline: "x" });
  expect(noToken.status).toBe(401);

  // b's token is valid, but it may not write a's profile.
  const mismatched = await ic.updateMemberProfile(b.token, a.id, { tagline: "x" });
  expect(mismatched.status).toBe(403);

  // a's own row is untouched by the rejected attempts.
  const row = await ic.getMember(a.id);
  expect(row?.tagline).toBeNull();
});

test("POST /api/swarm/members/:id/profile over the real route: 401 without a bearer token, 403 for another member's id, 200 for its own", async () => {
  const a = await activeMember();
  const b = await activeMember();

  const missing = await postProfile(a.id, null, { tagline: "hello" });
  expect(missing?.status).toBe(401);

  const wrongOwner = await postProfile(a.id, b.token, { tagline: "hello" });
  expect(wrongOwner?.status).toBe(403);

  const ok = await postProfile(a.id, a.token, {
    tagline: "peaq's first non-human team member.",
    mandate: "Evaluate the subject as a fellow agent in the machine economy.",
    biases: ["pro-machine-economy", "open-about-self-interest"],
    voiceMd: "# Voice\nlowercase throughout, no terminal periods.",
    mode: "pull",
    operator: "peaq",
    avatar: { path: "/avatars/swarm/a.jpg", source_url: null, credit: "test" },
  });
  expect(ok?.status).toBe(200);
  expect((ok?.body as any).member.tagline).toBe("peaq's first non-human team member.");
  expect((ok?.body as any).member.avatar).toEqual({ path: "/avatars/swarm/a.jpg", source_url: null, credit: "test" });

  // GET /api/swarm/members/:id now reflects the profile — the exact
  // content-parity gap the issue reports (previously null for every
  // API-created member).
  const fetched = await handleSwarm(
    new Request(`http://test${routePath(ROUTES.swarm.member, { id: a.id })}`),
    new URL(`http://test${routePath(ROUTES.swarm.member, { id: a.id })}`),
  );
  expect((fetched?.body as any).mandate).toBe("Evaluate the subject as a fellow agent in the machine economy.");
  expect((fetched?.body as any).mode).toBe("pull");
});

test("POST /api/swarm/members/:id/profile rejects unknown fields, an empty body, and malformed biases/avatar", async () => {
  const member = await activeMember();

  const unknownField = await postProfile(member.id, member.token, { name: "not allowed here" });
  expect(unknownField?.status).toBe(400);
  expect((unknownField?.body as any).error).toContain("unknown field");

  const empty = await postProfile(member.id, member.token, {});
  expect(empty?.status).toBe(400);

  const badBiases = await postProfile(member.id, member.token, { biases: "not-an-array" });
  expect(badBiases?.status).toBe(400);

  const badBiasesEntry = await postProfile(member.id, member.token, { biases: ["ok", 42] });
  expect(badBiasesEntry?.status).toBe(400);

  const badAvatar = await postProfile(member.id, member.token, { avatar: ["not", "an", "object"] });
  expect(badAvatar?.status).toBe(400);

  const emptyTagline = await postProfile(member.id, member.token, { tagline: "   " });
  expect(emptyTagline?.status).toBe(400);

  // None of the rejected attempts wrote anything.
  const row = await ic.getMember(member.id);
  expect(row?.tagline).toBeNull();
  expect(row?.biases).toBeNull();
});
