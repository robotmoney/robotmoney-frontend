import { describe, expect, test } from "bun:test";
import {
  cloudflareId,
  strongToken,
  validHttpsUrl,
  validateDatabaseUrl,
} from "../lib/credential-validation.ts";

describe("credential validation", () => {
  test("requires strong generated tokens", () => {
    expect(strongToken("short")).not.toBeNull();
    expect(strongToken("x".repeat(32))).toBeNull();
  });

  test("validates Cloudflare IDs and HTTPS endpoints", () => {
    expect(cloudflareId("a".repeat(32))).toBeNull();
    expect(cloudflareId("not-an-id")).not.toBeNull();
    expect(validHttpsUrl("https://example.com")).toBe(true);
    expect(validHttpsUrl("http://example.com")).toBe(false);
  });

  test("requires complete TLS PostgreSQL URLs", () => {
    expect(validateDatabaseUrl("postgres://user:pass@db.example/test?sslmode=require")).toBeNull();
    expect(validateDatabaseUrl("postgres://db.example/test")).not.toBeNull();
  });
});
