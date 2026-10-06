// PRODUCTION INITIALIZATION, AT RUNTIME — issue #1026 criterion 42,
// smoke-production-spec.md §9.1 steps 4-6, §4.3, §2, §3; D47, D52, D55 (9).
//
//   §4.3: production initialization is "a set of separate commands allowed on
//   `production`, each gated by `RM_ENV=prod`, `y/n`, a receipt and the target
//   lock. A command that writes the database directly also requires a typed
//   `rm_owner`; the key rotation of §9.1 step 6 goes through the admin API with
//   the operator's admin service token instead. None is reachable through
//   `bun smoke`."
//
// scripts/tests/unit/prod-init.test.ts grades every gate with the effects
// injected. This file runs the COMMAND — `bun scripts/prod-init.ts <command>`,
// as a process under a pseudo-terminal, through `realDeps` — against real
// services, and reads what it left:
//
//   - a Postgres the policy treats as REMOTE (./remote-db-harness.ts: published
//     on the Docker bridge address, provisioned as §9.1 leaves production), its
//     connection in the operator's `$HOME/.env` with an `rm_readonly` line and
//     nothing that can write;
//   - the real api (`bun run src/api/index.ts`, logged in as rm_app), for the
//     `rotate-key` admin route;
//   - the operator at the terminal, typing rm_owner and `y`.
//
// set-identity (§9.1 step 4). Under D55 (9) the first production migrate
// writes `production` in 0081's own transaction (backend/tests/
// identity-first-pass.test.ts proves that write). So the target here is
// enrolled `production` before the command runs — by the container's
// superuser, doadmin's stand-in — and set-identity must REPORT the row, read
// through rm_owner inside the fence, and leave it exactly as it was. A target
// with the table and no row refuses before any prompt: set-identity never
// writes a row.
//
// provision-tokens (§9.1 step 5): the three holders' rows in the token store,
// each secret in `tokens/<holder>/token` under the instance's state directory,
// each file's hash the row's.
//
// rebind-members (§9.1 step 6): each seated member's key moved to its
// credential.json key through `rotate-key`, called with the operator token
// provision-tokens just wrote, and the bearer the route returned written into
// that member's entry — the one that now authenticates, where the old one no
// longer does. Both namespaces are seated: two agents, and one judge seated
// through the admin role route, so the judge half of the rebind runs too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { onTerminal, repoRoot, startRemoteDb, type Operator, type RemoteDb } from "./remote-db-harness.ts";
import { instancePaths, PRODUCTION_INSTANCE, SERVICE_TOKEN_HOLDERS } from "../../lib/smoke-state.ts";

const BACKEND = join(repoRoot, "backend");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

let db: RemoteDb;
let op: Operator;
let apiPort = 0;
let api: ReturnType<typeof Bun.spawn> | null = null;
const apiLog: string[] = [];

beforeAll(async () => {
  db = await startRemoteDb("prodinit");
  op = db.operator("prodinit");
}, 180_000);

afterAll(async () => {
  if (api) {
    api.kill("SIGTERM");
    await api.exited.catch(() => {});
  }
  db?.close();
});

/** `bun scripts/prod-init.ts <argv>` at a terminal under RM_ENV=prod, answering its prompts. */
async function prodInit(
  argv: readonly string[],
  answers: { readonly password?: string; readonly y?: string },
): Promise<{ code: number; screen: string }> {
  const term = onTerminal(["bun", "--no-env-file", "scripts/prod-init.ts", ...argv], { ...op.env, RM_ENV: "prod" });
  try {
    if (answers.password !== undefined) {
      await term.waitFor("rm_owner password");
      await term.type(`${answers.password}\r`);
    }
    if (answers.y !== undefined) {
      await term.waitFor("Type y to continue");
      await term.type(`${answers.y}\r`);
    }
    const code = await term.exited();
    return { code, screen: term.screen() };
  } finally {
    term.kill();
  }
}

