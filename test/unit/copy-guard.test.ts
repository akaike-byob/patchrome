import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCli } from "../../src/cli.ts";
import {
  CopyGuard,
  helperFailure,
  parseApprovalAnswer,
  readAuditLog,
  type ApprovalAnswer,
  type CopyRequest,
  type HostPrompts,
} from "../../src/copy-guard.ts";
import { detectHostPlatform } from "../../src/host-platform.ts";
import { hostPromptsFor } from "../../src/host-prompts.ts";
import { approvalScript, encodedPowerShell, powerShellString } from "../../src/host-prompts-wsl.ts";
import { CommandError } from "../../src/protocol.ts";

const importRequest: CopyRequest = {
  kind: "state-import",
  session: "claude-1",
  source: `Chrome profile "Work" (Profile 1)`,
  target: "patchrome profile stealth (shared by every session)",
  site: "github.com",
  cookies: 3,
  origins: ["https://github.com"],
};

interface Harness {
  guard: CopyGuard;
  auditLogPath: string;
  asked: string[];
  notified: string[];
}

function guardWith(answers: Array<ApprovalAnswer | Error | Promise<ApprovalAnswer>>): Harness {
  const auditLogPath = join(mkdtempSync(join(tmpdir(), "patchrome-audit-")), "copy-audit.jsonl");
  const asked: string[] = [];
  const notified: string[] = [];
  const prompts: HostPrompts = {
    approval: "prompt",
    async askApproval(reason) {
      asked.push(reason);
      const next = answers.shift();
      if (next === undefined) throw new Error("no answer queued");
      if (next instanceof Error) throw next;
      return { answer: await next, detail: undefined };
    },
    async notify(title, body) {
      notified.push(`${title} | ${body}`);
    },
  };
  return {
    guard: new CopyGuard({
      prompts,
      auditLogPath,
      profile: "stealth",
      log: () => {},
      nowMs: () => Date.UTC(2026, 8, 13, 6, 30),
    }),
    auditLogPath,
    asked,
    notified,
  };
}

async function codeOf(action: Promise<unknown>): Promise<string | undefined> {
  try {
    await action;
  } catch (err) {
    return err instanceof CommandError ? err.code : String(err);
  }
  return undefined;
}

