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
// As amended by D61: the typed `rm_owner` is `~/.env`'s `rm_owner` line, and
// the `y/n` is `--confirm-target <host:port/database>`. Nothing prompts.
//
// scripts/tests/unit/prod-init.test.ts grades every gate with the effects
// injected. This file runs the COMMAND — `bun scripts/prod-init.ts <command>`,
// as a process with no terminal, through `realDeps` — against real services,
// and reads what it left:
//
//   - a Postgres the policy treats as REMOTE (./remote-db-harness.ts: published
//     on the Docker bridge address, provisioned as §9.1 leaves production), its
//     connection in the operator's `$HOME/.env` with the role lines and a
//     planted, WRONG `doadmin` line that must never be read (D61);
//   - the real api (`bun run src/api/index.ts`, logged in as rm_app), for the
//     `rotate-key` admin route.
//
// role-passwords (§9.1 step 1, D61): rm_owner made NOLOGIN by the
// container's superuser, then the command run as `doadmin` (a superuser role
// made for this file, the provider's stand-in), its password piped on stdin
// with --doadmin-stdin: working lines kept, rm_owner made LOGIN, an absent
// rm_owner line generated and written, a receipt of role → outcome; run again,
// everything is kept.
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
import { repoRoot, startRemoteDb, type Operator, type RemoteDb } from "./remote-db-harness.ts";
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

/** The doadmin stand-in's password: a `doadmin` line in ~/.env (D61). */
const DOADMIN_PASSWORD = `doadmin-${Math.random().toString(36).slice(2)}`;
/** A doadmin line planted in ~/.env that doadmin does not have: never read. */
const WRONG_DOADMIN = `wrong-doadmin-${Math.random().toString(36).slice(2)}`;

beforeAll(async () => {
  db = await startRemoteDb("prodinit");
  // The provider's doadmin, stood in for by a superuser role of that name.
  db.superuser(`CREATE ROLE doadmin LOGIN SUPERUSER PASSWORD '${DOADMIN_PASSWORD}';`);
  // RED CONTROL built in: ~/.env holds a WRONG doadmin line. role-passwords must
  // never read it (D61, owner 2026-10-08): doadmin arrives on stdin only.
  op = db.operator("prodinit", [`rm_owner = ${db.passwords.rm_owner}`, `doadmin = ${WRONG_DOADMIN}`]);
}, 180_000);

afterAll(async () => {
  if (api) {
    api.kill("SIGTERM");
    await api.exited.catch(() => {});
  }
  db?.close();
});

/** The target ~/.env resolves to, as the harness writes it. */
const target = (): string => `${db.host}:${db.port}/${db.database}`;

/** `bun scripts/prod-init.ts <argv>` with no terminal under RM_ENV=prod (D61).
 *  `confirm` is `--confirm-target`: the exact target by default, `null` for none. */
