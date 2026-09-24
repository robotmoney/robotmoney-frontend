import type { Comment, CommentCreate, CommentListResponse } from "@robotmoney/contract";
import { sql } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import { hashKey } from "../../lib/keys.ts";

// Validation caps — keep posts short and the page slug sane.
const MAX_AUTHOR = 80;
const MAX_CONTENT = 4000;
const MAX_PAGE = 200;

// In-memory per-ip rate limit. Deliberately simple (single-box deployment): a
// sliding window of POST timestamps keyed by the hashed ip. Resets on restart,
// which is fine — it's abuse mitigation, not durable accounting.
const RATE_MAX = 5; // posts allowed...
const RATE_WINDOW_MS = 60_000; // ...per this window
const postLog = new Map<string, number[]>();
let sweepCounter = 0;

// Drop keys whose window has fully aged out, so the map can't grow unboundedly
// (an abuse/DoS vector, amplified if many distinct ips post). Cheap amortized sweep.
function sweep(now: number): void {
  if (++sweepCounter < 500) return;
  sweepCounter = 0;
  const cutoff = now - RATE_WINDOW_MS;
  for (const [k, ts] of postLog) {
    const r = ts.filter((t) => t > cutoff);
    if (r.length === 0) postLog.delete(k);
    else postLog.set(k, r);
  }
}

function rateLimited(ipHash: string, now = Date.now()): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (postLog.get(ipHash) ?? []).filter((t) => t > cutoff);
  if (recent.length >= RATE_MAX) {
    postLog.set(ipHash, recent);
    return true;
  }
  recent.push(now);
  postLog.set(ipHash, recent);
  sweep(now);
  return false;
}

// Every statement is a registered query (smoke-production-spec.md §7.1): the
// public comment routes run as `rm_app`, and this route module is the entry
// module for all three.
const ROUTE = "src/api/routes/comments";

const listVisible = registerQuery({
  role: "rm_app",
  object: "comments",
  privileges: ["SELECT"],
  site: "src/api/routes/comments:listComments",
  purpose: "List a page's visible comments, oldest first, for GET /api/comments.",
  callers: [ROUTE],
});

const readParent = registerQuery({
  role: "rm_app",
  object: "comments",
  privileges: ["SELECT"],
  site: "src/api/routes/comments:createComment.parent",
  purpose: "Check that a reply's parent is a visible comment on the same page before inserting it.",
  callers: [ROUTE],
});

const insertComment = registerQuery({
  role: "rm_app",
  object: "comments",
  // SELECT because of RETURNING, which Postgres checks as a read of the row.
  privileges: ["INSERT", "SELECT"],
  site: "src/api/routes/comments:createComment.insert",
  purpose: "Insert one anonymous comment (ip stored only as a hash) for POST /api/comments.",
  callers: [ROUTE],
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// postgres.js returns timestamptz as a Date; normalize to ISO 8601.
const iso = (d: unknown): string =>
  d instanceof Date ? d.toISOString() : new Date(d as string).toISOString();

function toComment(r: any): Comment {
  return {
    id: r.id,
    page: r.page,
    author: r.author,
    content: r.content,
    parentId: r.parent_id ?? null,
    status: r.status,
    createdAt: iso(r.created_at),
  };
}

// GET /api/comments?page=<slug> — only visible comments, oldest → newest so the
// thread reads top-to-bottom. Empty/missing page → empty list (never an error).
export async function listComments(url: URL): Promise<CommentListResponse> {
  const page = (url.searchParams.get("page") ?? "").trim();
  if (!page) return { comments: [] };
  const rows = await on(sql, listVisible)<any>`
    SELECT id, page, author, content, parent_id, status, created_at
    FROM comments
    WHERE page = ${page} AND status = 'visible'
    ORDER BY created_at ASC`;
  return { comments: rows.map(toComment) };
}

export type CreateResult = { status: number; body: Comment | { error: string } };

// POST /api/comments — validate, rate-limit per hashed ip, insert, return the
// created Comment. `ip` is the raw client address (from x-forwarded-for or the
// socket); it is only ever stored as a sha256 hash.
export async function createComment(raw: unknown, ip: string): Promise<CreateResult> {
  const b = (raw ?? {}) as Partial<CommentCreate>;
  const page = typeof b.page === "string" ? b.page.trim() : "";
  const author = typeof b.author === "string" ? b.author.trim() : "";
  const content = typeof b.content === "string" ? b.content.trim() : "";
  const parentId = b.parentId ? String(b.parentId) : null;

  if (!page || page.length > MAX_PAGE) return { status: 400, body: { error: "invalid page" } };
  if (!author) return { status: 400, body: { error: "author is required" } };
  if (author.length > MAX_AUTHOR) return { status: 400, body: { error: `author exceeds ${MAX_AUTHOR} chars` } };
  if (!content) return { status: 400, body: { error: "content is required" } };
  if (content.length > MAX_CONTENT) return { status: 400, body: { error: `content exceeds ${MAX_CONTENT} chars` } };

  // A reply's parent must be a real, visible comment ON THE SAME PAGE. Validate
  // the id format first (a malformed value must 400, not 500 on insert).
  if (parentId !== null) {
    if (!UUID_RE.test(parentId)) return { status: 400, body: { error: "invalid parentId" } };
    const parent = (await on(sql, readParent)<any>`SELECT page, status FROM comments WHERE id = ${parentId}`)[0];
    if (!parent || parent.page !== page || parent.status !== "visible")
      return { status: 400, body: { error: "invalid parentId" } };
  }

  const ipHash = hashKey(ip || "unknown");
  if (rateLimited(ipHash)) {
    return { status: 429, body: { error: "too many comments — slow down and try again shortly" } };
  }

  const rows = await on(sql, insertComment)<any>`
    INSERT INTO comments (page, author, content, parent_id, ip_hash)
    VALUES (${page}, ${author}, ${content}, ${parentId}, ${ipHash})
    RETURNING id, page, author, content, parent_id, status, created_at`;
  return { status: 201, body: toComment(rows[0]) };
}
