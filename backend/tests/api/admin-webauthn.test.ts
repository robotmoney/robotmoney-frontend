// End-to-end WebAuthn ceremony coverage for the admin passkey endpoints. The
// backend test preload supplies real ephemeral Postgres and fails loudly when
// Docker is unavailable; this fixture supplies a deterministic software
// authenticator so registration and assertion verification execute in CI.
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { isPrivileged } from "../../src/api/auth.ts";
import { handleAdminWebauthn, relyingParty } from "../../src/api/routes/admin-webauthn.ts";
import { hashKey } from "../../src/lib/keys.ts";

const ORIGIN = "http://localhost";
const ADMIN = { adminToken: "passkey-test-admin-token", allowInsecure: false } as const;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function concat(...parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

// The fixture only needs the small CBOR subset used by an ES256 COSE key and a
// `none` attestation object. Keeping it local avoids a test-only encoder
// dependency while still exercising simplewebauthn's real decoder/verifier.
function cborHead(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  if (value < 65_536) return Buffer.from([(major << 5) | 25, value >> 8, value & 0xff]);
  throw new Error(`unsupported CBOR value: ${value}`);
}

function cbor(value: string | number | Uint8Array | Array<[string | number, string | number | Uint8Array | Array<[string | number, string | number | Uint8Array]>]>): Buffer {
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return concat(cborHead(3, bytes.length), bytes);
  }
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
  const entries = value;
  return concat(cborHead(5, entries.length), ...entries.flatMap(([key, entry]) => [cbor(key), cbor(entry)]));
}

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
}

function authenticatorData(credentialID: Uint8Array, publicKeyCOSE?: Uint8Array, counter = 0): Buffer {
  const rpIDHash = createHash("sha256").update("localhost").digest();
  const flags = publicKeyCOSE ? 0x45 : 0x05; // UP + UV (+ AT during registration)
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  if (!publicKeyCOSE) return concat(rpIDHash, Buffer.from([flags]), counterBytes);
  const credentialLength = Buffer.alloc(2);
  credentialLength.writeUInt16BE(credentialID.length);
  return concat(rpIDHash, Buffer.from([flags]), counterBytes, Buffer.alloc(16), credentialLength, credentialID, publicKeyCOSE);
}

