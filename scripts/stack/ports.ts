// Host-port allocation for a compose stack — pure of the process environment,
// free of module-scope work (see scripts/stack/config.ts's header for the three
// invariants this directory holds to).
//
// Moved verbatim out of scripts/lib/demo-main.ts, where it had to live at
// module scope and therefore could not be reused; the rails check in
// scripts/tests/integration/onboarding-eval-infra.test.ts still carries its own weaker fork
// (a `freePort()` that closed each socket before drawing the next, so two draws
// could collide) — replacing it with this is that check's own migration, not
// this one's.
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

type Held = ReturnType<typeof createServer>;

// Bind `port` (0 = a random free one) on 127.0.0.1; resolve the HELD server if
// it bound, else null (port already in use). Callers keep every returned server
// open until all ports are chosen so two allocations can't draw the same one.
function tryBind(port: number): Promise<Held | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.on("error", () => resolve(null));
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

// A host operator can PIN a host port (WEB_PORT / POSTGRES_PORT) instead of
// taking a random free one — useful when the host's root cloudflared config
// routes the robotmoney.net origin to a STABLE demo port. Returns undefined
// when unset/empty (→ a random free port is drawn instead). Only one demo can
// hold a given fixed port at a time.
//
// The raw value is an ARGUMENT: the entrypoint reads it from wherever it lives
// and hands it in, so this module never touches the environment itself.
export function parsePort(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name}=${raw} is not a valid TCP port (1-65535)`);
  }
  return n;
}

export interface PortRequest {
  // An explicit pin — honoured as-is, never probed.
  fixed?: number;
  // Tried first when there is no pin (e.g. the cloudflared-facing default), so
  // a standing demo lands on the port the host tunnel already routes to; falls
  // back to a random free port when taken.
  preferred?: number;
}

// Choose every port in one go, holding EVERY bound socket open until all of
// them are chosen and then closing them together. That collision-safety
// property is the reason this is a batch API rather than a `freePort()`.
export async function allocatePorts(requests: PortRequest[]): Promise<number[]> {
  const held: Held[] = [];
  try {
    const out: number[] = [];
    for (const req of requests) {
      if (req.fixed !== undefined) {
        out.push(req.fixed);
        continue;
      }
      if (req.preferred !== undefined) {
        const s = await tryBind(req.preferred);
        if (s) {
          held.push(s);
          out.push(req.preferred);
          continue;
        }
      }
      const s = await tryBind(0);
      if (!s) throw new Error("could not bind a free host port");
      held.push(s);
      out.push((s.address() as AddressInfo).port);
    }
    return out;
  } finally {
    await Promise.all(held.map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
}
