// Issue 1421: poison every HTTP client a downstream stage could reach, for the
// tests that assert "after extract, nothing acquires". Covers globalThis.fetch,
// node:http and node:https (request, get), WebSocket, EventSource and
// XMLHttpRequest. Database traffic (postgres.js over TCP) is untouched, so the
// real persistence keeps working. Every attempt is recorded AND throws.
import http from "node:http";
import https from "node:https";

export interface NetworkPoison {
  attempts: string[];
  restore(): void;
}

export function poisonNetwork(label = "after extract"): NetworkPoison {
  const attempts: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved = {
    fetch: globalThis.fetch,
    http: { request: http.request, get: http.get },
    https: { request: https.request, get: https.get },
    WebSocket: g.WebSocket,
    EventSource: g.EventSource,
    XMLHttpRequest: g.XMLHttpRequest,
  };
  const thrower = (what: string) => (...args: unknown[]) => {
    attempts.push(`${what} ${String(args[0] ?? "")}`);
    throw new Error(`${what} called ${label}: downstream stages never perform HTTP`);
  };
  globalThis.fetch = thrower("fetch") as unknown as typeof fetch;
  (http as { request: unknown }).request = thrower("node:http request");
  (http as { get: unknown }).get = thrower("node:http get");
  (https as { request: unknown }).request = thrower("node:https request");
  (https as { get: unknown }).get = thrower("node:https get");
  for (const name of ["WebSocket", "EventSource", "XMLHttpRequest"] as const) {
    g[name] = class {
      constructor(url?: unknown) {
        attempts.push(`${name} ${String(url ?? "")}`);
        throw new Error(`${name} constructed ${label}: downstream stages never perform HTTP`);
      }
    };
  }
  return {
    attempts,
    restore() {
      globalThis.fetch = saved.fetch;
      Object.assign(http, saved.http);
      Object.assign(https, saved.https);
      g.WebSocket = saved.WebSocket;
      g.EventSource = saved.EventSource;
      g.XMLHttpRequest = saved.XMLHttpRequest;
    },
  };
}
