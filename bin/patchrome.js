#!/usr/bin/env node
import { existsSync } from "node:fs";

// A checkout runs the TypeScript sources through Node's type stripping. Node refuses to strip types under
// node_modules, so the published package ships only the compiled dist/.
const sourceEntry = new URL("../src/cli.ts", import.meta.url);
const { runCli } = await import(existsSync(sourceEntry) ? sourceEntry.href : new URL("../dist/cli.js", import.meta.url).href);
process.exitCode = await runCli(process.argv.slice(2));
