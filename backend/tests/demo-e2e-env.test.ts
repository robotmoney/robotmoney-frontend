// Hermetic unit tests for src/demo/e2e.ts resolveBackendBase (review finding
// 014). The backend base URL was configured as API_BASE in that one driver and
// BACKEND_URL in every other (scripts/demo-frontend-check.ts,
// scripts/rmpc-release-e2e.ts, mcp/src/e2e.ts, mcp/src/agent.ts), so exporting
// BACKEND_URL silently failed to repoint it. The resolver honors the canonical
// BACKEND_URL first and keeps API_BASE only as a DEPRECATED one-release
// fallback. Importing src/demo/e2e.ts is safe: its main() is entry-point
// guarded (import.meta.url check), so the demo flow never runs here.
import { describe, expect, test } from "bun:test";
import { resolveBackendBase } from "../src/demo/e2e.ts";

describe("resolveBackendBase — canonical BACKEND_URL, deprecated API_BASE fallback", () => {
  test("BACKEND_URL wins when both variables are set", () => {
    expect(
      resolveBackendBase({ BACKEND_URL: "http://backend:1111", API_BASE: "http://legacy:2222" }),
    ).toBe("http://backend:1111");
  });

  test("API_BASE still works as the deprecated fallback when BACKEND_URL is unset", () => {
    expect(resolveBackendBase({ API_BASE: "http://legacy:2222" })).toBe("http://legacy:2222");
  });

  test("defaults to http://localhost:8787 when neither is set", () => {
    expect(resolveBackendBase({})).toBe("http://localhost:8787");
  });
});
