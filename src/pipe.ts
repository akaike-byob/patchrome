import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { CommandError } from "./protocol.ts";
import type { CommandRunner } from "./runner.ts";
import { parseJsonInput } from "./validate.ts";

// `patchrome pipe` reads one request per line and writes one JSON response per line, for any language that
// can start a process. A request is the command's words as a JSON array, or {"id", "argv"} to pick the id
// the response carries; without an id it is the line number. Words of one session run in order, different
// sessions at once, and streamed events arrive as {"id", "stream"} lines before their response.

const requestSchema = z.union([
  z.array(z.string()).min(1),
  z.strictObject({
    id: z.union([z.string(), z.number()]).optional(),
    argv: z.array(z.string()).min(1),
    // `session history --format jsonl` writes notes next to a step; they are for people and do not run.
    notes: z.array(z.string()).optional(),
  }),
]);

const requestHint = `send ["open", "https://example.com"] or {"id": 1, "argv": ["text", "--inline"]}`;

export interface PipeOptions {
  input: Readable;
  output: Writable;
  runner: CommandRunner;
  // Stop at the first failed request: no later line runs, and the exit code is 1.
  isBail: boolean;
}

export async function runPipe({ input, output, runner, isBail }: PipeOptions): Promise<number> {
  const queues = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<void>>();
  let hasFailed = false;
  let lineNumber = 0;
  const write = (message: object) => output.write(`${JSON.stringify(message)}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    lineNumber++;
    if (isBail && hasFailed) break;
    if (line.trim() === "") continue;
    let id: string | number = lineNumber;
    let argv: string[];
    try {
      const request = parseJsonInput(requestSchema, line, `line ${lineNumber}`, requestHint);
      if (Array.isArray(request)) {
        argv = request;
      } else {
        argv = request.argv;
        id = request.id ?? lineNumber;
      }
    } catch (err) {
      hasFailed = true;
      write({ id, ok: false, error: (err instanceof CommandError ? err : new CommandError("bad_args", String(err))).toBody() });
      continue;
    }

    const key = runner.queueKey(argv);
    const isStreaming = runner.isStreaming(argv);
    const previous = queues.get(key) ?? Promise.resolve();
    const running = previous.then(async () => {
      if (isBail && hasFailed) return;
      const result = await runner.run(argv, { onStream: (stream) => write({ id, stream: stream.fields }) });
      if (!result.ok) hasFailed = true;
      write({ id, ...result });
    });
    // A stream holds its place only until it starts, so a `watch` does not block the session behind it.
    const settled = isStreaming ? previous : running;
    queues.set(key, settled);
    inFlight.add(running);
    void running.finally(() => inFlight.delete(running));
  }

  await Promise.all(inFlight);
  runner.close();
  return hasFailed ? 1 : 0;
}
