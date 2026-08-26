import { describe, expect, test } from "bun:test";
import { resolveBackendBase } from "../src/smoke/e2e.ts";

describe("resolveBackendBase — canonical BACKEND_URL", () => {
  test("returns BACKEND_URL when present", () => {
    expect(
      resolveBackendBase({ BACKEND_URL: "http://backend:1111" }),
    ).toBe("http://backend:1111");
  });

  test("defaults to http://localhost:8787 when unset", () => {
    expect(resolveBackendBase({})).toBe("http://localhost:8787");
  });
});
