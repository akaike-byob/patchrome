import type { HostPrompts } from "./copy-guard.ts";
import { macosPrompts } from "./host-prompts-macos.ts";
import type { HostPlatform } from "./host-platform.ts";
import { wslPrompts } from "./host-prompts-wsl.ts";

// A desktop Linux has no prompt a script cannot click, so copies there go through on the audit record and a
// notification alone. Refusing them instead would only push an agent into copying the cookie files by hand.
const noPrompts = (platform: HostPlatform, log: (message: string) => void): HostPrompts => ({
  unpromptedReason: `no approval prompt on ${platform}; patchrome asks through Touch ID on macOS and Windows Hello on WSL`,
  async askApproval() {
    return { answer: "unavailable", detail: "no approval prompt to show" };
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
    case "unsupported":
      return noPrompts(platform, log);
  }
}
