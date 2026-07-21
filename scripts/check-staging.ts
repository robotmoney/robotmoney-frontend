const marketing = process.env.STAGING_MARKETING_URL || "https://staging.robotmoney.net";
export {};
const api = process.env.STAGING_API_URL || "https://committee.staging.robotmoney.net";
const mcp = process.env.STAGING_MCP_URL || "https://mcp.staging.robotmoney.net:8443";

type Check = { name: string; url: string; json?: (body: any) => boolean };
const checks: Check[] = [
  { name: "marketing shell", url: `${marketing}/` },
  { name: "API health", url: `${api}/health`, json: (body) => body?.status === "ok" },
  { name: "MCP health", url: `${mcp}/health`, json: (body) => body?.status === "ok" },
  {
    name: "MCP OAuth discovery",
    url: `${mcp}/.well-known/oauth-authorization-server`,
    json: (body) => body?.issuer === mcp && body?.token_endpoint === `${mcp}/mcp/oauth/token`,
  },
];

let failed = 0;
for (const check of checks) {
  try {
    const res = await fetch(check.url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
    const contentType = res.headers.get("content-type") || "";
    let valid = res.ok;
    let detail = `${res.status} ${contentType || "no content-type"}`;
    if (check.json) {
      valid &&= contentType.toLowerCase().includes("application/json");
      const body = valid ? await res.json().catch(() => null) : null;
      valid &&= check.json(body);
      if (!valid) detail += " (expected valid JSON payload)";
    } else {
      valid &&= contentType.toLowerCase().includes("text/html");
      if (!valid) detail += " (expected HTML shell)";
    }
    console.log(`${valid ? "PASS" : "FAIL"} ${check.name}: ${detail}`);
    if (!valid) failed++;
  } catch (error) {
    failed++;
    console.log(`FAIL ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed) {
  console.error(`staging readiness failed (${failed}/${checks.length})`);
  process.exit(1);
}
console.log(`staging ready (${checks.length}/${checks.length})`);
