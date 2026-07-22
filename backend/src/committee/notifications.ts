import { ROUTES } from "@robotmoney/contract";
import { config } from "../config.ts";
import { type DbHandle, jsonValue, sql } from "../db/client.ts";

export interface CommitteeEmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface CommitteeEmailTransport {
  send(message: CommitteeEmailMessage): Promise<void>;
}

interface ActivationPayload {
  subject: string;
  text: string;
}

export function deploymentCommitteeEmailTransport(
  env: Record<string, string | undefined> = process.env,
): CommitteeEmailTransport {
  const endpoint = env.COMMITTEE_NOTIFICATION_EMAIL_TRANSPORT_URL;
  if (!endpoint) throw new Error("missing required env var: COMMITTEE_NOTIFICATION_EMAIL_TRANSPORT_URL");
  const token = env.COMMITTEE_NOTIFICATION_EMAIL_TRANSPORT_TOKEN;
  return {
    async send(message) {
      // Hard timeout so a hanging transport endpoint can't stall the single-process,
      // sequential committee worker lane indefinitely (matches the fetch-timeout
      // convention used by chain/token-prices.ts and analytics/extract/http.ts).
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        throw new Error(`committee notification transport returned HTTP ${response.status}`);
      }
    },
  };
}

/** Persist the email and its retryable worker job inside the activation txn. */
export async function enqueueActivationNotification(
  tx: DbHandle,
  memberId: string,
  recipient: string,
): Promise<string> {
  const from = config.committeeNotificationEmailFrom;
  if (!from) throw new Error("missing required env var: COMMITTEE_NOTIFICATION_EMAIL_FROM");
  const payload: ActivationPayload = {
    subject: "Your Robot Money committee application was approved",
    text: [
      `Committee member ${memberId} is now active.`,
      "Request a 10-minute signing challenge and claim your bearer token with the Ed25519 private key you kept at application time.",
      `Challenge endpoint: POST ${ROUTES.committee.claimChallenge}`,
      `Claim endpoint: POST ${ROUTES.committee.claimToken}`,
      "A token is shown only on the first successful claim. If it is lost, ask an administrator to rotate the key.",
    ].join("\n\n"),
  };
  const rows = await tx<{ id: string }[]>`
    INSERT INTO committee_notification_outbox (kind, member_id, from_email, to_email, payload)
    VALUES ('activation_approved', ${memberId}, ${from}, ${recipient}, ${tx.json(jsonValue(payload))})
    ON CONFLICT (kind, member_id) DO UPDATE SET updated_at = committee_notification_outbox.updated_at
    RETURNING id`;
  const outboxId = rows[0].id;
  await tx`
    INSERT INTO jobs (kind, payload, dedupe_key, scope_type, scope_id, requested_by)
    VALUES (
      'committee.send_activation_notification',
      ${tx.json(jsonValue({ outboxId }))},
      ${`committee:activation-notification:${outboxId}`},
      'committee_member',
      ${memberId},
      'system:activation'
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
  return outboxId;
}

/** Send one persisted message. The queue retries thrown transport failures. */
export async function deliverCommitteeNotification(
  outboxId: string,
  transport: CommitteeEmailTransport = deploymentCommitteeEmailTransport(),
): Promise<{ sent: boolean; idempotent?: boolean }> {
  const row = (await sql<{
    from_email: string;
    to_email: string;
    payload: ActivationPayload;
    sent_at: Date | null;
  }[]>`
    SELECT from_email, to_email, payload, sent_at
    FROM committee_notification_outbox WHERE id = ${outboxId}`)[0];
  if (!row) throw new Error(`committee notification outbox row not found: ${outboxId}`);
  if (row.sent_at) return { sent: false, idempotent: true };

  try {
    await transport.send({
      from: row.from_email,
      to: row.to_email,
      subject: row.payload.subject,
      text: row.payload.text,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE committee_notification_outbox
      SET attempts = attempts + 1, last_error = ${message.slice(0, 2000)}, updated_at = now()
      WHERE id = ${outboxId} AND sent_at IS NULL`;
    throw error;
  }
  await sql`
    UPDATE committee_notification_outbox
    SET attempts = attempts + 1, sent_at = now(), last_error = NULL, updated_at = now()
    WHERE id = ${outboxId} AND sent_at IS NULL`;
  return { sent: true };
}
