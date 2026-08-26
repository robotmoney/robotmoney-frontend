export function resolveBackendBase(env: Record<string, string | undefined>): string {
  return env.BACKEND_URL ?? "http://localhost:8787";
}