describe("CopyGuard", () => {
  it("lets an approved copy through, records it, and does not notify the person who approved it", async () => {
    const { guard, auditLogPath, asked, notified } = guardWith(["approved"]);
    await guard.requireApproval(importRequest);
    expect(asked[0]).toBe(
      `import the github.com login (3 cookies and storage for 1 origin) from Chrome profile "Work" (Profile 1) into patchrome profile stealth (shared by every session). Asked by agent session claude-1.`,
    );
    expect(notified).toEqual([]);
    const { entries } = await readAuditLog(auditLogPath);
    expect(entries).toEqual([
      { ...importRequest, atUtc: "2026-09-13T06:30:00.000Z", profile: "stealth", decision: "approved" },
    ]);
  });

  it("refuses a denied copy with copy_denied and records the denial", async () => {
    const { guard, auditLogPath, notified } = guardWith(["denied"]);
    expect(await codeOf(guard.requireApproval(importRequest))).toBe("copy_denied");
    expect(notified).toEqual([]);
    expect(
      (await readAuditLog(auditLogPath)).entries.map((entry) => ("decision" in entry ? entry.decision : entry.kind)),
    ).toEqual(["denied"]);
  });

  it("notifies when nobody answered, or the prompt could not be shown", async () => {
    const { guard, auditLogPath, notified } = guardWith(["timed_out", new Error("osascript: command not found")]);
    expect(await codeOf(guard.requireApproval(importRequest))).toBe("copy_denied");
    expect(await codeOf(guard.requireApproval(importRequest))).toBe("copy_denied");
    expect(notified).toHaveLength(2);
    expect(notified[0]).toMatch(/^patchrome copy timed out \| claude-1: import the github.com login/);
    const { entries } = await readAuditLog(auditLogPath);
    expect(entries.map((entry) => ("decision" in entry ? [entry.decision, entry.detail] : [entry.kind]))).toEqual([
      ["timed_out", undefined],
      ["unavailable", "osascript: command not found"],
    ]);
  });

  it("records and notifies a save without asking", async () => {
    const { guard, auditLogPath, asked, notified } = guardWith([]);
    await guard.recordUnasked({
      ...importRequest,
      kind: "state-save",
      site: undefined,
      source: "patchrome profile stealth",
      target: "file /x/state.json",
    });
    expect(asked).toEqual([]);
    expect(notified[0]).toContain(
      "save 3 cookies and storage for 1 origin from patchrome profile stealth to file /x/state.json",
    );
    const [entry] = (await readAuditLog(auditLogPath)).entries;
    expect(entry).toMatchObject({ kind: "state-save", decision: "not_asked" });
    expect(entry).not.toHaveProperty("site");
  });

  it("describes an export to a file", async () => {
    const { guard, auditLogPath, asked } = guardWith(["approved"]);
    await guard.requireApproval({
      ...importRequest,
      kind: "state-export",
      source: "patchrome profile stealth (shared by every session)",
      target: "file /x/github.json",
    });
    expect(asked[0]).toBe(
      "export the github.com login (3 cookies and storage for 1 origin) from patchrome profile stealth (shared by every session) to file /x/github.json. Asked by agent session claude-1.",
    );
    expect((await readAuditLog(auditLogPath)).entries[0]).toMatchObject({ kind: "state-export", decision: "approved" });
  });

  it("shows one prompt at a time", async () => {
    let answerFirst: (answer: ApprovalAnswer) => void = () => {};
    const { guard, asked } = guardWith([
      new Promise<ApprovalAnswer>((resolve) => {
        answerFirst = resolve;
      }),
      "approved",
    ]);
    const first = guard.requireApproval(importRequest);
    const second = guard.requireApproval({ ...importRequest, session: "claude-2" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toHaveLength(1);
    answerFirst("denied");
    expect(await codeOf(first)).toBe("copy_denied");
    await second;
    expect(asked).toHaveLength(2);
  });

  it("fails the copy when the audit log cannot be written", async () => {
    const notADirectory = join(mkdtempSync(join(tmpdir(), "patchrome-audit-")), "file");
    writeFileSync(notADirectory, "");
    const guard = new CopyGuard({
      prompts: hostPromptsFor("linux", () => {}, "/unused"),
      auditLogPath: join(notADirectory, "copy-audit.jsonl"),
      profile: "stealth",
      log: () => {},
    });
    await expect(guard.requireApproval(importRequest)).rejects.toThrow(/ENOTDIR|EEXIST/);
  });
});

describe("audit log", () => {
  it("reports lines it cannot read instead of dropping them", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "patchrome-audit-")), "copy-audit.jsonl");
    const guard = new CopyGuard({
      prompts: hostPromptsFor("linux", () => {}, "/unused"),
      auditLogPath: path,
      profile: "stealth",
      log: () => {},
    });
    await guard.recordUnasked({ ...importRequest, kind: "state-save" });
    writeFileSync(path, `${readFileSync(path, "utf8")}not json\n{"decision":"approved"}\n`);
    const { entries, unreadableLines } = await readAuditLog(path);
    expect(entries).toHaveLength(1);
    expect(unreadableLines).toEqual([2, 3]);
  });

  it("reads a missing log as empty", async () => {
    expect(await readAuditLog(join(tmpdir(), "patchrome-no-such-dir", "copy-audit.jsonl"))).toEqual({
      entries: [],
      unreadableLines: [],
    });
  });

  it("is listed by `audit`, locally", () => {
    expect(parseCli(["audit"], {}, () => "s")).toEqual({ kind: "audit", count: 20, isJson: false });
    expect(parseCli(["--json", "audit", "--count", "5"], {}, () => "s")).toEqual({
      kind: "audit",
      count: 5,
      isJson: true,
    });
    expect(() => parseCli(["audit", "--count", "0"], {}, () => "s")).toThrow(CommandError);
  });
});

