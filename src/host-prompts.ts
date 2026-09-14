import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostPrompts } from "./copy-guard.ts";
import { macosPrompts } from "./host-prompts-macos.ts";
import type { HostPlatform } from "./host-platform.ts";
import { wslPrompts } from "./host-prompts-wsl.ts";

const run = promisify(execFile);

// A desktop Linux has no prompt a script cannot click, so copies there go through on the audit record and a
// notification alone. Refusing them instead would only push an agent into copying the cookie files by hand.
const linuxPrompts = (log: (message: string) => void): HostPrompts => ({
  approval: "unprompted",
  unpromptedReason: "no approval prompt on linux; patchrome asks through Touch ID on macOS and Windows Hello on WSL",
  async notify(title, body) {
    log(`${title}: ${body}`);
    await run("notify-send", ["--app-name=patchrome", title, body], { timeout: 10_000 });
  },
});

// A platform patchrome does not support has not been checked for what else can read the profile, so copies are refused.
const refusingPrompts = (log: (message: string) => void): HostPrompts => ({
  approval: "prompt",
  async askApproval() {
    return {
      answer: "unavailable",
      detail: "no approval prompt on this platform; patchrome asks through Touch ID on macOS and Windows Hello on WSL",
    };
  },
  async notify(title, body) {
    log(`${title}: ${body}`);
  },
});

export function hostPromptsFor(
  platform: HostPlatform,
  log: (message: string) => void,
  macosBundlesDir: string,
): HostPrompts {
  switch (platform) {
    case "macos":
      return macosPrompts(macosBundlesDir, log);
    case "wsl":
      return wslPrompts;
    case "linux":
      return linuxPrompts(log);
    case "unsupported":
      return refusingPrompts(log);
  }
}
