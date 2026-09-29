// A password change or recovery revokes every admin passkey and session by
// tombstone, and the revoked ones are refused on the very next request — as a
// real rm_app api on a snapshot-bootstrapped database, where rm_app holds no
// DELETE at all. Issue #1026 criterion 171, decision D55 (6).
//
// D55 (6): "Security revocations stay immediately effective. A revoked key,
// token or membership is refused on the next request, because the revoking
// transaction writes the tombstone." And no runtime role may DELETE.
//
// THE LIVE DEFECT THIS CLOSES. backend/schema/grants.sql never granted rm_app
// DELETE on the admin tables, so on a snapshot-bootstrapped instance (`--local
// blank`, every rehearsal) the password change and the recovery reset — which
// revoked by `DELETE FROM admin_passkey` / `DELETE FROM admin_session` — failed
// with 42501 and changed nothing. The RED CONTROL below boots the same api with
// the change route's first revocation put back to that DELETE and shows the
// route fail on the same database.
//
// EVERYTHING IS THE RUNNING API. The api is `bun run src/api/index.ts`, logged
// in as rm_app, asked over HTTP. The passkey is registered and used through the
// real WebAuthn ceremony with a deterministic software authenticator (the same
// fixture as tests/api/admin-webauthn.test.ts), so the session it mints is the
// one the api itself wrote. The only statements this file issues directly are
// the catalog reads and the reads of the tombstones.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import postgres from "postgres";
import { provisionAutomationToken } from "../src/db/automation-tokens.ts";
import { writeRedControlPreload } from "./support/automation-auth.ts";
import { harnessConnection } from "./support/cluster.ts";
import { restoreRoles, saveRoles, type SavedRole } from "./fixtures/releases/release-fixture.ts";
import {
  BACKEND_DIR,
  connectAdmin,
  createSnapshotTemplate,
  databaseUrl,
  dropDatabases,
  freePort,
} from "./support/startup-preflight.ts";

const APP = { name: "rm_app", password: `rm_app_revocation_${randomBytes(6).toString("hex")}` };
const ORIGIN = "http://localhost";

let name = "";
let owner: postgres.Sql<{}>;
let savedRoles: SavedRole[] = [];
let operator = "";

// ── the running api ─────────────────────────────────────────────────────────

interface Api {
  readonly base: string;
  stop(): Promise<void>;
}

/** Boot the real api as rm_app on this file's database, optionally with a
 *  `bun --preload` red-control rewrite. */
async function bootApi(preload?: string): Promise<Api> {
  const port = await freePort();
  const argv = ["bun", "run", ...(preload ? ["--preload", preload] : []), "src/api/index.ts"];
  const proc = Bun.spawn(argv, {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      RM_ENV: "stage",
      DATABASE_URL: databaseUrl(name, APP),
      API_PORT: String(port),
      WEBAUTHN_ORIGIN: ORIGIN,
      WEBAUTHN_RP_ID: "localhost",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`api exited with ${proc.exitCode}:\n${await new Response(proc.stderr as ReadableStream).text()}`);
    }
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`api never served /health on :${port}`);
    }
    await Bun.sleep(100);
  }
  return {
    base,
    async stop() {
      proc.kill();
      await proc.exited;
    },
  };
}

async function call(
  api: Api,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${api.base}${path}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed };
}

// ── a deterministic software authenticator (tests/api/admin-webauthn.test.ts) ─

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const concat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts.map((p) => Buffer.from(p)));

function cborHead(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  return Buffer.from([(major << 5) | 25, value >> 8, value & 0xff]);
}
type Cbor = string | number | Uint8Array | Array<[string | number, Cbor]>;
function cbor(value: Cbor): Buffer {
  if (typeof value === "string") return concat(cborHead(3, Buffer.byteLength(value)), Buffer.from(value));
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
  return concat(cborHead(5, value.length), ...value.flatMap(([k, v]) => [cbor(k), cbor(v)]));
}
const clientData = (type: "webauthn.create" | "webauthn.get", challenge: string): Buffer =>
  Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
function authenticatorData(credentialID: Uint8Array, publicKeyCOSE?: Uint8Array, counter = 0): Buffer {
  const rpIDHash = createHash("sha256").update("localhost").digest();
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  if (!publicKeyCOSE) return concat(rpIDHash, Buffer.from([0x05]), counterBytes);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(credentialID.length);
  return concat(rpIDHash, Buffer.from([0x45]), counterBytes, Buffer.alloc(16), length, credentialID, publicKeyCOSE);
}

interface Passkey {
  readonly id: string;
  readonly credentialID: Buffer;
  readonly privateKey: KeyObject;
  counter: number;
}

