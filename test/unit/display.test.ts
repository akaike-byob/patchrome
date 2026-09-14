import { describe, expect, it } from "vitest";
import { chromeLaunchError, listDisplays, resolveDisplay, type Displays } from "../../src/display.ts";
import { CommandError } from "../../src/protocol.ts";

const sockets: Record<string, string[]> = {
  "/tmp/.X11-unix": ["X99", "X20", "notasocket"],
  "/run/user/1000": ["wayland-0", "wayland-0.lock", "bus"],
};

const readDir = (dir: string): string[] => sockets[dir] ?? [];

const none: Displays = { x: [], wayland: [] };

describe("displays", () => {
  it("reads X and Wayland sockets as display names", () => {
    expect(listDisplays({ XDG_RUNTIME_DIR: "/run/user/1000" }, readDir)).toEqual({
      x: [":20", ":99"],
      wayland: ["wayland-0"],
    });
    expect(listDisplays({}, readDir)).toEqual({ x: [":20", ":99"], wayland: [] });
    expect(listDisplays({ XDG_RUNTIME_DIR: "/run/user/1000" }, () => [])).toEqual({ x: [], wayland: [] });
  });

  it("leaves the environment alone on macOS, on WSL, and when a display is already set", () => {
    expect(resolveDisplay("macos", {}, none, false).kind).toBe("inherit");
    expect(resolveDisplay("wsl", {}, none, false).kind).toBe("inherit");
    expect(resolveDisplay("linux", { DISPLAY: ":0" }, { x: [":0", ":1"], wayland: [] }, false).kind).toBe("inherit");
    expect(resolveDisplay("linux", { WAYLAND_DISPLAY: "wayland-0" }, none, false).kind).toBe("inherit");
  });

  it("asks for no display when Chrome runs headless", () => {
    expect(resolveDisplay("linux", {}, { x: [":20", ":99"], wayland: [] }, true).kind).toBe("inherit");
    expect(resolveDisplay("linux", {}, none, true).kind).toBe("inherit");
  });

  it("picks the only display on the machine", () => {
    expect(resolveDisplay("linux", {}, { x: [":0"], wayland: [] }, false)).toEqual({
      kind: "use",
      assignments: [{ variable: "DISPLAY", value: ":0" }],
    });
    expect(resolveDisplay("linux", { DISPLAY: "" }, { x: [], wayland: ["wayland-1"] }, false)).toEqual({
      kind: "use",
      assignments: [{ variable: "WAYLAND_DISPLAY", value: "wayland-1" }],
    });
  });

  it("reads a Wayland desktop with its Xwayland socket as one display, and sets both", () => {
    expect(resolveDisplay("linux", {}, { x: [":0"], wayland: ["wayland-0"] }, false)).toEqual({
      kind: "use",
      assignments: [
        { variable: "DISPLAY", value: ":0" },
        { variable: "WAYLAND_DISPLAY", value: "wayland-0" },
      ],
    });
  });

  it("suggests an X display before a Wayland one", () => {
    const choice = resolveDisplay("linux", {}, { x: [":20", ":99"], wayland: ["wayland-0"] }, false);
    if (choice.kind !== "missing") throw new Error(`expected a missing display, got ${choice.kind}`);
    expect(choice.error.hint).toContain(":20, :99, wayland-0");
    expect(choice.error.hint).toContain("`DISPLAY=:20 patchrome session`");
  });

  it("names every candidate when several displays could be the person's", () => {
    const choice = resolveDisplay("linux", {}, { x: [":20", ":99"], wayland: [] }, false);
    if (choice.kind !== "missing") throw new Error(`expected a missing display, got ${choice.kind}`);
    expect(choice.error.code).toBe("no_display");
    expect(choice.error.message).toContain("neither DISPLAY nor WAYLAND_DISPLAY is set");
    expect(choice.error.hint).toContain(":20, :99");
    expect(choice.error.hint).toContain("DISPLAY=:20 patchrome session");
  });

  it("sends a machine with no display to xvfb or a desktop session", () => {
    const choice = resolveDisplay("linux", {}, none, false);
    if (choice.kind !== "missing") throw new Error(`expected a missing display, got ${choice.kind}`);
    expect(choice.error.hint).toContain("xvfb-run");
  });

  it("reads Chrome's X server complaint as a missing display, and passes other failures through", () => {
    const xServer = chromeLaunchError(
      new Error("Target page, context or browser has been closed\nMissing X server or $DISPLAY"),
      { x: [":20"], wayland: [] },
    );
    expect(xServer.code).toBe("no_display");
    expect(xServer.hint).toContain(":20");

    const other = chromeLaunchError(new Error("Executable doesn't exist at /opt/google/chrome\nsecond line"), none);
    expect(other.code).toBe("bad_args");
    expect(other.message).toBe("Chrome failed to start: Executable doesn't exist at /opt/google/chrome");
    expect(other.hint).toBe("see `patchrome daemon logs`");

    const already = new CommandError("timeout", "took too long");
    expect(chromeLaunchError(already, none)).toBe(already);
  });
});
