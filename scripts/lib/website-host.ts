// The serving host `bun smoke:web` drives (issue 1628,
// docs/technical/web-serving-architecture.md §4). `smoke:web` runs on the
// control machine. Everything it does to a host is a command run there, plus
// an HTTP read of a port the host publishes on its loopback. This module is
// that boundary, and nothing else:
//
//   sshHost    runs each command as `ssh <dest> -- <quoted argv>` over one
//              multiplexed connection, and reads a host port through an
//              `ssh -L` forward;
//   localHost  runs each command here, and reads the port directly. It is the
//              "host" of the integration tests and of a run on the host itself.
//
// Both record every command they send, in order, so a test can assert the
// exact command list a release sent to the host.
//
// The host needs Docker and OpenSSH, nothing else (§4): every command sent is
// `docker …`, `mktemp`, `rm` or `sh -c 'cat > <file>'`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface HostResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WebHost {
  /** The ssh destination, or `local`. */
  readonly name: string;
  /** Every command sent to the host, in order. */
  readonly commands: string[][];
  /** Run one command on the host. Never throws for a non-zero exit. */
  run(argv: readonly string[], stdin?: string | Uint8Array): Promise<HostResult>;
  /** An origin on this machine that reaches the host's 127.0.0.1:`port`. */
  openPort(port: number): Promise<{ readonly origin: string; close(): void }>;
  close(): void;
}

/** PURE. One argument quoted for a POSIX shell. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** PURE. The argv ssh runs for one host command: the remote side gets one quoted string. */
export function sshArgv(dest: string, controlPath: string, argv: readonly string[]): string[] {
  return [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath}`,
    "-o", "ControlPersist=120",
    dest,
    "--",
    argv.map(shellQuote).join(" "),
  ];
}

async function spawn(argv: readonly string[], stdin?: string | Uint8Array): Promise<HostResult> {
  const proc = Bun.spawn([...argv], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** A port on this machine nothing listens on right now. */
function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function waitConnectable(port: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const ok = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } })
      .then((s) => {
        s.end();
        return true;
      })
      .catch(() => false);
    if (ok) return true;
    await Bun.sleep(100);
  }
  return false;
}

/** The host is this machine. */
export function localHost(): WebHost {
  const commands: string[][] = [];
  return {
    name: "local",
    commands,
    run(argv, stdin) {
      commands.push([...argv]);
      return spawn(argv, stdin);
    },
    async openPort(port) {
      return { origin: `http://127.0.0.1:${port}`, close() {} };
    },
    close() {},
  };
}

/** The host is `dest`, reached over SSH with one multiplexed connection. */
export function sshHost(dest: string): WebHost {
  if (dest === "" || dest.startsWith("-")) throw new Error(`Refusing: ${JSON.stringify(dest)} is not an ssh destination.`);
  const commands: string[][] = [];
  const socketDir = mkdtempSync(join(tmpdir(), "rm-smoke-web-ssh-"));
  const controlPath = join(socketDir, "control");
  const forwards = new Set<{ kill(): void }>();
  return {
    name: dest,
    commands,
    run(argv, stdin) {
      commands.push([...argv]);
      return spawn(sshArgv(dest, controlPath, argv), stdin);
    },
    async openPort(port) {
      const local = freePort();
      const proc = Bun.spawn(
        ["ssh", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", `ControlPath=${controlPath}`, "-N", "-L", `127.0.0.1:${local}:127.0.0.1:${port}`, dest],
        { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      );
      forwards.add(proc);
      if (!(await waitConnectable(local, 15_000))) {
        proc.kill();
        forwards.delete(proc);
        throw new Error(`could not forward ${dest}'s port ${port} over ssh`);
      }
      return {
        origin: `http://127.0.0.1:${local}`,
        close() {
          proc.kill();
          forwards.delete(proc);
        },
      };
    },
    close() {
      for (const f of forwards) f.kill();
      forwards.clear();
      Bun.spawnSync(["ssh", "-o", `ControlPath=${controlPath}`, "-O", "exit", dest], { stdout: "ignore", stderr: "ignore" });
      rmSync(socketDir, { recursive: true, force: true });
    },
  };
}
