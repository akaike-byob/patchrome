import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, expect } from "vitest";

const marksPath = process.env.PROBE_MARKS ?? "marks.log";
beforeEach(() => appendFileSync(marksPath, `${Date.now()} start ${expect.getState().currentTestName}\n`));
afterEach(() => appendFileSync(marksPath, `${Date.now()} end ${expect.getState().currentTestName}\n`));
