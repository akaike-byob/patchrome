import { z } from "zod";
import { CommandError } from "./protocol.ts";

// Parses JSON input against a schema. The first problem becomes a bad_args error that names the input and
// the path inside it, such as `extract schema: fields.a has unknown keys selecter`.
export function parseJsonInput<T extends z.ZodType>(schema: T, raw: string, what: string, hint?: string): z.infer<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CommandError("bad_args", `${what} is not JSON: ${err instanceof Error ? err.message : String(err)}`, hint);
  }
  return parseInput(schema, parsed, what, hint);
}

export function parseInput<T extends z.ZodType>(schema: T, value: unknown, what: string, hint?: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new CommandError("bad_args", `${what}: ${describeIssue(result.error.issues[0])}`, hint);
}

function describeIssue(issue: z.core.$ZodIssue | undefined): string {
  if (issue === undefined) return "is invalid";
  const where = issue.path.length === 0 ? "" : `${issue.path.join(".")} `;
  switch (issue.code) {
    case "unrecognized_keys":
      return `${where}has unknown keys ${issue.keys.join(", ")}`;
    default:
      return `${where}${issue.message}`;
  }
}
