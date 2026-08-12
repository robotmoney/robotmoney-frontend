import { expect, test } from "bun:test";
import {
  CONTACT_EMAIL_RE,
  parseApply,
  parseSigningDraft,
  parseSubmission,
  validateMemberAdminPatch,
  validateMemberProfile,
  validateSigningDraft,
  validateSubmission,
} from "../src/api/validation.ts";

test("swarm request parsers reject malformed and out-of-range input", () => {
  // §11 R2/R6: apply carries no client memberId; a signature is mandatory.
  expect(parseApply({ name: "A", contact: "a@example.test", publicKey: "key" })).toBeNull(); // missing signature
  expect(parseApply({ name: "A", publicKey: "key", signature: "sig" })).toBeNull(); // missing contact
  expect(parseSubmission({
    memberId: "a",
    date: "not-a-date",
    subjectId: "s",
    nonce: "n",
    stance: "neutral",
    confidence: 0.5,
    signature: "sig",
  })).toBeNull();
  expect(parseSubmission({
    memberId: "a",
    date: "2026-07-01",
    subjectId: "s",
    nonce: "n",
    stance: "neutral",
    confidence: 2,
    signature: "sig",
  })).toBeNull();
});

test("signing drafts and submissions share normalized fields", () => {
  const draft = {
    memberId: " athena ",
    date: "2026-07-01",
    subjectId: "woon",
    nonce: "nonce",
    stance: "constructive",
    confidence: 0.75,
    body: " analysis ",
    weights: [{ bucket: " agents ", weight: 1 }, { bucket: "cash", weight: 3 }],
  };
  expect(parseSigningDraft(draft)?.memberId).toBe("athena");
  expect(parseSigningDraft(draft)?.weights).toEqual([{ bucket: "agents", weight: 1 }, { bucket: "cash", weight: 3 }]);
  expect(parseSubmission({ ...draft, signature: "signature" })?.body).toBe("analysis");
});

test("weight validation requires distinct buckets, non-negative finite values, and a positive total", () => {
  const draft = {
    memberId: "athena", date: "2026-07-01", subjectId: "woon", nonce: "nonce",
    stance: "constructive", confidence: 0.75,
  };
  expect(parseSigningDraft({ ...draft, weights: [{ bucket: "cash", weight: -1 }] })).toBeNull();
  expect(parseSigningDraft({ ...draft, weights: [{ bucket: "cash", weight: 0 }] })).toBeNull();
  expect(parseSigningDraft({ ...draft, weights: [{ bucket: "cash", weight: 1 }, { bucket: "cash", weight: 2 }] })).toBeNull();
});

test("strict stance string validation accepts valid vocabulary and rejects unknown stances", () => {
  const validDraft = {
    memberId: "cygnus", date: "2026-09-25", subjectId: "woon", nonce: "n1",
    stance: "bullish", confidence: 0.7,
  };
  const validStances = ["bearish", "cautious", "neutral", "constructive", "bullish"];
  for (const stance of validStances) {
    expect(parseSigningDraft({ ...validDraft, stance })).not.toBeNull();
  }

  const invalidRes = validateSigningDraft({ ...validDraft, stance: "wildly-bullish" });
  expect(invalidRes.ok).toBe(false);
  if (!invalidRes.ok) {
    expect(invalidRes.error).toBe("stance must be one of bearish, cautious, neutral, constructive, bullish");
  }

  const invalidSub = validateSubmission({ ...validDraft, signature: "sig", stance: "<script>alert(1)</script>" });
  expect(invalidSub.ok).toBe(false);
  if (!invalidSub.ok) {
    expect(invalidSub.error).toBe("stance must be one of bearish, cautious, neutral, constructive, bullish");
  }
});

test("unknown top-level fields are rejected with clear error message", () => {
  const draft = {
    memberId: "cygnus", date: "2026-09-25", subjectId: "woon", nonce: "n1",
    summary: "my analysis", stance: "bullish", confidence: 0.7,
  };
  const draftRes = validateSigningDraft(draft);
  expect(draftRes.ok).toBe(false);
  if (!draftRes.ok) {
    expect(draftRes.error).toBe("unknown field: summary");
  }

  const subRes = validateSubmission({ ...draft, signature: "sig" });
  expect(subRes.ok).toBe(false);
  if (!subRes.ok) {
    expect(subRes.error).toBe("unknown field: summary");
  }
});


