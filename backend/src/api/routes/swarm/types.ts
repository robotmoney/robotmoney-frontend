export interface SwarmRouteResult {
  status: number;
  body: unknown;
}

// A raw `Response` is an admitted return, not an escape hatch: the anchored
// consensus-receipt route (decision D10) serves stored canonical bytes verbatim
// with its own content-type, and re-wrapping those in a `{status, body}` JSON
// envelope is exactly the re-serialization that would change the digest. The
// dispatcher already passes a `Response` through untouched (the avatar route),
// so this only widens the extension type to the dispatcher's own contract.
export type SwarmRouteExtension = (
  req: Request,
  url: URL,
) => Promise<SwarmRouteResult | Response | null>;
