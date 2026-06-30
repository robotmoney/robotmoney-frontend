#!/usr/bin/env bun
/**
 * Audit and configure credentials used by the Robot Money GitOps deployment.
 *
 * GitHub never returns secret values. This tool can therefore prove that a
 * secret exists, but it can only validate a vendor credential while the user
 * supplies it locally. Secret input is sent directly to GitHub and is neither
 * printed nor written to the repository.
 */
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import sodium from "libsodium-wrappers";
import {
  type CredentialVault,
  loadVault,
  saveVault,
} from "./lib/credential-vault.ts";

type Environment = "staging" | "production";
type Result = "pass" | "warn" | "fail";

interface Finding {
  result: Result;
  label: string;
  detail: string;
}

interface SecretSpec {
  name: string;
  description: string;
  source: "generated-token" | "generated-ssh" | "hidden" | "file";
  validate?: (value: string) => Promise<string | null> | string | null;
}

interface VariableSpec {
  name: string;
  description: string;
  validate?: (value: string) => string | null;
}

interface CloudflareMintedToken {
  id: string;
  value: string;
}

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check") || !process.stdin.isTTY;
const VALID_ENVIRONMENTS = new Set<Environment>(["staging", "production"]);
const DEFAULT_VAULT_PATH = join(
  homedir(),
  ".config",
  "robotmoney",
  "gitops",
  "credentials.enc.json",
);
const VAULT_PATH = option("--vault") ?? DEFAULT_VAULT_PATH;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (args.has("--help") || args.has("-h")) {
  console.log(`Robot Money GitOps credential doctor

Usage:
  bun run credentials                       interactive menu
  bun run credentials:check                 read-only audit (no changes)
  bun run credentials -- --environment staging
  bun run credentials -- --repo OWNER/REPO

Options:
  --check                  read-only audit; do not prompt or change anything
  --environment ENV        limit to staging or production (default: both)
  --repo OWNER/REPO        override repository inferred from .git/config
  --vault PATH             encrypted vault path (default: ~/.config/robotmoney/...)
  -h, --help               show this help`);
  process.exit(0);
}

const requestedEnvironment = option("--environment");
if (requestedEnvironment && !VALID_ENVIRONMENTS.has(requestedEnvironment as Environment)) {
  console.error(`Invalid environment "${requestedEnvironment}"; expected staging or production.`);
  process.exit(2);
}
const environments: Environment[] = requestedEnvironment
  ? [requestedEnvironment as Environment]
  : ["staging", "production"];

const rl = createInterface({ input: process.stdin, output: process.stdout });
const activeChildren = new Set<Bun.Subprocess>();
let shuttingDown = false;

function cleanupAndExit(signal: "SIGINT" | "SIGTERM"): never {
  if (shuttingDown) process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  shuttingDown = true;
  console.error(`\nReceived ${signal}, cleaning up...`);
  for (const child of activeChildren) {
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
  }
  activeChildren.clear();
  rl.close();
  process.exit(128 + (signal === "SIGINT" ? 2 : 15));
}

process.on("SIGINT", () => cleanupAndExit("SIGINT"));
process.on("SIGTERM", () => cleanupAndExit("SIGTERM"));

const findings: Finding[] = [];
let vault: CredentialVault | null = null;
let vaultPassphrase: string | null = null;

const ADMIN_SPECS: SecretSpec[] = [
  {
    name: "GITHUB_ADMIN_TOKEN",
    description: "manages repository Environments, secrets, and variables through the GitHub API",
    source: "hidden",
    validate: validateGitHubToken,
  },
  {
    name: "CF_BOOTSTRAP_TOKEN",
    description: "local-only token allowed to create scoped Cloudflare API tokens",
    source: "hidden",
    validate: validateCloudflareToken,
  },
  {
    name: "DO_BOOTSTRAP_TOKEN",
    description: "local-only DigitalOcean administration token; never uploaded to GitHub",
    source: "hidden",
    validate: validateDigitalOceanToken,
  },
];

const SECRET_SPECS: SecretSpec[] = [
  {
    name: "ADMIN_TOKEN",
    description: "guards committee onboarding and administrative endpoints",
    source: "generated-token",
    validate: strongToken,
  },
  {
    name: "ANALYTICS_TOKEN",
    description: "authorizes the analytics provider to publish regime snapshots",
    source: "generated-token",
    validate: strongToken,
  },
  {
    name: "SSH_PRIVATE_KEY",
    description: "lets GitHub Actions deploy to the environment's droplet",
    source: "generated-ssh",
    validate: (value) =>
      value.includes("BEGIN OPENSSH PRIVATE KEY") ? null : "not an OpenSSH private key",
  },
  {
    name: "CF_API_TOKEN",
    description: "environment-scoped GitOps token for Cloudflare DNS, health checks, and logs",
    source: "hidden",
    validate: validateCloudflareToken,
  },
  {
    name: "CF_ORIGIN_CERT",
    description: "Cloudflare Origin CA certificate installed on the droplet",
    source: "file",
    validate: (value) => pem(value, "CERTIFICATE"),
  },
  {
    name: "CF_ORIGIN_KEY",
    description: "private key for the Cloudflare Origin CA certificate",
    source: "file",
    validate: (value) =>
      /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/.test(value) ? null : "not a PEM private key",
  },
  {
    name: "DO_API_TOKEN",
    description: "environment-scoped DigitalOcean GitOps PAT (must differ from DO_BOOTSTRAP_TOKEN)",
    source: "hidden",
    validate: validateDigitalOceanToken,
  },
  {
    name: "DO_SPACES_KEY",
    description: "S3-compatible access-key ID for marketing assets",
    source: "hidden",
    validate: (value) => value.trim().length >= 16 ? null : "access-key ID is unexpectedly short",
  },
  {
    name: "DO_SPACES_SECRET",
    description: "S3-compatible secret key for marketing assets",
    source: "hidden",
    validate: strongToken,
  },
  {
    name: "DATABASE_URL",
    description: "TLS-enabled DigitalOcean Managed PostgreSQL connection URL",
    source: "hidden",
    validate: validateDatabaseUrl,
  },
];

const OPTIONAL_SECRETS: SecretSpec[] = [
  {
    name: "DO_DB_CA_CERT",
    description: "DigitalOcean database CA certificate (needed when system trust is insufficient)",
    source: "file",
    validate: (value) => pem(value, "CERTIFICATE"),
  },
  {
    name: "FRED_API_KEY",
    description: "FRED API key for live macro analytics series (T10Y2Y, HY_OAS, ICSA, UMCSENT); analytics run seeded without it",
    source: "hidden",
    validate: validateFredApiKey,
  },
];