function request(method: string, path: string, body?: unknown, token?: string): Request {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["X-Admin-Token"] = token;
  return new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function call(method: string, path: string, body?: unknown, token?: string) {
  const req = request(method, path, body, token);
  return handleAdminWebauthn(req, new URL(req.url), ADMIN);
}

test("WebAuthn zero-counter registration and authentication verify an ES256 passkey", async () => {
  const credentialID = randomBytes(32);
  const credentialID64 = base64url(credentialID);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("P-256 fixture did not export public coordinates");
  const publicKeyCOSE = cbor([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]);

  // Registration starts behind the existing admin gate and persists a
  // one-time challenge before the authenticator response is accepted.
  const registrationOptions = await call("GET", "/api/admin/webauthn/register/options", undefined, ADMIN.adminToken);
  expect(registrationOptions?.status).toBe(200);
  const registrationChallenge = (registrationOptions?.body as { challenge: string; rp: { id: string; name: string } }).challenge;
  expect((registrationOptions?.body as { rp: { id: string; name: string } }).rp).toEqual({ id: "localhost", name: "Robot Money" });

  const registrationClientData = clientData("webauthn.create", registrationChallenge);
  const attestationObject = cbor([
    ["fmt", "none"],
    ["authData", authenticatorData(credentialID, publicKeyCOSE)],
    ["attStmt", []],
  ]);
  const registered = await call("POST", "/api/admin/webauthn/register/verify", {
    id: credentialID64,
    rawId: credentialID64,
    type: "public-key",
    response: { clientDataJSON: base64url(registrationClientData), attestationObject: base64url(attestationObject) },
  }, ADMIN.adminToken);
  expect(registered).toEqual({ status: 200, body: { verified: true } });
  expect(Array.from(await sql`SELECT id, counter FROM admin_passkey WHERE id = ${credentialID64}`)).toEqual([{ id: credentialID64, counter: "0" }]);

  // A real signed zero-counter assertion creates a bearer session, updates
  // last_used_at, and authorizes the existing privileged gate. Some valid
  // authenticators never increment their signature counter, so this exercises
  // the endpoint's exact zero-to-zero exception rather than a mocked verifier.
  const authenticationOptions = await call("GET", "/api/admin/webauthn/auth/options");
  expect(authenticationOptions?.status).toBe(200);
  const authenticationChallenge = (authenticationOptions?.body as { challenge: string; allowCredentials: Array<{ id: string }> }).challenge;
  expect((authenticationOptions?.body as { allowCredentials: Array<{ id: string }> }).allowCredentials.map((credential) => credential.id)).toContain(credentialID64);

  const authenticationClientData = clientData("webauthn.get", authenticationChallenge);
  const assertionData = authenticatorData(credentialID, undefined, 0);
  const signedData = concat(assertionData, createHash("sha256").update(authenticationClientData).digest());
  const signer = createSign("SHA256");
  signer.update(signedData);
  const signature = signer.sign(privateKey);
  const authenticated = await call("POST", "/api/admin/webauthn/auth/verify", {
    id: credentialID64,
    rawId: credentialID64,
    type: "public-key",
    response: {
      clientDataJSON: base64url(authenticationClientData),
      authenticatorData: base64url(assertionData),
      signature: base64url(signature),
      userHandle: null,
    },
  });
  expect(authenticated?.status).toBe(200);
  const sessionToken = (authenticated?.body as { verified: boolean; token: string }).token;
  expect(sessionToken).toHaveLength(43);
  expect(await isPrivileged(request("GET", "/api/admin/overview", undefined, sessionToken), ADMIN)).toBe(true);
  expect(Array.from(await sql`SELECT counter, last_used_at FROM admin_passkey WHERE id = ${credentialID64}`)).toEqual([
    { counter: "0", last_used_at: expect.any(Date) },
  ]);

  // Challenges are consumed by the first verification, so a replay is rejected.
  const replay = await call("POST", "/api/admin/webauthn/auth/verify", {
    id: credentialID64,
    rawId: credentialID64,
    type: "public-key",
    response: {
      clientDataJSON: base64url(authenticationClientData),
      authenticatorData: base64url(assertionData),
      signature: base64url(signature),
      userHandle: null,
    },
  });
  expect(replay?.status).toBe(400);

  await sql`DELETE FROM admin_session WHERE token = ${hashKey(sessionToken)}`;
  await sql`DELETE FROM admin_passkey WHERE id = ${credentialID64}`;
});

test("concurrent out-of-order assertions never regress a passkey counter", async () => {
  const credentialID = randomBytes(32);
  const credentialID64 = base64url(credentialID);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("P-256 fixture did not export public coordinates");
  const publicKeyCOSE = cbor([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]);

  const registrationOptions = await call("GET", "/api/admin/webauthn/register/options", undefined, ADMIN.adminToken);
  const registrationChallenge = (registrationOptions?.body as { challenge: string }).challenge;
  const attestationObject = cbor([
    ["fmt", "none"],
    ["authData", authenticatorData(credentialID, publicKeyCOSE)],
    ["attStmt", []],
  ]);
  expect((await call("POST", "/api/admin/webauthn/register/verify", {
    id: credentialID64,
    rawId: credentialID64,
    type: "public-key",
    response: {
      clientDataJSON: base64url(clientData("webauthn.create", registrationChallenge)),
      attestationObject: base64url(attestationObject),
    },
  }, ADMIN.adminToken))?.status).toBe(200);

  const makeAssertion = (challenge: string, counter: number) => {
    const data = clientData("webauthn.get", challenge);
    const authData = authenticatorData(credentialID, undefined, counter);
    const signer = createSign("SHA256");
    signer.update(concat(authData, createHash("sha256").update(data).digest()));
    return {
      id: credentialID64,
      rawId: credentialID64,
      type: "public-key",
      response: {
        clientDataJSON: base64url(data),
        authenticatorData: base64url(authData),
        signature: base64url(signer.sign(privateKey)),
        userHandle: null,
      },
    };
  };
  const lowOptions = await call("GET", "/api/admin/webauthn/auth/options");
  const highOptions = await call("GET", "/api/admin/webauthn/auth/options");
  const lowAssertion = makeAssertion((lowOptions?.body as { challenge: string }).challenge, 1);
  const highAssertion = makeAssertion((highOptions?.body as { challenge: string }).challenge, 2);

  // Start a lower-counter verification, hold it at body parsing, then let a
  // higher-counter assertion finish first. This reproduces two in-flight
  // browser assertions whose completions arrive out of order.
  let releaseLowBody!: () => void;
  const lowBodyReady = new Promise<void>((resolve) => { releaseLowBody = resolve; });
  let bodySent = false;
  const delayedLowRequest = new Request(`${ORIGIN}/api/admin/webauthn/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (bodySent) return;
        bodySent = true;
        await lowBodyReady;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(lowAssertion)));
        controller.close();
      },
    }),
  });
  const lowResult = handleAdminWebauthn(delayedLowRequest, new URL(delayedLowRequest.url), ADMIN);
  const highResult = await call("POST", "/api/admin/webauthn/auth/verify", highAssertion);
  releaseLowBody();
  const lateLowResult = await lowResult;

  expect(highResult?.status).toBe(200);
  // simplewebauthn re-reads the credential immediately before verification,
  // so this late assertion is rejected at verification rather than reaching
  // our CAS. The CAS is the second line of defense for an assertion that read
  // the old value before another request committed.
  expect(lateLowResult).toEqual({ status: 400, body: { error: "passkey verification failed" } });
  expect(Array.from(await sql`SELECT counter FROM admin_passkey WHERE id = ${credentialID64}`)).toEqual([{ counter: "2" }]);
  expect(await sql`SELECT token FROM admin_session`).toHaveLength(1);

  await sql`DELETE FROM admin_session`;
  await sql`DELETE FROM admin_webauthn_challenge`;
  await sql`DELETE FROM admin_passkey WHERE id = ${credentialID64}`;
});

test("public authentication options clean expiry and retain a bounded challenge set", async () => {
  const prefix = `challenge-cap-${randomBytes(12).toString("hex")}`;
  const expired = `${prefix}-expired`;
  const oldestLive = `${prefix}-oldest-live`;
  await sql`
    INSERT INTO admin_webauthn_challenge (flow, challenge, expires_at)
    VALUES ('authentication', ${expired}, now() - interval '1 minute'),
           ('authentication', ${oldestLive}, now() + interval '1 minute')
  `;
  for (let index = 0; index < 31; index++) {
    await sql`
      INSERT INTO admin_webauthn_challenge (flow, challenge, expires_at)
      VALUES ('authentication', ${`${prefix}-live-${index}`}, now() + interval '2 minutes')
    `;
  }

  const options = await call("GET", "/api/admin/webauthn/auth/options");
  expect(options?.status).toBe(200);
  const issued = (options?.body as { challenge: string }).challenge;
  expect(await sql`SELECT challenge FROM admin_webauthn_challenge WHERE challenge = ${expired}`).toHaveLength(0);
  expect(await sql`SELECT challenge FROM admin_webauthn_challenge WHERE challenge = ${oldestLive}`).toHaveLength(0);
  expect(Array.from(await sql<{ count: string }[]>`SELECT count(*) FROM admin_webauthn_challenge WHERE flow = 'authentication'`)).toEqual([{ count: "32" }]);

  await sql`DELETE FROM admin_webauthn_challenge WHERE challenge LIKE ${`${prefix}%`} OR challenge = ${issued}`;
});

test("relyingParty() prefers WEBAUTHN_ORIGIN over the plain-HTTP request origin behind a TLS proxy", () => {
  const savedOrigin = process.env.WEBAUTHN_ORIGIN;
  const savedRpId = process.env.WEBAUTHN_RP_ID;
  try {
    // cloudflared terminates TLS and forwards to the api's plain-HTTP
    // Bun.serve, so `url` here is exactly what production sees:
    // http://robotmoney.network even though the browser's real origin is
    // https://robotmoney.network. Without the env override this collapses to
    // the wrong scheme and every ceremony fails origin verification (#617).
    delete process.env.WEBAUTHN_ORIGIN;
    delete process.env.WEBAUTHN_RP_ID;
    const proxiedUrl = new URL("http://robotmoney.network/api/admin/webauthn/auth/options");
    expect(relyingParty(proxiedUrl)).toEqual({ rpID: "robotmoney.network", expectedOrigin: "http://robotmoney.network" });

    process.env.WEBAUTHN_ORIGIN = "https://robotmoney.network";
    expect(relyingParty(proxiedUrl)).toEqual({ rpID: "robotmoney.network", expectedOrigin: "https://robotmoney.network" });

    // WEBAUTHN_RP_ID stays independently overridable for a relying party
    // whose id must differ from the origin's own hostname.
    process.env.WEBAUTHN_RP_ID = "robotmoney.example";
    expect(relyingParty(proxiedUrl)).toEqual({ rpID: "robotmoney.example", expectedOrigin: "https://robotmoney.network" });
  } finally {
    if (savedOrigin === undefined) delete process.env.WEBAUTHN_ORIGIN; else process.env.WEBAUTHN_ORIGIN = savedOrigin;
    if (savedRpId === undefined) delete process.env.WEBAUTHN_RP_ID; else process.env.WEBAUTHN_RP_ID = savedRpId;
  }
});
