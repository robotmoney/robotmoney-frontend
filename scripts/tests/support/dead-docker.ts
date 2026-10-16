import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Env for a child process that must see a Docker daemon it cannot reach.
 *
 * The unit tier removes the real `docker` binary from the runner (unit.yml), so
 * `DOCKER_HOST=tcp://127.0.0.1:1` alone is not enough there: the child would
 * find no `docker` at all and throw ENOENT instead of meeting a dead daemon.
 * A stub `docker` first on PATH answers every call the way a dead daemon does
 * (exit 1, a connection error), so the test behaves the same with or without a
 * real Docker installed.
 */
export function deadDockerEnv(): { PATH: string; DOCKER_HOST: string } {
  const dir = mkdtempSync(join(tmpdir(), "dead-docker-"));
  const stub = join(dir, "docker");
  writeFileSync(stub, "#!/bin/sh\necho 'Cannot connect to the Docker daemon at tcp://127.0.0.1:1' >&2\nexit 1\n");
  chmodSync(stub, 0o755);
  return { PATH: `${dir}:${process.env.PATH ?? ""}`, DOCKER_HOST: "tcp://127.0.0.1:1" };
}
