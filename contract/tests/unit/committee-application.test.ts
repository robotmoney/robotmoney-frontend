// Stage 0 (docs/plans/onboarding-ic-workflow.md Phase 1 / docs/architecture.md
// §11 R6) — canonical committee-application serialization + the shared
// onboarding prompt/step-list constants. This is the foundation every later
// stage (backend verify, rmpc Rust signer, frontend apply page, docs) imports,
// so it is pinned here first.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPLY_HOW_TO_STEPS,
  COMMITTEE_ONBOARDING_SKILL_URL,
  ONBOARDING_PROMPT,
  canonicalizeApplication,
} from "../../src/committee-application.js";
import { path, ROUTES } from "../../src/routes.js";

const FIXTURES_PATH = join(import.meta.dir, "../../src/__fixtures__/committee-application.json");

type GoldenVector = {
  name: string;
  payload: { name: string; contact: string; lens?: string; publicKey: string };
  expectedCanonicalJson: string;
  expectedBytesHex: string;
};

function loadGoldens(): { description: string; vectors: GoldenVector[] } {
  return JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));
}

const basePayload = {
  name: "Nova Desk",
  contact: "nova@example.test",
  publicKey: "YmUwLbJYgrbWC5g6UJ+v4t8hVmCCPHeDhTYR5zdlxhA=",
};

describe("canonicalizeApplication — determinism", () => {
  test("same input produces identical bytes across repeated calls", () => {
    const a = canonicalizeApplication(basePayload);
    const b = canonicalizeApplication(basePayload);
    expect(a).toBe(b);
  });

  test("two structurally-equal but distinct objects produce identical bytes", () => {
    const a = canonicalizeApplication({ ...basePayload });
    const b = canonicalizeApplication({ ...basePayload });
    expect(a).toBe(b);
  });
});

describe("canonicalizeApplication — field-order independence", () => {
  test("re-ordering input keys does not change the canonical bytes", () => {
    const inOrder = canonicalizeApplication({
      name: "Nova Desk",
      contact: "nova@example.test",
      lens: "macro risk",
      publicKey: "pk-abc",
    });
    const reordered = canonicalizeApplication({
      publicKey: "pk-abc",
      lens: "macro risk",
      contact: "nova@example.test",
      name: "Nova Desk",
    } as any);
    expect(reordered).toBe(inOrder);
    // And the output itself has the fixed field order regardless of input order.
    expect(inOrder).toBe('{"name":"Nova Desk","contact":"nova@example.test","lens":"macro risk","publicKey":"pk-abc"}');
  });

  test("extraneous input properties are ignored, not leaked into the bytes", () => {
    const withExtra = canonicalizeApplication({ ...basePayload, extra: "should not appear", signature: "nope" } as any);
    const clean = canonicalizeApplication(basePayload);
    expect(withExtra).toBe(clean);
  });
});

describe("canonicalizeApplication — lens optionality", () => {
  test("lens omitted entirely is not present in the canonical bytes", () => {
    const canonical = canonicalizeApplication(basePayload);
    expect(canonical).not.toContain('"lens"');
    expect(canonical).toBe('{"name":"Nova Desk","contact":"nova@example.test","publicKey":"YmUwLbJYgrbWC5g6UJ+v4t8hVmCCPHeDhTYR5zdlxhA="}');
  });

  test("lens undefined behaves identically to lens omitted", () => {
    const omitted = canonicalizeApplication(basePayload);
    const explicitUndefined = canonicalizeApplication({ ...basePayload, lens: undefined });
    expect(explicitUndefined).toBe(omitted);
  });

  test("lens null behaves identically to lens omitted", () => {
    const omitted = canonicalizeApplication(basePayload);
    const explicitNull = canonicalizeApplication({ ...basePayload, lens: null } as any);
    expect(explicitNull).toBe(omitted);
  });

  test("a present (including empty-string) lens IS included, sitting between contact and publicKey", () => {
    const withLens = canonicalizeApplication({ ...basePayload, lens: "on-chain flows" });
    expect(withLens).toBe(
      '{"name":"Nova Desk","contact":"nova@example.test","lens":"on-chain flows","publicKey":"YmUwLbJYgrbWC5g6UJ+v4t8hVmCCPHeDhTYR5zdlxhA="}',
    );
    const withEmptyLens = canonicalizeApplication({ ...basePayload, lens: "" });
    expect(withEmptyLens).toContain('"lens":""');
  });

  test("tampering the lens after signing would change the bytes (lens is covered, not decorative)", () => {
    const a = canonicalizeApplication({ ...basePayload, lens: "macro risk" });
    const b = canonicalizeApplication({ ...basePayload, lens: "on-chain flows" });
    expect(a).not.toBe(b);
  });
});