async function prodInit(argv: readonly string[], confirm: string | null = target(), stdin?: string): Promise<{ code: number; screen: string }> {
  const full = ["bun", "--no-env-file", "scripts/prod-init.ts", ...argv, ...(confirm === null ? [] : ["--confirm-target", confirm])];
  for (const secret of [db.passwords.rm_owner, DOADMIN_PASSWORD]) expect(full.join(" ")).not.toContain(secret);
  const child = Bun.spawn(full, { cwd: repoRoot, env: { ...op.env, RM_ENV: "prod" }, stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (stdin !== undefined && child.stdin) {
    child.stdin.write(stdin);
    await child.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const screen = stdout + stderr;
  for (const secret of [db.passwords.rm_owner, DOADMIN_PASSWORD]) expect(screen).not.toContain(secret);
  return { code, screen };
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
  test("a table with NO row refuses before anything is written", async () => {
    db.setIdentity(null);
    const run = await prodInit(["set-identity"]);
    expect(run.code).not.toBe(0);
    expect(run.screen).toContain("reads `missing`");
    expect(run.screen).toContain("bun run migrate");
    expect(db.superuser("SELECT count(*) FROM deployment_identity")).toBe("0");
    expect(receipts("set-identity")).toEqual([]);
  }, 120_000);

  test("D61: a wrong --confirm-target refuses, prints both, and writes nothing", async () => {
    db.setIdentity("production");
    const before = db.superuser("SELECT written_at::text FROM deployment_identity");
    const wrong = `${db.host}:${db.port}/${db.database}_other`;
    const run = await prodInit(["set-identity"], wrong);
    expect(run.code).not.toBe(0);
    expect(run.screen).toContain(JSON.stringify(wrong));
    expect(run.screen).toContain(JSON.stringify(target()));
    expect(db.superuser("SELECT written_at::text FROM deployment_identity")).toBe(before);
    expect(receipts("set-identity")).toEqual([]);
  }, 120_000);

  test("RM_ENV=prod, ~/.env's rm_owner, the exact --confirm-target and the target lock: the row is read through rm_owner inside the fence, reported, unchanged, and receipted", async () => {
    const before = db.superuser("SELECT kind || '|' || written_by || '|' || written_at::text FROM deployment_identity");
    const run = await prodInit(["set-identity"]);
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

describe("§9.1 step 1 — `prod-init role-passwords`: the role passwords through doadmin, typed or piped, stored nowhere (D61)", () => {
  const canLogin = (): string => db.superuser("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rm_owner'");
  /** role-passwords, with doadmin piped on stdin, the way the control-machine wrapper hands it over ssh. */
  const rolePasswords = (extra: readonly string[] = [], confirm: string | null = target()) =>
    prodInit(["role-passwords", "--doadmin-stdin", ...extra], confirm, `${DOADMIN_PASSWORD}\n`);

  test("a NOLOGIN rm_owner with a working line: kept, made LOGIN, the runtime roles kept; doadmin came from stdin, not ~/.env", async () => {
    db.setIdentity("production");
    db.superuser("ALTER ROLE rm_owner NOLOGIN;");
    expect(canLogin()).toBe("f");
    const run = await rolePasswords();
    expect({ code: run.code, tail: run.code === 0 ? "" : run.screen.slice(-2000) }).toEqual({ code: 0, tail: "" });
    expect(canLogin()).toBe("t");
    const [receipt] = receipts("role-passwords");
    expect(receipt).toMatchObject({
      command: "role-passwords", outcome: "completed",
      detail: { roles: { rm_owner: "kept", rm_app: "kept", rm_worker: "kept", rm_readonly: "kept" }, ownerLoginBefore: false },
    });
    const text = JSON.stringify(receipt);
    for (const secret of [db.passwords.rm_owner, DOADMIN_PASSWORD, WRONG_DOADMIN]) expect(text).not.toContain(secret);
    expect(run.screen).not.toContain(WRONG_DOADMIN);
  }, 120_000);

  test("the rerun: every role kept, nothing altered", async () => {
    const run = await rolePasswords();
    expect({ code: run.code, tail: run.code === 0 ? "" : run.screen.slice(-2000) }).toEqual({ code: 0, tail: "" });
    expect(receipts("role-passwords").at(-1)).toMatchObject({ detail: { roles: { rm_owner: "kept", rm_app: "kept", rm_worker: "kept", rm_readonly: "kept" }, ownerLoginBefore: true } });
  }, 120_000);

  test("RED CONTROL: without --doadmin-stdin and with no terminal it refuses before the lock; the ~/.env doadmin line is never a fallback", async () => {
    const count = receipts("role-passwords").length;
    const run = await prodInit(["role-passwords"]);
    expect(run.code).not.toBe(0);
    expect(run.screen).toContain("no terminal to prompt on");
    expect(receipts("role-passwords")).toHaveLength(count);
  }, 120_000);

  test("no rm_owner line: the CLI generates it, sets it as a verifier, writes ~/.env 0600, proves the login; nothing on screen or in the receipt", async () => {
    const envFile = join(op.home, ".env");
    const original = readFileSync(envFile, "utf8");
    const withoutOwner = original.split("\n").filter((l) => !/^\s*rm_owner\s*=/.test(l)).join("\n");
    writeFileSync(envFile, withoutOwner, { mode: 0o600 });
    db.superuser("ALTER ROLE rm_owner NOLOGIN;");
    try {
      const run = await rolePasswords();
      expect({ code: run.code, tail: run.code === 0 ? "" : run.screen.slice(-2000) }).toEqual({ code: 0, tail: "" });
      expect(canLogin()).toBe("t");
      const after = readFileSync(envFile, "utf8");
      const generated = /^rm_owner = ([A-Za-z0-9_-]{43})$/m.exec(after)?.[1];
      expect(generated).toBeDefined();
      expect(after).toBe(`${withoutOwner.endsWith("\n") ? withoutOwner : `${withoutOwner}\n`}rm_owner = ${generated}\n`);
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
      expect(run.screen).not.toContain(generated!);
      expect(db.superuser("SELECT rolpassword FROM pg_authid WHERE rolname = 'rm_owner'")).toMatch(/^SCRAM-SHA-256\$4096:/);
      const receipt = receipts("role-passwords").at(-1)!;
      expect(receipt).toMatchObject({ outcome: "completed", detail: { roles: { rm_owner: "set", rm_app: "kept", rm_worker: "kept", rm_readonly: "kept" } } });
      expect(JSON.stringify(receipt)).not.toContain(generated!);
      const rerun = await rolePasswords();
      expect(rerun.code).toBe(0);
      expect(rerun.screen).not.toContain(generated!);
      expect(receipts("role-passwords").at(-1)).toMatchObject({ detail: { roles: { rm_owner: "kept" } } });
      expect(readFileSync(envFile, "utf8")).toBe(after);
    } finally {
      // Put the harness's password back, for the steps that follow.
      db.superuser(`ALTER ROLE rm_owner LOGIN PASSWORD '${db.passwords.rm_owner}';`);
      writeFileSync(envFile, original, { mode: 0o600 });
    }
  }, 180_000);

  test("a wrong --confirm-target refuses, alters nothing, and never reads doadmin", async () => {
    db.superuser("ALTER ROLE rm_owner NOLOGIN;");
    try {
      const count = receipts("role-passwords").length;
      const run = await rolePasswords([], "elsewhere:5432/robotmoney");
      expect(run.code).not.toBe(0);
      expect(canLogin()).toBe("f");
      expect(receipts("role-passwords")).toHaveLength(count);
    } finally {
      db.superuser("ALTER ROLE rm_owner LOGIN;");
    }
  }, 120_000);
});

describe("§9.1 step 5 — `prod-init provision-tokens` writes the three holders' rows and token files", () => {
  test("~/.env's rm_owner, the exact --confirm-target and the target lock: three rows in the store, three 0600 files whose hashes are the rows', one receipt", async () => {
    const run = await prodInit(["provision-tokens"]);
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

    const run = await prodInit(["rebind-members", "--credentials", credentialPath, "--api", `http://127.0.0.1:${apiPort}`]);
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
