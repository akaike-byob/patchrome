import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import { CommandError } from "./protocol.ts";

// Commands that move logins between a patchrome profile and somewhere else. Loading data in waits for a
// person; saving it out only leaves a record, so an agent that saves often does not raise prompts.
export const copyKinds = ["state-import", "state-load", "state-save"] as const;
export type CopyKind = (typeof copyKinds)[number];

// What the person answered, or why nobody could be asked.
export const approvalAnswers = ["approved", "denied", "timed_out", "unavailable"] as const;
export type ApprovalAnswer = (typeof approvalAnswers)[number];

export const copyDecisions = [...approvalAnswers, "not_asked"] as const;
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

export interface HostPrompts {
  askApproval(reason: string, timeoutMs: number): Promise<{ answer: ApprovalAnswer; detail: string | undefined }>;
  notify(title: string, body: string): Promise<void>;
}

const auditEntrySchema = z.object({
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
    const { answer: decision, detail } = await this.#options.prompts.askApproval(approvalReason(request), approvalTimeoutMs).catch((err: unknown) => ({
      answer: "unavailable" as const,
      detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
    }));
    // Fails the command when the record cannot be written: an unrecorded copy is what the log exists to prevent.
    await this.#record(request, decision, detail);
    await this.#notify(request, decision);
    return { decision, detail };
  }

  async #record(request: CopyRequest, decision: CopyDecision, detail: string | undefined): Promise<void> {
    const entry: AuditEntry = {
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
    await mkdir(dirname(this.#options.auditLogPath), { recursive: true });
    await appendFile(this.#options.auditLogPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.#options.log(`copy ${decision}: ${describeCopy(request)} for ${request.session}`);
  }

  // A person who just answered the prompt already knows; everything else gets a notification.
  async #notify(request: CopyRequest, decision: CopyDecision): Promise<void> {
    if (!shouldNotify(decision)) return;
    await this.#options.prompts.notify(`patchrome copy ${decision.replace("_", " ")}`, `${request.session}: ${describeCopy(request)}`)
      .catch((err: unknown) => this.#options.log(`copy notification failed: ${String(err).split("\n")[0]}`));
  }
}

export function shouldNotify(decision: CopyDecision): boolean {
  switch (decision) {
    case "approved":
    case "denied":
      return false;
    case "timed_out":
    case "unavailable":
    case "not_asked":
      return true;
  }
}

export function describeCopy(request: CopyRequest): string {
  const counts = [plural(request.cookies, "cookie"), ...(request.origins.length === 0 ? [] : [`storage for ${plural(request.origins.length, "origin")}`])].join(" and ");
  const what = request.site === undefined ? counts : `the ${request.site} login (${counts})`;
  switch (request.kind) {
    case "state-import":
      return `import ${what} from ${request.source} into ${request.target}`;
    case "state-load":
      return `load ${what} from ${request.source} into ${request.target}`;
    case "state-save":
      return `save ${what} from ${request.source} to ${request.target}`;
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
  const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim().split("\n")[0];
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
  return `${entry.atUtc} ${entry.decision} ${entry.session}: ${describeCopy({ ...entry, site: entry.site })}${entry.detail === undefined ? "" : ` (${entry.detail})`}`;
}
