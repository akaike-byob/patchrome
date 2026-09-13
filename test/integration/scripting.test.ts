import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "../../src/index.ts";
import { makeHome, runCli, startFixtureServer, stopDaemon, type FixtureServer } from "./helpers.ts";

const binPath = fileURLToPath(new URL("../../bin/patchrome.js", import.meta.url));

interface PipeLine {
  id: string | number;
  ok?: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
  stream?: Record<string, unknown>;
}

describe("scripting", () => {
  let fixture: FixtureServer;
  const home = makeHome("scripting");
  const env = { ...process.env, PATCHROME_HOME: home, CLAUDE_CODE_SESSION_ID: "" };

  // Feeds lines to `patchrome pipe` and collects every JSON line it writes.
  const runPipe = (session: string, lines: string[], extraArgs: string[] = []) =>
    new Promise<{ exitCode: number; output: PipeLine[] }>((resolve) => {
      const child = spawn(process.execPath, [binPath, "--session", session, "pipe", ...extraArgs], { env });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("close", (code) =>
        resolve({
          exitCode: code ?? 1,
          output: stdout
            .trim()
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as PipeLine),
        }),
      );
      child.stdin.end(`${lines.join("\n")}\n`);
    });

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await stopDaemon(home);
    await fixture.close();
  });

  it("acts on elements by role, label and text", async () => {
    await runCli(home, "locators", ["open", `${fixture.origin}/form?name=roles`]);
    expect((await runCli(home, "locators", ["fill", "--label", "Name", "ada"])).json.ok).toBe(true);
    expect((await runCli(home, "locators", ["click", "--role", "button", "--name", "Greet", "--exact"])).json.ok).toBe(
      true,
    );
    expect((await runCli(home, "locators", ["wait", "--text", "hello ada"])).json.ok).toBe(true);
    expect((await runCli(home, "locators", ["text", "--selector", "#out", "--inline"])).json.data).toEqual({
      text: "hello ada",
    });
    const missing = await runCli(home, "locators", [
      "--timeout-ms",
      "800",
      "click",
      "--role",
      "link",
      "--name",
      "Nowhere",
    ]);
    expect(missing.json.error?.code).toBe("timeout");
  });

  it("keeps output in one shape with --inline and --out, and returns JSON values as values", async () => {
    await runCli(home, "shapes", ["open", `${fixture.origin}/long`]);
    expect((await runCli(home, "shapes", ["text"])).json.data?.path).toMatch(/text-t\d+-1\.txt$/);
    expect(String((await runCli(home, "shapes", ["text", "--inline"])).json.data?.text)).toContain("lorem ipsum");
    const outPath = join(home, "out", "long.txt");
    expect((await runCli(home, "shapes", ["text", "--out", outPath])).json.data?.path).toBe(outPath);
    expect(readFileSync(outPath, "utf8")).toContain("lorem ipsum");
    expect((await runCli(home, "shapes", ["eval", "({ title: document.title, n: 2 })"])).json.data).toEqual({
      value: { title: "long", n: 2 },
    });
    expect((await runCli(home, "shapes", ["eval", "undefined"])).json.data).toEqual({ value: null });

    await runCli(home, "shapes", ["goto", `${fixture.origin}/shop`]);
    await runCli(home, "shapes", ["wait", "--title", "shop loaded"]);
    const rows = await runCli(home, "shapes", ["extract", '{"rows": "li.item", "fields": {"sku": "h2"}}', "--inline"]);
    expect(rows.json.data).toEqual({ count: 2, rows: [{ sku: "a1" }, { sku: "b2" }] });
    const body = await runCli(home, "shapes", ["network", "get", "--url", "*/api/items*", "--body", "--inline"]);
    expect(JSON.parse(String(body.json.data?.body))).toMatchObject({ items: [{ sku: "a1" }, { sku: "b2" }] });
    expect((await runCli(home, "shapes", ["network", "get", "--url", "*/nothing"])).json.error?.code).toBe("bad_args");
  });

  it("runs many requests over pipe, in order per session, with ids and errors per line", async () => {
    const { exitCode, output } = await runPipe("piped", [
      JSON.stringify(["open", `${fixture.origin}/form?name=pipe`]),
      JSON.stringify({ id: "fill", argv: ["fill", "--label", "Name", "bo"] }),
      JSON.stringify(["click", "--role", "button", "--name", "Greet"]),
      JSON.stringify({ id: "out", argv: ["text", "--selector", "#out", "--inline"] }),
      JSON.stringify({ id: "other", argv: ["--session", "piped-2", "open", `${fixture.origin}/form?name=second`] }),
      "not json",
      JSON.stringify(["click", "@e999"]),
    ]);
    const byId = new Map(output.map((line) => [line.id, line]));
    expect(byId.get(1)).toMatchObject({ ok: true, data: { tab: expect.stringMatching(/^t\d+$/) } });
    expect(byId.get("out")).toEqual({ id: "out", ok: true, data: { text: "hello bo" } });
    expect(byId.get("other")).toMatchObject({ ok: true, data: { title: "form second" } });
    expect(byId.get(6)?.error?.code).toBe("bad_args");
    expect(byId.get(7)?.error?.code).toBe("ref_stale");
    expect(exitCode).toBe(1);
  });

  it("stops at the first failure with --bail", async () => {
    const { exitCode, output } = await runPipe(
      "bailer",
      [
        JSON.stringify(["open", `${fixture.origin}/form?name=bail`]),
        JSON.stringify(["--timeout-ms", "500", "click", "--selector", "#missing"]),
        JSON.stringify(["goto", `${fixture.origin}/form?name=never`]),
      ],
      ["--bail"],
    );
    expect(output.map((line) => [line.id, line.ok])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(exitCode).toBe(1);
    expect((await runCli(home, "bailer", ["eval", "document.title"])).json.data?.value).toBe("form bail");
  });

  it("exports a flow explored with refs, and the export replays in a new session", async () => {
    await runCli(home, "explorer", ["session", "history", "clear"]);
    await runCli(home, "explorer", ["open", `${fixture.origin}/form?name=explored`]);
    const snapshot = String((await runCli(home, "explorer", ["snapshot", "--inline"])).json.data?.snapshot);
    const nameRef = snapshot.match(/textbox "Name" \[ref=((?:f\d+)?e\d+)\]/)?.[1];
    const greetRef = snapshot.match(/button "Greet" \[ref=((?:f\d+)?e\d+)\]/)?.[1];
    expect(nameRef).toBeDefined();
    await runCli(home, "explorer", ["fill", `@${nameRef}`, "cy"]);
    await runCli(home, "explorer", ["click", `@${greetRef}`]);
    await runCli(home, "explorer", ["tabs"]);
    expect((await runCli(home, "explorer", ["text", "--selector", "#out", "--inline"])).json.data?.text).toBe(
      "hello cy",
    );

    const jsonl = await runCli(home, "explorer", ["session", "history", "--format", "jsonl"]);
    const steps = String(jsonl.json.data?.script)
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[] });
    expect(steps.map((step) => step.argv)).toEqual([
      ["open", `${fixture.origin}/form?name=explored`],
      ["fill", "--role", "textbox", "--name", "Name", "--exact", "cy"],
      ["click", "--role", "button", "--name", "Greet", "--exact"],
      ["text", "--selector", "#out", "--inline"],
    ]);
    const replayed = await runPipe("replayer", String(jsonl.json.data?.script).split("\n"));
    expect(replayed.exitCode).toBe(0);
    expect(replayed.output.at(-1)).toMatchObject({ ok: true, data: { text: "hello cy" } });

    // The sh export runs as a script with patchrome on PATH.
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(binPath, join(binDir, "patchrome"));
    chmodSync(binPath, 0o755);
    const scriptPath = join(home, "flow.sh");
    expect((await runCli(home, "explorer", ["session", "history", "--out", scriptPath])).json.data?.path).toBe(
      scriptPath,
    );
    const scriptRun = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        "sh",
        [scriptPath],
        { env: { ...env, PATH: `${binDir}:${process.env.PATH}`, PATCHROME_SESSION: "sh-replay" } },
        (err, stdout, stderr) => resolve({ code: err ? Number(err.code) : 0, stdout, stderr }),
      );
    });
    expect(scriptRun.stderr).toBe("");
    expect(scriptRun.code).toBe(0);
    expect(scriptRun.stdout).toContain("hello cy");
  });

  it("records password text as a placeholder", async () => {
    await runCli(home, "secretive", ["open", `data:text/html,<label>Password <input type=password></label>`]);
    await runCli(home, "secretive", ["fill", "--label", "Password", "hunter2"]);
    const history = await runCli(home, "secretive", ["session", "history", "--format", "jsonl"]);
    expect(String(history.json.data?.script)).not.toContain("hunter2");
    expect(String(history.json.data?.script)).toContain("<secret>");
  });

  it("works as a Node library over one connection", async () => {
    const browser = connect({ session: "library", env });
    const opened = await browser.run("open", `${fixture.origin}/form?name=lib`);
    expect(opened.title).toBe("form lib");
    await browser.run("fill", "--label", "Name", "di");
    await browser.run("click", "--role", "button", "--name", "Greet");
    expect(await browser.run("text", "--selector", "#out", "--inline")).toEqual({ text: "hello di" });
    await expect(browser.run("switch", "t9999")).rejects.toMatchObject({ code: "tab_gone" });
    browser.close();
  });
});
