// The authorship half of a rollout receipt, against REAL keys and REAL git.
//
// WHY REAL KEYPAIRS. backend/scripts/lib/rollout-signing.ts is a thin shell
// around `ssh-keygen -Y` and `git verify-tag`, and every interesting property it
// has — that a namespace binds, that one flipped byte breaks a signature, that
// an unlisted key resolves to nobody — belongs to those tools, not to the
// wrapper. Mocking them would test the mock. So this file generates ed25519
// keypairs with the real ssh-keygen in a mkdtemp dir, builds a real git repo
// with real signed tags, and asserts against what those binaries actually do.
//
// NEGATIVE CASES ARE THE POINT. The probe is documented as always exit-0 and
// side-effect free (rollout-procedure.md §1), and the receipts it now reads come
// from a PUBLIC repository where anybody can open a PR. So the cases that matter
// are the hostile and the broken ones: a tampered receipt, a signature made by a
// key nobody listed, a signature made under a different namespace, a .sig that
// is empty or garbage, and no allowed-signers file at all. Every one must
// resolve to NO principal, and none may throw — a probe that crashes on a
// malformed file denies an operator the state table at the moment they most need
// it.
//
// Runs in the required `unit.yml` job — `bun run test:unit`. ssh-keygen and git
// are asserted PRESENT rather than skipped around: a silent skip here would turn
// the whole file into decoration on a runner without OpenSSH.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RECEIPT_SIGNATURE_NAMESPACE,
  resolveSigner,
  signDetached,
  verifyTagSigner,
} from "../../../backend/scripts/lib/rollout-signing.ts";

const STAGE = "rollout-stage@test";
const PAYLOAD = '{\n  "step": "P4.preflight-live",\n  "exit": 0\n}\n';

let root: string;
/** The listed key. */
let stageKey: string;
/** A perfectly valid key that is deliberately NOT in the allowed-signers file. */
let strangerKey: string;
let allowed: string;

function sh(cmd: string[], cwd?: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const dec = new TextDecoder();
  return { code: r.exitCode ?? -1, out: dec.decode(r.stdout), err: dec.decode(r.stderr) };
}

function keygen(path: string, comment: string): void {
  const r = sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", path]);
  if (r.code !== 0) throw new Error(`ssh-keygen failed: ${r.err}`);
}

/** `<principal> <keytype> <base64>` — the allowed_signers line format. */
function signerLine(principal: string, pubPath: string): string {
  const [type, blob] = readFileSync(pubPath, "utf8").trim().split(/\s+/);
  return `${principal} ${type} ${blob}\n`;
}