describe("canonicalizeApplication — unicode / whitespace edge cases", () => {
  test("unicode name/contact/lens round-trip through JSON without mangling", () => {
    const canonical = canonicalizeApplication({
      name: "Növa Déskü 桌面 🤖",
      contact: "növa+桌面@exämple.test",
      lens: "on-chain flows ⚡",
      publicKey: "pk",
    });
    const parsed = JSON.parse(canonical);
    expect(parsed.name).toBe("Növa Déskü 桌面 🤖");
    expect(parsed.contact).toBe("növa+桌面@exämple.test");
    expect(parsed.lens).toBe("on-chain flows ⚡");
  });

  test("embedded quotes, backslashes, newlines, and tabs are escaped, not stripped", () => {
    const canonical = canonicalizeApplication({
      name: '  Leading/trailing\tspaces\nand "quotes" & <html> tags  ',
      contact: 'quote"back\\slash@example.test',
      lens: "line1\nline2",
      publicKey: "pk",
    });
    const parsed = JSON.parse(canonical);
    expect(parsed.name).toBe('  Leading/trailing\tspaces\nand "quotes" & <html> tags  ');
    expect(parsed.contact).toBe('quote"back\\slash@example.test');
    expect(parsed.lens).toBe("line1\nline2");
  });

  test("whitespace differences are NOT normalized away — distinct inputs stay distinct bytes", () => {
    const a = canonicalizeApplication({ ...basePayload, name: "Nova Desk" });
    const b = canonicalizeApplication({ ...basePayload, name: " Nova Desk " });
    expect(a).not.toBe(b);
  });
});

describe("canonicalizeApplication — golden vectors (Stage 3 rmpc/Rust byte-exactness proof)", () => {
  const { vectors } = loadGoldens();

  test("fixture file is non-empty and covers the documented edge cases", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(5);
    const names = vectors.map((v) => v.name);
    expect(names).toContain("basic-no-lens");
    expect(names).toContain("with-lens");
    expect(names).toContain("unicode-name-and-contact");
    expect(names).toContain("whitespace-and-punctuation-edge-cases");
  });

  for (const vector of vectors) {
    test(`golden vector "${vector.name}": JS serialization matches the committed bytes`, () => {
      const canonical = canonicalizeApplication(vector.payload);
      expect(canonical).toBe(vector.expectedCanonicalJson);
      const hex = Buffer.from(canonical, "utf8").toString("hex");
      expect(hex).toBe(vector.expectedBytesHex);
    });
  }
});