// ── Admin member edit patch (issue #567) ────────────────────────────────────
// The whole point of this validator is the two ways it differs from
// validateMemberProfile: it OWNS the three fields self-service refuses, and it
// treats an explicit `null` as a CLEAR rather than a malformed value.

test("admin member patch owns name/lens/contactEmail, which self-service profile refuses", () => {
  for (const key of ["name", "lens", "contactEmail"] as const) {
    const value = key === "contactEmail" ? "ops@example.test" : "a value";

    const adminRes = validateMemberAdminPatch({ [key]: value });
    expect(adminRes.ok).toBe(true);
    if (adminRes.ok) expect(adminRes.data[key]).toBe(value);

    // The same key is an unknown field on the member's own route — the two
    // validators are deliberately not a superset/subset pair.
    const selfRes = validateMemberProfile({ [key]: value });
    expect(selfRes.ok).toBe(false);
    if (!selfRes.ok) expect(selfRes.error).toBe(`unknown field: ${key}`);
  }
});

test("admin member patch accepts every editable field in one body, normalized", () => {
  const res = validateMemberAdminPatch({
    handle: "noop-analyst",
    name: "  Woon  ",
    lens: "machine economy, first person",
    contactEmail: "woon@peaq.test",
    tagline: "peaq's social media intern",
    mandate: "watch the machine economy",
    biases: ["  never-sells-agent-tokens  ", "openly-conflicted"],
    voiceMd: "# voice",
    mode: "self-advocacy",
    operator: "peaq",
    avatar: { path: "/img/woon.png" },
  });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.data).toEqual({
    handle: "noop-analyst",
    name: "Woon",
    lens: "machine economy, first person",
    contactEmail: "woon@peaq.test",
    tagline: "peaq's social media intern",
    mandate: "watch the machine economy",
    biases: ["never-sells-agent-tokens", "openly-conflicted"],
    voiceMd: "# voice",
    mode: "self-advocacy",
    operator: "peaq",
    avatar: { path: "/img/woon.png" },
  });
});

test("admin member patch: explicit null is a CLEAR on every nullable field, and absent is absent", () => {
  const nullable = ["lens", "contactEmail", "tagline", "mandate", "biases", "voiceMd", "mode", "operator", "avatar"] as const;
  for (const key of nullable) {
    const res = validateMemberAdminPatch({ [key]: null });
    expect(res.ok).toBe(true);
    // `null` must survive as a PRESENT key holding null — the store's
    // `!== undefined` merge is what turns that into a real column clear, and
    // it can only do so if the validator keeps the key.
    if (res.ok) {
      expect(Object.keys(res.data)).toEqual([key]);
      expect((res.data as Record<string, unknown>)[key]).toBeNull();
    }
  }

  // name is the one field with no null: swarm_members.name is NOT NULL.
  const nameNull = validateMemberAdminPatch({ name: null });
  expect(nameNull.ok).toBe(false);
  if (!nameNull.ok) expect(nameNull.error).toBe("name must be a non-empty string up to 200 chars");
});

test("admin member patch rejects an unknown field, an empty body, and a null body", () => {
  const unknown = validateMemberAdminPatch({ status: "active" });
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.error).toBe("unknown field: status");

  // `slug` was the name this field went by before it existed. It is NOT a
  // column and never became one — the public name is `handle` (issue #593) —
  // so it must still fail as an unknown field rather than silently reaching an
  // UPDATE that names a column Postgres does not have.
  const slug = validateMemberAdminPatch({ slug: "woon" });
  expect(slug.ok).toBe(false);
  if (!slug.ok) expect(slug.error).toBe("unknown field: slug");

  const empty = validateMemberAdminPatch({});
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.error).toBe("at least one field required");

  const nullBody = validateMemberAdminPatch(null);
  expect(nullBody.ok).toBe(false);
  if (!nullBody.ok) expect(nullBody.error).toBe("invalid member patch");
});

// ── Public handle vs immutable id (issue #593) ──────────────────────────────
// The whole separation is only worth anything if the two validators disagree
// about `handle` — the admin one owns it, the member's own route refuses it.
// Both halves are asserted here, in one file, so neither can drift alone.

