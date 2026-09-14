import { readdirSync } from "node:fs";
import type { HostPlatform } from "./host-platform.ts";
import { CommandError } from "./protocol.ts";

// A headed Chrome needs an X or Wayland display. A shell started over SSH or from a tty inherits none,
// even while the person's desktop runs on :20, and Chrome then dies with a sentence about a closed target.

export interface Displays {
  x: string[];
  wayland: string[];
}

export type DisplayChoice =
  // The environment already answers the question, or the platform does not ask it.
  | { kind: "inherit" }
  // The only display on the machine, picked because there is nothing to choose between.
  | { kind: "use"; variable: "DISPLAY" | "WAYLAND_DISPLAY"; value: string }
  | { kind: "missing"; error: CommandError };

const x11SocketDir = "/tmp/.X11-unix";

export function listDisplays(env: NodeJS.ProcessEnv = process.env, readDir = readNames): Displays {
  const x = readDir(x11SocketDir)
    .filter((name) => /^X\d+$/.test(name))
    .map((name) => Number(name.slice(1)))
    .toSorted((a, b) => a - b)
    .map((number) => `:${number}`);
  const runtimeDir = env.XDG_RUNTIME_DIR;
  const wayland =
    runtimeDir === undefined
      ? []
      : readDir(runtimeDir)
          .filter((name) => /^wayland-[^.]+$/.test(name))
          .toSorted();
  return { x, wayland };
}

export function resolveDisplay(platform: HostPlatform, env: NodeJS.ProcessEnv, displays: Displays): DisplayChoice {
  // WSLg sets DISPLAY for its own X server, and macOS has no display variable at all.
  if (platform !== "linux") return { kind: "inherit" };
  if (isSet(env.DISPLAY) || isSet(env.WAYLAND_DISPLAY)) return { kind: "inherit" };
  const found = [
    ...displays.wayland.map((value) => ({ variable: "WAYLAND_DISPLAY", value }) as const),
    ...displays.x.map((value) => ({ variable: "DISPLAY", value }) as const),
  ];
  const only = found.length === 1 ? found[0] : undefined;
  if (only !== undefined) return { kind: "use", ...only };
  return { kind: "missing", error: noDisplayError(displays) };
}

export function noDisplayError(displays: Displays): CommandError {
  const names = [...displays.wayland, ...displays.x];
  const hint =
    names.length === 0
      ? "start patchrome from your desktop session, or run it under `xvfb-run` for a headless machine"
      : `displays found: ${names.join(", ")}; run \`${variableFor(displays, names[0] ?? "")}=${names[0]} patchrome session\`, or start patchrome from your desktop session`;
  return new CommandError("no_display", "Chrome needs a display, and neither DISPLAY nor WAYLAND_DISPLAY is set", hint);
}

// Chrome fails the same way when a display is named but unreachable, which no preflight can see.
export function chromeLaunchError(err: unknown, displays: Displays): CommandError {
  if (err instanceof CommandError) return err;
  const text = err instanceof Error ? err.message : String(err);
  if (/Missing X server|without having a XServer/i.test(text)) return noDisplayError(displays);
  const firstLine = text.split("\n")[0] ?? text;
  return new CommandError("bad_args", `Chrome failed to start: ${firstLine}`, "see `patchrome daemon logs`");
}

function variableFor(displays: Displays, name: string): "DISPLAY" | "WAYLAND_DISPLAY" {
  return displays.wayland.includes(name) ? "WAYLAND_DISPLAY" : "DISPLAY";
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function readNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
