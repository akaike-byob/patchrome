import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import { CommandError } from "./protocol.ts";

// Commands that move logins between a patchrome profile and somewhere else. Loading data in, and exporting a
// whole site's login to carry to another machine, wait for a person; saving what a session visited only leaves
// a record, so an agent that saves often does not raise prompts.
export const copyKinds = ["state-import", "state-load", "state-save", "state-export"] as const;
export type CopyKind = (typeof copyKinds)[number];

// What the person answered, or why nobody could be asked.
export const approvalAnswers = ["approved", "denied", "timed_out", "unavailable"] as const;
export type ApprovalAnswer = (typeof approvalAnswers)[number];

// A desktop with no prompt of its own records the copy and lets it through, rather than refusing every login.
export const copyDecisions = [...approvalAnswers, "not_asked", "unprompted"] as const;
export type CopyDecision = (typeof copyDecisions)[number];

export const approvalTimeoutMs = 60_000;

export interface CopyRequest {
  kind: CopyKind;
  session: string;
  source: string;
  target: string;
  site: string | undefined;
  cookies: number;
  origins: string[];
}

// A desktop either asks a person, or has no prompt a script cannot click and lets copies through on the record.
export type HostPrompts =
  | {
      approval: "prompt";
      askApproval(reason: string, timeoutMs: number): Promise<{ answer: ApprovalAnswer; detail: string | undefined }>;
      notify(title: string, body: string): Promise<void>;
    }
  | {
      approval: "unprompted";
      unpromptedReason: string;
      notify(title: string, body: string): Promise<void>;
    };

// Proxy changes share the log: they decide where a logged-in profile's traffic goes, and nobody approves them.
export const proxyChangeKinds = [
  "proxy-add",
  "proxy-remove",
  "proxy-rule-add",
  "proxy-rule-remove",
  "proxy-clear",
] as const;
export type ProxyChangeKind = (typeof proxyChangeKinds)[number];

const copyAuditEntrySchema = z.object({
  atUtc: z.string(),
  profile: z.string(),
  kind: z.enum(copyKinds),
  session: z.string(),
  source: z.string(),
  target: z.string(),
  site: z.string().optional(),
  cookies: z.number(),
  origins: z.array(z.string()),
  decision: z.enum(copyDecisions),
  detail: z.string().optional(),
});
export type CopyAuditEntry = z.infer<typeof copyAuditEntrySchema>;

const proxyAuditEntrySchema = z.object({
  atUtc: z.string(),
  profile: z.string(),
  kind: z.enum(proxyChangeKinds),
  session: z.string(),
  change: z.string(),
});
export type ProxyAuditEntry = z.infer<typeof proxyAuditEntrySchema>;

const auditEntrySchema = z.union([copyAuditEntrySchema, proxyAuditEntrySchema]);
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export interface CopyGuardOptions {
  prompts: HostPrompts;
  auditLogPath: string;
  profile: string;
  log: (message: string) => void;
  nowMs?: () => number;
}

export class CopyGuard {
  readonly #options: CopyGuardOptions;
  // One prompt at a time, so two agents importing together never stack two Touch ID dialogs.
  #turns: Promise<unknown> = Promise.resolve();

  constructor(options: CopyGuardOptions) {
    this.#options = options;
  }

  async requireApproval(request: CopyRequest): Promise<void> {
    const turn = this.#turns.then(() => this.#decide(request));
    this.#turns = turn.catch(() => {});
    const { decision, detail } = await turn;
    switch (decision) {
      case "approved":
      case "unprompted":
        return;
      case "denied":
      case "timed_out":
      case "unavailable":
        throw new CommandError(
          "copy_denied",
          `${describeCopy(request)} was not approved: ${decision.replace("_", " ")}${detail === undefined ? "" : `, ${detail}`}`,
          "the user must approve this copy at the prompt; tell them, and do not retry or copy the data another way",
        );
      case "not_asked":
        throw new Error(`a ${request.kind} approval cannot end as not_asked`);
    }
  }

  async recordUnasked(request: CopyRequest): Promise<void> {
    await this.#record(request, "not_asked", undefined);
    await this.#notify(request, "not_asked");
  }

