#!/usr/bin/env bun
/**
 * Audit and configure credentials used by the Robot Money GitOps deployment.
 *
 * GitHub never returns secret values. This tool can therefore prove that a
 * secret exists, but it can only validate a vendor credential while the user
 * supplies it locally. Secret input is sent directly to GitHub and is neither
 * printed nor written to the repository.
 */
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

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

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check") || !process.stdin.isTTY;
const VALID_ENVIRONMENTS = new Set<Environment>(["staging", "production"]);

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (args.has("--help") || args.has("-h")) {
  console.log(`Robot Money GitOps credential doctor

Usage:
  bun run credentials                       interactive audit and repair
  bun run credentials:check                 read-only audit
  bun run credentials -- --environment staging
  bun run credentials -- --repo OWNER/REPO

Options:
  --check                  do not prompt or change GitHub
  --environment ENV        check staging or production (default: both)
  --repo OWNER/REPO        override repository inferred by gh
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
const findings: Finding[] = [];

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
    description: "manages Cloudflare DNS, health checks, logs, and certificates",
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
    description: "manages DigitalOcean compute, registry, firewalls, databases, and CDN",
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
    const response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
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

async function validateDigitalOceanToken(value: string): Promise<string | null> {
  try {
    const response = await fetch("https://api.digitalocean.com/v2/account", {
      headers: { Authorization: `Bearer ${value.trim()}` },
    });
    return response.ok ? null : `DigitalOcean rejected the token (HTTP ${response.status})`;
  } catch (error) {
    return `could not reach DigitalOcean: ${error instanceof Error ? error.message : error}`;
  }
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
  const child = Bun.spawn(
    ["bash", "-c", 'IFS= read -r -s value; printf "%s" "$value"'],
    { stdin: "inherit", stdout: "pipe", stderr: "inherit" },
  );
  const [code, value] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  rl.resume();
  process.stdout.write("\n");
  if (code !== 0) throw new Error("could not read hidden input");
  return value.trim();
}

async function inferRepo(): Promise<string> {
  const explicit = option("--repo");
  if (explicit) return explicit;
  const result = await command(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  if (result.code !== 0 || !result.stdout) {
    throw new Error(`could not infer GitHub repository: ${result.stderr || "gh repo view failed"}`);
  }
  return result.stdout;
}

async function githubNames(
  repo: string,
  environment: Environment,
  kind: "secret" | "variable",
): Promise<Set<string> | null> {
  const result = await command([
    "gh", kind, "list", "--repo", repo, "--env", environment,
    "--json", "name", "--jq", ".[].name",
  ]);
  if (result.code !== 0) return null;
  return new Set(result.stdout.split("\n").filter(Boolean));
}

async function ensureEnvironment(repo: string, environment: Environment): Promise<boolean> {
  const probe = await command(["gh", "api", `repos/${repo}/environments/${environment}`]);
  if (probe.code === 0) return true;
  if (CHECK_ONLY || !await yesNo(`Create GitHub environment "${environment}"?`, true)) {
    findings.push({ result: "fail", label: environment, detail: "GitHub environment does not exist" });
    return false;
  }
  const create = await command(["gh", "api", "--method", "PUT", `repos/${repo}/environments/${environment}`]);
  if (create.code !== 0) throw new Error(`could not create ${environment}: ${create.stderr}`);
  console.log(`  created GitHub environment ${environment}`);
  return true;
}

async function uploadSecret(
  repo: string,
  environment: Environment,
  name: string,
  value: string,
): Promise<void> {
  const result = await command([
    "gh", "secret", "set", name, "--repo", repo, "--env", environment,
  ], value);
  if (result.code !== 0) throw new Error(`could not set ${name}: ${result.stderr}`);
}

async function uploadVariable(
  repo: string,
  environment: Environment,
  name: string,
  value: string,
): Promise<void> {
  const result = await command([
    "gh", "variable", "set", name, "--repo", repo, "--env", environment, "--body", value,
  ]);
  if (result.code !== 0) throw new Error(`could not set ${name}: ${result.stderr}`);
}

async function generateToken(environment: Environment, name: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const directory = join(homedir(), ".config", "robotmoney", "gitops", environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  await Bun.write(path, value + "\n");
  await chmod(path, 0o600);
  console.log(`  generated ${name}; backup stored at ${path}`);
  return value;
}

async function generateSshKey(environment: Environment): Promise<string> {
  const directory = join(homedir(), ".config", "robotmoney", "gitops", environment);
  const path = join(directory, "deploy_ed25519");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = Bun.file(path);
  if (!await existing.exists()) {
    const result = await command([
      "ssh-keygen", "-q", "-t", "ed25519", "-N", "",
      "-C", `robotmoney-${environment}-github-actions`, "-f", path,
    ]);
    if (result.code !== 0) throw new Error(`ssh-keygen failed: ${result.stderr}`);
  }
  await chmod(path, 0o600);
  await chmod(`${path}.pub`, 0o600);
  console.log(`  public key to install on the droplet: ${path}.pub`);
  return (await Bun.file(path).text()).trim();
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
): Promise<boolean> {
  console.log(`  ${spec.name}: ${spec.description}`);
  if (!await yesNo(`  Configure ${spec.name} now?`)) return false;
  const value = await getSecretValue(spec, environment);
  if (!value) {
    console.log("  skipped: no value supplied");
    return false;
  }
  const problem = await spec.validate?.(value);
  if (problem) {
    console.log(`  validation failed: ${problem}`);
    if (!await yesNo("  Upload this value anyway?")) return false;
  }
  await uploadSecret(repo, environment, spec.name, value);
  console.log(`  uploaded ${spec.name}`);
  return true;
}

async function auditEnvironment(repo: string, environment: Environment): Promise<void> {
  console.log(`\n${environment.toUpperCase()}`);
  if (!await ensureEnvironment(repo, environment)) return;

  let secrets = await githubNames(repo, environment, "secret");
  let variables = await githubNames(repo, environment, "variable");
  if (!secrets || !variables) {
    findings.push({
      result: "fail",
      label: environment,
      detail: "cannot list GitHub environment secrets/variables; check repository permission",
    });
    return;
  }

  for (const spec of SECRET_SPECS) {
    if (secrets.has(spec.name)) {
      console.log(`  ✓ ${spec.name}`);
      continue;
    }
    console.log(`  ✗ ${spec.name} — ${spec.description}`);
    if (!CHECK_ONLY && await repairSecret(repo, environment, spec)) {
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
    if (!CHECK_ONLY && await repairSecret(repo, environment, spec)) {
      secrets.add(spec.name);
    } else {
      findings.push({ result: "warn", label: `${environment}/${spec.name}`, detail: spec.description });
    }
  }

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
    variables.add(spec.name);
    console.log(`  uploaded ${spec.name}`);
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

async function main(): Promise<void> {
  const gh = await command(["gh", "auth", "status"]);
  if (gh.code !== 0) throw new Error("GitHub CLI is not authenticated; run: gh auth login");
  const repo = await inferRepo();
  console.log(`Robot Money credential doctor`);
  console.log(`Repository: ${repo}`);
  console.log(`Mode: ${CHECK_ONLY ? "read-only check" : "interactive repair"}`);

  const workflowFiles = Array.from(
    new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: process.cwd() }),
  );
  const hasDeploymentWorkflow = workflowFiles.some((path) => /deploy|gitops|release/i.test(path));
  if (!hasDeploymentWorkflow) {
    findings.push({
      result: "warn",
      label: "deployment workflow",
      detail: "no deploy/GitOps/release workflow exists; credentials are not consumed yet",
    });
    console.log("! No deployment workflow found; this audit checks the documented credential inventory.");
  }

  for (const environment of environments) await auditEnvironment(repo, environment);

  const failures = findings.filter((finding) => finding.result === "fail");
  const warnings = findings.filter((finding) => finding.result === "warn");
  console.log(`\nSummary: ${failures.length} issue(s), ${warnings.length} warning(s).`);
  if (failures.length) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`\nCredential doctor failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 2;
} finally {
  rl.close();
}