describe("approval settings and platforms", () => {
  it("gives more time to state load, import and export, which wait for the person", () => {
    expect(parseCli(["state", "load", "a.json"], {}, () => "s")).toMatchObject({ timeoutMs: 120_000 });
    expect(parseCli(["state", "export", "github.com", "a.json"], {}, () => "s")).toMatchObject({ timeoutMs: 120_000 });
    expect(parseCli(["state", "save", "a.json"], {}, () => "s")).toMatchObject({ timeoutMs: 30_000 });
  });

  it("names a failed helper in one line", () => {
    expect(
      helperFailure(
        "osascript",
        Object.assign(new Error("Command failed: osascript -l JavaScript -e\nObjC.import"), {
          killed: false,
          signal: "SIGTERM",
          code: null,
        }),
      ),
    ).toBe("osascript stopped by SIGTERM");
    expect(
      helperFailure("powershell.exe", Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" })),
    ).toBe("powershell.exe not found");
  });

  it("reads a helper's answer, and treats anything else as unavailable", () => {
    expect(parseApprovalAnswer("approved\n")).toEqual({ answer: "approved", detail: undefined });
    expect(parseApprovalAnswer("unavailable Windows Hello is DeviceNotPresent")).toEqual({
      answer: "unavailable",
      detail: "Windows Hello is DeviceNotPresent",
    });
    expect(parseApprovalAnswer("#< CLIXML")).toEqual({
      answer: "unavailable",
      detail: "unreadable prompt answer: #< CLIXML",
    });
  });

  it("tells WSL from plain Linux", () => {
    expect(detectHostPlatform("darwin", {}, () => "")).toBe("macos");
    expect(detectHostPlatform("linux", { WSL_DISTRO_NAME: "Ubuntu" }, () => "")).toBe("wsl");
    expect(detectHostPlatform("linux", {}, () => "Linux version 6.6.87.2-microsoft-standard-WSL2")).toBe("wsl");
    expect(detectHostPlatform("linux", {}, () => "Linux version 6.8.0-45-generic")).toBe("linux");
    expect(detectHostPlatform("win32", {}, () => "")).toBe("unsupported");
  });

  it("lets a copy through on a platform without a prompt, recording and announcing why", async () => {
    const auditLogPath = join(mkdtempSync(join(tmpdir(), "patchrome-audit-")), "copy-audit.jsonl");
    const notified: string[] = [];
    const guard = new CopyGuard({
      prompts: {
        ...hostPromptsFor("linux", () => {}, "/unused"),
        async notify(title, body) {
          notified.push(`${title} | ${body}`);
        },
      },
      auditLogPath,
      profile: "stealth",
      log: () => {},
    });
    await guard.requireApproval(importRequest);
    expect(notified[0]).toMatch(/^patchrome copy unprompted \| claude-1: import the github.com login/);
    expect((await readAuditLog(auditLogPath)).entries[0]).toMatchObject({
      decision: "unprompted",
      detail: expect.stringContaining("no approval prompt on linux"),
    });
  });

  it("refuses a copy on an unsupported platform", async () => {
    const auditLogPath = join(mkdtempSync(join(tmpdir(), "patchrome-audit-")), "copy-audit.jsonl");
    const guard = new CopyGuard({
      prompts: hostPromptsFor("unsupported", () => {}, "/unused"),
      auditLogPath,
      profile: "stealth",
      log: () => {},
    });
    expect(await codeOf(guard.requireApproval(importRequest))).toBe("copy_denied");
    expect((await readAuditLog(auditLogPath)).entries[0]).toMatchObject({ decision: "unavailable" });
  });

  it("passes text into PowerShell as base64, never as code", () => {
    const hostile = `'); Remove-Item C:\\ -Recurse; ('`;
    const script = approvalScript(hostile, 60_000);
    expect(script).not.toContain("Remove-Item");
    const encoded = powerShellString(hostile).match(/FromBase64String\('([^']+)'\)/)?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(hostile);
    expect(Buffer.from(encodedPowerShell(script), "base64").toString("utf16le")).toBe(script);
  });
});
