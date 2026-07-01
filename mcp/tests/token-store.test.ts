import { describe, expect, test } from "bun:test";
import { TokenStore } from "../src/token-store.ts";

describe("TokenStore", () => {
  test("refresh rotation revokes the previous access-token family", () => {
    const store = new TokenStore(60, 120);
    const first = store.issue({ memberId: "athena", memberToken: "member-secret" })!;
    const second = store.rotate(first.refreshToken)!;

    expect(store.resolveAccess(first.accessToken)).toBeNull();
    expect(store.rotate(first.refreshToken)).toBeNull();
    expect(store.resolveAccess(second.accessToken)?.memberId).toBe("athena");
  });

  test("revoking either token revokes its family", () => {
    const store = new TokenStore(60, 120);
    const issued = store.issue({ memberId: "boreas", memberToken: "member-secret" })!;

    store.revoke(issued.refreshToken);
    expect(store.resolveAccess(issued.accessToken)).toBeNull();
  });

  test("sweep removes expired tokens and capacity becomes available", () => {
    const store = new TokenStore(1, 1, 1);
    const issued = store.issue({ memberId: "cygnus", memberToken: "member-secret" })!;
    expect(store.atCapacity).toBe(true);

    store.sweep(Date.now() + 2_000);
    expect(store.resolveAccess(issued.accessToken)).toBeNull();
    expect(store.atCapacity).toBe(false);
  });
});
