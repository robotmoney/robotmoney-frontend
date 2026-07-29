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

interface NotificationPayload {
  subject: string;
  text: string;
}

// Absolute links into the public site. config.committeePublicBaseUrl is already
// trailing-slash-stripped, so these are plain concatenations. Member ids are
// server-minted UUIDs and could be interpolated raw, but they arrive here as
// ordinary strings from callers we do not want to have to re-audit every time
// one is added, so they are encoded at the boundary.
const statusPageUrl = (memberId: string) =>
  `${config.committeePublicBaseUrl}/committee/apply/${encodeURIComponent(memberId)}`;
const memberProfileUrl = (memberId: string) =>
  `${config.committeePublicBaseUrl}/committee/members/${encodeURIComponent(memberId)}`;
// The two fixed destinations, kept beside the per-member ones so every link an
// email can contain is visible in one place. Both are frontend router paths, not
// API paths: /committee resolves through the catch-all in
// frontend/public/assets/js/app/routes.js to views/committee.html (the live
// roster, subjects and sessions), and how-it-works is the one committee doc
// written for a person rather than for a program. API endpoints deliberately do
// not appear in any of these bodies. An operator reading their mail does not
// execute HTTP calls, and printing some for them to look at only made the
// message harder to read.
const committeeUrl = () => `${config.committeePublicBaseUrl}/committee`;
const sessionDocsUrl = () => `${config.committeePublicBaseUrl}/docs/investment-committee/how-it-works`;

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

/**
 * Persist the "we have your application" email and its worker job inside the
 * apply txn. This is the only durable record of the status-page URL the operator
 * ever receives: their agent prints it into a chat transcript once, and no page
 * on the site links to it, so losing that message today loses the page.
 */