/** Register a passkey through the api, as the admin holding `credential`. */
async function registerPasskey(api: Api, credential: string): Promise<Passkey> {
  const credentialID = randomBytes(32);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = cbor([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]);
  const options = await call(api, "GET", "/api/admin/webauthn/register/options", undefined, { "X-Admin-Token": credential });
  expect(options.status).toBe(200);
  const attestation = cbor([["fmt", "none"], ["authData", authenticatorData(credentialID, cose)], ["attStmt", []]]);
  const id = b64url(credentialID);
  const verified = await call(
    api,
    "POST",
    "/api/admin/webauthn/register/verify",
    {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientData("webauthn.create", options.body.challenge)),
        attestationObject: b64url(attestation),
      },
    },
    { "X-Admin-Token": credential },
  );
  expect(verified).toEqual({ status: 200, body: { verified: true } });
  return { id, credentialID, privateKey, counter: 0 };
}

/** Sign in with `passkey` through the api: auth options, then a signed assertion. */
async function signIn(api: Api, passkey: Passkey): Promise<{ status: number; body: any }> {
  const options = await call(api, "GET", "/api/admin/webauthn/auth/options");
  expect(options.status).toBe(200);
  passkey.counter += 1;
  const data = clientData("webauthn.get", options.body.challenge);
  const authData = authenticatorData(passkey.credentialID, undefined, passkey.counter);
  const signer = createSign("SHA256");
  signer.update(concat(authData, createHash("sha256").update(data).digest()));
  return call(api, "POST", "/api/admin/webauthn/auth/verify", {
    id: passkey.id,
    rawId: passkey.id,
    type: "public-key",
    response: {
      clientDataJSON: b64url(data),
      authenticatorData: b64url(authData),
      signature: b64url(signer.sign(passkey.privateKey)),
      userHandle: null,
    },
  });
}

/** Whether `credential` opens a privileged route right now. */
const privileged = async (api: Api, credential: string): Promise<number> =>
  (await call(api, "POST", "/api/admin/auth", undefined, { "X-Admin-Token": credential })).status;

/** Which of `ids` the api would offer for sign-in. */
async function offered(api: Api): Promise<string[]> {
  const options = await call(api, "GET", "/api/admin/webauthn/auth/options");
  return (options.body.allowCredentials as { id: string }[]).map((c) => c.id);
}

async function tombstones(ids: { passkey: string }): Promise<{ passkeyRevoked: boolean; liveSessions: number; sessions: number }> {
  const [row] = (await owner`
    SELECT (SELECT revoked_at IS NOT NULL FROM admin_passkey WHERE id = ${ids.passkey}) AS "passkeyRevoked",
           (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS "liveSessions",
           (SELECT count(*)::int FROM admin_session) AS sessions`) as unknown as {
    passkeyRevoked: boolean;
    liveSessions: number;
    sessions: number;
  }[];
  return row!;
}

beforeAll(async () => {
  // cluster admin: saving and altering role logins is superuser-only
  const cluster = connectAdmin();
  try {
    savedRoles = await saveRoles(cluster);
    await cluster.unsafe(`ALTER ROLE rm_app LOGIN PASSWORD '${APP.password}'`);
  } finally {
    await cluster.end({ timeout: 5 });
  }
  name = await createSnapshotTemplate("admin_revocation");
  owner = harnessConnection(name);
  // The operator's store token (smoke spec §3), provisioned as the owner would.
  operator = (await provisionAutomationToken(`rm_revocation_${process.pid}`, ["admin"], { holder: "operator", db: owner }))
    .token;
}, 120_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  const cluster = connectAdmin();
  try {
    await restoreRoles(cluster, savedRoles);
  } finally {
    await cluster.end({ timeout: 5 });
  }
  await dropDatabases(name ? [name] : []);
});

