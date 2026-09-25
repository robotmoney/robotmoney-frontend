import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import { sql } from "../../db/client.ts";
import { isPrivileged } from "../auth.ts";
import { hashKey } from "../../lib/keys.ts";

const FORBIDDEN = { status: 403, body: { error: "admin authorization required" } } as const;
const BAD = (error: string) => ({ status: 400, body: { error } }) as const;
// Authentication options are public so the login surface can discover a
// passkey before it has a session, so the one-time challenge store is a table
// unauthenticated requests write. D55 (6): such a table "stays bounded with no
// `rm_owner` run", and no runtime role may DELETE. So the store is a fixed set
// of 32 slots (migration 0088): issuing a challenge overwrites the slot with
// the oldest `issued_at` in place, and consuming one is a single-use
// conditional UPDATE of `consumed_at`. rm_app holds no INSERT and no DELETE on
// the table, so a caller can make us evict old pending ceremonies but can never
// change the row count. The transaction advisory lock serializes issuance, so
// two concurrent requests never pick, and overwrite, the same slot.
const CHALLENGE_TTL = "5 minutes";
const CHALLENGE_ISSUE_LOCK = 587001;

// The relying party must match the page hosting the browser WebAuthn call. A
// deployment can pin it explicitly when the API sits behind a reverse proxy;
// otherwise the public request origin is the safe same-origin default. This
// must stay a fallback rather than a header-derived value: Bun.serve here has
// no `tls:` key (TLS is terminated upstream by cloudflared), and X-Forwarded-
// Proto is an unauthenticated client-settable header — trusting it would let
// any caller pick the relying-party origin (issue #617).
export function relyingParty(url: URL): { rpID: string; expectedOrigin: string } {
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

// Single use: the conditional UPDATE matches a live slot at most once. Two
// racing consumers of one challenge serialize on the row, and the second
// re-reads `consumed_at IS NULL` as false and matches nothing — exactly as the
// second of two DELETEs used to. An expired or already-consumed challenge is
// never accepted.
async function consumeChallenge(flow: "registration" | "authentication", challenge: string): Promise<string | null> {
  const rows = await sql<{ challenge: string }[]>`
    UPDATE admin_webauthn_challenge
       SET consumed_at = now()
     WHERE flow = ${flow} AND challenge = ${challenge} AND consumed_at IS NULL AND expires_at > now()
    RETURNING challenge
  `;
  return rows[0]?.challenge ?? null;
}

async function storeChallenge(flow: "registration" | "authentication", challenge: string): Promise<void> {
  await sql.begin(async (tx) => {
    // Serialize issuance so two concurrent option requests never choose the
    // same slot. The slot overwritten is the one issued longest ago, as D55 (6)
    // specifies: an empty slot (issued_at NULL) first, then the oldest
    // ceremony, whether it is pending, consumed or expired. A ceremony lives
    // five minutes, so a pending one is evicted only by 32 newer issuances.
    await tx`SELECT pg_advisory_xact_lock(${CHALLENGE_ISSUE_LOCK})`;
    const written = await tx`
      UPDATE admin_webauthn_challenge
         SET flow = ${flow}, challenge = ${challenge}, issued_at = now(),
             expires_at = now() + ${CHALLENGE_TTL}::interval, consumed_at = NULL
       WHERE slot = (
         SELECT slot FROM admin_webauthn_challenge
          ORDER BY issued_at ASC NULLS FIRST, slot ASC
          LIMIT 1
       )
      RETURNING slot
    `;
    if (written.length !== 1) {
      // 0088 and the blank bootstrap write the 32 slots; the runtime cannot
      // add one. A table with none is a database that never reached 0088.
      throw new Error("admin_webauthn_challenge holds no slot to overwrite: migration 0088 has not been applied");
    }
  });
}

export async function handleAdminWebauthn(
  req: Request,
  url: URL,
): Promise<{ status: number; body: unknown } | null> {
  const p = url.pathname;
  const m = req.method;
  const { rpID, expectedOrigin } = relyingParty(url);

  if (m === "GET" && p === "/api/admin/webauthn/register/options") {
    if (!await isPrivileged(req)) return FORBIDDEN;

    // Live passkeys only: a revoked one (D55 (6), `revoked_at`) is not a
    // credential any more, so it neither blocks re-registering its
    // authenticator nor is offered for sign-in below.
    const passkeys = await sql<{ id: string, transports: string[] }[]>`
      SELECT id, transports FROM admin_passkey WHERE revoked_at IS NULL`;

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

    await storeChallenge("registration", options.challenge);

    return { status: 200, body: options };
  }

  if (m === "POST" && p === "/api/admin/webauthn/register/verify") {
    if (!await isPrivileged(req)) return FORBIDDEN;
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

      const registered = await sql.begin(async (tx) => {
        // Pair the authorization re-check with a credential row lock. If a
        // password rotation wins, its transaction revokes the sessions first
        // and this second check rejects the now-revoked caller. If this wins,
        // rotation waits and then revokes this new passkey before returning.
        await tx`SELECT id FROM admin_credential WHERE id = 1 FOR UPDATE`;
        if (!await isPrivileged(req)) return false;
        await tx`
          INSERT INTO admin_passkey (id, public_key, counter, transports)
          VALUES (${id}, ${Buffer.from(publicKey)}, ${counter}, ${transports || []})
        `;
        await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'register_passkey', ${tx.json({ id })})`;
        return true;
      });
      if (!registered) return FORBIDDEN;

      return { status: 200, body: { verified: true } };
    }

    return BAD("verification failed");
  }

  if (m === "GET" && p === "/api/admin/webauthn/auth/options") {
    const passkeys = await sql<{ id: string, transports: string[] }[]>`
      SELECT id, transports FROM admin_passkey WHERE revoked_at IS NULL`;

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: passkeys.map(pk => ({
        id: pk.id,
        type: "public-key",
        transports: pk.transports as any,
      })),
      userVerification: "preferred",
    });

    await storeChallenge("authentication", options.challenge);

    return { status: 200, body: options };
  }

  if (m === "POST" && p === "/api/admin/webauthn/auth/verify") {
    const body = await req.json().catch(() => null);
    if (!body || !body.id) return BAD("missing body or credential id");

    const responseChallenge = challengeFromResponse(body);
    if (!responseChallenge) return BAD("invalid WebAuthn response");
    const challenge = await consumeChallenge("authentication", responseChallenge);
    if (!challenge) return BAD("challenge not found or expired");

    // A revoked passkey is refused here, on the very next ceremony after the
    // rotation that revoked it (D55 (6)).
    const passkeys = await sql<{ id: string, public_key: Buffer, counter: number, transports: string[] }[]>`
      SELECT id, public_key, counter, transports FROM admin_passkey WHERE id = ${body.id} AND revoked_at IS NULL
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
      const sessionToken = randomBytes(32).toString("base64url");
      const advanced = await sql.begin(async (tx) => {
        // Serialize session issuance with credential rotation. A rotation
        // that follows this lock revokes the just-created session; one that
        // precedes it revokes the passkey so the CAS below cannot succeed.
        await tx`SELECT id FROM admin_credential WHERE id = 1 FOR UPDATE`;
        // Verification uses the counter observed above, but a second valid
        // assertion can finish first. Compare-and-swap makes the stored
        // counter monotonic and prevents the late assertion from regressing
        // it (or minting a session after its credential was revoked). Some
        // authenticators deliberately always report a zero signature counter:
        // accept only that exact zero-to-zero case. Challenge consumption is
        // still single-use, so it does not weaken assertion replay defense.
        const updated = await tx`
          UPDATE admin_passkey
          SET counter = ${newCounter}, last_used_at = now()
          WHERE id = ${pk.id} AND revoked_at IS NULL
            AND (counter < ${newCounter} OR (counter = 0 AND ${newCounter} = 0))
          RETURNING id
        `;
        if (!updated.length) return false;
        await tx`INSERT INTO admin_session (token, expires_at) VALUES (${hashKey(sessionToken)}, now() + interval '1 day')`;
        await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'login_passkey', ${tx.json({ id: pk.id })})`;
        return true;
      });
      if (!advanced) return BAD("passkey counter did not advance");

      return { status: 200, body: { verified: true, token: sessionToken } };
    }

    return BAD("verification failed");
  }

  return null;
}
