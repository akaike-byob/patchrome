import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { helperFailure, parseApprovalAnswer, type HostPrompts } from "./copy-guard.ts";

const run = promisify(execFile);
const systemOsascript = "/usr/bin/osascript";

// JXA reaches LocalAuthentication through the ObjC bridge. Policy 2 is LAPolicyDeviceOwnerAuthentication: Touch ID,
// or the account password on a Mac without it. A script cannot answer that dialog, where it could click an
// ordinary `display dialog` through System Events. The bridge hands error codes over as strings, hence Number().
const approvalScript = `
ObjC.import("LocalAuthentication");
ObjC.import("Foundation");
function spin(untilDate, isDone) {
  while (!isDone() && $.NSDate.date.compare(untilDate) < 0) {
    $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.2));
  }
}
function run(argv) {
  const policy = 2;
  const context = $.LAContext.alloc.init;
  const error = Ref();
  if (!context.canEvaluatePolicyError(policy, error)) return "unavailable " + (error[0] ? error[0].localizedDescription.js : "no Touch ID or password");
  let answer;
  context.evaluatePolicyLocalizedReasonReply(policy, argv[0], (isApproved, failure) => {
    const code = isApproved ? 0 : Number(failure.code);
    if (isApproved) answer = "approved";
    else if (code === -9) answer = "timed_out";
    else if (code === -1 || code === -2 || code === -4) answer = "denied";
    else answer = "unavailable " + failure.localizedDescription.js;
  });
  spin($.NSDate.dateWithTimeIntervalSinceNow(Number(argv[1])), () => answer !== undefined);
  if (answer === undefined) {
    context.invalidate;
    spin($.NSDate.dateWithTimeIntervalSinceNow(2), () => answer !== undefined);
  }
  return answer === undefined ? "timed_out" : answer;
}`;

const notifyScript = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run`;

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>patchrome</string>
<key>CFBundleIdentifier</key><string>io.patchrome.copy-approval</string>
<key>CFBundleName</key><string>patchrome</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`;

// macOS names the asking app in the dialog, so plain osascript reads "osascript is trying to ...". A copy of
// osascript inside a patchrome.app bundle reads "patchrome is trying to ...". An osacompile applet would
// be simpler, but its runtime aborts when LocalAuthentication replies on a background thread. The folder name
// hashes the plist and the system osascript's size and mtime, so an OS update builds a fresh bundle.
async function renamedOsascript(bundlesDir: string): Promise<string> {
  const system = await stat(systemOsascript);
  const hash = createHash("sha256").update(`${infoPlist}${system.size}:${system.mtimeMs}`).digest("hex").slice(0, 12);
  const executable = join(bundlesDir, hash, "patchrome.app", "Contents", "MacOS", "patchrome");
  if (
    await stat(executable).then(
      () => true,
      () => false,
    )
  )
    return executable;

  await mkdir(bundlesDir, { recursive: true });
  const building = await mkdtemp(join(bundlesDir, "building-"));
  try {
    const app = join(building, "patchrome.app");
    await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
    await writeFile(join(app, "Contents", "Info.plist"), infoPlist);
    await copyFile(systemOsascript, join(app, "Contents", "MacOS", "patchrome"));
    // The copy loses Apple's signature for the bundle; an ad-hoc signature lets it run as patchrome.app.
    await run("codesign", ["--force", "--sign", "-", app], { timeout: 30_000 });
    // Two daemons may build at once; the first rename wins and the other bundle is dropped.
    await rename(building, join(bundlesDir, hash)).catch((err: unknown) => {
      if (!["EEXIST", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
    });
  } finally {
    await rm(building, { recursive: true, force: true });
  }
  return executable;
}

export function macosPrompts(bundlesDir: string, log: (message: string) => void): HostPrompts {
  return {
    async askApproval(reason, timeoutMs) {
      // A failed build still asks, under the name osascript, rather than refusing every copy.
      const osascript = await renamedOsascript(bundlesDir).catch((err: unknown) => {
        log(`building patchrome.app failed, asking through osascript: ${String(err).split("\n")[0]}`);
        return systemOsascript;
      });
      try {
        const { stdout } = await run(
          osascript,
          ["-l", "JavaScript", "-e", approvalScript, reason, String(Math.ceil(timeoutMs / 1000))],
          { timeout: timeoutMs + 10_000 },
        );
        return parseApprovalAnswer(stdout);
      } catch (err) {
        return { answer: "unavailable", detail: helperFailure("osascript", err) };
      }
    },
    async notify(title, body) {
      await run(systemOsascript, ["-e", notifyScript, title, body], { timeout: 10_000 });
    },
  };
}
