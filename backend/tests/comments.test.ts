import { test, expect } from "bun:test";
import { createComment, listComments } from "../src/api/routes/comments.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

test("create + list round-trip; validation; parentId checks", async () => {
  const page = rid("p");
  const ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  expect((await createComment({ page, author: "A", content: "hello" }, ip)).status).toBe(201);
  const list = await listComments(new URL(`http://x/api/comments?page=${page}`));
  expect(list.comments.length).toBe(1);

  expect((await createComment({ page, author: "", content: "x" }, ip)).status).toBe(400);
  expect((await createComment({ page, author: "A", content: "" }, ip)).status).toBe(400);
  expect((await createComment({ page, author: "A", content: "x", parentId: "not-a-uuid" }, ip)).status).toBe(400);
  expect((await createComment({ page, author: "A", content: "x", parentId: crypto.randomUUID() }, ip)).status).toBe(400);
});

test("rate limit: a burst from one ip yields 429 after the cap", async () => {
  const page = rid("rl");
  const ip = `10.7.7.${Math.floor(Math.random() * 250)}-${crypto.randomUUID().slice(0, 4)}`;
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await createComment({ page, author: "A", content: "x" }, ip)).status);
  expect(codes.filter((c) => c === 201).length).toBe(5);
  expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
});