const VARIABLE_SPECS: VariableSpec[] = [
  {
    name: "CF_ACCOUNT_ID",
    description: "Cloudflare account identifier",
    validate: cloudflareId,
  },
  {
    name: "CF_ZONE_ID",
    description: "Cloudflare robotmoney.net zone identifier",
    validate: cloudflareId,
  },
  {
    name: "SPACES_BUCKET",
    description: "DigitalOcean Spaces bucket name",
    validate: (value) => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value)
      ? null : "not a valid bucket name",
  },
  {
    name: "SPACES_REGION",
    description: "DigitalOcean Spaces region, for example nyc3",
    validate: (value) => /^[a-z]{3}\d$/.test(value) ? null : "expected a region such as nyc3",
  },
  {
    name: "SPACES_ENDPOINT",
    description: "DigitalOcean Spaces CDN endpoint URL",
    validate: (value) => validHttpsUrl(value) ? null : "expected an https:// URL",
  },
];

function strongToken(value: string): string | null {
  return value.trim().length >= 32 ? null : "must contain at least 32 characters";
}

function pem(value: string, label: string): string | null {
  return value.includes(`-----BEGIN ${label}-----`) &&
    value.includes(`-----END ${label}-----`)
    ? null
    : `not a PEM ${label.toLowerCase()}`;
}

function cloudflareId(value: string): string | null {
  return /^[a-f0-9]{32}$/i.test(value.trim()) ? null : "expected a 32-character hexadecimal ID";
}

function validHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validateDatabaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) return "URL must use postgres://";
    if (!url.hostname || !url.username || !url.password) return "URL must include host, user, and password";
    if (url.searchParams.get("sslmode") !== "require") return "URL must include sslmode=require";
    return null;
  } catch {
    return "not a valid PostgreSQL URL";
  }
}

async function validateCloudflareToken(value: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { Authorization: `Bearer ${value.trim()}` },
    });
    const body = await response.json() as { success?: boolean; result?: { status?: string } };
    return response.ok && body.success && body.result?.status === "active"
      ? null
      : `Cloudflare rejected the token (HTTP ${response.status})`;
  } catch (error) {
    return `could not reach Cloudflare: ${error instanceof Error ? error.message : error}`;
  }
}

async function validateGitHubToken(value: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout("https://api.github.com/user", {
      headers: githubHeaders(value),
    });
    return response.ok ? null : `GitHub rejected the token (HTTP ${response.status})`;
  } catch (error) {
    return `could not reach GitHub: ${error instanceof Error ? error.message : error}`;
  }
}

async function validateDigitalOceanToken(value: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout("https://api.digitalocean.com/v2/account", {
      headers: { Authorization: `Bearer ${value.trim()}` },
    });
    return response.ok ? null : `DigitalOcean rejected the token (HTTP ${response.status})`;
  } catch (error) {
    return `could not reach DigitalOcean: ${error instanceof Error ? error.message : error}`;
  }
}

async function validateFredApiKey(value: string): Promise<string | null> {
  const key = value.trim();
  if (!/^[0-9a-z]{32}$/.test(key)) {
    return "expected a 32-character lowercase alphanumeric FRED API key";
  }
  try {
    const response = await fetchWithTimeout(
      `https://api.stlouisfed.org/fred/series/observations?series_id=T10Y2Y&api_key=${key}&file_type=json&limit=1`,
    );
    return response.ok ? null : `FRED rejected the key (HTTP ${response.status})`;
  } catch (error) {
    return `could not reach FRED: ${error instanceof Error ? error.message : error}`;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { timeout = 30_000, ...options } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function cloudflareRequest(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetchWithTimeout(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init.headers ?? {}),
    },
  });
}

async function cloudflareMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { errors?: Array<{ message?: string }> };
    const messages = body.errors?.map((error) => error.message).filter(Boolean).join("; ");
    return messages || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function mintCloudflareToken(
  bootstrapToken: string,
  accountId: string,
  zoneId: string,
  environment: Environment,
  requestedPermissions: string[][],
  purpose: string,
): Promise<CloudflareMintedToken> {
  const groupsResponse = await cloudflareRequest(
    "/user/tokens/permission_groups",
    bootstrapToken,
  );
  if (!groupsResponse.ok) {
    throw new Error(`cannot list Cloudflare permission groups: ${await cloudflareMessage(groupsResponse)}`);
  }
  const groupsBody = await groupsResponse.json() as {
    result?: Array<{ id: string; name: string; scopes?: string[] }>;
  };
  const available = groupsBody.result ?? [];
  const selected = requestedPermissions.map((aliases) => {
    const match = available.find((group) =>
      aliases.some((alias) => group.name.toLowerCase() === alias.toLowerCase())
    );
    if (!match) {
      throw new Error(`Cloudflare permission group not available: ${aliases.join(" / ")}`);
    }
    return match;
  });
  const policyGroups = new Map<string, Array<{ id: string }>>();
  for (const group of selected) {
    const accountScoped = group.scopes?.includes("com.cloudflare.api.account") &&
      !group.scopes.includes("com.cloudflare.api.account.zone");
    const resource = accountScoped
      ? `com.cloudflare.api.account.${accountId}`
      : `com.cloudflare.api.account.zone.${zoneId}`;
    policyGroups.set(resource, [...(policyGroups.get(resource) ?? []), { id: group.id }]);
  }

  const response = await cloudflareRequest("/user/tokens", bootstrapToken, {
    method: "POST",
    body: JSON.stringify({
      name: `robotmoney-${purpose}-${environment}-${new Date().toISOString().slice(0, 10)}`,
      policies: Array.from(policyGroups, ([resource, permissionGroups]) => ({
        effect: "allow",
        permission_groups: permissionGroups,
        resources: { [resource]: "*" },
      })),
    }),
  });
  if (!response.ok) {
    throw new Error(`cannot mint Cloudflare token: ${await cloudflareMessage(response)}`);
  }
  const body = await response.json() as {
    result?: { id?: string; value?: string };
  };
  if (!body.result?.id || !body.result.value) {
    throw new Error("Cloudflare created a token but did not return its ID and value");
  }
  return { id: body.result.id, value: body.result.value };
}

async function revokeCloudflareToken(bootstrapToken: string, tokenId: string): Promise<void> {
  const response = await cloudflareRequest(
    `/user/tokens/${encodeURIComponent(tokenId)}`,
    bootstrapToken,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(`could not revoke temporary Cloudflare token: ${await cloudflareMessage(response)}`);
  }
}

