import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = new URL("./", import.meta.url);

// ".ts" in a checkout, where Node strips types, and ".js" in the published package, built into dist/.
export const moduleExtension = extname(fileURLToPath(import.meta.url));

// An installed package is identified by its version, so the same release installed twice (globally, in a
// project, in the npx cache) shares one daemon. A checkout adds the newest source mtime, so a daemon left
// running across an edit reports a different id than the CLI talking to it.
export function currentBuildId(env: NodeJS.ProcessEnv = process.env): string {
  // Tests set this to play a CLI from another build without editing sources.
  if (env.PATCHROME_BUILD_ID !== undefined && env.PATCHROME_BUILD_ID !== "") return env.PATCHROME_BUILD_ID;
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  if (moduleExtension === ".js") return version;
  const newestMtimeMs = Math.max(...readdirSync(srcDir).filter((name) => name.endsWith(moduleExtension)).map((name) => statSync(new URL(name, srcDir)).mtimeMs));
  return `${version}+${Math.floor(newestMtimeMs)}`;
}
