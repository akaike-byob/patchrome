import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeHome, runCli, startDaemonTrusting, stopDaemon } from "./helpers.ts";
import {
  carrierOf,
  closedPort,
  makeTestCertificate,
  startTestProxy,
  startTestSites,
  type TestProxy,
  type TestSites,
} from "./proxy-fixtures.ts";

const binPath = fileURLToPath(new URL("../../bin/patchrome.js", import.meta.url));
const alicePassword = "alice-secret-4711";
const carolWrongPassword = "carol-wrong-0815";

describe("proxy rules", () => {
  const home = makeHome("proxy");
  const session = "proxied";
  const passwords = { ALICE_PASS: alicePassword, CAROL_PASS: carolWrongPassword, BOB_PASS: "bob-secret" };
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(home, session, args, { ...passwords, ...env });
  const daemonOutput: string[] = [];
  let sites: TestSites;
  let alice: TestProxy;
  let bob: TestProxy;
  let carol: TestProxy;
  let deadPort: number;
  let certificate: ReturnType<typeof makeTestCertificate>;
  let daemon: { exited: Promise<void> };

  const lastRequestTo = (host: string) => sites.requests.findLast((request) => request.host === host);

  beforeAll(async () => {
    certificate = makeTestCertificate();
    sites = await startTestSites(certificate);
    alice = await startTestProxy(certificate, sites, { username: "alice", password: alicePassword });
    bob = await startTestProxy(certificate, sites, { username: "bob", password: "bob-secret" });
    carol = await startTestProxy(certificate, sites, { username: "carol", password: "carol-right" });
    deadPort = await closedPort();
    const write = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk, ...rest) => {
      daemonOutput.push(String(chunk));
      return write(chunk, ...(rest as []));
    });
    daemon = await startDaemonTrusting(home, [certificate.cert]);
  });

  afterAll(async () => {
    await stopDaemon(home);
    vi.restoreAllMocks();
    for (const proxy of [alice, bob, carol]) proxy?.close();
    sites?.close();
  });

  it("stores a proxy with its password out of argv and out of the readable file", async () => {
    const added = await run([
      "proxy",
      "add",
      "alice",
      `https://127.0.0.1:${alice.port}`,
      "--username",
      "alice",
      "--password-env",
      "ALICE_PASS",
    ]);
    expect(added.json).toMatchObject({ ok: true, data: { name: "alice", username: "alice", hasPassword: true } });
    const profileDir = join(home, "stealth");
    expect(readFileSync(join(profileDir, "proxies.json"), "utf8")).not.toContain(alicePassword);
    expect(JSON.parse(readFileSync(join(profileDir, "proxy-secrets.json"), "utf8"))).toEqual({ alice: alicePassword });
    expect(statSync(join(profileDir, "proxy-secrets.json")).mode & 0o777).toBe(0o600);
    expect(
      (
        await run([
          "proxy",
          "add",
          "bob",
          `https://127.0.0.1:${bob.port}`,
          "--username",
          "bob",
          "--password-env",
          "BOB_PASS",
        ])
      ).json.ok,
    ).toBe(true);
  });

  it("reads a password from stdin", async () => {
    const output = await new Promise<string>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          binPath,
          "--json",
          "--session",
          session,
          "proxy",
          "add",
          "bob",
          `https://127.0.0.1:${bob.port}`,
          "--username",
          "bob",
          "--password-stdin",
        ],
        { env: { ...process.env, PATCHROME_HOME: home, CLAUDE_CODE_SESSION_ID: "" } },
      );
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.on("close", () => resolve(stdout));
      child.stdin.end("bob-secret\n");
    });
    expect(JSON.parse(output)).toMatchObject({ ok: true, data: { name: "bob", isReplaced: true, hasPassword: true } });
    expect(JSON.parse(readFileSync(join(home, "stealth", "proxy-secrets.json"), "utf8")).bob).toBe("bob-secret");
  });

  it("refuses plain http and socks proxies, and credentials inside the URL", async () => {
    for (const server of [
      `http://127.0.0.1:${alice.port}`,
      `socks5://127.0.0.1:${alice.port}`,
      `https://u:p@127.0.0.1:${alice.port}`,
    ]) {
      const refused = await run(["proxy", "add", "other", server]);
      expect(refused.exitCode, server).toBe(2);
      expect(refused.json.error?.code, server).toBe("bad_args");
    }
  });

  it("routes each host through the proxy its rule names, answering the proxy's password prompt", async () => {
    expect((await run(["proxy", "rule", "add", "*.proxy.test", "alice"])).json.ok).toBe(true);
    expect((await run(["proxy", "rule", "add", "bob.proxy.test", "bob"])).json.ok).toBe(true);

    expect((await run(["open", "https://shop.proxy.test/"])).json).toMatchObject({
      ok: true,
      data: { title: "shop.proxy.test" },
    });
    expect(carrierOf([alice, bob], lastRequestTo("shop.proxy.test"))).toBe(alice);
    expect((await run(["goto", "https://bob.proxy.test/"])).json).toMatchObject({
      ok: true,
      data: { title: "bob.proxy.test" },
    });
    expect(carrierOf([alice, bob], lastRequestTo("bob.proxy.test"))).toBe(bob);

    const rules = await run(["proxy", "rule", "list"]);
    expect(rules.json.data?.rules).toEqual([
      { pattern: "bob.proxy.test", via: "bob", route: `via bob (127.0.0.1:${bob.port})` },
      { pattern: "*.proxy.test", via: "alice", route: `via alice (127.0.0.1:${alice.port})` },
    ]);
  });

  it("keeps WebRTC from reaching the network outside the proxy", async () => {
    const candidates = await run([
      "eval",
      `(async () => { const pc = new RTCPeerConnection({ iceServers: [] }); pc.createDataChannel("x"); const found = []; pc.onicecandidate = (e) => e.candidate && found.push(e.candidate.candidate); await pc.setLocalDescription(await pc.createOffer()); await new Promise((r) => setTimeout(r, 1500)); pc.close(); return found.length; })()`,
      "--inline",
    ]);
    expect(candidates.json).toMatchObject({ ok: true, data: { value: 0 } });
  });

  it("sends hosts no rule matches straight to the site", async () => {
    const direct = await run(["goto", "https://unmatched.invalid/"]);
    expect(direct.json.error?.code).toBe("navigation_failed");
    expect(direct.json.error?.message).toContain("ERR_NAME_NOT_RESOLVED");
  });

  it("names a blocked host, a refused password and a dead proxy", async () => {
    expect((await run(["proxy", "rule", "add", "blocked.proxy.test", "block"])).json.ok).toBe(true);
    const blocked = await run(["goto", "https://blocked.proxy.test/"]);
    expect(blocked.json.error).toMatchObject({
      code: "navigation_failed",
      message: "blocked.proxy.test is blocked by proxy rule blocked.proxy.test",
    });

    await run([
      "proxy",
      "add",
      "carol",
      `https://127.0.0.1:${carol.port}`,
      "--username",
      "carol",
      "--password-env",
      "CAROL_PASS",
    ]);
    await run(["proxy", "rule", "add", "carol.proxy.test", "carol"]);
    const refused = await run(["goto", "https://carol.proxy.test/"]);
    expect(refused.json.error?.code).toBe("proxy_auth_failed");
    expect(carol.refusedAuth).toBeGreaterThan(0);

    await run(["proxy", "add", "dead", `https://127.0.0.1:${deadPort}`]);
    await run(["proxy", "rule", "add", "dead.proxy.test", "dead"]);
    const dead = await run(["goto", "https://dead.proxy.test/"]);
    expect(dead.json.error?.code).toBe("proxy_unreachable");
  });

  it("reports the rule, route and exit address for a URL", async () => {
    const tested = await run(["proxy", "test", "https://shop.proxy.test/cart"], {
      PATCHROME_IP_ECHO_URL: "https://echo.proxy.test/echo",
    });
    expect(tested.json.data).toMatchObject({
      host: "shop.proxy.test",
      rule: "*.proxy.test",
      route: "proxy",
      proxy: "alice",
      exitIp: "203.0.113.7",
      exitCountry: "DE",
      exitTimeZone: "Europe/Berlin",
    });
    expect(carrierOf([alice], lastRequestTo("echo.proxy.test"))).toBe(alice);
    const refused = await run(["proxy", "test", "https://carol.proxy.test/"], {
      PATCHROME_IP_ECHO_URL: "https://echo.proxy.test/echo",
    });
    expect(refused.json.error?.code).toBe("proxy_auth_failed");
  });

  it("keeps a proxy that rules use, and keeps isolated tabs away from rules they cannot follow", async () => {
    const removal = await run(["proxy", "remove", "alice"]);
    expect(removal.json.error).toMatchObject({
      code: "bad_args",
      message: "proxy alice is used by 1 rule: *.proxy.test",
    });
    const isolated = await runCli(home, "isolated-one", ["open", "--isolated", "https://shop.proxy.test/"]);
    expect(isolated.json.error?.code).toBe("bad_args");
    expect(isolated.json.error?.message).toContain("isolated tabs cannot use this profile's proxy rules");
  });

  it("refuses a new rule while an isolated session is open", async () => {
    const other = makeHome("proxy-isolated");
    await startDaemonTrusting(other, []);
    try {
      expect((await runCli(other, "isolated-two", ["open", "--isolated"])).json.ok).toBe(true);
      const refused = await runCli(other, "adder", ["proxy", "rule", "add", "*", "direct"]);
      expect(refused.json.error).toMatchObject({
        code: "bad_args",
        message: "sessions isolated-two have isolated tabs, which proxy rules cannot reach",
      });
    } finally {
      await stopDaemon(other);
    }
  });

  it("applies the stored rules and passwords again after a daemon restart", async () => {
    await stopDaemon(home);
    await daemon.exited;
    daemon = await startDaemonTrusting(home, [certificate.cert]);
    expect((await run(["open", "https://restarted.proxy.test/"])).json).toMatchObject({
      ok: true,
      data: { title: "restarted.proxy.test" },
    });
    expect(carrierOf([alice, bob], lastRequestTo("restarted.proxy.test"))).toBe(alice);
  });

  it("shows the rules in daemon status and every change in the audit log, never the password", async () => {
    const status = await run(["daemon", "status"]);
    expect(status.json.data?.proxy).toBe("proxy: 5 rules, unmatched hosts direct");
    const audit = await run(["audit", "--count", "50"]);
    expect(audit.stdout).toContain("add proxy alice https://127.0.0.1:");
    expect(audit.stdout).toContain("add rule *.proxy.test via alice");
    const auditLog = readFileSync(join(home, "copy-audit.jsonl"), "utf8");
    for (const secret of Object.values(passwords)) {
      expect(auditLog).not.toContain(secret);
      expect(daemonOutput.join("")).not.toContain(secret);
    }
  });

  it("turns everything off with clear", async () => {
    const cleared = await run(["proxy", "clear"]);
    expect(cleared.json.data).toMatchObject({ clearedProxies: 4, clearedRules: 5 });
    const direct = await run(["goto", "https://shop.proxy.test/"]);
    expect(direct.json.error?.message).toContain("ERR_NAME_NOT_RESOLVED");
    expect(JSON.parse(readFileSync(join(home, "stealth", "proxy-secrets.json"), "utf8"))).toEqual({});
  });
});