async function provisionOriginCertificate(
  environment: Environment,
  accountId: string,
  zoneId: string,
  bootstrapToken: string,
): Promise<{ certificate: string; privateKey: string }> {
  const temporaryToken = await mintCloudflareToken(
    bootstrapToken,
    accountId,
    zoneId,
    environment,
    [["SSL and Certificates Write", "SSL and Certificates Edit"]],
    "origin-cert-bootstrap",
  );
  const directory = await mkdtemp(join(tmpdir(), "robotmoney-origin-cert-"));
  const keyPath = join(directory, "origin.key");
  const csrPath = join(directory, "origin.csr");
  const suffix = environment === "staging" ? ".staging.robotmoney.net" : ".robotmoney.net";
  const hostnames = [`committee${suffix}`, `app${suffix}`];
  try {
    const keyResult = await command([
      "openssl", "ecparam", "-genkey", "-name", "prime256v1", "-out", keyPath,
    ]);
    if (keyResult.code !== 0) throw new Error(`openssl key generation failed: ${keyResult.stderr}`);
    const csrResult = await command([
      "openssl", "req", "-new", "-key", keyPath, "-out", csrPath,
      "-subj", `/CN=${hostnames[0]}`,
      "-addext", `subjectAltName=${hostnames.map((name) => `DNS:${name}`).join(",")}`,
    ]);
    if (csrResult.code !== 0) throw new Error(`openssl CSR generation failed: ${csrResult.stderr}`);
    const csr = await Bun.file(csrPath).text();
    const response = await cloudflareRequest("/certificates", temporaryToken.value, {
      method: "POST",
      body: JSON.stringify({
        csr,
        hostnames,
        request_type: "origin-ecc",
        requested_validity: 5475,
      }),
    });
    if (!response.ok) {
      throw new Error(`cannot create Cloudflare Origin CA certificate: ${await cloudflareMessage(response)}`);
    }
    const body = await response.json() as { result?: { certificate?: string } };
    if (!body.result?.certificate) throw new Error("Cloudflare did not return an Origin CA certificate");
    return {
      certificate: body.result.certificate,
      privateKey: (await Bun.file(keyPath).text()).trim(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
    await revokeCloudflareToken(bootstrapToken, temporaryToken.id);
  }
}

async function createSpacesKey(
  token: string,
  environment: Environment,
  bucket: string,
): Promise<{ accessKey: string; secretKey: string }> {
  const response = await fetchWithTimeout("https://api.digitalocean.com/v2/spaces/keys", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: `robotmoney-gitops-${environment}`,
      grants: [{ bucket, permission: "readwrite" }],
    }),
  });
  if (!response.ok) {
    throw new Error(`cannot create DigitalOcean Spaces key (HTTP ${response.status})`);
  }
  const body = await response.json() as {
    key?: { access_key?: string; secret_key?: string };
  };
  if (!body.key?.access_key || !body.key.secret_key) {
    throw new Error("DigitalOcean created a Spaces key but did not return both credentials");
  }
  return { accessKey: body.key.access_key, secretKey: body.key.secret_key };
}

