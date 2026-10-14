// website-server/nginx.conf keeps the site up while the api is down (issue 1220 (b)).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const conf = readFileSync(join(import.meta.dir, "../../../website-server/nginx.conf"), "utf8").replace(/^\s*#.*$/gm, "");
const block = (re: RegExp): string => {
  const m = conf.match(re);
  if (!m) throw new Error(`no ${re} block in nginx.conf`);
  return m[0];
};

describe("website-server/nginx.conf maintenance fallback", () => {
  test("/api/ declares error_page 502 503 504 and keeps the client-ip header", () => {
    const api = block(/location\s+\^~\s+\/api\/\s*\{[^}]*\}/);
    expect(api).toMatch(/error_page\s+502\s+503\s+504\s+=\s+@maintenance_body;/);
    expect(api).toMatch(/proxy_set_header\s+CF-Connecting-IP\s+\$client_ip;/);
    expect(api).not.toMatch(/proxy_intercept_errors\s+on/);
  });

  test("the status route falls back to maintenance.json in the web root", () => {
    const status = block(/location\s+=\s+\/api\/status\/maintenance\s*\{[^}]*\}/);
    expect(status).toMatch(/proxy_pass\s+\$api_upstream;/);
    expect(status).toMatch(/error_page\s+502\s+503\s+504\s+=\s+@maintenance_file;/);
    const file = block(/location\s+@maintenance_file\s*\{[^}]*\}/);
    expect(file).toMatch(/root\s+\/srv\/web;/);
    expect(file).toMatch(/try_files\s+\/maintenance\.json\s+@maintenance_body;/);
  });

  test("the 503 body is JSON and says maintenance", () => {
    const body = block(/location\s+@maintenance_body\s*\{[^}]*\}/);
    expect(body).toMatch(/default_type\s+application\/json;/);
    expect(body).toMatch(/return\s+503\s+'\{"error":"maintenance"/);
  });

  test("the site root and the cf geo block are untouched", () => {
    expect(conf).toMatch(/root\s+\/srv\/web\/current;/);
    expect(conf).toMatch(/geo\s+\$cf_trusted_peer/);
  });
});
