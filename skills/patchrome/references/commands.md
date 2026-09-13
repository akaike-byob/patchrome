# Command reference

## Contents
- Global flags and output
- Elements: refs and locators
- Tabs and navigation
- Reading the page
- Acting
- Waiting and watching
- Network
- Logins and state
- Scripting
- Debug profile
- Sessions, profiles and the daemon

## Global flags and output

Global flags go before the command: `--json` (one object, `{ok, data}` or `{ok: false, error}`),
`--timeout-ms <n>` (default 30000; `login`, `watch`, `challenge --handoff` and `console --follow`
default to 10 min), `--session <name>`, `--profile <name>` (default `stealth`).

Plain output is a few lines. A value over 2 KB goes to a file in the session folder and stdout carries
the path. `--inline` always prints the value; `--out <file>` always writes that file.

## Elements: refs and locators

`<element>` is one of:

- `@e12` or `@f1e12`, a ref from the latest snapshot (`--ref <ref>` on commands that read one)
- `--role <role> [--name <name>]`, the role and accessible name on a snapshot line
- `--text <text>`, visible text, case-insensitive substring
- `--label <text>`, a form field's label
- `--selector <css>`, which also pierces closed shadow roots

Modifiers: `--exact` matches the whole name or text, `--nth <n>` picks match n from 0 instead of the
first, `--frame <iframe-css>` looks inside that iframe.

## Tabs and navigation

| Command | Does |
|---|---|
| `open [url] [--wait load\|domcontentloaded\|networkidle] [--isolated]` | new background tab, becomes current; `--isolated` on your first tab gives your session its own cookies |
| `goto <url> [--wait ...]` | navigate the current tab |
| `tabs [--all]` | your tabs, `*` marks current; `--all` lists every session's, read-only |
| `switch <tab>`, `close [tab]` | tab ids look like `t3`; only your own tabs |

## Reading the page

| Command | Does |
|---|---|
| `snapshot [--inline \| --out <file>]` | accessibility tree with refs, iframes included; `--inline` only for small pages |
| `text [<element>] [--inline \| --out <file>]` | visible text of the page or one element |
| `screenshot [--full] [<element>] [--out <file>]` | PNG to a file |
| `eval <js> [--main-world] [--inline \| --out <file>]` | JS expression, prints JSON; `--json` puts it under `value` |
| `extract <schema> [<element>] [--inline \| --out <file>]` | CSS selectors to JSON rows: `{"rows": "li.item", "fields": {"name": "h2", "url": {"selector": "a", "attr": "href"}}}` |

`eval` runs in an isolated world: the DOM works, page globals (`window.myApp`) read as undefined.
`--main-world` sees them but runs inside the page's own realm, which a protected site can notice.

## Acting

| Command | Does |
|---|---|
| `click <ref> \| <element>` | click |
| `click --at <x>,<y>` | trusted click at viewport pixels read off a screenshot |
| `fill <ref> \| <element> <text>` | replace a field's value |
| `type <text>` | trusted keystrokes into whatever has focus; click the field first |
| `press <key>` | Playwright key names: `Enter`, `Tab`, `Control+a` |
| `challenge [--handoff]` | CAPTCHA state (`none`, `pending`, `solved`); `--handoff` raises the tab for the user |

## Waiting and watching

| Command | Does |
|---|---|
| `wait <element> \| --url <glob> \| --title <text> [--gone]` | block until the page shows it, or with `--gone` stops showing it; a condition already true returns at once |
| `wait --load load\|domcontentloaded\|networkidle` | block until the tab reaches a load state |
| `watch [--events navigation,load,response,console,error] [--url <glob>] [--count <n>]` | stream your tabs' events, one line each; `console` and `error` need a debug profile |

## Network

| Command | Does |
|---|---|
| `network list [--url <glob>] [--type xhr,fetch] [--status 4xx] [--inline \| --out <file>]` | your requests, newest last, ids like `n17`; last 1000 kept |
| `network get <id> \| --url <glob> [--body] [--inline \| --out <file>]` | headers, post data, and with `--body` the response body; `--url` takes the newest match |
| `network har start\|stop [--out <file>]` | record your requests; `stop` writes a HAR with text bodies |
| `route block <glob>`, `route mock <glob> <file>` | abort, or answer from a file, matching requests on your tabs |
| `route list\|clear` | your rules; the newest matching rule wins |

## Logins and state

| Command | Does |
|---|---|
| `login <url> [--until <url-glob>]` | a visible tab for a person to sign in |
| `cookies [--domain <domain>] [--inline \| --out <file>]` | cookies with values |
| `state save <file>`, `state load <file>` | cookies and localStorage, Playwright storageState format |
| `state import <site> [--from <chrome-profile>]` | one site's login from the user's everyday Chrome |
| `audit [--count <n>]` | recent login copies and who approved them |

## Scripting

| Command | Does |
|---|---|
| `session history [--format sh\|jsonl] [--out <file>]` | your session's working commands, refs rewritten as locators |
| `session history clear` | empty the recording |
| `pipe [--bail]` | JSON requests on stdin, one JSON response per line |

## Debug profile

| Command | Does |
|---|---|
| `console [--level debug\|info\|warning\|error] [--follow]` | your tabs' console, that level and above |
| `errors` | uncaught page errors with stacks |
| `trace start\|stop [--out <file>]` | Playwright trace zip of every tab in the profile; one session at a time |
| `cdp <Domain.method> [params-json]` | raw CDP on your current tab |
| `cdp help [Domain\|Domain.method]` | the CDP domains, commands and params this Chrome implements |
| `devtools-url` | debugging URL for chrome-devtools, Lighthouse or heap snapshots |

## Sessions, profiles and the daemon

| Command | Does |
|---|---|
| `session`, `session close` | your session name, label and tabs; close all your tabs |
| `session label <text>` | what you are doing, shown on your Chrome tab group |
| `sessions [pattern]`, `session close <session\|pattern>` | list sessions; close others by name or glob (`'work-*'`), only when the user asks |
| `profile create <name> --mode stealth\|debug` | a profile's mode is fixed once made |
| `daemon status\|stop\|logs` | `stop` closes Chrome for every session |
| `completions zsh` | zsh completion script, for people |

If the daemon restarts, your tabs come back on your next command under the same ids, reloaded at
their last URL. Typed input and refs are gone: take a fresh snapshot.