describe("revocation is a tombstone, immediate, and needs no DELETE (D55 (6))", () => {
  test("the database is the snapshot's: rm_app holds UPDATE and no DELETE or TRUNCATE on the admin tables", async () => {
    const rows = (await owner`
      SELECT t, has_table_privilege('rm_app', 'public.' || t, 'UPDATE') AS may_update,
             has_table_privilege('rm_app', 'public.' || t, 'DELETE') OR
             has_table_privilege('rm_app', 'public.' || t, 'TRUNCATE') AS may_delete
        FROM unnest(ARRAY['admin_passkey', 'admin_session', 'admin_webauthn_challenge']) AS t
       ORDER BY t`) as unknown as { t: string; may_update: boolean; may_delete: boolean }[];
    expect(rows).toEqual([
      { t: "admin_passkey", may_update: true, may_delete: false },
      { t: "admin_session", may_update: true, may_delete: false },
      { t: "admin_webauthn_challenge", may_update: true, may_delete: false },
    ]);
  });

  test("password change and password recovery each succeed as rm_app, and the old passkey and session are refused on the next request", async () => {
    const api = await bootApi();
    try {
      const claim = await call(api, "POST", "/api/admin/claim", { password: "first-password-1234" }, { "X-Admin-Token": operator });
      expect(claim.status).toBe(200);
      const firstRecovery = claim.body.recoveryCode as string;

      // A passkey, and the session it signs in to.
      const before = await registerPasskey(api, "first-password-1234");
      const login = await signIn(api, before);
      expect(login.status).toBe(200);
      const session = login.body.token as string;
      expect(await privileged(api, session)).toBe(200);
      expect(await offered(api)).toContain(before.id);

      // The password change revokes both, in its own transaction.
      const changed = await call(
        api,
        "POST",
        "/api/admin/password-change",
        { currentPassword: "first-password-1234", newPassword: "second-password-1234" },
        { "X-Admin-Token": "first-password-1234" },
      );
      expect(changed.status).toBe(200);
      // The very next request with the old session is refused …
      expect(await privileged(api, session)).toBe(403);
      // … the passkey is not offered, and a sign-in with it is refused.
      expect(await offered(api)).not.toContain(before.id);
      expect(await signIn(api, before)).toEqual({ status: 400, body: { error: "passkey not found" } });
      // The rows are still there, revoked — a tombstone, not a deletion.
      expect(await tombstones({ passkey: before.id })).toEqual({ passkeyRevoked: true, liveSessions: 0, sessions: 1 });
      expect(await privileged(api, "second-password-1234")).toBe(200);

      // The same for the recovery reset.
      const again = await registerPasskey(api, "second-password-1234");
      const second = await signIn(api, again);
      expect(second.status).toBe(200);
      expect(await privileged(api, second.body.token)).toBe(200);
      const recovered = await call(api, "POST", "/api/admin/password-recover", {
        recoveryCode: changed.body.recoveryCode,
        newPassword: "third-password-1234",
      });
      expect(recovered.status).toBe(200);
      expect(changed.body.recoveryCode).not.toBe(firstRecovery);
      expect(await privileged(api, second.body.token)).toBe(403);
      expect(await offered(api)).toEqual([]);
      expect(await signIn(api, again)).toEqual({ status: 400, body: { error: "passkey not found" } });
      expect(await tombstones({ passkey: again.id })).toEqual({ passkeyRevoked: true, liveSessions: 0, sessions: 2 });

      // Every revocation is on file: both rotations audited, nothing removed.
      const [{ n }] = (await owner`
        SELECT count(*)::int AS n FROM audit_log WHERE action IN ('change_admin_password', 'recover_admin_password')`) as unknown as {
        n: number;
      }[];
      expect(n).toBe(2);
      const [{ passkeys }] = (await owner`SELECT count(*)::int AS passkeys FROM admin_passkey`) as unknown as {
        passkeys: number;
      }[];
      expect(passkeys).toBe(2);
    } finally {
      await api.stop();
    }
  }, 180_000);

  test("RED CONTROL: the same api with the change route's revocation put back to a DELETE fails 42501 on this database, and changes nothing", async () => {
    // What the code before wave 5 ran (routes/admin.ts, `DELETE FROM
    // admin_passkey`), on the snapshot-built database it failed on.
    const preload = writeRedControlPreload(
      "src/api/routes/admin.ts",
      "await on(tx, revokePasskeys)`UPDATE admin_passkey SET revoked_at = now() WHERE revoked_at IS NULL`;",
      "await on(tx, revokePasskeys)`DELETE FROM admin_passkey`;",
    );
    const api = await bootApi(preload);
    try {
      const [{ hash }] = (await owner`SELECT pass_hash AS hash FROM admin_credential WHERE id = 1`) as unknown as {
        hash: string;
      }[];
      const changed = await call(
        api,
        "POST",
        "/api/admin/password-change",
        { currentPassword: "third-password-1234", newPassword: "fourth-password-1234" },
        { "X-Admin-Token": "third-password-1234" },
      );
      expect(changed.status).toBe(500);
      // The rotation rolled back with the refused DELETE: the old password
      // still opens the admin surface, the new one does not.
      const [{ after }] = (await owner`SELECT pass_hash AS after FROM admin_credential WHERE id = 1`) as unknown as {
        after: string;
      }[];
      expect(after).toBe(hash);
      expect(await privileged(api, "third-password-1234")).toBe(200);
      expect(await privileged(api, "fourth-password-1234")).toBe(403);
    } finally {
      await api.stop();
    }
  }, 120_000);
});
