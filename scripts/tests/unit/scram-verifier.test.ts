// backend/src/db/scram-verifier.ts: the SCRAM-SHA-256 verifier `prod-init
// role-passwords` sends instead of a plaintext password (D61), and the one
// vetted way to make it a SQL literal.
//
// THE KNOWN VECTOR is RFC 7677 §3: user "user", password "pencil", salt
// W22ZaJ0SNY7soEsUEjb6gQ==, 4096 iterations. The RFC prints the exchange, not
// the keys, so the test checks the verifier against the exchange: the server
// signature computed from our ServerKey equals the RFC's `v=`, and the client
// key recovered from the RFC's proof with our StoredKey hashes to our
// StoredKey. Both hold only when StoredKey and ServerKey are right.
// backend/tests/role-passwords.test.ts proves Postgres accepts the
// verifier (set it, then log in with the plaintext).
import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  generatePassword,
  isVettedVerifierLiteral,
  passwordVerifierLiteral,
  SCRAM_VERIFIER_PATTERN,
  scramSha256Verifier,
} from "../../../backend/src/db/scram-verifier.ts";

const RFC_SALT = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
const CLIENT_FIRST_BARE = "n=user,r=rOprNGfwEbeRWgbNEkqO";
const SERVER_FIRST = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
const CLIENT_FINAL_NO_PROOF = "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
const CLIENT_PROOF = "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=";
const SERVER_SIGNATURE = "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=";
const AUTH_MESSAGE = `${CLIENT_FIRST_BARE},${SERVER_FIRST},${CLIENT_FINAL_NO_PROOF}`;

function keysOf(verifier: string): { iterations: number; salt: string; storedKey: Buffer; serverKey: Buffer } {
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
  if (!m) throw new Error("not a verifier");
  return { iterations: Number(m[1]), salt: m[2]!, storedKey: Buffer.from(m[3]!, "base64"), serverKey: Buffer.from(m[4]!, "base64") };
}

/** Does `verifier` reproduce RFC 7677's exchange? */
function matchesRfc7677(verifier: string): boolean {
  const { storedKey, serverKey } = keysOf(verifier);
  const signature = createHmac("sha256", serverKey).update(AUTH_MESSAGE).digest("base64");
  const clientSignature = createHmac("sha256", storedKey).update(AUTH_MESSAGE).digest();
  const proof = Buffer.from(CLIENT_PROOF, "base64");
  const clientKey = Buffer.from(proof.map((b, i) => b ^ clientSignature[i]!));
  return signature === SERVER_SIGNATURE && createHash("sha256").update(clientKey).digest().equals(storedKey);
}

describe("scramSha256Verifier", () => {
  test("RFC 7677's vector: the verifier reproduces the RFC's server signature and client proof", () => {
    const verifier = scramSha256Verifier("pencil", { salt: RFC_SALT });
    expect(verifier.startsWith("SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$")).toBe(true);
    expect(matchesRfc7677(verifier)).toBe(true);
    expect(SCRAM_VERIFIER_PATTERN.test(verifier)).toBe(true);
  });

  test("RED CONTROL: a different password, or the right password with another salt, does not reproduce it", () => {
    expect(matchesRfc7677(scramSha256Verifier("pencils", { salt: RFC_SALT }))).toBe(false);
    expect(matchesRfc7677(scramSha256Verifier("pencil", { salt: Buffer.alloc(16, 1) }))).toBe(false);
  });

  test("defaults: 4096 iterations and a fresh 16-byte random salt every time", () => {
    const a = keysOf(scramSha256Verifier("pencil"));
    const b = keysOf(scramSha256Verifier("pencil"));
    expect(a.iterations).toBe(4096);
    expect(Buffer.from(a.salt, "base64").length).toBe(16);
    expect(a.salt).not.toBe(b.salt);
  });

  test("refuses what SASLprep would change, fewer than 4096 iterations, and an empty salt, without printing the value", () => {
    expect(() => scramSha256Verifier("pässword")).toThrow(/printable ASCII/);
    expect(() => scramSha256Verifier("")).toThrow(/printable ASCII/);
    expect(() => scramSha256Verifier("pencil", { iterations: 1000 })).toThrow(/4096/);
    expect(() => scramSha256Verifier("pencil", { salt: Buffer.alloc(0) })).toThrow(/salt/);
    try {
      scramSha256Verifier("sëcret-value");
    } catch (error) {
      expect((error as Error).message).not.toContain("sëcret-value");
    }
  });
});

describe("generatePassword", () => {
  test("32 random bytes as base64url: 43 URL-safe characters, never the same twice", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword();
      expect(pw).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(pw);
    }
    expect(seen.size).toBe(50);
    expect(() => generatePassword(16)).toThrow(/at least 32/);
  });
});

describe("passwordVerifierLiteral", () => {
  test("quotes a verifier and is vetted; logging or serializing it shows no verifier", () => {
    const verifier = scramSha256Verifier("pencil", { salt: RFC_SALT });
    const literal = passwordVerifierLiteral(verifier);
    expect(literal.sql).toBe(`'${verifier}'`);
    expect(isVettedVerifierLiteral(literal)).toBe(true);
    expect(Object.isFrozen(literal)).toBe(true);
    expect(JSON.stringify({ literal })).not.toContain("SCRAM");
    expect(String(literal)).not.toContain("SCRAM");
    expect(Bun.inspect(literal)).not.toContain("SCRAM");
  });

  test("RED CONTROL: a plaintext, an injection attempt, or a look-alike object is refused or not vetted", () => {
    const verifier = scramSha256Verifier("pencil");
    for (const bad of ["pencil", `${verifier}'; DROP ROLE rm_owner; --`, `${verifier}\\`, "SCRAM-SHA-256$4096:a$b", `md5${"0".repeat(32)}`]) {
      expect(() => passwordVerifierLiteral(bad)).toThrow(/not a SCRAM-SHA-256 verifier/);
      try {
        passwordVerifierLiteral(bad);
      } catch (error) {
        expect((error as Error).message).not.toContain(bad);
      }
    }
    expect(isVettedVerifierLiteral({ kind: "scram-sha-256-verifier-literal", sql: `'${verifier}'` })).toBe(false);
    expect(isVettedVerifierLiteral(`'${verifier}'`)).toBe(false);
  });
});
