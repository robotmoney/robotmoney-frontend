import { readFileSync } from "node:fs";

/** Resolve a secret from NAME or NAME_FILE, never logging either value. */
export function envSecret(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const direct = env[name]?.trim();
  if (direct) return direct;
  const file = env[`${name}_FILE`]?.trim();
  if (!file) return null;
  const value = readFileSync(file, "utf8").trim();
  if (!value) throw new Error(`${name}_FILE points to an empty secret file`);
  return value;
}
