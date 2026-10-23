// Test preload: the SDK is pure compute and must never call the network.
// Every HTTP client a test or the code under test could reach is replaced with
// a thrower, so an accidental call turns into a red test: globalThis.fetch,
// node:http and node:https (request, get), WebSocket, EventSource and
// XMLHttpRequest (issue 1421: fetch alone left the other clients open).
import http from "node:http";
import https from "node:https";

const message = (what: string) => `analyst-sdk tests must not use the network (${what} is a thrower)`;
const thrower = (what: string) => () => {
  throw new Error(message(what));
};

globalThis.fetch = thrower("globalThis.fetch") as unknown as typeof fetch;
for (const [name, mod] of [["node:http", http], ["node:https", https]] as const) {
  (mod as { request: unknown }).request = thrower(`${name} request`);
  (mod as { get: unknown }).get = thrower(`${name} get`);
}
for (const name of ["WebSocket", "EventSource", "XMLHttpRequest"] as const) {
  (globalThis as Record<string, unknown>)[name] = class {
    constructor() {
      throw new Error(message(name));
    }
  };
}
