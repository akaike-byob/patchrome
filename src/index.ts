import { CommandError, errorCodes, type ErrorCode } from "./protocol.ts";
import { CommandRunner } from "./runner.ts";
import { lookupProcess, resolveSessionName } from "./session-name.ts";

export { CommandError, errorCodes, type ErrorCode };

export interface ConnectOptions {
  // Defaults as on the command line: $PATCHROME_SESSION, the agent's session, the terminal, the parent process.
  session?: string;
  // Defaults to $PATCHROME_PROFILE, then stealth.
  profile?: string;
  // Applies to every command that does not pass --timeout-ms itself.
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export type CommandFields = Record<string, unknown>;

// The patchrome CLI as a Node library. Each call takes the words you would type after `patchrome` and
// returns what `--json` puts under `data`; a failed command throws a CommandError with its code.
//
//   const browser = connect({ session: "prices" });
//   await browser.run("open", "https://shop.example");
//   const { rows } = await browser.run("extract", schema, "--inline");
export class Patchrome {
  readonly #runner: CommandRunner;
  readonly #timeoutMs: number | undefined;

  constructor(options: ConnectOptions = {}) {
    const env = { ...(options.env ?? process.env), ...(options.profile === undefined ? {} : { PATCHROME_PROFILE: options.profile }) };
    let session = options.session;
    this.#runner = new CommandRunner(env, () => {
      session ??= resolveSessionName(env, process.ppid, lookupProcess);
      return session;
    });
    this.#timeoutMs = options.timeoutMs;
  }

  async run(...words: string[]): Promise<CommandFields> {
    return this.stream(words, () => {});
  }

  // For `watch` and `console --follow`: onEvent gets each event's fields, and the promise resolves when the
  // stream stops.
  async stream(words: string[], onEvent: (fields: CommandFields) => void): Promise<CommandFields> {
    const argv = this.#timeoutMs === undefined || words.includes("--timeout-ms") ? words : ["--timeout-ms", String(this.#timeoutMs), ...words];
    const result = await this.#runner.run(argv, { onStream: (stream) => onEvent(stream.fields) });
    if (!result.ok) throw new CommandError(result.error.code, result.error.message, result.error.hint);
    return result.data;
  }

  // Idle connections never keep the process alive, so close is only needed to drop them early.
  close(): void {
    this.#runner.close();
  }
}

export function connect(options: ConnectOptions = {}): Patchrome {
  return new Patchrome(options);
}