beforeAll(() => {
  // Loud, not skipped: these binaries are the subject, so their absence is a
  // failing test rather than a quietly green one.
  expect({ tool: "ssh-keygen", present: sh(["ssh-keygen", "-A", "-h"]).code !== 127 }).toEqual({ tool: "ssh-keygen", present: true });
  expect({ tool: "git", present: sh(["git", "--version"]).code === 0 }).toEqual({ tool: "git", present: true });

  root = mkdtempSync(join(tmpdir(), "rollout-signing-"));
  stageKey = join(root, "stage");
  strangerKey = join(root, "stranger");
  keygen(stageKey, STAGE);
  keygen(strangerKey, "nobody@test");
  allowed = join(root, "allowed-signers");
  writeFileSync(allowed, `# comment line the parser must tolerate\n${signerLine(STAGE, `${stageKey}.pub`)}`);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("receipt signatures resolve to a listed principal, and to nobody otherwise", () => {
  test("a signature by a listed key verifies under the receipt namespace and names the principal", () => {
    const sig = signDetached(PAYLOAD, stageKey);
    expect({ signed: sig !== null && sig.includes("BEGIN SSH SIGNATURE") }).toEqual({ signed: true });
    expect(resolveSigner({ payload: PAYLOAD, signature: sig!, allowedSigners: allowed })).toBe(STAGE);
  });

  test("THE NAMESPACE BINDS: the same signature verified under any other namespace names nobody", () => {
    // Without this, a signature the agent made over some other blob would count
    // as a rollout receipt the moment its bytes matched.
    const sig = signDetached(PAYLOAD, stageKey)!;
    expect(resolveSigner({ payload: PAYLOAD, signature: sig, allowedSigners: allowed, namespace: "some-other.v1" })).toBeNull();
    expect(resolveSigner({ payload: PAYLOAD, signature: sig, allowedSigners: allowed, namespace: "" })).toBeNull();
    // ...and a signature MADE under a different namespace does not pass as one.
    const wrongNs = signDetached(PAYLOAD, stageKey, "git")!;
    expect(resolveSigner({ payload: PAYLOAD, signature: wrongNs, allowedSigners: allowed })).toBeNull();
    // Control: it verifies under the namespace it was actually made under, so
    // the two assertions above are about the namespace and not about signing.
    expect(resolveSigner({ payload: PAYLOAD, signature: wrongNs, allowedSigners: allowed, namespace: "git" })).toBe(STAGE);
  });

  test("ONE FLIPPED BYTE in the receipt breaks verification and names nobody", () => {
    const sig = signDetached(PAYLOAD, stageKey)!;
    const tampered = PAYLOAD.replace('"exit": 0', '"exit": 1');
    expect({ differs: tampered !== PAYLOAD, sameLength: tampered.length === PAYLOAD.length }).toEqual({ differs: true, sameLength: true });
    expect(resolveSigner({ payload: tampered, signature: sig, allowedSigners: allowed })).toBeNull();
  });

  test("a signature by a key that is NOT in the allowed-signers file names nobody", () => {
    const sig = signDetached(PAYLOAD, strangerKey);
    // The signature itself is perfectly valid — it is the TRUST that is absent.
    expect({ signed: sig !== null }).toEqual({ signed: true });
    expect(resolveSigner({ payload: PAYLOAD, signature: sig!, allowedSigners: allowed })).toBeNull();
  });

  test("an empty .sig, a garbage .sig and a missing allowed-signers file each name nobody WITHOUT throwing", () => {
    const good = signDetached(PAYLOAD, stageKey)!;
    const cases: [string, () => string | null][] = [
      ["empty signature", () => resolveSigner({ payload: PAYLOAD, signature: "", allowedSigners: allowed })],
      ["whitespace-only signature", () => resolveSigner({ payload: PAYLOAD, signature: "   \n\n", allowedSigners: allowed })],
      ["garbage signature", () => resolveSigner({ payload: PAYLOAD, signature: "not a signature at all\n", allowedSigners: allowed })],
      [
        "truncated armour",
        () => resolveSigner({ payload: PAYLOAD, signature: `${good.split("\n").slice(0, 2).join("\n")}\n`, allowedSigners: allowed }),
      ],
      ["missing allowed-signers", () => resolveSigner({ payload: PAYLOAD, signature: good, allowedSigners: join(root, "no-such-file") })],
      [
        "allowed-signers is a directory, not a file",
        () => resolveSigner({ payload: PAYLOAD, signature: good, allowedSigners: root }),
      ],
    ];
    for (const [name, run] of cases) {
      let threw: string | null = null;
      let result: string | null | undefined;
      try {
        result = run();
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      expect({ name, threw, result }).toEqual({ name, threw: null, result: null });
    }
  });

  test("signing with a key path that does not exist returns null rather than throwing", () => {
    expect(signDetached(PAYLOAD, join(root, "no-such-key"))).toBeNull();
  });

  test("the namespace constant is versioned, so a future projection change invalidates old signatures", () => {
    expect(RECEIPT_SIGNATURE_NAMESPACE).toMatch(/^rollout-receipt\.v\d+$/);
  });
});

describe("verifyTagSigner() — who cut the rc tag", () => {
  let repo: string;
  const SIGNED = "v9.9.9-rc.1";
  const UNLISTED = "v9.9.9-rc.2";
  const UNSIGNED = "v9.9.9-rc.3";

  beforeAll(() => {
    repo = join(root, "repo");
    const git = (...args: string[]) => {
      const r = sh(["git", ...args], repo);
      if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
    };
    const init = sh(["git", "init", "-q", repo]);
    if (init.code !== 0) throw new Error(`git init: ${init.err}`);
    git("config", "user.email", "rollout@invalid");
    git("config", "user.name", "rollout");
    git("config", "gpg.format", "ssh");
    writeFileSync(join(repo, "f.txt"), "x\n");
    git("add", "f.txt");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "init");

    git("-c", `user.signingkey=${stageKey}.pub`, "tag", "-s", "-m", "rc", SIGNED);
    git("-c", `user.signingkey=${strangerKey}.pub`, "tag", "-s", "-m", "rc", UNLISTED);
    git("tag", "-a", "-m", "rc", UNSIGNED);
  });

  test("a tag signed by a listed key resolves to that principal", () => {
    expect(verifyTagSigner(repo, SIGNED, allowed)).toBe(STAGE);
  });

  test("a tag signed by an UNLISTED key resolves to nobody", () => {
    // git prints `Good "git" signature` for it — the key is real, the trust is
    // not — and then `No principal matched.` with exit 1. Reading only the first
    // line would report a stranger as the signer.
    expect(verifyTagSigner(repo, UNLISTED, allowed)).toBeNull();
  });

  test("an UNSIGNED tag resolves to nobody", () => {
    expect(verifyTagSigner(repo, UNSIGNED, allowed)).toBeNull();
  });

  test("a missing tag, an empty tag name and a missing allowed-signers file each resolve to nobody without throwing", () => {
    expect(verifyTagSigner(repo, "v0.0.0-nope", allowed)).toBeNull();
    expect(verifyTagSigner(repo, "", allowed)).toBeNull();
    expect(verifyTagSigner(repo, SIGNED, join(root, "no-such-file"))).toBeNull();
    expect(verifyTagSigner(join(root, "not-a-repo"), SIGNED, allowed)).toBeNull();
  });

  test("the answer comes from the COMMITTED allow-list, not the host's git config", () => {
    // The repo above configures gpg.format but deliberately never sets
    // gpg.ssh.allowedSignersFile — if verifyTagSigner leaned on repo config it
    // would resolve nobody for the listed key, and would resolve the stranger
    // for anyone whose own config happened to list them.
    const configured = sh(["git", "config", "--get", "gpg.ssh.allowedSignersFile"], repo);
    expect({ configured: configured.out.trim() }).toEqual({ configured: "" });
    expect(verifyTagSigner(repo, SIGNED, allowed)).toBe(STAGE);
  });
});
