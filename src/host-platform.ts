import { readFileSync } from "node:fs";

// The desktop a person sits at decides how patchrome asks them anything. WSL runs Linux, but its person
// sits at Windows, so prompts and notifications go through powershell.exe.
export const hostPlatforms = ["macos", "wsl", "linux", "unsupported"] as const;
export type HostPlatform = (typeof hostPlatforms)[number];

export function detectHostPlatform(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  procVersion = readProcVersion,
): HostPlatform {
  if (platform === "darwin") return "macos";
  if (platform !== "linux") return "unsupported";
  return env.WSL_DISTRO_NAME !== undefined || /microsoft/i.test(procVersion()) ? "wsl" : "linux";
}

function readProcVersion(): string {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
}
