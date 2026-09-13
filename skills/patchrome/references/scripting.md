# Scripting a flow

## Contents
- Export what worked
- Output that keeps its shape
- `patchrome pipe`
- The Node library
- Sessions in scripts

## Export what worked

Explore with refs, then export the successful commands as a script. The daemon rewrites each ref as
the role and name from the snapshot it came from.

```bash
patchrome session history clear                     # before exploring
# ... open, snapshot, fill @e5, click @e6, extract ...
patchrome session history --out scrape.sh           # runnable sh
patchrome session history --format jsonl --out scrape.jsonl
sh scrape.sh                                        # or: patchrome pipe --bail < scrape.jsonl
```

History leaves out snapshots, tabs, session commands and failed commands. Read every `# check:` line
before handing the script over:

- a repeated role and name got `--nth` from its position on the recorded page
- a ref inside an iframe needs `--frame <iframe-css>`
- text typed into a password field became `$PATCHROME_SECRET` (sh) or `<secret>` (jsonl)
- tab ids and `login`, `challenge --handoff`, `state import` steps need a person or may differ

Run the export once in a fresh session (`PATCHROME_SESSION=try-1 sh scrape.sh`) before calling it done.

## Output that keeps its shape

Without flags, `text`, `eval`, `extract`, `cookies`, `network list` and `network get --body` print a
value up to 2 KB and a path past that. Scripts pass `--inline` (always the value) or `--out <file>`
(always the file). With `--json`, values keep their JSON type: `eval` answers `{"value": ...}`,
`extract` answers `{"count", "rows": [...]}`. Use `network get --url <glob>`, not request ids.

## `patchrome pipe`

One request per line on stdin: the words after `patchrome` as a JSON array, or
`{"id": ..., "argv": [...]}`. One response per line on stdout: the `--json` object plus `id` (the line
number when none was given).

```bash
printf '%s\n' '["open", "https://news.ycombinator.com"]' \
  '{"id": "top", "argv": ["extract", "{\"rows\": \"tr.athing\", \"fields\": {\"title\": \".titleline > a\"}}", "--inline"]}' \
  | patchrome pipe
# {"id":1,"ok":true,"data":{"tab":"t1","url":"https://news.ycombinator.com/","title":"Hacker News"}}
# {"id":"top","ok":true,"data":{"count":30,"rows":[{"title":"..."}]}}
```

- Requests for one session run in order; `--session` inside `argv` runs other sessions at once.
- `watch` and `console --follow` send `{"id", "stream"}` lines first and do not block later requests.
- `--bail` stops at the first failure. Exit code 0 when every request succeeded, 1 otherwise.
- Kept open as a coprocess, one pipe serves a whole Python or Go program with no process per step.

A Python caller writes `json.dumps({"id": n, "argv": [...]})` to the pipe's stdin and reads lines
until one has that `id` and no `stream` key. The package's `examples/` folder has sh, Python, Node and
Go versions.

## The Node library

```ts
import { CommandError, connect } from "patchrome";

const browser = connect({ session: "prices" });
await browser.run("open", "https://shop.example");
const { rows } = await browser.run("extract", "schema.json", "--inline");
await browser.stream(["watch", "--events", "response", "--count", "3"], (event) => console.log(event));
```

`run` resolves to the `--json` `data` and throws `CommandError` with `code`.

## Sessions in scripts

A script started from your shell shares your session and tabs. Give each run its own:
`PATCHROME_SESSION=scrape-$$` in sh, `connect({ session })` in Node. End with `session close`.
