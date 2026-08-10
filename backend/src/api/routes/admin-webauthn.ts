import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import { sql } from "../../db/client.ts";
import { isPrivileged } from "../auth.ts";
import { hashKey } from "../../lib/keys.ts";

const FORBIDDEN = { status: 403, body: { error: "admin authorization required" } } as const;
const BAD = (error: string) => ({ status: 400, body: { error } }) as const;

type AdminAuthConfig = { adminToken: string | null; allowInsecure: boolean };

// The relying party must match the page hosting the browser WebAuthn call. A
// deployment can pin it explicitly when the API sits behind a reverse proxy;
// otherwise the public request origin is the safe same-origin default.
function relyingParty(url: URL): { rpID: string; expectedOrigin: string } {
  const expectedOrigin = process.env.WEBAUTHN_ORIGIN || url.origin;
  const rpID = process.env.WEBAUTHN_RP_ID || new URL(expectedOrigin).hostname;
  return { rpID, expectedOrigin };
}

function challengeFromResponse(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const encoded = (body as { response?: { clientDataJSON?: unknown } }).response?.clientDataJSON;
  if (typeof encoded !== "string") return null;
  try {
    const challenge = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")).challenge;
    return typeof challenge === "string" && challenge.length > 0 ? challenge : null;
  } catch {
    return null;
  }
}

async function consumeChallenge(flow: "registration" | "authentication", challenge: string): Promise<string | null> {
  const rows = await sql<{ challenge: string }[]>`
    DELETE FROM admin_webauthn_challenge
    WHERE flow = ${flow} AND challenge = ${challenge} AND expires_at > now()
    RETURNING challenge
  `;
  return rows[0]?.challenge ?? null;
}

export async function handleAdminWebauthn(
  req: Request,
  url: URL,
  authConfig?: AdminAuthConfig,
): Promise<{ status: number; body: unknown } | null> {
  const p = url.pathname;
  const m = req.method;
  const { rpID, expectedOrigin } = relyingParty(url);

  if (m === "GET" && p === "/api/admin/webauthn/register/options") {
    if (!await isPrivileged(req, authConfig)) return FORBIDDEN;

    const passkeys = await sql<{ id: string, transports: string[] }[]>`SELECT id, transports FROM admin_passkey`;

    const options = await generateRegistrationOptions({
      rpName: "Robot Money",
      rpID,
      userID: new Uint8Array(Buffer.from("admin", "utf-8")),
      userName: "admin",
      attestationType: "none",
      excludeCredentials: passkeys.map(pk => ({
        id: pk.id,
        type: "public-key",
        transports: pk.transports as any,
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

    await sql`
      INSERT INTO admin_webauthn_challenge (flow, challenge, expires_at)
      VALUES ('registration', ${options.challenge}, now() + interval '5 minutes')
    `;

    return { status: 200, body: options };
  }

  if (m === "POST" && p === "/api/admin/webauthn/register/verify") {
    if (!await isPrivileged(req, authConfig)) return FORBIDDEN;
    const body = await req.json().catch(() => null);
    if (!body) return BAD("missing body");

    const responseChallenge = challengeFromResponse(body);
    if (!responseChallenge) return BAD("invalid WebAuthn response");
    const challenge = await consumeChallenge("registration", responseChallenge);
    if (!challenge) return BAD("challenge not found or expired");

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: challenge,
        expectedOrigin,
        expectedRPID: rpID,
      });
    } catch {
      return BAD("passkey verification failed");
    }

    if (verification.verified && verification.registrationInfo) {
      const { credential } = verification.registrationInfo;
      const { id, publicKey, counter, transports } = credential;

      await sql`
        INSERT INTO admin_passkey (id, public_key, counter, transports)
        VALUES (${id}, ${Buffer.from(publicKey)}, ${counter}, ${transports || []})
      `;

      await sql`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'register_passkey', ${sql.json({ id })})`;

      return { status: 200, body: { verified: true } };
    }

    return BAD("verification failed");
  }

  if (m === "GET" && p === "/api/admin/webauthn/auth/options") {
    const passkeys = await sql<{ id: string, transports: string[] }[]>`SELECT id, transports FROM admin_passkey`;

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: passkeys.map(pk => ({
        id: pk.id,
        type: "public-key",
        transports: pk.transports as any,
      })),
      userVerification: "preferred",
    });

    await sql`
      INSERT INTO admin_webauthn_challenge (flow, challenge, expires_at)
      VALUES ('authentication', ${options.challenge}, now() + interval '5 minutes')
    `;

    return { status: 200, body: options };
  }

  if (m === "POST" && p === "/api/admin/webauthn/auth/verify") {
    const body = await req.json().catch(() => null);
    if (!body || !body.id) return BAD("missing body or credential id");

    const responseChallenge = challengeFromResponse(body);
    if (!responseChallenge) return BAD("invalid WebAuthn response");
    const challenge = await consumeChallenge("authentication", responseChallenge);
    if (!challenge) return BAD("challenge not found or expired");

    const passkeys = await sql<{ id: string, public_key: Buffer, counter: number, transports: string[] }[]>`
      SELECT id, public_key, counter, transports FROM admin_passkey WHERE id = ${body.id}
    `;
    if (!passkeys.length) return BAD("passkey not found");
    const pk = passkeys[0];

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: challenge,
        expectedOrigin,
        expectedRPID: rpID,
        credential: {
          id: pk.id,
          publicKey: new Uint8Array(pk.public_key),
          counter: Number(pk.counter),
          transports: pk.transports as any,
        }
      });
    } catch {
      return BAD("passkey verification failed");
    }

    if (verification.verified && verification.authenticationInfo) {
      const { newCounter } = verification.authenticationInfo;
      await sql`UPDATE admin_passkey SET counter = ${newCounter}, last_used_at = now() WHERE id = ${pk.id}`;

      const sessionToken = randomBytes(32).toString("base64url");
      await sql`INSERT INTO admin_session (token, expires_at) VALUES (${hashKey(sessionToken)}, now() + interval '1 day')`;

      await sql`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'login_passkey', ${sql.json({ id: pk.id })})`;

      return { status: 200, body: { verified: true, token: sessionToken } };
    }

    return BAD("verification failed");
  }

  return null;
}