async function command(
  commandArgs: string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(commandArgs, {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  activeChildren.add(child);
  child.exited.catch(() => {}).finally(() => activeChildren.delete(child));
  if (input !== undefined) {
    if (!child.stdin) throw new Error(`could not open stdin for ${commandArgs[0]}`);
    child.stdin.write(input);
    child.stdin.end();
  }
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function yesNo(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await rl.question(question + suffix)).trim().toLowerCase();
  return answer === "" ? defaultYes : answer === "y" || answer === "yes";
}

async function hidden(question: string): Promise<string> {
  process.stdout.write(`${question}: `);
  rl.pause();
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode?.(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolve) => {
      let input = "";
      const onData = (data: Buffer) => {
        const char = data.toString();
        if (char === "\r" || char === "\n") {
          stdin.setRawMode?.(wasRaw);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(input);
        } else if (char === "\x7f" || char === "\b") {
          if (input.length > 0) input = input.slice(0, -1);
        } else if (char.length === 1 && char >= " ") {
          input += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    rl.resume();
  }
}

async function unlockVault(): Promise<void> {
  const resolvedVault = resolve(VAULT_PATH);
  const repositoryRoot = resolve(process.cwd()) + sep;
  if (resolvedVault.startsWith(repositoryRoot)) {
    throw new Error("credential vault must be stored outside the repository");
  }
  const exists = await Bun.file(VAULT_PATH).exists();
  const passphrase = await hidden(exists ? "Vault passphrase" : "Create vault passphrase");
  if (!exists) {
    const confirmation = await hidden("Confirm vault passphrase");
    if (passphrase !== confirmation) throw new Error("vault passphrases do not match");
  }
  vault = await loadVault(VAULT_PATH, passphrase);
  vaultPassphrase = passphrase;
  if (!exists) {
    await saveCurrentVault();
    console.log(`Created encrypted credential vault: ${VAULT_PATH}`);
  } else {
    console.log(`Unlocked encrypted credential vault: ${VAULT_PATH}`);
  }
}

async function saveCurrentVault(): Promise<void> {
  if (!vault || !vaultPassphrase) throw new Error("credential vault is not unlocked");
  await saveVault(VAULT_PATH, vault, vaultPassphrase);
}

async function migrateLegacyCredentials(): Promise<void> {
  if (!vault) return;
  const legacy: Array<{ environment: Environment; name: string; path: string }> = [];
  for (const environment of environments) {
    const directory = join(homedir(), ".config", "robotmoney", "gitops", environment);
    for (const [name, filename] of [
      ["ADMIN_TOKEN", "ADMIN_TOKEN"],
      ["ANALYTICS_TOKEN", "ANALYTICS_TOKEN"],
      ["SSH_PRIVATE_KEY", "deploy_ed25519"],
    ] as const) {
      const path = join(directory, filename);
      if (await Bun.file(path).exists()) legacy.push({ environment, name, path });
    }
  }
  if (!legacy.length) return;

  console.log(`\n! Found ${legacy.length} plaintext credential file(s) created by the old tool.`);
  if (!await yesNo("Move them into the encrypted vault and remove the plaintext files?", true)) {
    findings.push({
      result: "warn",
      label: "plaintext credentials",
      detail: "legacy plaintext credential files remain on this machine",
    });
    return;
  }

  for (const item of legacy) {
    if (!vault.deployment[item.environment][item.name]) {
      vault.deployment[item.environment][item.name] = (await Bun.file(item.path).text()).trim();
    }
    await rm(item.path, { force: true });
  }
  await saveCurrentVault();
  console.log("  migrated credentials and removed plaintext private files");
}

async function stageAdminCredentials(forceReview: boolean): Promise<void> {
  if (!vault) return;
  console.log("\nADMIN BOOTSTRAP KEYS (local vault only; never uploaded)");
  for (const spec of ADMIN_SPECS) {
    const existing = Boolean(vault.admin[spec.name]);
    const optional = spec.name === "DO_BOOTSTRAP_TOKEN";
    console.log(`  ${existing ? "✓" : optional ? "!" : "✗"} ${spec.name}${optional ? " (optional)" : ""} — ${spec.description}`);
    if (!forceReview && existing) continue;
    if (!forceReview && optional) continue;
    const prompt = existing ? `  Replace staged ${spec.name}?` : `  Stage ${spec.name} now?`;
    if (!await yesNo(prompt)) continue;
    const value = await hidden(`  Enter ${spec.name} (hidden)`);
    if (!value) {
      console.log("  skipped: no value supplied");
      continue;
    }
    const problem = await spec.validate?.(value);
    if (problem) {
      console.log(`  validation failed: ${problem}`);
      if (!await yesNo("  Stage this value anyway?")) continue;
    }
    vault.admin[spec.name] = value;
    await saveCurrentVault();
    console.log(`  staged ${spec.name} in the encrypted vault`);
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "robotmoney-credential-doctor",
  };
}

function githubToken(): string {
  const token = vault?.admin.GITHUB_ADMIN_TOKEN ??
    process.env.ROBOTMONEY_GITHUB_ADMIN_TOKEN ??
    process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GitHub API authentication is missing; stage GITHUB_ADMIN_TOKEN or set ROBOTMONEY_GITHUB_ADMIN_TOKEN",
    );
  }
  return token;
}

async function githubApi(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = {
    ...githubHeaders(githubToken()),
    ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(init.headers ?? {}),
  };
  return fetchWithTimeout(`https://api.github.com${path}`, { ...init, headers });
}

async function githubError(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = await response.json() as { message?: string };
    detail = body.message ? `: ${body.message}` : "";
  } catch {
    // An HTTP status is sufficient when GitHub returns no JSON body.
  }
  return `HTTP ${response.status}${detail}`;
}

async function inferRepo(): Promise<string> {
  const explicit = option("--repo");
  if (explicit) return explicit;
  const config = Bun.file(join(process.cwd(), ".git", "config"));
  if (!await config.exists()) {
    throw new Error("could not infer GitHub repository; pass --repo OWNER/REPO");
  }
  const text = await config.text();
  const remote = text.match(
    /url\s*=\s*(?:https:\/\/github\.com\/|git@github\.com:)([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/m,
  );
  if (!remote?.[1]) throw new Error("could not infer GitHub repository; pass --repo OWNER/REPO");
  return remote[1].replace(/\.git$/, "");
}

async function githubNames(
  repo: string,
  environment: Environment,
  kind: "secret" | "variable",
): Promise<Set<string> | null> {
  const plural = kind === "secret" ? "secrets" : "variables";
  const response = await githubApi(
    `/repos/${repo}/environments/${environment}/${plural}?per_page=100`,
  );
  if (!response.ok) return null;
  const body = await response.json() as {
    secrets?: Array<{ name: string }>;
    variables?: Array<{ name: string }>;
  };
  const values = kind === "secret" ? body.secrets : body.variables;
  return new Set((values ?? []).map((value) => value.name));
}

async function githubVariables(
  repo: string,
  environment: Environment,
): Promise<Map<string, string> | null> {
  const response = await githubApi(
    `/repos/${repo}/environments/${environment}/variables?per_page=100`,
  );
  if (!response.ok) return null;
  const body = await response.json() as {
    variables?: Array<{ name: string; value: string }>;
  };
  return new Map((body.variables ?? []).map((variable) => [variable.name, variable.value]));
}

async function ensureEnvironment(repo: string, environment: Environment): Promise<boolean> {
  const path = `/repos/${repo}/environments/${environment}`;
  const probe = await githubApi(path);
  if (probe.ok) return true;
  if (CHECK_ONLY || !await yesNo(`Create GitHub environment "${environment}"?`, true)) {
    findings.push({ result: "fail", label: environment, detail: "GitHub environment does not exist" });
    return false;
  }
  const create = await githubApi(path, { method: "PUT", body: JSON.stringify({}) });
  if (!create.ok) throw new Error(`could not create ${environment}: ${await githubError(create)}`);
  console.log(`  created GitHub environment ${environment}`);
  return true;
}

async function uploadSecret(
  repo: string,
  environment: Environment,
  name: string,
  value: string,
): Promise<void> {
  const base = `/repos/${repo}/environments/${environment}/secrets`;
  const keyResponse = await githubApi(`${base}/public-key`);
  if (!keyResponse.ok) {
    throw new Error(`could not get GitHub secret public key: ${await githubError(keyResponse)}`);
  }
  const key = await keyResponse.json() as { key: string; key_id: string };
  await sodium.ready;
  const publicKey = sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL);
  const encrypted = sodium.crypto_box_seal(sodium.from_string(value), publicKey);
  const encryptedValue = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
  const response = await githubApi(`${base}/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id: key.key_id }),
  });
  if (!response.ok) throw new Error(`could not set ${name}: ${await githubError(response)}`);
}

async function uploadVariable(
  repo: string,
  environment: Environment,
  name: string,
  value: string,
): Promise<void> {
  const response = await githubApi(`/repos/${repo}/environments/${environment}/variables`, {
    method: "POST",
    body: JSON.stringify({ name, value }),
  });
  if (!response.ok) throw new Error(`could not set ${name}: ${await githubError(response)}`);
}

async function deleteSecret(repo: string, environment: Environment, name: string): Promise<void> {
  const response = await githubApi(
    `/repos/${repo}/environments/${environment}/secrets/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`could not delete secret ${name}: ${await githubError(response)}`);
  }
}

async function deleteVariable(repo: string, environment: Environment, name: string): Promise<void> {
  const response = await githubApi(
    `/repos/${repo}/environments/${environment}/variables/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`could not delete variable ${name}: ${await githubError(response)}`);
  }
}

async function generateToken(environment: Environment, name: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  console.log(`  generated ${name}; it will be stored only in the encrypted vault`);
  return value;
}

async function generateSshKey(environment: Environment): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "robotmoney-ssh-"));
  const temporaryKey = join(temporaryDirectory, "deploy_ed25519");
  const publicDirectory = join(homedir(), ".config", "robotmoney", "gitops", "public");
  const publicPath = join(publicDirectory, `${environment}_deploy_ed25519.pub`);
  try {
    const result = await command([
      "ssh-keygen", "-q", "-t", "ed25519", "-N", "",
      "-C", `robotmoney-${environment}-github-actions`, "-f", temporaryKey,
    ]);
    if (result.code !== 0) throw new Error(`ssh-keygen failed: ${result.stderr}`);
    const privateKey = (await Bun.file(temporaryKey).text()).trim();
    const publicKey = await Bun.file(`${temporaryKey}.pub`).text();
    await mkdir(publicDirectory, { recursive: true, mode: 0o700 });
    await Bun.write(publicPath, publicKey);
    await chmod(publicPath, 0o600);
    console.log(`  public key to install on the droplet: ${publicPath}`);
    return privateKey;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function getSecretValue(spec: SecretSpec, environment: Environment): Promise<string | null> {
  if (spec.source === "generated-token") return generateToken(environment, spec.name);
  if (spec.source === "generated-ssh") return generateSshKey(environment);
  if (spec.source === "hidden") return hidden(`  Enter ${spec.name} (hidden)`);

  const path = (await rl.question(`  Path containing ${spec.name}: `)).trim();
  if (!path) return null;
  const file = Bun.file(path);
  if (!await file.exists()) {
    console.log(`  file does not exist: ${path}`);
    return null;
  }
  return (await file.text()).trim();
}

async function repairSecret(
  repo: string,
  environment: Environment,
  spec: SecretSpec,
  variables: Map<string, string>,
): Promise<boolean> {
  if (!vault) throw new Error("credential vault is not unlocked");
  console.log(`  ${spec.name}: ${spec.description}`);
  const staged = vault.deployment[environment][spec.name];
  let value: string | null;
  if (staged) {
    if (!await yesNo(`  Upload staged ${spec.name} from the encrypted vault?`, true)) return false;
    value = staged;
  } else {
    const accountId = variables.get("CF_ACCOUNT_ID");
    const zoneId = variables.get("CF_ZONE_ID");
    const bootstrapToken = vault.admin.CF_BOOTSTRAP_TOKEN;
    try {
      if (spec.name === "CF_API_TOKEN" && accountId && zoneId && bootstrapToken) {
        if (await yesNo("  Mint an environment-scoped token using CF_BOOTSTRAP_TOKEN?", true)) {
          const minted = await mintCloudflareToken(
            bootstrapToken,
            accountId,
            zoneId,
            environment,
            [
              ["DNS Write", "DNS Edit"],
              ["Health Checks Write", "Health Checks Edit"],
              ["Analytics Read", "Zone Analytics Read"],
              ["Logs Write", "Logpush Write", "Logpush Edit"],
              ["Zone Read"],
            ],
            "gitops",
          );
          vault.deployment[environment].CF_API_TOKEN_ID = minted.id;
          value = minted.value;
        } else {
          return false;
        }
      } else if (spec.name === "CF_ORIGIN_CERT" && accountId && zoneId && bootstrapToken) {
        if (await yesNo("  Generate the key and provision an Origin CA certificate through Cloudflare?", true)) {
          const origin = await provisionOriginCertificate(
            environment,
            accountId,
            zoneId,
            bootstrapToken,
          );
          vault.deployment[environment].CF_ORIGIN_CERT = origin.certificate;
          vault.deployment[environment].CF_ORIGIN_KEY = origin.privateKey;
          await saveCurrentVault();
          value = origin.certificate;
        } else {
          return false;
        }
      } else if (
        spec.name === "DO_SPACES_KEY" &&
        vault.deployment[environment].DO_API_TOKEN &&
        variables.get("SPACES_BUCKET")
      ) {
        if (await yesNo("  Create a bucket-scoped Spaces key through the DigitalOcean API?", true)) {
          const spaces = await createSpacesKey(
            vault.deployment[environment].DO_API_TOKEN,
            environment,
            variables.get("SPACES_BUCKET")!,
          );
          vault.deployment[environment].DO_SPACES_KEY = spaces.accessKey;
          vault.deployment[environment].DO_SPACES_SECRET = spaces.secretKey;
          await saveCurrentVault();
          value = spaces.accessKey;
        } else {
          return false;
        }
      } else {
        if (!await yesNo(`  Stage and configure ${spec.name} now?`)) return false;
        value = await getSecretValue(spec, environment);
      }
    } catch (error) {
      console.log(`  automated bootstrap failed: ${error instanceof Error ? error.message : error}`);
      if (!await yesNo(`  Stage ${spec.name} manually instead?`)) return false;
      value = await getSecretValue(spec, environment);
    }
  }
  if (!value) {
    console.log("  skipped: no value supplied");
    return false;
  }
  const adminEquivalent = spec.name === "CF_API_TOKEN"
    ? vault.admin.CF_BOOTSTRAP_TOKEN
    : spec.name === "DO_API_TOKEN"
      ? vault.admin.DO_BOOTSTRAP_TOKEN
      : undefined;
  if (adminEquivalent && value === adminEquivalent) {
    console.log("  rejected: deployment credentials must not reuse an admin bootstrap key");
    return false;
  }
  const problem = await spec.validate?.(value);
  if (problem) {
    console.log(`  validation failed: ${problem}`);
    if (!await yesNo("  Upload this value anyway?")) return false;
  }
  if (!staged) {
    vault.deployment[environment][spec.name] = value;
    await saveCurrentVault();
    console.log(`  staged ${spec.name} in the encrypted vault`);
  }
  await uploadSecret(repo, environment, spec.name, value);
  console.log(`  uploaded ${spec.name}`);
  return true;
}

async function auditEnvironment(repo: string, environment: Environment): Promise<void> {
  console.log(`\n${environment.toUpperCase()}`);
  if (!await ensureEnvironment(repo, environment)) return;

  let secrets = await githubNames(repo, environment, "secret");
  let variables = await githubVariables(repo, environment);
  if (!secrets || !variables) {
    findings.push({
      result: "fail",
      label: environment,
      detail: "cannot list GitHub environment secrets/variables; check repository permission",
    });
    return;
  }

  const existingVariables = VARIABLE_SPECS.filter((s) => variables.has(s.name)).length;
  const existingSecrets = SECRET_SPECS.filter((s) => secrets.has(s.name)).length;
  const existingOptional = OPTIONAL_SECRETS.filter((s) => secrets.has(s.name)).length;
  console.log(`  ${existingVariables} variable(s), ${existingSecrets} required secret(s), ${existingOptional} optional secret(s) found on GitHub.`);

  for (const spec of VARIABLE_SPECS) {
    if (variables.has(spec.name)) {
      console.log(`  ✓ ${spec.name}`);
      continue;
    }
    console.log(`  ✗ ${spec.name} — ${spec.description}`);
    if (CHECK_ONLY || !await yesNo(`  Configure ${spec.name} now?`)) {
      findings.push({ result: "fail", label: `${environment}/${spec.name}`, detail: spec.description });
      continue;
    }
    const value = (await rl.question(`  Enter ${spec.name}: `)).trim();
    const problem = spec.validate?.(value);
    if (!value || problem) {
      console.log(`  rejected: ${problem ?? "no value supplied"}`);
      findings.push({ result: "fail", label: `${environment}/${spec.name}`, detail: spec.description });
      continue;
    }
    await uploadVariable(repo, environment, spec.name, value);
    variables.set(spec.name, value);
    console.log(`  uploaded ${spec.name}`);
  }

  for (const spec of SECRET_SPECS) {
    if (secrets.has(spec.name)) {
      console.log(`  ✓ ${spec.name}`);
      continue;
    }
    console.log(`  ✗ ${spec.name} — ${spec.description}`);
    if (!CHECK_ONLY && await repairSecret(repo, environment, spec, variables)) {
      secrets.add(spec.name);
    } else {
      findings.push({ result: "fail", label: `${environment}/${spec.name}`, detail: spec.description });
    }
  }

  for (const spec of OPTIONAL_SECRETS) {
    if (secrets.has(spec.name)) {
      console.log(`  ✓ ${spec.name} (optional)`);
      continue;
    }
    console.log(`  ! ${spec.name} (optional) — ${spec.description}`);
    if (!CHECK_ONLY && await repairSecret(repo, environment, spec, variables)) {
      secrets.add(spec.name);
    } else {
      findings.push({ result: "warn", label: `${environment}/${spec.name}`, detail: spec.description });
    }
  }

  const unresolvedSecrets = SECRET_SPECS.filter((spec) => !secrets.has(spec.name));
  const unresolvedVariables = VARIABLE_SPECS.filter((spec) => !variables.has(spec.name));
  if (unresolvedSecrets.length || unresolvedVariables.length) {
    console.log("\n  Outstanding:");
    for (const spec of unresolvedSecrets) console.log(`    - secret ${spec.name}: ${spec.description}`);
    for (const spec of unresolvedVariables) console.log(`    - variable ${spec.name}: ${spec.description}`);
  } else {
    console.log("  credential inventory complete");
  }
}

// ===== Step Functions =====

async function collectVariable(
  environment: Environment,
  spec: VariableSpec,
): Promise<string | null> {
  if (!vault) throw new Error("credential vault is not unlocked");
  const existing = vault.deployment[environment][spec.name];
  if (existing) {
    console.log(`  ✓ ${spec.name} — already in vault`);
    return existing;
  }
  console.log(`  ${spec.name} — ${spec.description}`);
  const value = (await rl.question(`  Enter ${spec.name}: `)).trim();
  const problem = spec.validate?.(value);
  if (!value || problem) {
    console.log(`  rejected: ${problem ?? "no value supplied"}`);
    return null;
  }
  vault.deployment[environment][spec.name] = value;
  await saveCurrentVault();
  console.log(`  stored ${spec.name} in the encrypted vault`);
  return value;
}

async function collectDeploymentSecret(
  environment: Environment,
  spec: SecretSpec,
  variables: Record<string, string>,
): Promise<string | null> {
  if (!vault) throw new Error("credential vault is not unlocked");
  const existing = vault.deployment[environment][spec.name];
  if (existing) {
    console.log(`  ✓ ${spec.name} — already in vault`);
    return existing;
  }
  console.log(`  ${spec.name} — ${spec.description}`);

  const accountId = variables["CF_ACCOUNT_ID"];
  const zoneId = variables["CF_ZONE_ID"];
  const bootstrapToken = vault.admin.CF_BOOTSTRAP_TOKEN;
  try {
    if (spec.name === "CF_API_TOKEN" && accountId && zoneId && bootstrapToken) {
      if (!await yesNo("  Mint an environment-scoped token using CF_BOOTSTRAP_TOKEN?", true)) return null;
      const minted = await mintCloudflareToken(
        bootstrapToken, accountId, zoneId, environment,
        [
          ["DNS Write", "DNS Edit"],
          ["Health Checks Write", "Health Checks Edit"],
          ["Analytics Read", "Zone Analytics Read"],
          ["Logs Write", "Logpush Write", "Logpush Edit"],
          ["Zone Read"],
        ],
        "gitops",
      );
      vault.deployment[environment].CF_API_TOKEN_ID = minted.id;
      vault.deployment[environment][spec.name] = minted.value;
      await saveCurrentVault();
      console.log(`  stored ${spec.name} in the encrypted vault`);
      return minted.value;
    } else if (spec.name === "CF_ORIGIN_CERT" && accountId && zoneId && bootstrapToken) {
      if (!await yesNo("  Generate key and provision Origin CA certificate through Cloudflare?", true)) return null;
      const origin = await provisionOriginCertificate(environment, accountId, zoneId, bootstrapToken);
      vault.deployment[environment].CF_ORIGIN_CERT = origin.certificate;
      vault.deployment[environment].CF_ORIGIN_KEY = origin.privateKey;
      await saveCurrentVault();
      console.log("  stored CF_ORIGIN_CERT and CF_ORIGIN_KEY in the encrypted vault");
      return origin.certificate;
    } else if (
      spec.name === "DO_SPACES_KEY" &&
      vault.deployment[environment].DO_API_TOKEN &&
      variables["SPACES_BUCKET"]
    ) {
      if (!await yesNo("  Create a bucket-scoped Spaces key through the DigitalOcean API?", true)) return null;
      const spaces = await createSpacesKey(
        vault.deployment[environment].DO_API_TOKEN, environment, variables["SPACES_BUCKET"],
      );
      vault.deployment[environment].DO_SPACES_KEY = spaces.accessKey;
      vault.deployment[environment].DO_SPACES_SECRET = spaces.secretKey;
      await saveCurrentVault();
      console.log("  stored DO_SPACES_KEY and DO_SPACES_SECRET in the encrypted vault");
      return spaces.accessKey;
    } else {
      if (!await yesNo(`  Configure ${spec.name} now?`)) return null;
      const value = await getSecretValue(spec, environment);
      if (!value) {
        console.log("  skipped: no value supplied");
        return null;
      }
      const problem = await spec.validate?.(value);
      if (problem) {
        console.log(`  validation failed: ${problem}`);
        if (!await yesNo("  Store this value anyway?")) return null;
      }
      const adminEquivalent = spec.name === "CF_API_TOKEN"
        ? vault.admin.CF_BOOTSTRAP_TOKEN
        : spec.name === "DO_API_TOKEN"
          ? vault.admin.DO_BOOTSTRAP_TOKEN
          : undefined;
      if (adminEquivalent && value === adminEquivalent) {
        console.log("  rejected: deployment credentials must not reuse an admin bootstrap key");
        return null;
      }
      vault.deployment[environment][spec.name] = value;
      await saveCurrentVault();
      console.log(`  stored ${spec.name} in the encrypted vault`);
      return value;
    }
  } catch (error) {
    console.log(`  automated bootstrap failed: ${error instanceof Error ? error.message : error}`);
    if (!await yesNo(`  Configure ${spec.name} manually instead?`)) return null;
    const value = await getSecretValue(spec, environment);
    if (!value) {
      console.log("  skipped: no value supplied");
      return null;
    }
    const adminEquivalent = spec.name === "CF_API_TOKEN"
      ? vault.admin.CF_BOOTSTRAP_TOKEN
      : spec.name === "DO_API_TOKEN"
        ? vault.admin.DO_BOOTSTRAP_TOKEN
        : undefined;
    if (adminEquivalent && value === adminEquivalent) {
      console.log("  rejected: deployment credentials must not reuse an admin bootstrap key");
      return null;
    }
    vault.deployment[environment][spec.name] = value;
    await saveCurrentVault();
    console.log(`  stored ${spec.name} in the encrypted vault`);
    return value;
  }
}

async function step1ConfigureAdmin(): Promise<void> {
  console.log("───── Step 1: Configure Admin Bootstrap Keys ─────\n");
  await stageAdminCredentials(true);
  const missing = ADMIN_SPECS.filter((s) => !vault?.admin[s.name]);
  if (missing.length) {
    console.log(`\n  Admin keys still missing: ${missing.map((s) => s.name).join(", ")}`);
  } else {
    console.log("\n  All admin bootstrap keys are configured.");
  }
}

async function step2CollectKeys(): Promise<void> {
  console.log("───── Step 2: Collect Deployment Credentials ─────\n");
  for (const environment of environments) {
    console.log(`--- ${environment.toUpperCase()} ---`);
    const variables: Record<string, string> = {};
    for (const spec of VARIABLE_SPECS) {
      const value = await collectVariable(environment, spec);
      if (value) variables[spec.name] = value;
    }
    for (const spec of SECRET_SPECS) {
      await collectDeploymentSecret(environment, spec, variables);
    }
    for (const spec of OPTIONAL_SECRETS) {
      const value = await collectDeploymentSecret(environment, spec, variables);
      if (!value && !vault?.deployment[environment][spec.name]) {
        findings.push({ result: "warn", label: `${environment}/${spec.name}`, detail: spec.description });
      }
    }
    const missingVars = VARIABLE_SPECS.filter((s) => !vault?.deployment[environment][s.name]);
    const missingSecrets = SECRET_SPECS.filter((s) => !vault?.deployment[environment][s.name]);
    if (missingVars.length || missingSecrets.length) {
      console.log("\n  Still missing from vault:");
      for (const s of missingVars) console.log(`    variable ${s.name}: ${s.description}`);
      for (const s of missingSecrets) console.log(`    secret ${s.name}: ${s.description}`);
    } else {
      console.log("  All credentials collected for this environment.");
    }
  }
}

async function step3PublishKeys(): Promise<void> {
  console.log("───── Step 3: Publish Credentials to GitHub ─────\n");
  if (!vault?.admin.GITHUB_ADMIN_TOKEN) {
    console.error("GITHUB_ADMIN_TOKEN is not configured. Run Step 1 first.");
    return;
  }
  const repo = await inferRepo();
  console.log(`Repository: ${repo}`);
  const repository = await githubApi(`/repos/${repo}`);
  if (!repository.ok) {
    throw new Error(`cannot administer GitHub repository ${repo}: ${await githubError(repository)}`);
  }
  const repoInfo = await repository.json() as { permissions?: { admin?: boolean } };
  if (repoInfo.permissions?.admin === false) {
    throw new Error(`GitHub token does not have admin access to ${repo}`);
  }
  let successCount = 0;
  for (const environment of environments) {
    console.log(`\n--- ${environment.toUpperCase()} ---`);
    if (!await ensureEnvironment(repo, environment)) continue;
    const existingSecrets = await githubNames(repo, environment, "secret");
    const existingVariables = await githubVariables(repo, environment);
    if (!existingSecrets || !existingVariables) {
      findings.push({ result: "fail", label: environment, detail: "cannot list GitHub secrets/variables" });
      continue;
    }
    const presentVars = VARIABLE_SPECS.filter((s) => existingVariables.has(s.name)).length;
    const presentSecrets = SECRET_SPECS.filter((s) => existingSecrets.has(s.name)).length;
    console.log(`  ${presentVars} variable(s), ${presentSecrets} secret(s) already on GitHub.`);
    for (const spec of VARIABLE_SPECS) {
      if (existingVariables.has(spec.name)) { console.log(`  ✓ ${spec.name}`); continue; }
      const value = vault.deployment[environment][spec.name];
      if (!value) {
        console.log(`  ✗ ${spec.name} — not in vault; run Step 2 first`);
        findings.push({ result: "fail", label: `${environment}/${spec.name}`, detail: spec.description });
        continue;
      }
      await uploadVariable(repo, environment, spec.name, value);
      console.log(`  uploaded ${spec.name}`);
      successCount++;
    }
    for (const spec of [...SECRET_SPECS, ...OPTIONAL_SECRETS]) {
      if (existingSecrets.has(spec.name)) { console.log(`  ✓ ${spec.name}`); continue; }
      const value = vault.deployment[environment][spec.name];
      if (!value) {
        const isOptional = OPTIONAL_SECRETS.includes(spec);
        console.log(`  ✗ ${spec.name} — not in vault; run Step 2 first`);
        findings.push({ result: isOptional ? "warn" : "fail", label: `${environment}/${spec.name}`, detail: spec.description });
        continue;
      }
      await uploadSecret(repo, environment, spec.name, value);
      console.log(`  uploaded ${spec.name}`);
      successCount++;
    }
  }
  console.log(`\nPublished ${successCount} credential(s) to GitHub.`);
}

async function revokeCredentials(): Promise<void> {
  console.log("───── Revoke Credentials ─────\n");
  if (!vault) { console.error("Vault is not unlocked."); return; }
  const repo = await inferRepo();
  console.log(`Repository: ${repo}\n`);
  for (const environment of environments) {
    console.log(`--- ${environment.toUpperCase()} ---`);
    const credentialKeys = Object.keys(vault.deployment[environment]).filter(
      (k) => !k.endsWith("_ID"),
    );
    if (!credentialKeys.length) {
      console.log("  No credentials in the vault.\n");
      continue;
    }
    console.log(`  Credentials in vault: ${credentialKeys.join(", ")}`);
    if (!await yesNo(`  Revoke credentials for ${environment}?`)) continue;

    for (const name of credentialKeys) {
      if (!await yesNo(`    Remove ${name}?`)) continue;

      // Revoke at the provider
      if (name === "CF_API_TOKEN" && vault.admin.CF_BOOTSTRAP_TOKEN && vault.deployment[environment].CF_API_TOKEN_ID) {
        try {
          await revokeCloudflareToken(vault.admin.CF_BOOTSTRAP_TOKEN, vault.deployment[environment].CF_API_TOKEN_ID);
          console.log(`    revoked ${name} at Cloudflare`);
        } catch (error) {
          console.log(`    could not revoke at Cloudflare: ${error instanceof Error ? error.message : error}`);
        }
      }

      // Delete from GitHub
      const isVariable = VARIABLE_SPECS.some((s) => s.name === name);
      try {
        if (isVariable) {
          await deleteVariable(repo, environment, name);
          console.log(`    deleted ${name} from GitHub`);
        } else {
          await deleteSecret(repo, environment, name);
          console.log(`    deleted ${name} from GitHub`);
        }
      } catch (error) {
        console.log(`    could not delete from GitHub: ${error instanceof Error ? error.message : error}`);
      }

      // Remove from vault
      delete vault.deployment[environment][name];
      await saveCurrentVault();
      console.log(`    removed ${name} from vault`);
    }
    console.log();
  }
}

async function fullPipeline(): Promise<void> {
  console.log("═════════════════ Full Pipeline ═════════════════\n");
  await step1ConfigureAdmin();
  await step2CollectKeys();
  await step3PublishKeys();
  const failures = findings.filter((f) => f.result === "fail");
  const warnings = findings.filter((f) => f.result === "warn");
  console.log(`\nPipeline complete: ${failures.length} issue(s), ${warnings.length} warning(s).`);
  if (failures.length) process.exitCode = 1;
}

async function readOnlyAudit(): Promise<void> {
  const repo = await inferRepo();
  console.log("\n───── Read-Only Audit ─────\n");
  const workflowFiles = Array.from(
    new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: process.cwd() }),
  );
  const hasDeploymentWorkflow = workflowFiles.some((path) => /deploy|gitops|release/i.test(path));
  if (!hasDeploymentWorkflow) {
    findings.push({ result: "warn", label: "deployment workflow", detail: "no deploy/GitOps/release workflow exists; credentials are not consumed yet" });
    console.log("! No deployment workflow found; this audit checks the documented credential inventory.");
  }
  for (const environment of environments) {
    console.log(`\n--- ${environment.toUpperCase()} ---`);
    const existingSecrets = await githubNames(repo, environment, "secret");
    const existingVariables = await githubVariables(repo, environment);
    if (!existingSecrets || !existingVariables) {
      findings.push({ result: "fail", label: environment, detail: "cannot list GitHub secrets/variables; check repository permission" });
      continue;
    }
    const varCount = VARIABLE_SPECS.filter((s) => existingVariables.has(s.name)).length;
    const secretCount = SECRET_SPECS.filter((s) => existingSecrets.has(s.name)).length;
    const optionalCount = OPTIONAL_SECRETS.filter((s) => existingSecrets.has(s.name)).length;
    console.log(`  ${varCount} variable(s), ${secretCount} required secret(s), ${optionalCount} optional secret(s) found on GitHub.`);
    for (const spec of VARIABLE_SPECS) {
      if (existingVariables.has(spec.name)) { console.log(`  ✓ ${spec.name}`); }
      else { console.log(`  ✗ ${spec.name} — ${spec.description}`); findings.push({ result: "fail", label: `${environment}/${spec.name}`, detail: spec.description }); }
    }
    for (const spec of SECRET_SPECS) {
      if (existingSecrets.has(spec.name)) { console.log(`  ✓ ${spec.name}`); }
      else { console.log(`  ✗ ${spec.name} — ${spec.description}`); findings.push({ result: "fail", label: `${environment}/${spec.name}`, detail: spec.description }); }
    }
    for (const spec of OPTIONAL_SECRETS) {
      if (existingSecrets.has(spec.name)) { console.log(`  ✓ ${spec.name} (optional)`); }
      else { console.log(`  ! ${spec.name} (optional) — ${spec.description}`); findings.push({ result: "warn", label: `${environment}/${spec.name}`, detail: spec.description }); }
    }
  }
  const failures = findings.filter((f) => f.result === "fail");
  const warnings = findings.filter((f) => f.result === "warn");
  console.log(`\nSummary: ${failures.length} issue(s), ${warnings.length} warning(s).`);
  if (failures.length) process.exitCode = 1;
}

// ===== Menu =====

async function runMenu(): Promise<boolean> {
  console.log("\n─── Menu ───");
  console.log("1. Configure admin bootstrap keys (local vault only)");
  console.log("2. Collect/generate deployment credentials (local vault)");
  console.log("3. Publish credentials to GitHub secrets");
  console.log("4. Run full pipeline (1 → 2 → 3)");
  console.log("5. Read-only audit (no changes)");
  console.log("6. Revoke credentials");
  console.log("q. Quit");
  const choice = (await rl.question("\nChoice [1-6/q]: ")).trim().toLowerCase();
  switch (choice) {
    case "1": await step1ConfigureAdmin(); return true;
    case "2": await step2CollectKeys(); return true;
    case "3": await step3PublishKeys(); return true;
    case "4": await fullPipeline(); return true;
    case "5": await readOnlyAudit(); return true;
    case "6": await revokeCredentials(); return true;
    case "q": case "quit": case "exit": return false;
    case "": return true;
    default: console.log("  Invalid choice."); return true;
  }
}

// ===== Main Entry Point =====

async function main(): Promise<void> {
  const repo = await inferRepo();
  console.log(`Robot Money credential doctor`);
  console.log(`Repository: ${repo}\n`);

  if (CHECK_ONLY) {
    console.log("Mode: read-only audit\n");
    await readOnlyAudit();
    return;
  }

  await unlockVault();
  await migrateLegacyCredentials();
  while (await runMenu()) { /* loop */ }
  console.log("Done.");
}

try {
  await main();
} catch (error) {
  console.error(`\nCredential doctor failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 2;
} finally {
  rl.close();
}
