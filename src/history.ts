import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { cliOptions } from "./cli-options.ts";
import { CommandError, type CommandName } from "./protocol.ts";

// A session's history is the commands that worked, as a person would type them again. An agent explores a
// site with refs, which die with the page; the daemon rewrites each ref into a locator taken from the
// snapshot the ref came from, so the exported script finds the same element on the next run.

export const historyFormats = ["sh", "jsonl"] as const;
export type HistoryFormat = (typeof historyFormats)[number];

export function isHistoryFormat(value: string): value is HistoryFormat {
  return (historyFormats as readonly string[]).includes(value);
}

export interface HistoryStep {
  atMs: number;
  argv: string[];
  // Things a person should look at before replaying: a guessed position, a tab id from the recording.
  notes: string[];
}

// What a command learned while running that changes how it replays.
export interface ReplayHint {
  // Locator flags that stand in for the ref the command used.
  refLocator?: { flags: string[]; notes: string[] };
  // A glob that stands in for a request id, so the replay finds the same request by URL.
  requestUrlGlob?: string;
  // The text went into a password field and is not written down.
  isSecretText?: boolean;
}

export const secretPlaceholder = "<secret>";

// Lives in the session folder, next to its snapshots.
export const historyFileName = "history.jsonl";

// Commands worth replaying. Reading the page layout (snapshot, tabs) and managing sessions or the daemon
// is exploration, not part of the flow.
export function isReplayable(command: CommandName, args: Record<string, unknown>): boolean {
  switch (command) {
    case "open":
    case "goto":
    case "switch":
    case "close":
    case "click":
    case "fill":
    case "type":
    case "press":
    case "wait":
    case "text":
    case "eval":
    case "extract":
    case "screenshot":
    case "network-list":
    case "network-get":
    case "network-har-start":
    case "network-har-stop":
    case "route-block":
    case "route-mock":
    case "route-clear":
    case "login":
    case "cookies":
    case "state-save":
    case "state-load":
    case "state-import":
      return true;
    case "challenge":
      return args.handoff === true;
    case "tabs":
    case "snapshot":
    case "watch":
    case "route-list":
    case "console":
    case "errors":
    case "trace-start":
    case "trace-stop":
    case "cdp":
    case "cdp-help":
    case "devtools-url":
    case "session":
    case "sessions":
    case "session-close":
    case "session-label":
    case "daemon-status":
    case "daemon-stop":
      return false;
  }
}

// Flags that belong to the caller, not to the step: the session and profile come from the replay's own
// environment, and --json from how the replay reads output.
const callerFlags = new Set(["json", "session", "profile"]);

export function stepArgv(argv: string[]): string[] {
  const { tokens } = parseArgs({ args: argv, allowPositionals: true, strict: false, tokens: true, options: cliOptions });
  const dropped = new Set<number>();
  for (const token of tokens) {
    if (token.kind !== "option" || !callerFlags.has(token.name)) continue;
    dropped.add(token.index);
    if (token.value !== undefined && !token.inlineValue) dropped.add(token.index + 1);
  }
  return argv.filter((_, index) => !dropped.has(index));
}

// Replaces the ref, request id and secret text in a step's words with what replays.
export function replayStep(command: CommandName, argv: string[], hint: ReplayHint | undefined, atMs: number): HistoryStep {
  const words = stepArgv(argv);
  const notes: string[] = [];
  const { tokens } = parseArgs({ args: words, allowPositionals: true, strict: false, tokens: true, options: cliOptions });
  const positionals = tokens.filter((token) => token.kind === "positional");
  const valueOf = (name: string) => tokens.find((token) => token.kind === "option" && token.name === name);
  const replacements = new Map<number, string[]>();

  if (hint?.refLocator !== undefined) {
    const refOption = valueOf("ref");
    const refPositional = positionals.find((token) => /^@?(?:f\d+)?e\d+$/.test(token.value));
    if (refOption !== undefined && refOption.kind === "option" && refOption.value !== undefined) {
      replacements.set(refOption.index, hint.refLocator.flags);
      if (!refOption.inlineValue) replacements.set(refOption.index + 1, []);
    } else if (refPositional !== undefined) {
      replacements.set(refPositional.index, hint.refLocator.flags);
    }
    notes.push(...hint.refLocator.notes);
  }
  if (hint?.requestUrlGlob !== undefined) {
    // `network get <id>`: the id is the positional after `get`.
    const id = positionals.find((token) => /^n\d+$/.test(token.value));
    if (id !== undefined) replacements.set(id.index, ["--url", hint.requestUrlGlob]);
  }
  if (hint?.isSecretText === true) {
    const text = positionals.at(-1);
    if (text !== undefined) replacements.set(text.index, [secretPlaceholder]);
    notes.push(`the text went into a password field and was not recorded: the sh script reads $PATCHROME_SECRET, jsonl carries ${secretPlaceholder} to replace`);
  }
  switch (command) {
    case "switch":
    case "close":
      if (positionals.some((token) => /^t\d+$/.test(token.value))) notes.push("tab ids from the recording can differ on replay");
      break;
    case "login":
      notes.push("waits for a person to sign in");
      break;
    case "challenge":
      notes.push("waits for a person to solve a CAPTCHA");
      break;
    case "state-import":
    case "state-load":
      notes.push("waits for the person to approve a login copy");
      break;
    default:
      break;
  }
  return { atMs, argv: words.flatMap((word, index) => replacements.get(index) ?? [word]), notes };
}

