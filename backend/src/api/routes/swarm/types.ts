export interface SwarmRouteResult {
  status: number;
  body: unknown;
}

export type SwarmRouteExtension = (
  req: Request,
  url: URL,
) => Promise<SwarmRouteResult | null>;