  async #decide(request: CopyRequest): Promise<{ decision: CopyDecision; detail: string | undefined }> {
    const { decision, detail } = await this.#answer(request);
    // Fails the command when the record cannot be written: an unrecorded copy is what the log exists to prevent.
    await this.#record(request, decision, detail);
    await this.#notify(request, decision);
    return { decision, detail };
  }

  async #answer(request: CopyRequest): Promise<{ decision: CopyDecision; detail: string | undefined }> {
    const prompts = this.#options.prompts;
    switch (prompts.approval) {
      case "unprompted":
        return { decision: "unprompted", detail: prompts.unpromptedReason };
      case "prompt": {
        const { answer, detail } = await prompts
          .askApproval(approvalReason(request), approvalTimeoutMs)
          .catch((err: unknown) => ({
            answer: "unavailable" as const,
            detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
          }));
        return { decision: answer, detail };
      }
    }
  }

  async #record(request: CopyRequest, decision: CopyDecision, detail: string | undefined): Promise<void> {
    const entry: CopyAuditEntry = {
      atUtc: new Date((this.#options.nowMs ?? Date.now)()).toISOString(),
      profile: this.#options.profile,
      kind: request.kind,
      session: request.session,
      source: request.source,
      target: request.target,
      ...(request.site === undefined ? {} : { site: request.site }),
      cookies: request.cookies,
      origins: request.origins,
      decision,
      ...(detail === undefined ? {} : { detail }),
    };
    await appendAuditEntry(this.#options.auditLogPath, entry);
    this.#options.log(`copy ${decision}: ${describeCopy(request)} for ${request.session}`);
  }

  // A person who just answered the prompt already knows; everything else gets a notification.
  async #notify(request: CopyRequest, decision: CopyDecision): Promise<void> {
    if (!shouldNotify(decision)) return;
    await this.#options.prompts
      .notify(`patchrome copy ${decision.replace("_", " ")}`, `${request.session}: ${describeCopy(request)}`)
      .catch((err: unknown) => this.#options.log(`copy notification failed: ${String(err).split("\n")[0]}`));
  }
}

export async function appendAuditEntry(path: string, entry: AuditEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function shouldNotify(decision: CopyDecision): boolean {
  switch (decision) {
    case "approved":
    case "denied":
      return false;
    case "timed_out":
    case "unavailable":
    case "not_asked":
    case "unprompted":
      return true;
  }
}

export function describeCopy(request: CopyRequest): string {
  const counts = [
    plural(request.cookies, "cookie"),
    ...(request.origins.length === 0 ? [] : [`storage for ${plural(request.origins.length, "origin")}`]),
  ].join(" and ");
  const what = request.site === undefined ? counts : `the ${request.site} login (${counts})`;
  switch (request.kind) {
    case "state-import":
      return `import ${what} from ${request.source} into ${request.target}`;
    case "state-load":
      return `load ${what} from ${request.source} into ${request.target}`;
    case "state-save":
      return `save ${what} from ${request.source} to ${request.target}`;
    case "state-export":
      return `export ${what} from ${request.source} to ${request.target}`;
  }
}

// macOS shows this after "patchrome is trying to", Windows Hello shows it as the dialog's message.
export function approvalReason(request: CopyRequest): string {
  const home = homedir();
  const described = describeCopy(request).replaceAll(`${home}/`, "~/");
  return `${described}. Asked by agent session ${request.session}.`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// A killed or missing helper says why in one line, without echoing the script it was given.
export function helperFailure(helper: string, err: unknown): string {
  const failure = err as NodeJS.ErrnoException & { signal?: string | null; killed?: boolean };
  if (failure.code === "ENOENT") return `${helper} not found`;
  if (failure.killed === true || failure.signal) return `${helper} stopped by ${failure.signal ?? "timeout"}`;
  const stderr = ((err as { stderr?: string | Buffer }).stderr ?? "").toString().trim().split("\n")[0];
  return `${helper} exited with ${String(failure.code)}${stderr ? `: ${stderr}` : ""}`;
}

// Platform helpers print one answer word, optionally followed by a detail.
export function parseApprovalAnswer(stdout: string): { answer: ApprovalAnswer; detail: string | undefined } {
  const text = stdout.trim();
  const [word = "", ...rest] = text.split(/\s+/);
  const answer = approvalAnswers.find((candidate) => candidate === word);
  if (answer === undefined) return { answer: "unavailable", detail: `unreadable prompt answer: ${text.slice(0, 200)}` };
  return { answer, detail: rest.length === 0 ? undefined : rest.join(" ") };
}

export async function readAuditLog(path: string): Promise<{ entries: AuditEntry[]; unreadableLines: number[] }> {
  const raw = await readFile(path, "utf8").catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  });
  const entries: AuditEntry[] = [];
  const unreadableLines: number[] = [];
  raw.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      entries.push(auditEntrySchema.parse(JSON.parse(line)));
    } catch {
      unreadableLines.push(index + 1);
    }
  });
  return { entries, unreadableLines };
}

export function auditLine(entry: AuditEntry): string {
  if ("change" in entry) return `${entry.atUtc} proxy ${entry.session}: ${entry.change}`;
  return `${entry.atUtc} ${entry.decision} ${entry.session}: ${describeCopy({ ...entry, site: entry.site })}${entry.detail === undefined ? "" : ` (${entry.detail})`}`;
}
