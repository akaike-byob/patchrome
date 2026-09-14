import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { encodedPowerShell, powerShellString } from "./host-prompts-wsl.ts";
import { CommandError } from "./protocol.ts";

const run = promisify(execFile);
const findTimeoutMs = 30_000;
const newIssueUrl = "https://github.com/akaike-byob/patchrome/issues/new";

// On WSL patchrome drives the Windows Chrome the person sees, not a Linux Chrome in WSLg. Playwright talks to
// Chrome over fds 3 and 4, and WSL interop forwards only stdin, stdout and stderr to a Windows process. So
// Playwright launches a shell launcher, which runs the relay, which feeds fd 3 into powershell.exe's stdin and
// gives it fd 4 as stdout. PowerShell starts chrome.exe on anonymous pipes and copies bytes both ways. No port
// opens.
export interface WindowsChrome {
  // Windows path of chrome.exe.
  chromePath: string;
  // %LOCALAPPDATA% as a WSL path, on the Windows disk, where Chrome's own files have to live.
  localAppDataDir: string;
}

export function findChromeScript(): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$appPaths = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe'
$candidates = @(
  (Get-ItemProperty -LiteralPath "HKCU:\\$appPaths" -ErrorAction SilentlyContinue).'(default)',
  (Get-ItemProperty -LiteralPath "HKLM:\\$appPaths" -ErrorAction SilentlyContinue).'(default)',
  (Join-Path $env:ProgramFiles 'Google\\Chrome\\Application\\chrome.exe'),
  (Join-Path \${env:ProgramFiles(x86)} 'Google\\Chrome\\Application\\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\\Chrome\\Application\\chrome.exe')
)
$chrome = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
@{ chromePath = $chrome; localAppData = [Environment]::GetFolderPath('LocalApplicationData') } | ConvertTo-Json -Compress
`;
}

export async function findWindowsChrome(): Promise<WindowsChrome> {
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedPowerShell(findChromeScript()),
    ],
    { timeout: findTimeoutMs },
  ).catch((err: unknown) => {
    throw new CommandError(
      "setup_required",
      `patchrome on WSL runs the Windows Chrome through powershell.exe, which failed: ${String(err)}`,
      "check that WSL interop is on and powershell.exe is on PATH",
    );
  });
  const found = JSON.parse(stdout) as { chromePath: string | null; localAppData: string };
  if (found.chromePath === null) {
    throw new CommandError(
      "setup_required",
      "no Google Chrome installed on Windows",
      "install Google Chrome on Windows; patchrome on WSL drives the Windows Chrome",
    );
  }
  return { chromePath: found.chromePath, localAppDataDir: await wslPathOf(found.localAppData) };
}

const mirroredSteps =
  "add networkingMode=mirrored under [wsl2] in %UserProfile%\\.wslconfig, run `wsl --shutdown` from Windows, and retry";

// Only mirrored networking is supported: the daemon, the Chrome on Windows and the dev servers an agent opens
// then share one localhost, and a debug profile's port on the Windows loopback is reachable from WSL.
export async function requireMirroredNetworking(
  readNetworkingMode: () => Promise<string> = readWslNetworkingMode,
): Promise<void> {
  const mode = await readNetworkingMode().catch((err: unknown) => {
    throw new CommandError(
      "setup_required",
      `cannot read the WSL networking mode: ${String(err)}`,
      `patchrome on WSL needs mirrored networking, which needs WSL 2.0 or newer: run \`wsl --update\` from Windows, then ${mirroredSteps}`,
    );
  });
  if (mode === "mirrored") return;
  throw new CommandError(
    "setup_required",
    `WSL networking mode is ${mode}; patchrome on WSL supports mirrored networking only`,
    `${mirroredSteps}. If you need ${mode} mode, open an issue at ${newIssueUrl}`,
  );
}

async function readWslNetworkingMode(): Promise<string> {
  return (await run("wslinfo", ["--networking-mode"])).stdout.trim();
}

export async function wslPathOf(windowsPath: string): Promise<string> {
  return (await run("wslpath", ["-u", windowsPath])).stdout.trim();
}

export async function windowsPathOf(wslPath: string): Promise<string> {
  return (await run("wslpath", ["-w", wslPath])).stdout.trim();
}

// The pipe protocol ends every JSON message with a NUL byte. Chunks split messages anywhere.
export class ProtocolMessages {
  #pending: Buffer[] = [];
  #onMessage: (message: Buffer) => void;

  constructor(onMessage: (message: Buffer) => void) {
    this.#onMessage = onMessage;
  }

  push(chunk: Buffer): void {
    let start = 0;
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      this.#pending.push(chunk.subarray(start, end + 1));
      this.#onMessage(Buffer.concat(this.#pending));
      this.#pending = [];
      start = end + 1;
    }
    if (start < chunk.length) this.#pending.push(chunk.subarray(start));
  }
}

