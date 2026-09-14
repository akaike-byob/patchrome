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

// Reactivates `previous` whenever Chrome is in front, until `until` settles and graceMs more pass. The watch
// cannot tell Chrome raising itself from the user clicking Chrome, so the grace stays short. `open -b` needs no
// Apple Events permission, unlike osascript.
function returnFocusFromChrome(previous: string, until: Promise<unknown>, graceMs: number): void {
  let isWatching = true;
  void (async () => {
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- the grace timer below clears it
    while (isWatching) {
      if ((await frontmostBundleId()) === chromeBundleId) {
        await run("open", ["-b", previous]).catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  })();
  void until.finally(() => {
    setTimeout(() => {
      isWatching = false;
    }, graceMs);
  });
}

// macOS activates Chrome when its first window appears, so keystrokes meant for the user's editor land in
// the address bar. Chrome has no flag to launch in the background, and --no-startup-window stalls Playwright,
// so this watches the launch and reactivates whichever app was in front.
export async function keepFocusDuring<T>(launch: Promise<T>, graceMs: number): Promise<T> {
  if (process.platform !== "darwin") return launch;
  const previous = await frontmostBundleId();
  if (previous !== undefined && previous !== chromeBundleId) returnFocusFromChrome(previous, launch, graceMs);
  return launch;
}

export interface FocusHost {
  frontmostBundleId(): Promise<string | undefined>;
  returnFocusFromChrome(previous: string, graceMs: number): void;
  nowMs(): number;
}

const macFocusHost: FocusHost = {
  frontmostBundleId,
  returnFocusFromChrome: (previous, graceMs) => returnFocusFromChrome(previous, Promise.resolve(), graceMs),
  nowMs: () => Date.now(),
};

// A request that arrives after the popup activated Chrome, such as an agent polling `tabs`, samples Chrome.
// Older samples cover that; past this age the user may have moved to Chrome on purpose.
const requestSampleMaxAgeMs = 5_000;

// A page opening a tab or window, such as a target=_blank link an agent clicks, activates Chrome too. Chrome
// takes the front 4-330 ms before Playwright reports the popup, so the app to return to is the last one other
// than Chrome that was in front when a request arrived.
export class PopupFocusReturn {
  #appSample: Promise<{ bundleId: string; atMs: number } | undefined> = Promise.resolve(undefined);
  #graceMs: number;
  #host: FocusHost | undefined;

  constructor(graceMs: number, host: FocusHost | undefined = process.platform === "darwin" ? macFocusHost : undefined) {
    this.#graceMs = graceMs;
    this.#host = host;
  }

  noteRequestArrived(): void {
    const host = this.#host;
    if (host === undefined) return;
    const earlier = this.#appSample;
    const atMs = host.nowMs();
    this.#appSample = host
      .frontmostBundleId()
      .then(async (bundleId) => (bundleId === undefined || bundleId === chromeBundleId ? earlier : { bundleId, atMs }));
  }

  async returnAfterPopup(): Promise<void> {
    const host = this.#host;
    if (host === undefined) return;
    const sample = await this.#appSample;
    if (sample === undefined || host.nowMs() - sample.atMs > requestSampleMaxAgeMs) return;
    host.returnFocusFromChrome(sample.bundleId, this.#graceMs);
  }
}