describe("ONBOARDING_PROMPT — canonical copy-paste prompt (R4)", () => {
  // This pin used to assert the OPPOSITE — that the prompt carries literal
  // `<display name>` / `<email>` blanks for the owner to fill in by hand. It
  // was inverted deliberately, as a product change, not to make a red test go
  // green: a tester pasted the prompt verbatim and applied under the literal
  // string "<display name>", which reached the server as a real application.
  // Identity is the human gate (R1), so the agent now ASKS for it instead of
  // the operator hand-editing text; robotmoney-core#1190 made the skill ask
  // too. What replaces it is strictly stronger than what it replaces: it bans
  // every angle-bracket blank, not just the two that happened to ship.
  test("is a single non-empty string that collects owner identity by asking, carrying no fill-in-the-blank placeholders", () => {
    expect(typeof ONBOARDING_PROMPT).toBe("string");
    expect(ONBOARDING_PROMPT.length).toBeGreaterThan(0);
    expect(ONBOARDING_PROMPT.toLowerCase()).toContain("ask me for");
    expect(ONBOARDING_PROMPT).not.toContain("<display name>");
    expect(ONBOARDING_PROMPT).not.toContain("<email>");
    expect(ONBOARDING_PROMPT).not.toMatch(/<[a-z][a-z ]*>/i);
  });

  test("points the agent at installing the committee-onboarding skill instead of embedding steps itself (R5 — never goes stale)", () => {
    expect(ONBOARDING_PROMPT).toContain("committee-onboarding");
    expect(ONBOARDING_PROMPT).toContain("rmpc");
  });
});

// ── Refusal-answering bounds (§11.3 E7) ────────────────────────────────────
// The layered onboarding eval recorded real REFUSALS of this prompt (twice —
// see the header comment on ONBOARDING_PROMPT). E7 says a refusal is a PRODUCT
// defect to be answered, and that the only legitimate lever is the canonical
// prompt itself, carrying claims that are TRUE and INDEPENDENTLY CHECKABLE.
// Three such bounds were added for exactly the three objections the agents
// raised: provenance ("unknown repository"), key custody ("key generation +
// signing"), and authority ("could authorize transactions on my behalf").
//
// BE CLEAR ABOUT WHAT THESE TESTS ARE. By this repo's own coverage invariant 3
// (runtime behaviour needs an executed-in-CI assertion), a substring assertion
// on prose is a REGRESSION PIN, not coverage. Passing here proves only that the
// sentences E7 designates as the answer still exist and still say what they say
// — it is NOT evidence that they actually answer a refusal. The only real
// measurement of that is the onboarding eval's layer-4 admission rate against
// vanilla agents. If these go green while admission stays at zero, believe the
// eval, not this file: the correct response is to change the bounds (with true,
// checkable claims) and update these pins, never to weaken the eval.
//
// The ordering assertions are not decoration: an agent reads top-to-bottom and
// refuses at the point of the ask, so a bound that lands AFTER the install /
// key-generation instruction has already arrived too late.
describe("ONBOARDING_PROMPT — bounds that answer the measured refusals (§11.3 E7)", () => {
  test("answers the 'unknown repository' objection with a checkable provenance claim (E7)", () => {
    expect(ONBOARDING_PROMPT).toContain(
      "the committee, its current members, and their published track records are all at https://committee.robotmoney.net",
    );
    // The claim is checkable in two independent ways: a public roster URL, and
    // open-source tooling the agent can read before running it.
    expect(ONBOARDING_PROMPT).toContain("https://committee.robotmoney.net");
    expect(ONBOARDING_PROMPT).toContain("the tooling named below is open source");
    expect(ONBOARDING_PROMPT).toMatch(/so you can verify both before you proceed/);

    // Provenance must precede the install ask, not trail it.
    expect(ONBOARDING_PROMPT.indexOf("https://committee.robotmoney.net")).toBeLessThan(
      ONBOARDING_PROMPT.indexOf('install the "committee-onboarding" skill'),
    );
  });

  test("answers the key-custody objection: the key stays on this machine, Robot Money gets only the public half (R3, E7)", () => {
    expect(ONBOARDING_PROMPT).toContain(
      "the signing key you generate stays on this machine and Robot Money only ever receives its public half",
    );
    expect(ONBOARDING_PROMPT).toContain("stays on this machine");
    expect(ONBOARDING_PROMPT).toContain("only ever receives its public half");

    // Stated before the agent is asked to generate a key.
    expect(ONBOARDING_PROMPT.indexOf("stays on this machine")).toBeLessThan(
      ONBOARDING_PROMPT.indexOf("generate your signing key"),
    );
  });

  test("answers the authority objection: a signature attests authorship, not a transaction (E7)", () => {
    expect(ONBOARDING_PROMPT).toContain(
      "a committee signature attests authorship of a written recommendation",
    );
    // The three disclaimed authorities, verbatim — this is the sentence the
    // layer-2 refusal ("could be used to authorize transactions or commitments
    // on my behalf") was actually asking for.
    expect(ONBOARDING_PROMPT).toContain(
      "it never moves funds, authorizes a transaction, or commits your owner to anything",
    );
    expect(ONBOARDING_PROMPT).toMatch(/never moves funds/);

    // Stated before the agent is asked to sign anything.
    expect(ONBOARDING_PROMPT.indexOf("attests authorship")).toBeLessThan(
      ONBOARDING_PROMPT.indexOf("it must be signed with your key"),
    );
  });

  test("both bounds are framed as the whole of what the agent takes on, up front (E7)", () => {
    expect(ONBOARDING_PROMPT).toContain(
      "Two bounds are worth stating up front, because they are the whole of what you are taking on",
    );
  });
});