test("admin member patch accepts a well-formed handle and rejects every malformed shape", () => {
  for (const good of ["noop-analyst", "woon", "a", "member-7", "x1-y2-z3"]) {
    const res = validateMemberAdminPatch({ handle: good });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.handle).toBe(good);
  }

  // Each of these would either need percent-encoding in a URL, collide with a
  // visually identical sibling, or read as a display name rather than an
  // address.
  const bad = [
    "Noop Analyst",   // spaces
    "NoopAnalyst",    // uppercase
    "noop_analyst",   // underscore
    "-noop",          // leading hyphen
    "noop-",          // trailing hyphen
    "noop--analyst",  // doubled hyphen
    "noop/analyst",   // path separator
    "noop.analyst",   // dot
    "",               // empty
    "   ",            // whitespace only
    "a".repeat(81),   // over the 80-char bound
  ];
  for (const value of bad) {
    const res = validateMemberAdminPatch({ handle: value });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("handle must be lowercase kebab-case, up to 80 chars (for example noop-analyst)");
    }
  }
});

test("admin member patch refuses to CLEAR the handle — a member with no public address is unreachable", () => {
  // Every other optional field takes null as a clear. This one cannot: it is
  // the URL segment, and swarm_members.handle is NOT NULL (migration 0030).
  const res = validateMemberAdminPatch({ handle: null });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.error).toBe("handle must be lowercase kebab-case, up to 80 chars (for example noop-analyst)");
  }
});

test("self-service profile REFUSES handle by name, not as an accidental unknown key", () => {
  // The refusal is explicit (api/validation.ts names `handle` before the
  // unknown-key sweep) because the generic "unknown field: handle" reads like a
  // typo, and a member trying to rename its own public URL is not making one.
  const res = validateMemberProfile({ handle: "stolen-name" });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.error).toBe("handle is administrator-managed and cannot be set from a member profile update");
  }

  // …and it refuses even when smuggled alongside fields the member DOES own,
  // rather than quietly applying those and dropping the handle.
  const mixed = validateMemberProfile({ tagline: "a legitimate edit", handle: "stolen-name" });
  expect(mixed.ok).toBe(false);
  if (!mixed.ok) {
    expect(mixed.error).toBe("handle is administrator-managed and cannot be set from a member profile update");
  }
});

test("admin member patch rejects a malformed email, keeping apply and the admin route on one regex", () => {
  for (const bad of ["not-an-email", "no@dot", "spaces in@example.test", "@example.test", ""]) {
    const res = validateMemberAdminPatch({ contactEmail: bad });
    expect(res.ok).toBe(false);
  }
  const res = validateMemberAdminPatch({ contactEmail: "woon@peaq.test" });
  expect(res.ok).toBe(true);

  // The exported regex IS the one routes/swarm.ts's apply handler now tests
  // against, so the two surfaces cannot drift apart on what an address is.
  expect(CONTACT_EMAIL_RE.test("woon@peaq.test")).toBe(true);
  expect(CONTACT_EMAIL_RE.test("no@dot")).toBe(false);
});

test("admin member patch rejects a malformed biases shape and a malformed avatar", () => {
  for (const bad of ["a string", [], [""], ["ok", 7], ["x".repeat(201)], Array(21).fill("b")]) {
    const res = validateMemberAdminPatch({ biases: bad });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("biases must be an array");
  }
  const ok = validateMemberAdminPatch({ biases: ["long-the-machines"] });
  expect(ok.ok).toBe(true);

  for (const bad of ["a string", ["array"], 7, { big: "x".repeat(6000) }]) {
    const res = validateMemberAdminPatch({ avatar: bad });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("avatar must be a JSON object");
  }
});

test("admin member patch rejects an over-long or blank value on every text field", () => {
  const limits: [string, number][] = [
    ["name", 200], ["lens", 500], ["tagline", 300], ["mandate", 4000],
    ["voiceMd", 20_000], ["mode", 100], ["operator", 200], ["contactEmail", 320],
  ];
  for (const [key, max] of limits) {
    expect(validateMemberAdminPatch({ [key]: "x".repeat(max + 1) }).ok).toBe(false);
    expect(validateMemberAdminPatch({ [key]: "   " }).ok).toBe(false);
    expect(validateMemberAdminPatch({ [key]: 7 }).ok).toBe(false);
  }
});
