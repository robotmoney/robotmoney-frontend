// `contract/src/admin.d.ts`'s `AdminMember` and `backend/src/swarm/admin.ts`'s
// `toMemberAdmin()` are two hand-maintained spellings of ONE wire shape, and
// nothing held them together. #571 widened the projection by five fields
// (`biases`, `voiceMd`, `mode`, `operator`, `avatar`) and left the interface
// declaring twelve; #593 later added `handle` to both and had nothing that
// would have gone red had it forgotten one side. Every existing check looks
// past this:
//
//   * `bun run check-contract` compares the VENDORED frontend copy against
//     `contract/src/` — it proves the copy is current, never that the declared
//     types match what the handler returns. It also only vendors `routes.js`
//     and `swarm-application.js` (see scripts/sync-contract.ts's FILES), so no
//     `.d.ts` passes through it at all.
//   * No `tsc` reads `contract/**`: neither tsconfig's `include` covers it, and
//     both set `skipLibCheck: true`, which excuses every `.d.ts` in the repo
//     from checking regardless. A wrong type added there is caught by nothing.
//   * `backend/tests/api/admin-swarm.test.ts` asserts the projection's exact
//     key set with `toEqual` — the runtime half — but never compares it to the
//     declared type.
//
// WHY THIS LIVES IN scripts/tests/unit RATHER THAN backend/ OR contract/
// (issue #572). `backend.yml` is job-level path-gated on `backend/**` and
// `contract.yml` on `contract/**`. A guard on either side alone is skipped by
// exactly the PR shape it exists to catch: a contract-only widening skips
// `backend.yml`, a backend-only widening skips `contract.yml`. `unit.yml`
// carries no paths filter at all and runs on every PR, draft and ready — it is
// the only test-executing job that runs no matter which of the two sides a PR
// touches. The "no paths filter" half of that reasoning is asserted below, not
// trusted.
//
// The parse is done with the real TypeScript parser rather than a regex on
// purpose: BOTH source regions carry interleaved comments (JSDoc between the
// interface's fields, a four-line comment inside the returned object literal),
// and a naive line regex silently under-counts them — a green-for-the-wrong-
// reason guard. Every shape this parser cannot resolve into a plain key list
// (a spread, a computed key, a shorthand, an index signature, a method) throws
// rather than returning a short list, so the guard can never be defeated by
// rewriting either region into a form it does not understand.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const contractPath = join(repoRoot, "contract", "src", "admin.d.ts");
const backendPath = join(repoRoot, "backend", "src", "swarm", "admin.ts");
const unitWorkflowPath = join(repoRoot, ".github", "workflows", "unit.yml");

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** The keys `AdminMember` declares, in declaration order. */
function declaredKeys(source: string): string[] {
  const sf = parse("admin.d.ts", source);
  const decl = sf.statements.find(
    (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === "AdminMember",
  );
  if (!decl) throw new Error("no `interface AdminMember` in the parsed contract source");
  return decl.members.map((m) => {
    if (!ts.isPropertySignature(m) || !ts.isIdentifier(m.name)) {
      throw new Error(`AdminMember member is not a plain property signature: ${m.getText(sf)}`);
    }
    // An optional field is a DIFFERENT wire claim from a required one, and
    // toMemberAdmin() always emits every key. Reject rather than silently
    // treating `x?:` as parity with `x:`.
    if (m.questionToken) throw new Error(`AdminMember.${m.name.text} is optional; toMemberAdmin() always emits every key`);
    return m.name.text;
  });
}

/** The keys `toMemberAdmin()`'s returned object literal emits, in order. */
function projectedKeys(source: string): string[] {
  const sf = parse("admin.ts", source);
  const fn = findToMemberAdmin(sf);
  const ret = fn.body?.statements.find(ts.isReturnStatement);
  if (!ret?.expression || !ts.isObjectLiteralExpression(ret.expression)) {
    throw new Error("toMemberAdmin() does not `return { ... }` an object literal");
  }
  return ret.expression.properties.map((p) => {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) {
      throw new Error(`toMemberAdmin() emits a key this guard cannot resolve statically: ${p.getText(sf)}`);
    }
    return p.name.text;
  });
}

