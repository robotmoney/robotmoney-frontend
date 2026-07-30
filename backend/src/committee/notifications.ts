import { ROUTES } from "@robotmoney/contract";
import { config } from "../config.ts";
import { type DbHandle, jsonValue, sql } from "../db/client.ts";

export interface SwarmEmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface SwarmEmailTransport {
  send(message: SwarmEmailMessage): Promise<void>;
}

interface ActivationPayload {
  subject: string;
  text: string;
}

export function deploymentSwarmEmailTransport(
  env: Record<string, string | undefined> = process.env,
): SwarmEmailTransport {
  const endpoint = env.COMMITTEE_NOTIFICATION_EMAIL_TRANSPORT_URL;
  if (!endpoint) throw new Error("missing required env var: COMMITTEE_NOTIFICATION_EMAIL_TRANSPORT_URL");
  const token = env.COMMITTEE_NOTIFICATION_EMAIL_TRANSPORT_TOKEN;
  return {
    async send(message) {
      // Hard timeout so a hanging transport endpoint can't stall the single-process,
      // sequential swarm worker lane indefinitely (matches the fetch-timeout
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
        throw new Error(`swarm notification transport returned HTTP ${response.status}`);
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
    subject: "Your Robot Money swarm application was approved",
    text: [
      `Swarm member ${memberId} is now active.`,
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

/** Persist seat_open emails and worker jobs for all unnotified waitlist entries. */
export async function enqueueSeatOpenNotifications(
  tx: DbHandle,
): Promise<string[]> {
  const from = config.committeeNotificationEmailFrom || process.env.COMMITTEE_NOTIFICATION_EMAIL_FROM;
  if (!from) throw new Error("missing required env var: COMMITTEE_NOTIFICATION_EMAIL_FROM");

  const waitlist = await tx<{ id: string; email: string }[]>`
    SELECT id, email FROM committee_waitlist WHERE notified_at IS NULL FOR UPDATE`;
  if (waitlist.length === 0) return [];

  const outboxIds: string[] = [];
  for (const w of waitlist) {
    const payload = {
      subject: "A seat has opened on the Robot Money Investment Swarm",
      text: [
        "A seat is now open on the Robot Money Investment Swarm.",
        "Apply now at https://robotmoney.net/committee/apply",
      ].join("\n\n"),
      waitlistId: w.id,
    };
    const rows = await tx<{ id: string }[]>`
      INSERT INTO committee_notification_outbox (kind, from_email, to_email, payload)
      VALUES ('seat_open', ${from}, ${w.email}, ${tx.json(jsonValue(payload))})
      RETURNING id`;
    const outboxId = rows[0].id;
    outboxIds.push(outboxId);
    await tx`
      INSERT INTO jobs (kind, payload, dedupe_key, scope_type, scope_id, requested_by)
      VALUES (
        'committee.send_seat_open_notification',
        ${tx.json(jsonValue({ outboxId, waitlistId: w.id }))},
        ${`committee:seat-open-notification:${outboxId}`},
        'committee_waitlist',
        ${w.id},
        'system:seat_open'
      )
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
  }
  return outboxIds;
}

/** Send one persisted message. The queue retries thrown transport failures. */
export async function deliverSwarmNotification(
  outboxId: string,
  transport: SwarmEmailTransport = deploymentSwarmEmailTransport(),
): Promise<{ sent: boolean; idempotent?: boolean }> {
  const row = (await sql<{
    from_email: string;
    to_email: string;
    payload: { subject: string; text: string; waitlistId?: string };
    sent_at: Date | null;
  }[]>`
    SELECT from_email, to_email, payload, sent_at
    FROM committee_notification_outbox WHERE id = ${outboxId}`)[0];
  if (!row) throw new Error(`swarm notification outbox row not found: ${outboxId}`);
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
  if (row.payload?.waitlistId) {
    await sql`
      UPDATE committee_waitlist
      SET notified_at = COALESCE(notified_at, now())
      WHERE id = ${row.payload.waitlistId}`;
  }
  return { sent: true };
}
