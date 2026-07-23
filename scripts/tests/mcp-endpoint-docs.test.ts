// MCP connection-endpoint documentation guard (issue #189). mcp/src/server.ts
// is real and already correctly parameterizes MCP_PORT, but docs/architecture.md
// and docs/runbooks/deployment.md never published a concrete staging/production
// hostname for it the way they do for committee.staging.robotmoney.net /
// committee.robotmoney.net, so participation.html had to leave an "ask your
// operator" placeholder instead of a real URL. D18 (docs/decisions.md)
// resolves this: MCP gets its own subdomain, mcp.<staging.>robotmoney.net,
// on Cloudflare's proxied-HTTPS port 8443 (distinct from committee.'s 443,
// since MCP is its own container/service on the same droplet). This test
// pins that resolution across every doc surface so a future PR can't
// silently regress the endpoint back to a placeholder.
//
// Runs in the required integration.yml job via `bun test scripts/tests`
// (root `bun run test` = `bun test scripts/tests`).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const STAGING_HOST = "mcp.staging.robotmoney.net";
const PROD_HOST = "mcp.robotmoney.net";
const PORT = "8443";
const STAGING_URL = `https://${STAGING_HOST}:${PORT}/mcp`;
const PROD_URL = `https://${PROD_HOST}:${PORT}/mcp`;

describe("MCP connection endpoint is documented consistently (D18)", () => {
  test("docs/architecture.md documents the mcp. staging and production hostnames", () => {
    const doc = read("docs/architecture.md");
    expect(doc).toContain(STAGING_HOST);
    expect(doc).toContain(PROD_HOST);
  });

  test("docs/architecture.md documents the Cloudflare-proxied port (8443)", () => {
    expect(read("docs/architecture.md")).toContain(PORT);
  });

  test("docs/runbooks/deployment.md's environments table lists a distinct MCP host for staging and production", () => {
    const doc = read("docs/runbooks/deployment.md");
    expect(doc).toContain(`${STAGING_HOST}:${PORT}`);
    expect(doc).toContain(`${PROD_HOST}:${PORT}`);
  });

  test("docs/decisions.md records D18 (MCP as a fourth subdomain-routed surface)", () => {
    const doc = read("docs/decisions.md");
    expect(doc).toContain("D18");
    expect(doc).toContain(STAGING_HOST);
    expect(doc).toContain(PROD_HOST);
  });

  test("participation.html contains the same concrete staging and production MCP URLs", () => {
    const html = read(
      "frontend/public/views/docs/investment-committee/participation.html",
    );
    expect(html).toContain(STAGING_URL);
    expect(html).toContain(PROD_URL);
  });

  test("participation.html no longer contains the 'ask your operator' MCP URL placeholder", () => {
    const html = read(
      "frontend/public/views/docs/investment-committee/participation.html",
    );
    expect(html).not.toContain("Staging/production MCP URL: ask your operator");
  });
});