function findToMemberAdmin(sf: ts.SourceFile): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "toMemberAdmin") found = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found?.body) throw new Error("no `function toMemberAdmin(...)` with a body in the parsed backend source");
  return found;
}

/** The text of toMemberAdmin()'s return-type annotation, or undefined. */
function returnAnnotation(source: string): string | undefined {
  const sf = parse("admin.ts", source);
  return findToMemberAdmin(sf).type?.getText(sf);
}

function sorted(keys: string[]): string[] {
  return [...keys].sort();
}

/** Mutate `needle` inside a named region only. Both files declare several
 * interfaces/functions that share field lines verbatim (`updatedAt: string;`
 * appears in `AdminTopic` too, `updatedAt: row.updated_at,` in
 * `toSubjectAdmin`), so an unanchored `String.replace` edits the WRONG
 * declaration and makes a must-fail control pass for the wrong reason. */
function editInRegion(source: string, regionAnchor: string, needle: string, replacement: string): string {
  const start = source.indexOf(regionAnchor);
  if (start < 0) throw new Error(`region anchor not found: ${regionAnchor}`);
  const at = source.indexOf(needle, start);
  if (at < 0) throw new Error(`needle not found inside ${regionAnchor}: ${needle}`);
  return source.slice(0, at) + replacement + source.slice(at + needle.length);
}

const CONTRACT_REGION = "export interface AdminMember {";
const BACKEND_REGION = "function toMemberAdmin(";

function onlyIn(a: string[], b: string[]): string[] {
  const other = new Set(b);
  return a.filter((k) => !other.has(k));
}

const contractSource = readFileSync(contractPath, "utf8");
const backendSource = readFileSync(backendPath, "utf8");