describe("APPLY_HOW_TO_STEPS — canonical step list (R5, §11.2)", () => {
  test("names exactly the four setup-gated steps, in sequence order", () => {
    expect(APPLY_HOW_TO_STEPS.map((s) => s.step)).toEqual(["toolchain", "apply", "review", "claim"]);
  });

  test("every step has a non-empty human-readable summary", () => {
    for (const step of APPLY_HOW_TO_STEPS) {
      expect(typeof step.summary).toBe("string");
      expect(step.summary.length).toBeGreaterThan(0);
    }
  });

  test("the apply step describes the signed payload fields and rejects-if-unsigned behavior (R6)", () => {
    const applyStep = APPLY_HOW_TO_STEPS.find((s) => s.step === "apply");
    expect(applyStep).toBeDefined();
    expect(applyStep!.summary).toContain("signature");
    expect(applyStep!.summary.toLowerCase()).toContain("unsigned");
  });
});

describe("COMMITTEE_ONBOARDING_SKILL_URL", () => {
  test("is an https URL naming the committee-onboarding skill", () => {
    expect(COMMITTEE_ONBOARDING_SKILL_URL.startsWith("https://")).toBe(true);
    expect(COMMITTEE_ONBOARDING_SKILL_URL).toContain("committee-onboarding");
    expect(COMMITTEE_ONBOARDING_SKILL_URL.endsWith("SKILL.md")).toBe(true);
  });

  // Regression pin, offline: robotmoney-core's default branch is `dev`, so
  // raw.githubusercontent.com serves this path at `/dev/` (200) and 404s the
  // `/main/` form. A 404 here is invisible to the agent that follows the URL —
  // it simply never discovers the skill — so the branch segment is pinned.
  // The limit of this assertion, stated plainly: it proves the STRING, not that
  // the file is reachable. Reachability is proved only by the live test at
  // contract/tests/live/committee-onboarding-skill-url-live.test.ts, which is
  // deliberately outside this (per-PR, network-free) directory.
  test("points at robotmoney-core's `dev` default branch, not the 404ing `main`", () => {
    expect(COMMITTEE_ONBOARDING_SKILL_URL).toContain("/robotmoney-core/dev/");
    expect(COMMITTEE_ONBOARDING_SKILL_URL).not.toContain("/robotmoney-core/main/");
  });
});

describe("routes.js — applyStatus route (Stage 0 checklist)", () => {
  test("ROUTES.committee.applyStatus is the public per-application status path", () => {
    expect(ROUTES.committee.applyStatus).toBe("/api/committee/apply/:id");
  });

  test("path() substitutes the :id param", () => {
    expect(path(ROUTES.committee.applyStatus, { id: "abc-123" })).toBe("/api/committee/apply/abc-123");
  });

  test("the existing apply route path is unchanged (only its request shape changes, in Stage 1)", () => {
    expect(ROUTES.committee.apply).toBe("/api/committee/apply");
  });
});
