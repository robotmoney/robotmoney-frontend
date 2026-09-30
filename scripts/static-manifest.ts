#!/usr/bin/env bun
// T26 — the impure half: walk an assembled STATIC_DIR, hash every file, and
// write `.rm-static-manifest.json` into it. Run by scripts/static-assembly.sh
// as its last step (so the manifest describes the finished directory), and by
// `bun run static:manifest <dir>` by hand.
//
// The identity it records comes from RM_BUILD_COMMIT / RM_BUILD_TAG, the same
// two variables the images are built with — scripts/stack/stack.ts resolves
// them once per bring-up and hands them to the assembly and to `docker compose
// build` alike, which is what lets /version say whether the SPA and the API
// came from ONE tree. Unset is recorded as null, never as a stand-in.
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  STATIC_MANIFEST_FILENAME,
  buildStaticManifest,
  type StaticFileEntry,
} from "./lib/static-manifest.ts";

export async function collectEntries(root: string): Promise<StaticFileEntry[]> {
  const out: StaticFileEntry[] = [];
  async function walk(dir: string): Promise<void> {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      // Symlinks are NOT followed: `_static` is assembled by `cp -R` from the
      // source tree, and a link that pointed outside the directory would put
      // bytes in the digest that are not served from it.
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile()) {
        const rel = relative(root, full).split(sep).join("/");
        if (rel === STATIC_MANIFEST_FILENAME) continue; // never covers itself
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(new Uint8Array(await Bun.file(full).arrayBuffer()));
        out.push({ path: rel, sha256: hasher.digest("hex") });
      }
    }
  }
  await walk(root);
  return out;
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.env.STATIC_ASSEMBLY_DIR ?? "_static";
  const entries = await collectEntries(root);
  const manifest = buildStaticManifest({
    commit: process.env.RM_BUILD_COMMIT ?? "",
    tag: process.env.RM_BUILD_TAG ?? "",
    entries,
    generatedAt: new Date().toISOString(),
  });
  await Bun.write(join(root, STATIC_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `[static-manifest] ${root}: ${manifest.files} files, ${manifest.digest} ` +
      `(commit ${manifest.commit ?? "unavailable"}${manifest.tag ? `, ${manifest.tag}` : ""})`,
  );
}