describe("AdminMember (contract) matches toMemberAdmin() (backend) key-for-key — issue #572", () => {
  // ── the parse is non-vacuous ───────────────────────────────────────────────
  // Without these, a parser that silently returned [] on both sides would
  // "pass" the parity assertion below while checking nothing at all.
  test("both source files exist and are non-empty — a missing file must not read as an empty key set", () => {
    expect(existsSync(contractPath)).toBe(true);
    expect(existsSync(backendPath)).toBe(true);
    expect(contractSource.length).toBeGreaterThan(1000);
    expect(backendSource.length).toBeGreaterThan(1000);
  });

  test("AdminMember parses to a plausible, duplicate-free key set", () => {
    const keys = declaredKeys(contractSource);
    expect(keys.length).toBeGreaterThanOrEqual(17);
    expect(new Set(keys).size).toBe(keys.length);
    // Anchors from three different regions of the interface, so a parser that
    // stopped early or skipped commented-out spans cannot pass.
    expect(keys).toContain("id");
    expect(keys).toContain("handle");
    expect(keys).toContain("biases");
    expect(keys).toContain("avatar");
    expect(keys).toContain("updatedAt");
  });

  test("toMemberAdmin() parses to a plausible, duplicate-free key set", () => {
    const keys = projectedKeys(backendSource);
    expect(keys.length).toBeGreaterThanOrEqual(17);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("id");
    expect(keys).toContain("handle");
    expect(keys).toContain("biases");
    expect(keys).toContain("avatar");
    expect(keys).toContain("updatedAt");
  });

  // ── the gate ───────────────────────────────────────────────────────────────
  test("the two key sets are identical — a widening on either side must update the other", () => {
    const declared = declaredKeys(contractSource);
    const projected = projectedKeys(backendSource);
    const undeclared = onlyIn(projected, declared);
    const unprojected = onlyIn(declared, projected);
    expect(
      { undeclared, unprojected },
      `toMemberAdmin() returns keys AdminMember does not declare: [${undeclared.join(", ")}]; ` +
        `AdminMember declares keys toMemberAdmin() never returns: [${unprojected.join(", ")}]. ` +
        "Update contract/src/admin.d.ts and backend/src/swarm/admin.ts together.",
    ).toEqual({ undeclared: [], unprojected: [] });
    expect(sorted(declared)).toEqual(sorted(projected));
  });

  test("the five fields issue #572 found undeclared are declared on both sides", () => {
    const declared = declaredKeys(contractSource);
    const projected = projectedKeys(backendSource);
    for (const key of ["biases", "voiceMd", "mode", "operator", "avatar"]) {
      expect(declared, `AdminMember is missing ${key}`).toContain(key);
      expect(projected, `toMemberAdmin() is missing ${key}`).toContain(key);
    }
  });

  // ── the second line of defence stays wired ─────────────────────────────────
  test("toMemberAdmin() is annotated `: AdminMember`, so backend.yml's typecheck catches a backend-side widening too", () => {
    expect(returnAnnotation(backendSource)).toBe("AdminMember");
    expect(backendSource).toMatch(/import type \{[^}]*\bAdminMember\b[^}]*\} from "@robotmoney\/contract";/);
  });

  test("unit.yml has no paths filter — this guard cannot be skipped by a PR that touches only one of the two sides", () => {
    const wf = readFileSync(unitWorkflowPath, "utf8");
    expect(wf).not.toContain("dorny/paths-filter");
    expect(wf).not.toMatch(/^\s*paths(-ignore)?:/m);
  });

  // ── must-fail controls: a gate never proven capable of failing is not a gate ─
  test("the REAL #571 regression is caught: strip the five fields from the contract and the comparison goes red", () => {
    // Reconstruct the pre-fix key set by deleting the five field declarations
    // from the current source. Their JSDoc is deliberately LEFT BEHIND: the
    // orphaned comments are exactly the interleaved-comment noise a line regex
    // would miscount, so this control doubles as a check that the parser reads
    // declarations rather than lines.
    let regressed = contractSource;
    for (const line of [
      "  biases: string[] | null;\n",
      "  voiceMd: string | null;\n",
      "  mode: string | null;\n",
      "  operator: string | null;\n",
      "  avatar: Record<string, unknown> | null;\n",
    ]) {
      expect(regressed, `expected to find the literal line: ${line.trim()}`).toContain(line);
      regressed = editInRegion(regressed, CONTRACT_REGION, line, "");
    }
    const declared = declaredKeys(regressed);
    const projected = projectedKeys(backendSource);
    expect(sorted(declared)).not.toEqual(sorted(projected));
    expect(sorted(onlyIn(projected, declared))).toEqual(["avatar", "biases", "mode", "operator", "voiceMd"]);
  });

  test("a contract-side field with no projection counterpart is caught too — the comparison is symmetric", () => {
    const widened = editInRegion(
      contractSource,
      CONTRACT_REGION,
      "  updatedAt: string;\n",
      "  updatedAt: string;\n  neverProjected572: string | null;\n",
    );
    expect(widened).not.toBe(contractSource);
    expect(onlyIn(declaredKeys(widened), projectedKeys(backendSource))).toEqual(["neverProjected572"]);
  });

  test("a backend-side field with no declaration is caught — the #571 shape, from the other direction", () => {
    const widened = editInRegion(
      backendSource,
      BACKEND_REGION,
      "    updatedAt: row.updated_at,\n",
      "    undeclared572: row.undeclared ?? null,\n    updatedAt: row.updated_at,\n",
    );
    expect(widened).not.toBe(backendSource);
    expect(onlyIn(projectedKeys(widened), declaredKeys(contractSource))).toEqual(["undeclared572"]);
  });

  // ── the comment trap ───────────────────────────────────────────────────────
  // Both real regions interleave comments with fields. These synthetic pairs
  // pin that the parser counts fields, not lines: the same key set written with
  // JSDoc, line comments, block comments and a commented-OUT field must compare
  // equal, and a commented-out field must NOT be counted as declared.
  const COMMENTED_INTERFACE = [
    "// leading file comment mentioning biases: string[] | null;",
    "export interface AdminMember {",
    "  /** JSDoc between fields, like the real one. */",
    "  id: string;",
    "  // a line comment naming a field that is NOT declared: ghostField: string;",
    "  status: string;",
    "  /* block",
    "     comment: alsoNotAField: string; */",
    "  updatedAt: string;",
    "}",
    "",
  ].join("\n");

  const COMMENTED_PROJECTION = [
    "function toMemberAdmin(row: Record<string, any>): AdminMember {",
    "  return {",
    "    // A four-line comment inside the literal, like the real one, which",
    "    // names fields in prose: ghostField, alsoNotAField — neither of which",
    "    // is emitted. A line-oriented regex counts these; a parser does not.",
    "    id: row.id,",
    "    status: row.status,",
    "    /* commentedOut: row.commented_out, */",
    "    updatedAt: row.updated_at,",
    "  };",
    "}",
    "",
  ].join("\n");

  test("interleaved comments do not inflate or deflate either key set", () => {
    expect(declaredKeys(COMMENTED_INTERFACE)).toEqual(["id", "status", "updatedAt"]);
    expect(projectedKeys(COMMENTED_PROJECTION)).toEqual(["id", "status", "updatedAt"]);
    expect(sorted(declaredKeys(COMMENTED_INTERFACE))).toEqual(sorted(projectedKeys(COMMENTED_PROJECTION)));
  });

  test("a mismatch hidden among those same comments is still caught", () => {
    const drifted = COMMENTED_PROJECTION.replace("    updatedAt: row.updated_at,\n", "    updatedAt: row.updated_at,\n    voiceMd: row.voice_md ?? null,\n");
    expect(onlyIn(projectedKeys(drifted), declaredKeys(COMMENTED_INTERFACE))).toEqual(["voiceMd"]);
  });

  // ── the parser refuses what it cannot resolve, rather than under-counting ──
  test("a spread in the projection throws instead of silently reporting a short key set", () => {
    const spread = COMMENTED_PROJECTION.replace("    id: row.id,", "    ...row,\n    id: row.id,");
    expect(() => projectedKeys(spread)).toThrow(/cannot resolve statically/);
  });

  test("an optional field in the interface throws — `x?:` is not parity with `x:`", () => {
    const optional = COMMENTED_INTERFACE.replace("  status: string;", "  status?: string;");
    expect(() => declaredKeys(optional)).toThrow(/optional/);
  });

  test("a renamed interface or function throws instead of comparing two empty lists", () => {
    expect(() => declaredKeys(COMMENTED_INTERFACE.replace("interface AdminMember", "interface AdminMemberV2"))).toThrow(
      /no `interface AdminMember`/,
    );
    expect(() => projectedKeys(COMMENTED_PROJECTION.replace("function toMemberAdmin", "function toMemberAdminV2"))).toThrow(
      /no `function toMemberAdmin/,
    );
  });
});

// ── The manual-add REQUEST shape, and what the contract says about it (#690) ─
//
// The block above holds the RESPONSE projection to its declared type. This one
// holds the REQUEST to the thing the contract tells a client about it, which is
// the half issue #690 changed: `POST /api/swarm/admin/members` used to take the
// member's primary key as a caller-supplied string, and that is where every
// human-slug member id came from.
//
// WHY HERE. Same reason as the parity block: the two sides of this promise live
// in `backend/` and `contract/`, whose workflows are each path-gated, and
// `unit.yml` is the only test-executing job with no paths filter. A PR that
// re-added `memberId` to `ManualMemberInput` without touching `contract/` — or
// that rewrote the route comment while leaving the backend alone — would skip
// whichever of the two gated jobs it did not touch.
//
// WHAT THIS IS NOT. It is a CONSISTENCY guard between two source files, not
// coverage of the behaviour: the id being minted, the 400 on a body that names
// one, the derived handle and the residual 409 are all asserted against a real
// database over the real route in backend/tests/api/admin-swarm.test.ts and
// backend/tests/swarm-member-handle.test.ts. Those are the executed-in-CI
// assertions; this one only stops the two declarations drifting apart.
const validationPath = join(repoRoot, "backend", "src", "api", "validation.ts");
const contractRoutesPath = join(repoRoot, "contract", "src", "routes.js");
const validationSource = readFileSync(validationPath, "utf8");
const contractRoutesSource = readFileSync(contractRoutesPath, "utf8");

/** The keys a named interface declares, by parse — same rules as declaredKeys. */
function interfaceKeys(source: string, name: string): string[] {
  const sf = parse("admin.ts", source);
  let decl: ts.InterfaceDeclaration | undefined;
  const visit = (n: ts.Node): void => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === name) decl = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!decl) throw new Error(`no \`interface ${name}\` in the parsed source`);
  return decl.members.map((m) => {
    if (!ts.isPropertySignature(m) || !ts.isIdentifier(m.name)) {
      throw new Error(`${name} member is not a plain property signature: ${m.getText(sf)}`);
    }
    return m.name.text;
  });
}

describe("the admin manual-add request takes no member id (issue #690)", () => {
  test("the parse is non-vacuous — a renamed interface throws rather than reporting an empty key set", () => {
    expect(interfaceKeys(backendSource, "ManualMemberInput").length).toBeGreaterThanOrEqual(2);
    expect(() => interfaceKeys(backendSource, "ManualMemberInputV2")).toThrow(/no `interface ManualMemberInputV2`/);
  });

  test("ManualMemberInput declares name/publicKey and NOT memberId", () => {
    const keys = interfaceKeys(backendSource, "ManualMemberInput");
    expect(keys).toContain("name");
    expect(keys).toContain("publicKey");
    expect(keys).not.toContain("memberId");
  });

  test("the must-fail control: re-adding the field to ManualMemberInput is caught", () => {
    const regressed = editInRegion(
      backendSource,
      "export interface ManualMemberInput {",
      "  name: string;\n",
      "  memberId: string;\n  name: string;\n",
    );
    expect(regressed).not.toBe(backendSource);
    expect(interfaceKeys(regressed, "ManualMemberInput")).toContain("memberId");
  });

  test("addMemberAdmin mints the id itself, and the shared register parser is a SEPARATE function", () => {
    // `crypto.randomUUID()` inside addMemberAdmin is the whole fix; the split
    // parser is what stops it being undone by the demo/E2E register route,
    // which legitimately still takes a caller-supplied id.
    const addMember = backendSource.slice(backendSource.indexOf("export async function addMemberAdmin("));
    expect(addMember.slice(0, addMember.indexOf("\nexport "))).toContain("crypto.randomUUID()");
    expect(validationSource).toContain("export function parseRegisterMember(");
    expect(validationSource).toContain("export function parseManualMember(");
  });

  test("the route's own comment in contract/src/routes.js says the id is generated and the field refused", () => {
    const at = contractRoutesSource.indexOf('members: "/api/swarm/admin/members"');
    expect(at).toBeGreaterThan(0);
    // The comment block immediately above the entry — 400 characters back is
    // comfortably inside it and well short of the previous route's entry.
    const preamble = contractRoutesSource.slice(Math.max(0, at - 400), at);
    expect(preamble).toContain("#690");
    expect(preamble).toContain("GENERATED");
    expect(preamble).toContain("memberId");
  });

  test("the vendored frontend copy of routes.js carries the same sentence — check-contract only proves it is CURRENT, not that it says this", () => {
    const vendored = readFileSync(
      join(repoRoot, "frontend", "public", "assets", "js", "app", "contract", "routes.js"),
      "utf8",
    );
    const at = vendored.indexOf('members: "/api/swarm/admin/members"');
    expect(at).toBeGreaterThan(0);
    expect(vendored.slice(Math.max(0, at - 400), at)).toContain("#690");
  });
});
