import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Box-drawing and typographic characters render inconsistently across terminals and editors.
describe("repository text", () => {
  it("is plain ASCII in every tracked or new file", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter((path) => path !== "" && path !== "package-lock.json" && !path.endsWith(".png"));
    const offenders = files.flatMap((path) =>
      readFileSync(`${repoRoot}${path}`, "utf8")
        .split("\n")
        .flatMap((line, index) => (/[^\x00-\x7F]/.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [])),
    );
    expect(offenders).toEqual([]);
  });
});
