export interface CommitteeRouteResult {
  status: number;
  body: unknown;
}

export type CommitteeRouteExtension = (
  req: Request,
  url: URL,
) => Promise<CommitteeRouteResult | null>;
