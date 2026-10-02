// The indicator-id -> fetch wiring lives in the SDK (packages/analyst-sdk/src/extract/sources.ts).
// The backend adds the two things the SDK may not import: the geckoterminal adapter
// (reads process.env) and the source ledger (writes a database).
import type { Point } from "../types.ts";
import type { Indicator } from "../analyze/indicators.ts";
import { fetchOne as sdkFetchOne, fetchAll as sdkFetchAll, type AcquireFn } from "../../../../packages/analyst-sdk/src/extract/sources.ts";
import { fetchGeckoTerminalNewPools } from "./geckoterminal.ts";
import { captureSourceAcquisition, type AcquisitionSink } from "../source-ledger.ts";
import "./http.ts";

export { mergeRatioSeries } from "../../../../packages/analyst-sdk/src/extract/sources.ts";

const extensions = { geckoterminal_newpools: fetchGeckoTerminalNewPools };

export function fetchOne(ind: Indicator, logger: Parameters<typeof sdkFetchOne>[1] = console): Promise<Point[]> {
  return sdkFetchOne(ind, logger, extensions);
}

export function fetchAll(
  opts: Omit<NonNullable<Parameters<typeof sdkFetchAll>[0]>, "acquire" | "extensions"> & { acquisitionSink?: AcquisitionSink } = {},
): Promise<Record<string, Point[]>> {
  const { acquisitionSink, ...rest } = opts;
  const acquire: AcquireFn | undefined = acquisitionSink
    ? (meta, operation) => captureSourceAcquisition(meta, acquisitionSink, operation)
    : undefined;
  return sdkFetchAll({ ...rest, acquire, extensions });
}