// Glob for a recorded request: its URL without the query, since ids, timestamps and cursors change per run.
// `*` and `?` in the URL itself become `?`, the one-character wildcard, as the glob has no escape.
export function requestUrlGlob(url: string): string {
  let base = url;
  try {
    const parsed = new URL(url);
    base = `${parsed.origin}${parsed.pathname}`;
  } catch {
    // A URL Chrome reported but Node cannot parse is used as is.
  }
  return `${base.replace(/[*?]/g, "?")}*`;
}

const snapshotLinePattern = /^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/;

// Finds the snapshot line that carries the ref and turns its role and name into locator flags. Refs inside
// an iframe have no page-level locator, and nameless or repeated nodes need a position; both get a note.
export function locatorForRef(snapshot: string, ref: string): { flags: string[]; notes: string[] } | undefined {
  const nodes = snapshot.split("\n").flatMap((line) => {
    const refs = [...line.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map((match) => match[1] ?? "");
    const match = line.match(snapshotLinePattern);
    if (refs.length === 0 || !match?.[1]) return [];
    return [{ ref: refs[0] ?? "", frame: frameOfRef(refs[0] ?? ""), role: match[1], name: match[2] === undefined ? undefined : unescapeName(match[2]) }];
  });
  const node = nodes.find((candidate) => candidate.ref === ref);
  if (node === undefined) return undefined;
  const sameFrame = nodes.filter((candidate) => candidate.frame === node.frame);
  const notes: string[] = [];
  const flags = ["--role", node.role];
  // Without a name, getByRole matches every node of the role, named or not.
  const peers = node.name === undefined
    ? sameFrame.filter((candidate) => candidate.role === node.role)
    : sameFrame.filter((candidate) => candidate.role === node.role && candidate.name === node.name);
  if (node.name !== undefined) flags.push("--name", node.name, "--exact");
  if (peers.length > 1) {
    const nth = peers.findIndex((candidate) => candidate.ref === ref);
    flags.push("--nth", String(nth));
    notes.push(`${peers.length} elements matched ${node.role}${node.name === undefined ? "" : ` "${node.name}"`}; --nth ${nth} is its position in the recorded page`);
  } else if (node.name === undefined) {
    notes.push(`${node.role} has no accessible name; the locator matches the only ${node.role} on the recorded page`);
  }
  // The snapshot starts at the main frame's root, so its frame prefix, often f1 and sometimes none, marks the
  // page itself; any other prefix is an iframe.
  if (node.frame !== nodes[0]?.frame) notes.push("the element is inside an iframe; add --frame <iframe-css>");
  return { flags, notes };
}

function frameOfRef(ref: string): string {
  return ref.match(/^(f\d+)e\d+$/)?.[1] ?? "";
}

function unescapeName(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw.replace(/\\(.)/g, "$1");
  }
}

const stepSchema = z.object({ atMs: z.number(), argv: z.array(z.string()), notes: z.array(z.string()) });

export async function appendHistoryStep(path: string, step: HistoryStep): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(step)}\n`, { mode: 0o600 });
}

// A line that does not parse is skipped, so one torn write cannot hide the rest of the flow.
export async function readHistory(path: string): Promise<HistoryStep[]> {
  const text = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw new CommandError("bad_args", `cannot read history ${path}: ${err.message}`);
  });
  return text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      const parsed = stepSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

export async function clearHistory(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function formatHistory(steps: HistoryStep[], format: HistoryFormat, { session, profile }: { session: string; profile: string }): string {
  switch (format) {
    case "jsonl":
      return steps.map((step) => JSON.stringify(step.notes.length === 0 ? { argv: step.argv } : { argv: step.argv, notes: step.notes })).join("\n");
    case "sh": {
      const first = steps[0];
      const last = steps.at(-1);
      const header = [
        "#!/bin/sh",
        first === undefined || last === undefined
          ? `# patchrome session ${session}: no steps recorded`
          : `# patchrome session ${session}: ${steps.length} steps, ${new Date(first.atMs).toISOString()} to ${new Date(last.atMs).toISOString()}`,
        "# Lines starting with `# check:` need a look before this runs unattended.",
        "set -eu",
        `export PATCHROME_SESSION="\${PATCHROME_SESSION:-replay-$$}"`,
        ...(profile === "stealth" ? [] : [`export PATCHROME_PROFILE="\${PATCHROME_PROFILE:-${profile}}"`]),
        "",
      ];
      const body = steps.flatMap((step) => [...step.notes.map((note) => `# check: ${note}`), ["patchrome", ...step.argv].map(shellWord).join(" ")]);
      return [...header, ...body, "patchrome session close"].join("\n");
    }
  }
}

export function shellWord(word: string): string {
  if (word === secretPlaceholder) return `"$PATCHROME_SECRET"`;
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
