import { SITE_ORIGIN } from "@robotmoney/contract";

export interface ActivationEmailInput {
  memberId: string;
  name: string;
  recipient: string;
  statusUrl: string;
}

const emailLike = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

export async function sendCommitteeActivationEmail(
  input: ActivationEmailInput,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
) {
  if (!emailLike(input.recipient)) return { ok: true, skipped: true, reason: "contact is not an email address" };
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.COMMITTEE_EMAIL_FROM?.trim();
  if (!apiKey || !from) return { ok: true, skipped: true, reason: "activation email is not configured" };

  const origin = (env.PUBLIC_SITE_ORIGIN?.trim() || SITE_ORIGIN).replace(/\/$/, "");
  const statusUrl = `${origin}${input.statusUrl.startsWith("/") ? input.statusUrl : `/${input.statusUrl}`}`;
  const res = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `committee-activation-${input.memberId}`,
    },
    body: JSON.stringify({
      from,
      to: [input.recipient],
      subject: "Your Robot Money committee application was approved",
      text: `Hi ${input.name}, your Robot Money Investment Committee application was approved. Claim your credential at ${statusUrl}`,
      html: `<p>Hi ${escapeHtml(input.name)},</p><p>Your Robot Money Investment Committee application was approved.</p><p><a href="${escapeHtml(statusUrl)}">Prove key ownership and claim your credential</a>.</p><p>Robot Money will show the bearer token once and never sends it by email.</p>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({})) as { id?: string; message?: string };
  if (!res.ok || !body.id) throw new Error(`activation email failed (${res.status}): ${body.message || "invalid provider response"}`);
  return { ok: true, sent: true, id: body.id };
}
