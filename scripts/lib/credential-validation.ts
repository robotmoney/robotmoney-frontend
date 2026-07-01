export function strongToken(value: string): string | null {
  return value.trim().length >= 32 ? null : "must contain at least 32 characters";
}

export function pem(value: string, label: string): string | null {
  return value.includes(`-----BEGIN ${label}-----`) &&
    value.includes(`-----END ${label}-----`)
    ? null
    : `not a PEM ${label.toLowerCase()}`;
}

export function cloudflareId(value: string): string | null {
  return /^[a-f0-9]{32}$/i.test(value.trim())
    ? null
    : "expected a 32-character hexadecimal ID";
}

export function validHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function validateDatabaseUrl(value: string): string | null {
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

export function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "robotmoney-credential-doctor",
  };
}

export async function fetchWithTimeout(
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

export async function validateCloudflareToken(value: string): Promise<string | null> {
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

export async function validateGitHubToken(value: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout("https://api.github.com/user", {
      headers: githubHeaders(value),
    });
    return response.ok ? null : `GitHub rejected the token (HTTP ${response.status})`;
  } catch (error) {
    return `could not reach GitHub: ${error instanceof Error ? error.message : error}`;
  }
}

export async function validateDigitalOceanToken(value: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout("https://api.digitalocean.com/v2/account", {
      headers: { Authorization: `Bearer ${value.trim()}` },
    });
    return response.ok ? null : `DigitalOcean rejected the token (HTTP ${response.status})`;
  } catch (error) {
    return `could not reach DigitalOcean: ${error instanceof Error ? error.message : error}`;
  }
}

export async function validateFredApiKey(value: string): Promise<string | null> {
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
