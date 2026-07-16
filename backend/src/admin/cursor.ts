// Opaque cursor helper shared by every admin list endpoint (jobs/runs/audit).
// The cursor encodes only the last-seen numeric id from a strictly-monotonic
// `id DESC` ordering, so "next page" is `WHERE id < cursor.id`. Base64url of a
// tiny JSON envelope keeps it opaque to the client (never a raw SQL offset)
// while staying trivially decodable server-side.
export interface DecodedCursor {
  id: number;
}

export function encodeCursor(id: number | bigint): string {
  return Buffer.from(JSON.stringify({ id: Number(id) }), "utf8").toString("base64url");
}

// Returns the decoded cursor, `null` for an absent/empty param (first page),
// or throws for a malformed one — callers translate the throw into 400.
export function decodeCursor(raw: string | null): DecodedCursor | null {
  if (raw == null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("malformed cursor");
  }
  if (
    parsed == null ||
    typeof parsed !== "object" ||
    !Number.isFinite((parsed as { id?: unknown }).id) ||
    !Number.isInteger((parsed as { id: number }).id)
  ) {
    throw new Error("malformed cursor");
  }
  return { id: (parsed as { id: number }).id };
}
