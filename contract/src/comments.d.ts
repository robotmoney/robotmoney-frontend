// Comments API DTOs.

export interface Comment {
  id: string;
  page: string;
  author: string;
  content: string;
  parentId: string | null;
  status: "visible" | "hidden";
  createdAt: string; // ISO 8601
}

export interface CommentCreate {
  page: string;
  author: string;
  content: string;
  parentId?: string | null;
}

export interface CommentListResponse {
  comments: Comment[];
}