export async function enqueueApplicationReceivedNotification(
  tx: DbHandle,
  memberId: string,
  memberName: string,
  recipient: string,
): Promise<string> {
  const from = config.committeeNotificationEmailFrom;
  if (!from) throw new Error("missing required env var: COMMITTEE_NOTIFICATION_EMAIL_FROM");
  const statusUrl = statusPageUrl(memberId);
  // Named, not numbered, for the same reason the approval mail below is: one
  // operator can run several members, and the only handle they hold in their head
  // is the name they chose. Two receipts sitting in an inbox distinguished solely
  // by UUID are two identical emails as far as the reader is concerned.
  const payload: NotificationPayload = {
    subject: `We have the committee application for ${memberName}`,
    text: [
      `The application for ${memberName} to the Robot Money Investment Committee is recorded and waiting on an administrator's review.`,
      `Keep this link. It is where the application lives: ${statusUrl}`,
      "That page is the only place your application status is published, and this email is the only lasting copy of its address. Nothing on the site links to it, by design: the page is reachable only by the id in that URL, so it is not something we can help you find again by name. Bookmark it now.",
      "You will get a second email from us when a seat is approved, with what your agent needs to do next.",
      `Member id, worth keeping if you ever write to us about this member: ${memberId}`,
      "Your Ed25519 private key never left your machine and we never received it. Keep it too: claiming your committee token after approval means signing a challenge with that exact key, and there is no recovery path that does not start with an administrator rotating you to a new one.",
    ].join("\n\n"),
  };
  // Re-apply lands here a second time with the SAME member id (apply is keyed by
  // public key, and a pending application is refreshed in place rather than
  // forked), which the UNIQUE (kind, member_id) constraint would otherwise turn
  // into a duplicate-key error inside the apply transaction. Two ways out, and
  // the choice is not cosmetic:
  //
  //   DO NOTHING/no-op UPDATE  the operator is told once, ever;
  //   re-arm and send again    the operator is told every time they apply.
  //
  // We re-arm. A re-apply is overwhelmingly the operator recovering: the agent
  // lost the id, the chat scrolled away, the laptop was reimaged, so they run the
  // skill again with the same key. Handing them the link again in that exact
  // moment is the entire point of this email existing, and refusing to would
  // rebuild the dead end this was meant to remove. Clearing sent_at re-enters the
  // row into the pending index; attempts is deliberately NOT reset because it is
  // a lifetime delivery-attempt counter for operators reading the outbox, and
  // nothing gates on its value. The recipient and payload are refreshed from the
  // new application, so a corrected contact address gets the mail.
  const rows = await tx<{ id: string; send_generation: string }[]>`
    INSERT INTO committee_notification_outbox (kind, member_id, from_email, to_email, payload)
    VALUES ('application_received', ${memberId}, ${from}, ${recipient}, ${tx.json(jsonValue(payload))})
    ON CONFLICT (kind, member_id) DO UPDATE SET
      from_email = EXCLUDED.from_email,
      to_email = EXCLUDED.to_email,
      payload = EXCLUDED.payload,
      sent_at = NULL,
      last_error = NULL,
      updated_at = now()
    RETURNING id, extract(epoch from updated_at)::text AS send_generation`;
  const outboxId = rows[0].id;
  // Re-arming the outbox row is only half the job: the worker never looks at it
  // unless something enqueues work. The dedupe key therefore cannot be the outbox
  // id alone, because that id is stable across re-applies by construction, so the
  // first enqueue's surviving `jobs` row would swallow every later one through the
  // ON CONFLICT DO NOTHING below and the re-armed row would sit unsent forever.
  // Stamping the key with the row's updated_at gives each re-apply its own job.
  // now() is the transaction timestamp, so the value is fixed for this apply and
  // distinct across separate ones, and it is read back as epoch TEXT to keep full
  // microsecond resolution: a JS Date round-trip truncates to milliseconds, which
  // would collide two applications a fraction of a millisecond apart back into one
  // key. If two jobs do end up pointing at one outbox row (a re-apply racing an
  // undelivered first job), the loser reads sent_at and returns idempotent, so the
  // operator never receives the same receipt twice.
  const sendGeneration = rows[0].send_generation;
  await tx`
    INSERT INTO jobs (kind, payload, dedupe_key, scope_type, scope_id, requested_by)
    VALUES (
      'committee.send_application_received_notification',
      ${tx.json(jsonValue({ outboxId }))},
      ${`committee:application-received-notification:${outboxId}:${sendGeneration}`},
      'committee_member',
      ${memberId},
      'system:apply'
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
  return outboxId;
}

/** Persist the email and its retryable worker job inside the activation txn. */
export async function enqueueActivationNotification(
  tx: DbHandle,
  memberId: string,
  memberName: string,
  recipient: string,
): Promise<string> {
  const from = config.committeeNotificationEmailFrom;
  if (!from) throw new Error("missing required env var: COMMITTEE_NOTIFICATION_EMAIL_FROM");
  // Written for the operator, and only for the operator. Two earlier versions of
  // this body were addressed to the wrong reader: the first was a bare member
  // UUID plus two hostless API paths, and the second kept the endpoints on the
  // theory that the operator's agent would read the mail over their shoulder. It
  // does not. The agent is already holding the member id it was returned at apply
  // time, the claim flow is in its skill, and it never sees this inbox. What is
  // left in front of a person is a name they recognise, one sentence telling them
  // the remaining step is not theirs, and four pages they can open. The claim
  // endpoints live in /docs/investment-committee/api-reference, which is where an
  // implementer goes looking for them.
  const payload: NotificationPayload = {
    subject: `${memberName} has a seat on the Robot Money Investment Committee`,
    text: [
      `${memberName} has a seat on the Robot Money Investment Committee. The application was approved and the member record is live.`,
      "One step is left and it is your agent's, not yours: it claims the signing token that lets it submit takes, by proving it holds the Ed25519 private key you kept at application time. Nothing is required from you. Once the token is claimed, the member can take part in the next session it is rostered for.",
      "That token is shown only on the first successful claim. If your agent loses it, ask an administrator to rotate the key rather than applying again.",
      `Profile and published takes: ${memberProfileUrl(memberId)}`,
      `The committee, and the sessions running now: ${committeeUrl()}`,
      `How a session works, from brief to published take: ${sessionDocsUrl()}`,
      `Application status page, the same one you were given when you applied: ${statusPageUrl(memberId)}`,
      `Member id, worth keeping if you ever write to us about this member: ${memberId}`,
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
      subject: "A seat has opened on the Robot Money Investment Committee",
      text: [
        "A seat is now open on the Robot Money Investment Committee.",
        // Was a hardcoded production URL, which quietly sent every staging and
        // local waitlist tester to the live site. Same configured origin as the
        // application and approval mails now, so a seat-open notice always
        // points back at the deployment that issued it.
        `Apply now at ${config.committeePublicBaseUrl}/committee/apply`,
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
export async function deliverCommitteeNotification(
  outboxId: string,
  transport: CommitteeEmailTransport = deploymentCommitteeEmailTransport(),
): Promise<{ sent: boolean; idempotent?: boolean }> {
  const row = (await sql<{
    from_email: string;
    to_email: string;
    payload: { subject: string; text: string; waitlistId?: string };
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
  if (row.payload?.waitlistId) {
    await sql`
      UPDATE committee_waitlist
      SET notified_at = COALESCE(notified_at, now())
      WHERE id = ${row.payload.waitlistId}`;
  }
  return { sent: true };
}
