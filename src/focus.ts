import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const chromeBundleId = "com.google.Chrome";
const pollIntervalMs = 50;

async function frontmostBundleId(): Promise<string | undefined> {
  try {
    const { stdout } = await run("/bin/zsh", ["-c", "lsappinfo info -only bundleid $(lsappinfo front)"]);
    return stdout.match(/="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

// macOS activates Chrome when its first window appears, so keystrokes meant for the user's editor land in
// the address bar. Chrome has no flag to launch in the background, and --no-startup-window stalls Playwright,
// so this watches the launch and reactivates whichever app was in front. Chrome can activate more than once
// while its first window settles, so the watch keeps going until the grace period ends. `open -b` needs no Apple Events
// permission, unlike osascript.
export async function keepFocusDuring<T>(launch: Promise<T>, graceMs: number): Promise<T> {
  if (process.platform !== "darwin") return launch;
  const previous = await frontmostBundleId();
  if (previous === undefined || previous === chromeBundleId) return launch;

  let isWatching = true;
  void (async () => {
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- the grace timer in the finally below clears it
    while (isWatching) {
      if ((await frontmostBundleId()) === chromeBundleId) {
        await run("open", ["-b", previous]).catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  })();

  try {
    return await launch;
  } finally {
    setTimeout(() => {
      isWatching = false;
    }, graceMs);
  }
}
