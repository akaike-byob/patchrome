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
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  if (moduleExtension === ".js") return version;
  const newestMtimeMs = Math.max(
    ...readdirSync(srcDir)
      .filter((name) => name.endsWith(moduleExtension))
      .map((name) => statSync(new URL(name, srcDir)).mtimeMs),
  );
  return `${version}+${Math.floor(newestMtimeMs)}`;
}

// A CLI newer than the daemon it reaches replaces that daemon, so agents running `npx patchrome@latest` move
// every session onto a new release the first time one of them runs it. Released versions compare by semver;
// two edits of one checkout compare by source mtime. Anything else, such as a checkout against a release,
// has no order and keeps the daemon.
export function isNewerBuild(candidate: string, running: string): boolean {
  const next = parseBuildId(candidate);
  const current = parseBuildId(running);
  if (next === undefined || current === undefined) return false;
  if (next.sourceMtimeMs !== undefined || current.sourceMtimeMs !== undefined) {
    return (
      next.version === current.version &&
      next.sourceMtimeMs !== undefined &&
      current.sourceMtimeMs !== undefined &&
      next.sourceMtimeMs > current.sourceMtimeMs
    );
  }
  if (next.prerelease !== undefined || current.prerelease !== undefined) return false;
  for (const [index, part] of next.core.entries()) {
    const other = current.core[index] ?? 0;
    if (part !== other) return part > other;
  }
  return false;
}

interface ParsedBuildId {
  version: string;
  core: number[];
  prerelease: string | undefined;
  sourceMtimeMs: number | undefined;
}

function parseBuildId(buildId: string): ParsedBuildId | undefined {
  const match = /^((\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?)(?:\+(\d+))?$/.exec(buildId);
  if (match === null) return undefined;
  const [, version = "", major = "", minor = "", patch = "", prerelease, sourceMtimeMs] = match;
  return {
    version,
    core: [Number(major), Number(minor), Number(patch)],
    prerelease,
    sourceMtimeMs: sourceMtimeMs === undefined ? undefined : Number(sourceMtimeMs),
  };
}
