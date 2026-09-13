import { CommandError } from "./protocol.ts";

// One glob dialect for `network list --url` and `route`: `*` matches any run of characters, `?` one
// character, and the glob must match the whole URL. Playwright's own globs treat `/` specially, which
// surprises agents writing `*api*`.
export function urlGlobMatches(glob: string, url: string): boolean {
  return globToRegExp(glob).test(url);
}

const compiled = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  let pattern = compiled.get(glob);
  if (!pattern) {
    const source = [...glob]
      .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("");
    pattern = new RegExp(`^${source}$`, "s");
    compiled.set(glob, pattern);
  }
  return pattern;
}

// Session names take shell-style patterns: `*`, `?` and `[abc]`. A name without those characters is
// literal, so `session close work-1` never closes `work-10`.
export function isNamePattern(input: string): boolean {
  return /[*?[]/.test(input);
}

export function nameGlobMatches(pattern: string, name: string): boolean {
  if (!isNamePattern(pattern)) return pattern === name;
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? "";
    const classEnd = char === "[" ? pattern.indexOf("]", index + 2) : -1;
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (classEnd !== -1) {
      const members = pattern.slice(index + 1, classEnd);
      source += members.startsWith("!") ? `[^${escapeClass(members.slice(1))}]` : `[${escapeClass(members)}]`;
      index = classEnd;
    } else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "s").test(name);
}

function escapeClass(members: string): string {
  return members.replace(/[\\\]^]/g, "\\$&");
}

// `--status 404`, `--status 4xx`, `--status 2xx,304`.
export function parseStatusFilter(raw: string): (status: number | undefined) => boolean {
  const parts = raw.split(",").map((part) => part.trim().toLowerCase());
  const checks = parts.map((part) => {
    if (/^[1-5]xx$/.test(part)) {
      const hundred = Number(part[0]) * 100;
      return (status: number) => status >= hundred && status < hundred + 100;
    }
    if (/^[1-5]\d\d$/.test(part)) return (status: number) => status === Number(part);
    throw new CommandError("bad_args", `--status takes codes like 404, 4xx or 2xx,304, got ${raw}`);
  });
  return (status) => status !== undefined && checks.some((check) => check(status));
}
