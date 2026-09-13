import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { makeHome } from "./helpers.ts";

const repoDir = fileURLToPath(new URL("../..", import.meta.url));

describe("published package", () => {
  const workDir = mkdtempSync(join(tmpdir(), "patchrome-package-"));
  const home = makeHome("package");
  const installedBin = join(workDir, "prefix", "bin", "patchrome");
  const runInstalled = (args: string[]) =>
    execFileSync(installedBin, args, {
      encoding: "utf8",
      env: { ...process.env, PATCHROME_HOME: home, CLAUDE_CODE_SESSION_ID: "" },
    });

  afterAll(() => {
    if (existsSync(installedBin)) runInstalled(["--session", "pkg", "daemon", "stop"]);
  });

  it("ships compiled dist without sources or tests, and runs from a global install", () => {
    execFileSync("npm", ["pack", "--pack-destination", workDir], { cwd: repoDir, stdio: "ignore" });
    const tarball = readdirSync(workDir).find((name) => name.endsWith(".tgz"));
    expect(tarball).toBeDefined();
    const listing = execFileSync("tar", ["-tzf", join(workDir, tarball ?? "")], { encoding: "utf8" }).split("\n");
    expect(listing).toContain("package/dist/cli.js");
    expect(listing).toContain("package/skills/patchrome/SKILL.md");
    expect(listing).toContain("package/extension/tab-groups/manifest.json");
    expect(listing.filter((path) => /^package\/(src|test|spikes|scratch)\//.test(path))).toEqual([]);

    execFileSync("npm", ["i", "-g", "--prefix", join(workDir, "prefix"), join(workDir, tarball ?? "")], {
      stdio: "ignore",
    });
    const opened = JSON.parse(runInstalled(["--json", "--session", "pkg", "open"])) as {
      ok: boolean;
      data: { tab: string };
    };
    expect(opened).toMatchObject({ ok: true, data: { tab: "t1" } });

    // The library from the same install talks to the daemon the CLI started.
    expect(listing).toContain("package/dist/index.d.ts");
    const packageDir = join(workDir, "prefix", "lib", "node_modules", "patchrome");
    const libraryScript = `import { connect } from ${JSON.stringify(join(packageDir, "dist", "index.js"))};
      const browser = connect({ session: "pkg" });
      console.log(JSON.stringify(await browser.run("tabs")));`;
    const tabs = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", libraryScript], {
        encoding: "utf8",
        env: { ...process.env, PATCHROME_HOME: home, CLAUDE_CODE_SESSION_ID: "" },
      }),
    ) as { tabs: Array<{ id: string }> };
    expect(tabs.tabs.map((tab) => tab.id)).toEqual(["t1"]);
  });
});
