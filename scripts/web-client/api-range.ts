// Fail the web client's merge gate when the site's declared API range excludes
// the API this tree builds (D54, issue #1026 W7).
//
//   bun scripts/web-client/api-range.ts            # check the repo
//   bun scripts/web-client/api-range.ts --root <dir>
//
// The range is frontend/package.json `apiRange` (the value /version.json
// publishes); the API version is contract/package.json's (the value GET
// /api/version reports). A contract bump that leaves the range behind would
// ship a site that tells every reader to reload against the API built from the
// same commit, so web-client.yml runs this on every change to either file.
//
// Exits 1 naming both values when the range is missing, unparseable, or
// excludes the version; 0 with one line otherwise.
import { apiVersionInRange, isValidApiRange, readContractVersion, readFrontendApiRange } from "../lib/api-range.ts";
import { repoRoot } from "./version.ts";

export interface ApiRangeCheck {
  ok: boolean;
  apiVersion: string;
  apiRange: string | null;
  message: string;
}

export function checkApiRange(root: string = repoRoot): ApiRangeCheck {
  const apiVersion = readContractVersion(root);
  const apiRange = readFrontendApiRange(root);
  if (apiRange === null) {
    return {
      ok: false,
      apiVersion,
      apiRange,
      message: `frontend/package.json declares no apiRange; the contract version is ${apiVersion}. Add "apiRange" (e.g. "^${apiVersion}").`,
    };
  }
  if (!isValidApiRange(apiRange)) {
    return {
      ok: false,
      apiVersion,
      apiRange,
      message:
        `frontend/package.json apiRange "${apiRange}" is not a range the site can read ` +
        `(space-separated ^ ~ >= > <= < = or exact X.Y.Z comparators); the contract version is ${apiVersion}.`,
    };
  }
  if (!apiVersionInRange(apiVersion, apiRange)) {
    return {
      ok: false,
      apiVersion,
      apiRange,
      message: `frontend/package.json apiRange "${apiRange}" excludes contract/package.json version ${apiVersion}.`,
    };
  }
  return { ok: true, apiVersion, apiRange, message: `apiRange "${apiRange}" admits contract version ${apiVersion}.` };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const root = rootIdx === -1 ? repoRoot : args[rootIdx + 1];
  if (!root) {
    console.error("--root needs a directory");
    process.exit(2);
  }
  const result = checkApiRange(root);
  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exit(1);
  }
}