// The Chrome requests that name a file on disk: where downloads go, and the files an input receives.
// Playwright sends Linux paths, and the Windows Chrome opens them through \\wsl.localhost or C:\.
const downloadBehaviorMethod = Buffer.from(`"Browser.setDownloadBehavior"`);
const fileInputMethod = Buffer.from(`"DOM.setFileInputFiles"`);

export function withWindowsPaths(message: Buffer, toWindowsPath: (wslPath: string) => string): Buffer {
  if (!message.includes(downloadBehaviorMethod) && !message.includes(fileInputMethod)) return message;
  const request = JSON.parse(message.subarray(0, -1).toString("utf8")) as {
    method: string;
    params?: { downloadPath?: string; files?: string[] };
  };
  const params = request.params;
  if (params === undefined) return message;
  if (request.method === "Browser.setDownloadBehavior" && params.downloadPath !== undefined)
    params.downloadPath = toWindowsPath(params.downloadPath);
  else if (request.method === "DOM.setFileInputFiles" && params.files !== undefined)
    params.files = params.files.map(toWindowsPath);
  else return message;
  return Buffer.concat([Buffer.from(JSON.stringify(request)), Buffer.from([0])]);
}

// Chrome locks its profile files on Windows and reads them slowly over the \\wsl.localhost share, so each
// patchrome profile gets a Windows twin. The hash keeps two PATCHROME_HOMEs, or two distros, apart.
export function windowsChromeProfileDirFor(
  windowsChrome: WindowsChrome,
  chromeProfileDir: string,
  distro: string | undefined,
): string {
  const profile = basename(dirname(chromeProfileDir));
  const hash = createHash("sha256")
    .update(`${distro ?? ""}:${chromeProfileDir}`)
    .digest("hex")
    .slice(0, 12);
  return join(windowsChromeProfilesRoot(windowsChrome), `${profile}-${hash}`);
}

export function windowsChromeProfilesRoot(windowsChrome: WindowsChrome): string {
  return join(windowsChrome.localAppDataDir, "patchrome", "wsl");
}

// The launcher lives beside the Linux profile. Playwright needs a file to execute, and the relay needs the
// Node that runs patchrome, which may not be the first node on PATH.
export async function writeChromeLauncher(dir: string, windowsChrome: WindowsChrome): Promise<string> {
  const launcherPath = join(dir, "windows-chrome-launcher.sh");
  const relayEntry = new URL(
    `./windows-chrome-relay${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
    import.meta.url,
  );
  const words = [process.execPath, relayEntry.pathname, windowsChrome.chromePath].map(shellWord);
  await writeFile(launcherPath, `#!/bin/sh\nexec ${words.join(" ")} "$@"\n`);
  await chmod(launcherPath, 0o700);
  return launcherPath;
}

export function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

// Chrome parses its command line with CommandLineToArgvW: quotes group, and backslashes escape only a quote.
export function windowsCommandLine(args: string[]): string {
  return args.map(windowsArg).join(" ");
}

function windowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    quoted += char === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

// Runs in Windows PowerShell 5.1, which every Windows has. Chrome's own stdout would land in the protocol
// stream, so both of Chrome's output streams go to stderr, where Playwright keeps browser logs. When Playwright
// closes its end, Chrome gets the same EOF and exits; one that hangs on is killed.
export function relayScript(chromePath: string, commandLine: string): string {
  return `
$ErrorActionPreference = 'Stop'
$toChrome = New-Object System.IO.Pipes.AnonymousPipeServerStream ([System.IO.Pipes.PipeDirection]::Out, [System.IO.HandleInheritability]::Inheritable)
$fromChrome = New-Object System.IO.Pipes.AnonymousPipeServerStream ([System.IO.Pipes.PipeDirection]::In, [System.IO.HandleInheritability]::Inheritable)
$start = New-Object System.Diagnostics.ProcessStartInfo ${powerShellString(chromePath)}
$start.Arguments = ${powerShellString(commandLine)} + ' --remote-debugging-io-pipes=' + $toChrome.GetClientHandleAsString() + ',' + $fromChrome.GetClientHandleAsString()
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$chrome = [System.Diagnostics.Process]::Start($start)
$toChrome.DisposeLocalCopyOfClientHandle()
$fromChrome.DisposeLocalCopyOfClientHandle()
$logs = [Console]::OpenStandardError()
$null = $chrome.StandardOutput.BaseStream.CopyToAsync($logs)
$null = $chrome.StandardError.BaseStream.CopyToAsync($logs)
$requests = [Console]::OpenStandardInput().CopyToAsync($toChrome)
$responses = $fromChrome.CopyToAsync([Console]::OpenStandardOutput())
while (-not $chrome.WaitForExit(100)) {
  if ($requests.IsCompleted) {
    $toChrome.Dispose()
    if (-not $chrome.WaitForExit(5000)) { $chrome.Kill() }
    break
  }
}
$chrome.WaitForExit()
$null = $responses.Wait(2000)
exit $chrome.ExitCode
`;
}
