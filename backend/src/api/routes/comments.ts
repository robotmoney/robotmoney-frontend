import type { CommentListResponse } from "@robotmoney/contract";

// Implemented in Phase 2 (reads from the `comments` table). Stub for now.
export async function listComments(_url: URL): Promise<CommentListResponse> {
  return { comments: [] };
}
