// Unit tests for the pure, network-free helpers in scripts/rmpc-release-e2e.ts
// (issue #104): the release-asset URL resolver and the committee-identity
// subcommand check. The actual live flow (download a real released binary, boot
// the demo stack, drive rmpc through the README external-agent flow) is proven
// by .github/workflows/rmpc-release-e2e-nightly.yml — a full-stack docker-compose
// + real GitHub Releases download is out of place in the required per-PR suite,
// but the deterministic asset-name/URL math and the subcommand-presence check are
// exactly the kind of logic that should NOT go untested between nightly runs.
import { describe, expect, test } from "bun:test";
import { resolveRmpcAsset, missingCommitteeIdentitySubcommands } from "../../rmpc-release-e2e.ts";

describe("resolveRmpcAsset", () => {
  test("linux/x64 → linux-amd64 asset + URL", () => {
    const r = resolveRmpcAsset("v0.3.2", "linux", "x64");
    expect(r).toEqual({
      os: "linux",
      arch: "amd64",
      asset: "rmpc-v0.3.2-linux-amd64.tar.gz",
      url: "https://github.com/robotmoney/robotmoney-core/releases/download/v0.3.2/rmpc-v0.3.2-linux-amd64.tar.gz",
    });
  });

  test("linux/arm64 → linux-arm64 asset", () => {
    const r = resolveRmpcAsset("v0.3.2", "linux", "arm64");
    expect(r.asset).toBe("rmpc-v0.3.2-linux-arm64.tar.gz");
  });

  test("darwin/x64 → macos-amd64 asset", () => {
    const r = resolveRmpcAsset("v0.3.2", "darwin", "x64");
    expect(r.asset).toBe("rmpc-v0.3.2-macos-amd64.tar.gz");
  });

  test("darwin/arm64 → macos-arm64 asset", () => {
    const r = resolveRmpcAsset("v0.3.2", "darwin", "arm64");
    expect(r.asset).toBe("rmpc-v0.3.2-macos-arm64.tar.gz");
  });

  test("a different version pin is reflected verbatim in the asset name + URL", () => {
    const r = resolveRmpcAsset("v9.9.9", "linux", "x64");
    expect(r.asset).toBe("rmpc-v9.9.9-linux-amd64.tar.gz");
    expect(r.url).toContain("/releases/download/v9.9.9/rmpc-v9.9.9-linux-amd64.tar.gz");
  });

  test("throws (never silently degrades) on an unsupported platform", () => {
    expect(() => resolveRmpcAsset("v0.3.2", "win32", "x64")).toThrow(/unsupported runner platform/);
  });

  test("throws on an unsupported architecture", () => {
    expect(() => resolveRmpcAsset("v0.3.2", "linux", "ia32")).toThrow(/unsupported runner platform/);
  });
});

describe("missingCommitteeIdentitySubcommands", () => {
  test("all three subcommands present → nothing missing", () => {
    const help = `
Usage: rmpc committee-identity [OPTIONS] --path <PATH> <COMMAND>

Commands:
  create           Generate a fresh Ed25519 committee MCP signing identity
  show-public-key  Print the identity's base64 public key
  sign             Sign the exact canonical payload string
  help             Print this message or the help of the given subcommand(s)
`;
    expect(missingCommitteeIdentitySubcommands(help)).toEqual([]);
  });

  test("flags a missing subcommand loudly instead of silently passing", () => {
    const help = `
Commands:
  create           Generate a fresh Ed25519 committee MCP signing identity
  help             Print this message or the help of the given subcommand(s)
`;
    expect(missingCommitteeIdentitySubcommands(help).sort()).toEqual(["show-public-key", "sign"]);
  });

  test("empty/garbage help text is missing everything", () => {
    expect(missingCommitteeIdentitySubcommands("").sort()).toEqual(["create", "show-public-key", "sign"]);
  });
});
