import { localActionData, parseCli } from "./cli.ts";
import { DaemonConnection } from "./client.ts";
import { CommandError, type DaemonStreamLine, type ErrorBody } from "./protocol.ts";

export type RunResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: ErrorBody };

export interface RunOptions {
  onStream?: (stream: DaemonStreamLine["stream"]) => void;
}

// Runs CLI words the way the `patchrome` command does, over one kept-open connection per profile. `pipe`
// and the library sit on this, so a script's words mean exactly what they mean on the command line.
export class CommandRunner {
  readonly #env: NodeJS.ProcessEnv;
  readonly #sessionFallback: () => string;
  #connections = new Map<string, DaemonConnection>();

  constructor(env: NodeJS.ProcessEnv, sessionFallback: () => string) {
    this.#env = env;
    this.#sessionFallback = sessionFallback;
  }

  // Which queue the words run in: commands of one session in one profile run in order.
  queueKey(argv: string[]): string {
    try {
      const parsed = parseCli(argv, this.#env, this.#sessionFallback);
      if ("kind" in parsed) return "local";
      return `${parsed.profile}\n${parsed.session}`;
    } catch {
      return "local";
    }
  }

  // Streaming commands run outside their session's queue, so the next words need not wait for them.
  isStreaming(argv: string[]): boolean {
    try {
      const parsed = parseCli(argv, this.#env, this.#sessionFallback);
      return (
        !("kind" in parsed) &&
        (parsed.command === "watch" || (parsed.command === "console" && parsed.args.follow === true))
      );
    } catch {
      return false;
    }
  }

  async run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
    try {
      const parsed = parseCli(argv, this.#env, this.#sessionFallback);
      if ("kind" in parsed) {
        switch (parsed.kind) {
          case "completions":
          case "pipe":
            throw new CommandError(
              "bad_args",
              `${parsed.kind} runs only as its own command`,
              `run \`patchrome ${parsed.kind === "pipe" ? "pipe" : "completions zsh"}\` from a shell`,
            );
          case "logs":
          case "audit":
          case "create-profile":
          case "history":
            return { ok: true, data: (await localActionData(parsed)).fields };
        }
      }
      if (parsed.args.passwordFromStdin === true)
        throw new CommandError(
          "bad_args",
          "--password-stdin reads the terminal's stdin, which pipe and the library do not have",
          "use --password-env <VAR> instead",
        );
      const response = await this.#connectionFor(parsed.profile).request({
        ...parsed,
        argv,
        onStream: options.onStream,
      });
      return response.ok ? { ok: true, data: response.data.fields } : { ok: false, error: response.error };
    } catch (err) {
      return { ok: false, error: toCommandError(err).toBody() };
    }
  }

  close(): void {
    for (const connection of this.#connections.values()) connection.close();
    this.#connections.clear();
  }

  #connectionFor(profile: string): DaemonConnection {
    let connection = this.#connections.get(profile);
    if (connection === undefined) {
      connection = new DaemonConnection(profile, this.#env);
      this.#connections.set(profile, connection);
    }
    return connection;
  }
}

export function toCommandError(err: unknown): CommandError {
  return err instanceof CommandError
    ? err
    : new CommandError("bad_args", err instanceof Error ? err.message : String(err));
}