const paths = () => instancePaths(op.root, PRODUCTION_INSTANCE);

function receipts(command: string): Record<string, any>[] {
  const dir = join(paths().dir, "prod-init");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${command}-`))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

describe("§9.1 step 4 — `prod-init set-identity` confirms the production row and never writes one", () => {
  test("a table with NO row refuses before any prompt, and writes nothing", async () => {
    db.setIdentity(null);
    const run = await prodInit(["set-identity"], {});
    expect(run.code).not.toBe(0);
    expect(run.screen).toContain("reads `missing`");
    expect(run.screen).toContain("bun run migrate");
    expect(run.screen).not.toContain("rm_owner password");
    expect(db.superuser("SELECT count(*) FROM deployment_identity")).toBe("0");
    expect(receipts("set-identity")).toEqual([]);
  }, 120_000);

  test("an answer that is not y refuses after the password, and writes nothing", async () => {
    db.setIdentity("production");
    const before = db.superuser("SELECT written_at::text FROM deployment_identity");
    const run = await prodInit(["set-identity"], { password: db.passwords.rm_owner, y: "yes" });
    expect(run.code).not.toBe(0);
    expect(run.screen).toContain("not y");
    expect(run.screen).not.toContain(db.passwords.rm_owner);
    expect(db.superuser("SELECT written_at::text FROM deployment_identity")).toBe(before);
    expect(receipts("set-identity")).toEqual([]);
  }, 120_000);

  test("RM_ENV=prod, a typed rm_owner, y and the target lock: the row is read through rm_owner inside the fence, reported, unchanged, and receipted", async () => {
    const before = db.superuser("SELECT kind || '|' || written_by || '|' || written_at::text FROM deployment_identity");
    const run = await prodInit(["set-identity"], { password: db.passwords.rm_owner, y: "y" });
    expect({ code: run.code, tail: run.code === 0 ? "" : run.screen.slice(-2000) }).toEqual({ code: 0, tail: "" });
    expect(run.screen).not.toContain(db.passwords.rm_owner);
    // Not rewritten: the same row, to the microsecond.
    expect(db.superuser("SELECT kind || '|' || written_by || '|' || written_at::text FROM deployment_identity")).toBe(before);
    const [receipt] = receipts("set-identity");
    expect(receipt).toMatchObject({
      command: "set-identity",
      instance: PRODUCTION_INSTANCE,
      rmEnv: "prod",
      identityBefore: "production",
      lockHolder: "prod-init:set-identity",
      outcome: "completed",
      detail: { before: "production", after: "production", written: false },
    });
    expect(JSON.stringify(receipt)).not.toContain(db.passwords.rm_owner);
  }, 120_000);
});

describe("§9.1 step 5 — `prod-init provision-tokens` writes the three holders' rows and token files", () => {
  test("a typed rm_owner, y and the target lock: three rows in the store, three 0600 files whose hashes are the rows', one receipt", async () => {
    const run = await prodInit(["provision-tokens"], { password: db.passwords.rm_owner, y: "y" });
    expect({ code: run.code, tail: run.code === 0 ? "" : run.screen.slice(-2000) }).toEqual({ code: 0, tail: "" });
    const rows = db
      .superuser(`SELECT holder || '|' || token_hash || '|' || created_by FROM automation_tokens WHERE instance = '${PRODUCTION_INSTANCE}' ORDER BY holder`)
      .split("\n");
    expect(rows).toHaveLength(3);
    for (const holder of SERVICE_TOKEN_HOLDERS) {
      const file = paths().tokenFiles[holder];
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const token = readFileSync(file, "utf8").trim();
      expect(token.length).toBeGreaterThan(20);
      expect(run.screen).not.toContain(token);
      const hash = createHash("sha256").update(token).digest("hex");
      expect(rows).toContain(`${holder}|${hash}|rm_owner`);
    }
    const [receipt] = receipts("provision-tokens");
    expect(receipt).toMatchObject({
      command: "provision-tokens",
      identityBefore: "production",
      lockHolder: "prod-init:provision-tokens",
      outcome: "completed",
      detail: { holders: [...SERVICE_TOKEN_HOLDERS] },
    });
    for (const holder of SERVICE_TOKEN_HOLDERS) expect(JSON.stringify(receipt)).not.toContain(readFileSync(paths().tokenFiles[holder], "utf8").trim());
  }, 120_000);
});

describe("§9.1 step 6 — `prod-init rebind-members` rotates each member to its credential.json key through the real api", () => {
  const b64 = (buf: ArrayBuffer) => Buffer.from(new Uint8Array(buf)).toString("base64");
  let operatorToken = "";
  const members: {
    name: string;
    kind: "agent" | "judge";
    id: string;
    oldBearer: string;
    publicKeyB64: string;
    privateJwk: JsonWebKey;
  }[] = [];

  beforeAll(async () => {
    // The api, as a stack runs it: its own database login (rm_app), over the
    // same bridge address, with no admin token in its environment — the
    // operator's store token (written by provision-tokens above) is the admin
    // credential (§3).
    apiPort = await freePort();
    if (apiPort === 48787) throw new Error("refusing to bind :48787");
    api = Bun.spawn(["bun", "run", "src/api/index.ts"], {
      cwd: BACKEND,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        DATABASE_URL: `postgres://rm_app:${db.passwords.rm_app}@${db.host}:${db.port}/${db.database}?sslmode=disable`,
        API_PORT: String(apiPort),
        RM_ENV: "stage",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (const stream of [api.stdout, api.stderr]) {
      void (async () => {
        const dec = new TextDecoder();
        for await (const chunk of stream as ReadableStream<Uint8Array>) apiLog.push(dec.decode(chunk));
      })();
    }
    const deadline = Date.now() + 90_000;
    for (;;) {
      const r = await fetch(`http://127.0.0.1:${apiPort}/api/version`).catch(() => null);
      if (r?.ok) break;
      if (api.exitCode !== null || Date.now() > deadline) throw new Error(`the api never answered:\n${apiLog.join("").slice(-3000)}`);
      await Bun.sleep(250);
    }

    operatorToken = readFileSync(paths().tokenFiles.operator, "utf8").trim();
    // Three seated members, registered with the keys they hold TODAY — two
    // agents and a judge (seated through the admin role route, as an operator
    // seats one); the credential file then names the keys each should hold
    // (fresh ones).
    for (const [name, kind] of [["athena", "agent"], ["boreas", "agent"], ["themis", "judge"]] as const) {
      const today = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
      const id = `rt_prodinit_${name}_${crypto.randomUUID().slice(0, 6)}`;
      const r = await fetch(`http://127.0.0.1:${apiPort}${ROUTES.swarm.register}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Automation-Token": operatorToken },
        body: JSON.stringify({ memberId: id, name: id, publicKey: b64(await crypto.subtle.exportKey("raw", today.publicKey)) }),
      });
      const body = (await r.json()) as { token?: string };
      if (r.status !== 201 || !body.token) throw new Error(`register ${id}: ${r.status} ${JSON.stringify(body)}\n${apiLog.join("").slice(-2000)}`);
      if (kind === "judge") {
        const expectedVersion = Number(db.superuser(`SELECT version FROM swarm_members WHERE id = '${id}'`));
        const seat = await fetch(`http://127.0.0.1:${apiPort}${ROUTES.swarm.admin.memberRole.replace(":id", encodeURIComponent(id))}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Automation-Token": operatorToken },
          body: JSON.stringify({ role: "judge", expectedVersion }),
        });
        if (seat.status !== 200) throw new Error(`seat ${id} as judge: ${seat.status} ${await seat.text()}\n${apiLog.join("").slice(-2000)}`);
        if (db.superuser(`SELECT role FROM swarm_members WHERE id = '${id}'`) !== "judge") throw new Error(`${id} is not seated as a judge`);
      }
      const target = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
      members.push({
        name,
        kind,
        id,
        oldBearer: body.token,
        publicKeyB64: b64(await crypto.subtle.exportKey("raw", target.publicKey)),
        privateJwk: await crypto.subtle.exportKey("jwk", target.privateKey),
      });
    }
  }, 180_000);

  async function verify(token: string): Promise<{ status: number; memberId?: string }> {
    const r = await fetch(`http://127.0.0.1:${apiPort}${ROUTES.swarm.verifyToken}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await r.json().catch(() => ({}))) as { memberId?: string };
    return { status: r.status, memberId: body.memberId };
  }

  test("each member's key — agents and the judge — moves to its credential.json key, and the bearer rotate-key returned is written into its entry", async () => {
    // The old bearers authenticate before the rebind.
    for (const m of members) expect(await verify(m.oldBearer)).toEqual({ status: 200, memberId: m.id });

    const credentialPath = join(op.root, "credential.json");
    const entriesOf = (kind: "agent" | "judge") =>
      Object.fromEntries(
        members
          .filter((m) => m.kind === kind)
          .map((m) => [m.name, { memberId: m.id, publicKeyB64: m.publicKeyB64, privateJwk: m.privateJwk, bearer: m.oldBearer, modelKey: `model-${m.name}` }]),
      );
    expect(members.filter((m) => m.kind === "judge")).toHaveLength(1);
    writeFileSync(credentialPath, JSON.stringify({ agents: entriesOf("agent"), judges: entriesOf("judge") }, null, 2), { mode: 0o600 });
    chmodSync(credentialPath, 0o600);

    const run = await prodInit(["rebind-members", "--credentials", credentialPath, "--api", `http://127.0.0.1:${apiPort}`], { y: "y" });
    expect({ code: run.code, tail: run.code === 0 ? "" : `${run.screen.slice(-2000)}\n${apiLog.join("").slice(-2000)}` }).toEqual({ code: 0, tail: "" });
    // No rm_owner for an API write (§4.3).
    expect(run.screen).not.toContain("rm_owner password");

    type Entry = { bearer: string; publicKeyB64: string; modelKey: string };
    const after = JSON.parse(readFileSync(credentialPath, "utf8")) as { agents: Record<string, Entry>; judges: Record<string, Entry> };
    const entryOf = (m: (typeof members)[number]): Entry => (m.kind === "judge" ? after.judges : after.agents)[m.name]!;
    for (const m of members) {
      const entry = entryOf(m);
      // The entry now carries the bearer the route returned, and only that changed.
      expect(entry.bearer).not.toBe(m.oldBearer);
      expect({ publicKeyB64: entry.publicKeyB64, modelKey: entry.modelKey }).toEqual({ publicKeyB64: m.publicKeyB64, modelKey: `model-${m.name}` });
      expect(run.screen).not.toContain(entry.bearer);
      // That bearer is the member's credential now; the old one is refused.
      expect(await verify(entry.bearer)).toEqual({ status: 200, memberId: m.id });
      expect((await verify(m.oldBearer)).status).toBe(401);
      // And the member's active key is the credential file's.
      expect(
        db.superuser(`SELECT count(*) FROM swarm_member_keys WHERE member_id = '${m.id}' AND public_key = '${m.publicKeyB64}' AND active`),
      ).toBe("1");
    }
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);

    const [receipt] = receipts("rebind-members");
    expect(receipt).toMatchObject({
      command: "rebind-members",
      identityBefore: "production",
      lockHolder: "prod-init:rebind-members",
      outcome: "completed",
      detail: { credentialFile: credentialPath, rebound: members.map((m) => ({ name: m.name, kind: m.kind, memberId: m.id })) },
    });
    const text = JSON.stringify(receipt);
    for (const m of members) expect(text).not.toContain(entryOf(m).bearer);
    expect(text).not.toContain(operatorToken);
  }, 180_000);
});
