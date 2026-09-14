# patchrome

[![npm](https://img.shields.io/npm/v/patchrome)](https://www.npmjs.com/package/patchrome)
[![CI](https://github.com/akaike-byob/patchrome/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/akaike-byob/patchrome/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/patchrome)](LICENSE)

One stealth Chrome, shared by all your coding agents. Each agent session gets its own tabs.

patchrome is a command-line browser for Claude Code, Codex, pi and humans in a terminal. A small
daemon keeps one headed Google Chrome running through [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs),
the undetected fork of Playwright. Every `patchrome` call is a short-lived client, so five agents
can browse at once in the same logged-in profile without touching each other's tabs.

```bash
patchrome open https://news.ycombinator.com
patchrome snapshot            # accessibility tree with @refs, written to a file
patchrome click @f1e42
patchrome text
```

- **One browser, many sessions.** Chrome's profile lock allows one automation client per profile.
  patchrome puts a daemon in front of it, and every session owns only the tabs it opened.
- **Stealth by default.** Real Google Chrome, headed, with Patchright's patches: no `Runtime.enable`,
  no `navigator.webdriver`, no open debugging port.
- **Small context.** A CLI plus a 5 KB `SKILL.md`, loaded only in sessions that browse, with details
  in reference files the agent reads when a task needs them. Snapshots go to files, and stdout carries
  the path.
- **Scriptable.** Explore a site with an agent, then `session history` exports what worked as a sh
  script with refs rewritten as role and name locators. `patchrome pipe` runs JSON requests from any
  language over one connection, and `import { connect } from "patchrome"` does the same in Node.
- **Stays out of your way.** Tabs open in the background, and agents work in them while you use your desktop.
  When the daemon first starts Chrome, macOS brings it forward for under a second, and patchrome hands
  focus back to the app you were in. Linux leaves window activation to the desktop environment.

> [!NOTE]
> Early software. The core loop, network capture, scraping, the debug profile and scripting work
> (milestones M1 to M5 below). macOS and desktop Linux are supported.

## Why

Browser tools for agents usually get one of two things right:

- **The session model.** [agent-browser](https://github.com/vercel-labs/agent-browser) has tabs per
  session and a `tab_gone` error, but it drives stock Chrome over plain CDP. Bot walls notice that.
- **Stealth.** Patchright, CloakBrowser and Camoufox pass the detectors. But they are libraries: each
  script launches its own browser and locks its own profile.

With several agents in parallel, you end up logging in once per agent or taking turns. patchrome
takes agent-browser's session model and runs it on Patchright.

| | patchrome | agent-browser | playwright-cli | chrome-devtools-mcp | Patchright |
|---|---|---|---|---|---|
| Many agents in one browser, tabs owned per session | yes, always on | yes, with `--pin-tab` | separate browsers per session | shared, pass `pageId` | no, a library |
| Stealth against bot detection | Patchright on real Chrome | stock CDP | stock Playwright | stock CDP | yes |
| Snapshot with refs | yes | yes | yes | yes, uids | no |
| Network log, HAR, request mocking | yes, per session | yes | yes | log only | via API |
| Console, perf traces | debug profile only | yes | yes | yes, the best | console disabled |
| Interface | CLI + skill | CLI + skill | CLI + skill | MCP, CLI | Node/Python API |

patchrome is built for real sites: logged-in apps, scraping, pages behind Cloudflare or DataDome,
and several agents at once. For your own localhost app, a debug profile adds console capture, page
errors, traces and raw CDP, and it lets chrome-devtools-mcp attach for Lighthouse and performance work.

## Requirements

- macOS or desktop Linux. Windows and WSL are not supported yet.
- Node.js 24.2 or newer. A checkout runs the TypeScript sources through Node's type stripping. Node
  refuses to strip types under `node_modules`, so the package ships JavaScript compiled into `dist/`.
- Google Chrome installed in the usual place
- On Linux, a desktop session for the headed Chrome. A shell opened over SSH or from a tty has no
  `DISPLAY`: patchrome uses the machine's only X or Wayland display when there is one, and otherwise
  fails with `no_display` listing the displays it found, so you can run `DISPLAY=:20 patchrome session`

## Install

```bash
npm i -g patchrome        # the `patchrome` command, on PATH everywhere
npx patchrome session     # or without installing
npm i patchrome           # in a Node project, for `import { connect } from "patchrome"`
patchrome session         # starts the daemon and Chrome, prints your session name
```

Every install of the same version shares one daemon per profile, so a global CLI, a project's library
and `npx` can browse at once.

From a checkout:

```bash
cd patchrome
npm install
npm link                 # runs the TypeScript sources; edits take effect on the next daemon start
npm run build            # dist/, which `import "patchrome"` and the packed tarball use
```

A checkout's CLI runs `src/` and its library runs `dist/`, so they report different builds and cannot
share a daemon: stop one's daemon before using the other.

### Give it to your agents

The skill installs with the [`skills`](https://github.com/vercel-labs/skills) CLI, which supports
Claude Code, Codex, Cursor, Gemini CLI, OpenCode and dozens more:

```bash
npx skills@latest add akaike-byob/patchrome            # this project's agents
npx skills@latest add akaike-byob/patchrome -g         # every project, for your user
npx skills@latest add akaike-byob/patchrome -g -a claude-code -a codex
```

[`skills/patchrome/SKILL.md`](skills/patchrome/SKILL.md), 5 KB, teaches the snapshot, ref, act, wait
loop, locators, the error codes, and the rules: never touch another session's tabs, read big snapshots
from their files, and hand CAPTCHAs to a person. A table in it sends the agent to one file in
[`references/`](skills/patchrome/references) per kind of task: the full command list, scraping,
scripting, logins, iframes and CAPTCHAs, and debugging a local app. Those files cost nothing until
read. A unit test keeps SKILL.md under 6 KB, every reference linked from it and none linking onward. Its `allowed-tools` grants `Bash(patchrome:*)`, so
agents that honour it run browser commands without a permission prompt.

## How it works

```
claude session  --+
codex session   --+-- patchrome CLI -- unix socket -- daemon -- Patchright -- Chrome
you, a terminal --+   (one per command)   (JSON lines)   (one per profile)     (headed)
```

- **Daemon.** The first command starts the daemon. `mkdir` is atomic, so three agents starting at once
  still get one daemon. It exits after 30 minutes without requests, or when you close Chrome.
- **Socket.** A unix socket with mode `0600` under `~/.cache/patchrome/<profile>/`. No TCP port is
  opened: page scripts can probe localhost ports, and a debugging port would give them control of
  every logged-in account.
- **Sessions.** A session is a name, resolved in order: `--session`, `$PATCHROME_SESSION`,
  `$CLAUDE_CODE_SESSION_ID`, the terminal's tty, then the first non-shell parent process. Claude Code
  sessions need no setup.
- **Tab ownership.** Commands from one session run in order. Different sessions run in parallel.
  Popups join the session whose click opened them. If your current tab closes, the next command fails
  with `tab_gone` instead of acting on someone else's tab.
- **Shared profile.** Cookies and logins are shared: log in once, and every agent is logged in. A
  session started with `open --isolated` gets its own in-memory cookie jar instead, gone when the
  session closes or the daemon restarts.
- **Restarts.** Chrome closes with the daemon. The daemon saves each session's tabs to
  `sessions.json`, and after a restart it reopens a session's tabs, same ids and URLs, on that
  session's next command. Form input, scroll position and snapshot refs do not survive. Session
  folders untouched for 7 days are deleted when the daemon starts.
- **Tab groups.** Each session's tabs sit in a Chrome tab group titled with the session name, so you
  can see which agent owns which tabs. `session label "checkout flow"` makes the title
  `agent-1: checkout flow`. The colour comes from the name. The daemon loads a small bundled extension
  over its launch pipe (`--enable-unsafe-extension-debugging`, no port) to do this; it injects nothing
  into pages and shows in `chrome://extensions`. Isolated sessions stay ungrouped, because Chrome keeps
  their browser context out of reach of extensions.

## Commands

Global flags come before the command: `--json`, `--timeout-ms <n>` (default 30000),
`--session <name>`, `--profile <name>` (default `stealth`).

| Command | Does |
|---|---|
| `open [url] [--wait load\|domcontentloaded\|networkidle] [--isolated]` | new background tab, becomes your current tab; `--isolated` on a session's first tab gives it its own cookies |
| `goto <url> [--wait ...]` | navigate the current tab |
| `tabs [--all]` | your tabs; `--all` lists every session's, read-only |
| `switch <tab>`, `close [tab]` | among your own tabs |
| `snapshot [--inline\|--out <file>]` | accessibility tree with `@refs`, iframes included, to a file |
| `click <ref>\|<element>`, `fill <ref>\|<element> <text>`, `press <key>` | act on the page; `<element>` is a locator, see [Scripting](#scripting) |
| `click --selector <css> [--frame <iframe-css>]` | act on elements a snapshot cannot show: CSS pierces closed shadow roots |
| `click --at <x>,<y>` | trusted click at viewport pixels, reaching any iframe under the point |
| `type <text>` | trusted keystrokes with human gaps into the focused element |
| `challenge [--handoff]` | detect Turnstile, reCAPTCHA, hCaptcha, MTCaptcha, DataDome or Cloudflare's full-page check; `--handoff` raises the tab for you to solve it |
| `text [<element>] [--inline\|--out <file>]` | visible text; over 2 KB goes to a file |
| `screenshot [--full] [<element>] [--out <file>]` | PNG to a file |
| `eval <js> [--main-world] [--inline\|--out <file>]` | run JS, print JSON |
| `extract <schema> [<element>] [--inline\|--out <file>]` | CSS selectors to JSON rows; schema is a file or inline JSON |
| `wait <element> \| --url <glob> \| --title <text> [--gone]` | block until the page shows the condition, or stops showing it with `--gone` |
| `wait --load load\|domcontentloaded\|networkidle` | block until the current tab reaches a load state |
| `watch [--events navigation,load,response,console,error] [--url <glob>] [--count <n>]` | stream your tabs' events, one line each; `console` and `error` need a debug profile |
| `network list [--url <glob>] [--type xhr,fetch] [--status 4xx]` | your session's requests, last 1000 |
| `network get <id>\|--url <glob> [--body]` | headers, timing, and the response body; `--url` takes the newest match |
| `network har start\|stop [--out <file>]` | HAR of your session's requests, with text bodies |
| `route block <glob>`, `route mock <glob> <file>`, `route list\|clear` | abort or fake requests on your tabs |
| `login <url> [--until <url-glob>]` | a visible tab for you to sign in; waits up to 10 minutes |
| `cookies [--domain <domain>]` | cookies in the profile, or in an isolated session's own jar |
| `state save <file>`, `state load <file>` | cookies and localStorage, in Playwright's storageState format |
| `state import <site> [--from <chrome-profile>]` | one site's login from your everyday Chrome: cookies, localStorage, IndexedDB |
| `state export <site> <file>` | one site's login from this profile to a file, to load on another machine |
| `console [--level <level>] [--follow]` | debug profile: your tabs' console messages; `--follow` streams them |
| `errors` | debug profile: uncaught page errors with stacks |
| `trace start\|stop` | debug profile: Playwright trace zip, one session at a time |
| `cdp <Domain.method> [params-json]` | debug profile: raw CDP on your current tab |
| `cdp help [Domain\|Domain.method]` | debug profile: CDP reference read from the running Chrome's `/json/protocol` |
| `devtools-url` | debug profile: the `127.0.0.1` endpoint for chrome-devtools-mcp |
| `profile create <name> --mode stealth\|debug` | fix a profile's mode before first use |
| `audit [--count <n>]` | recent login copies into and out of profiles, with who approved them |
| `session`, `session close` | your session, its label, tab group and tabs; close them all |
| `session label <text>` | say what the session is doing; shown in its Chrome tab group title |
| `session history [--format sh\|jsonl] [--out <file>]` | the session's working commands as a replayable script; `session history clear` empties it |
| `pipe [--bail]` | JSON requests on stdin, one JSON response per line on stdout |
| `sessions [pattern]` | every session in the daemon, with tab counts and labels |
| `session close <session\|pattern>` | close other sessions by name or glob; a plain name never matches as a glob |
| `daemon status\|stop\|logs` | |
| `completions zsh` | zsh completion for commands, session names and tab ids |

### Output

Plain text by default, a few lines an agent can read cheaply. Pass `--json` for one object:

```json
{"ok":true,"data":{"path":"/Users/you/.cache/patchrome/stealth/sessions/readme-example/snapshot-t3-1.yml","url":"https://en.wikipedia.org/wiki/Web_browser","title":"Web browser - Wikipedia","refCount":993}}
```

Snapshots of real pages are large. Measured during the M1 run on 13 September 2026: 18 to 278 KB
for Wikipedia articles, and 49 KB for a Hacker News thread. That is why they go to disk, and why the
agent greps them for what it needs.

### Errors

Exit code 0 on success, 1 on a command error, 2 on bad usage. `--json` errors carry a `code` from a
closed set:

| Code | Meaning | Recovery |
|---|---|---|
| `tab_gone` | your current tab closed, or you have none | `patchrome open <url>` |
| `ref_stale` | the page navigated since your last snapshot | `patchrome snapshot` |
| `timeout` | the element or page did not arrive in time | snapshot, or raise `--timeout-ms` |
| `navigation_failed` | DNS, TLS or connection failure | check the URL |
| `daemon_unreachable` | the daemon is down or did not start | `patchrome daemon logs` |
| `daemon_outdated` | the daemon was started by another patchrome build | `patchrome daemon stop` when no agent is browsing |
| `bad_args` | wrong usage, or a JS error in `eval` | read the message |
| `unsupported_in_stealth` | the command needs a debug profile | rerun with `--profile debug` |
| `copy_denied` | the person did not approve a login copy | approve the prompt, or run the command yourself |
| `no_display` | Linux, and the shell has no X or Wayland display | `DISPLAY=:20 patchrome session`, with a display from the hint |

A stale ref fails at once. Plain Playwright would wait out the full timeout on it.

### Waiting for a page

A bot wall's interstitial can clear by itself within seconds, so one early read reports a block that
is not there. `wait` returns as soon as the condition holds. Selector, text and URL waits use Patchright's own
waits, which query from an isolated world; a title wait polls `document.title` from outside the page:

```bash
patchrome open https://www.reddit.com/r/programming/
patchrome wait --title "Prove your humanity" --gone --timeout-ms 20000
patchrome snapshot
```

`watch` streams events instead, for an agent that runs it in the background and reads the output:

```bash
patchrome watch --events response --url '*/api/*' --count 1   # returns after the first API response
```

### Scripting

Once an agent has worked out a flow, the same commands run unattended from sh, Python, Go, Node or
anything else that starts a process. [`examples/`](examples) scrapes Hacker News in each.

**Locators.** Refs die when the page changes. Every command that takes an element also takes a
locator, which finds the element again on the next run:

```bash
patchrome click --role button --name "Sign in" --exact   # role and name, as on the snapshot line
patchrome fill --label Email ada@example.com             # form label
patchrome wait --text "Order placed"                     # visible text, case-insensitive
patchrome text --selector "#total" --inline              # CSS
```

A locator takes its first match. `--nth <n>` picks another, and `--frame <iframe-css>` looks inside an
iframe.

**One output shape.** Without flags, `text`, `eval`, `extract`, `cookies`, `network list` and
`network get --body` print a value up to 2 KB and a file path past that. A script passes `--inline` to
always get the value, or `--out <file>` to always get the file. With `--json`, values keep their JSON
type: `eval` answers `{"ok":true,"data":{"value":{"n":2}}}`, and `extract` answers `rows` as an array.
`network get --url '*/api/items*'` takes the newest matching request, so scripts need no request ids.

**Recording.** The daemon keeps each session's successful commands. Snapshots, tabs and session
commands are left out. When a command used a ref, the daemon looks up the ref's line in the snapshot
it came from and records the role and name instead:

```bash
patchrome session history clear
patchrome open https://shop.example/login
patchrome snapshot                         # - textbox "Email" [ref=e5], - button "Sign in" [ref=e9]
patchrome fill @e5 ada@example.com
patchrome click @e9
patchrome session history
```

```sh
#!/bin/sh
# patchrome session tty-s003: 3 steps, 2026-09-13T14:50:02.114Z to 2026-09-13T14:50:09.870Z
# Lines starting with `# check:` need a look before this runs unattended.
set -eu
export PATCHROME_SESSION="${PATCHROME_SESSION:-replay-$$}"

patchrome open https://shop.example/login
patchrome fill --role textbox --name Email --exact ada@example.com
patchrome click --role button --name 'Sign in' --exact
patchrome session close
```

`# check:` lines flag what a person should read first. When several elements share the role and
name, the step gets `--nth` from its position on the recorded page. A ref inside an iframe needs
`--frame`. Text typed into a password field is not recorded, and the script reads
`$PATCHROME_SECRET` in its place. Tab ids may differ on replay. `--format jsonl` writes the same
steps as `pipe` requests.

**`patchrome pipe`.** Reads one request per line and writes one JSON response per line. A request
is the words after `patchrome`, as a JSON array or as `{"id": ..., "argv": [...]}`. A response is the
`--json` object plus the id, which is the line number when the request gave none:

```bash
printf '%s
' '["open", "https://news.ycombinator.com"]' \
  '{"id": "top", "argv": ["extract", "{\"rows\": \"tr.athing\", \"fields\": {\"title\": \".titleline > a\"}}", "--inline"]}' \
  | patchrome pipe
# {"id":1,"ok":true,"data":{"tab":"t1","url":"https://news.ycombinator.com/","title":"Hacker News"}}
# {"id":"top","ok":true,"data":{"count":30,"rows":[{"title":"..."}]}}
```

Requests for one session run in order, and requests for different sessions (`--session` inside
`argv`) run at once. `watch` and `console --follow` send `{"id", "stream"}` lines before their
response, and they do not hold up the requests behind them. `--bail` stops at the first failure and
runs no later lines. The exit code is 0 when every request succeeded, 1 otherwise. Kept open as a
coprocess, one pipe answers a program's commands with no process start per step. 50 `eval`s through
one pipe took 0.23 s in total on an M-series Mac, against 0.06 s per CLI call from an installed package
and 0.10 s from a checkout.

**Node library.** The same requests, without a child process:

```ts
import { CommandError, connect } from "patchrome";

const browser = connect({ session: "prices" });
await browser.run("open", "https://shop.example");
const { rows } = await browser.run("extract", "schema.json", "--inline");
await browser.stream(["watch", "--events", "response", "--count", "3"], (event) => console.log(event));
```

`run` resolves to what `--json` puts under `data` and throws a `CommandError` with the `code`. An idle
connection does not keep the process alive.

**Sessions in scripts.** A script resolves its session the same way the CLI does. Started by Claude
Code, it shares the agent's session and tabs. Two scripts started from the same terminal share the
terminal's session. Set `PATCHROME_SESSION`, or `connect({ session })`, per script run.

### Tab completion

```bash
source <(patchrome completions zsh)   # in ~/.zshrc, after compinit
```

Session names and tab ids come from the running daemon. With no daemon running, completion offers
commands only and never starts Chrome.

### Scraping

Most shops and apps render from a JSON API. Reading the response the page already fetched is cheaper
and sturdier than parsing its HTML:

```bash
patchrome open https://shop.example/product/42
patchrome network list --type xhr,fetch
# requests: 2
# n17 t2 200 fetch GET https://shop.example/api/product/42 88ms
# n18 t2 404 fetch GET https://shop.example/api/reviews 31ms
patchrome network get n17 --body
```

For data that only exists in HTML:

```bash
patchrome extract '{"rows": "li.product", "fields": {"name": "h2", "url": {"selector": "a", "attr": "href"}}}'
```

`state load` adds cookies to the shared profile without clearing it. Playwright's
`setStorageState` would clear every cookie first, which would sign every agent out of every site. For
localStorage, a background tab loads the origin from a local route that never contacts the site.

### Reusing a login from your everyday Chrome

```bash
patchrome state import github.com --from "Profile 1"
```

`--from` takes the name in Chrome's profile menu, the folder name (`Default`, `Profile 1`), or the
signed-in email; without it, Chrome's last used profile. A wrong name lists the profiles. The site
covers its subdomains.

The import copies the profile's cookie jar, its localStorage, and the site's IndexedDB into a
temporary folder, opens the copy in a headless Chrome whose network is routed to empty pages, and
reads the site's cookies and storage. The copy is deleted afterwards, and your everyday Chrome can keep
running. Cookies are encrypted with Chrome's OS credential-store key, so the reader Chrome runs
without Playwright's mock credential store. Cookies go in next to the ones already there. localStorage items
are added, and each imported IndexedDB database replaces the one with the same name.

### Moving a login to another machine

```bash
patchrome state export github.com github-login.json
scp github-login.json build-box:
ssh build-box patchrome state load github-login.json
```

`state export` writes one site's cookies, localStorage and IndexedDB from the profile, or from an isolated
session's own jar, to a file. Moving the file is up to you. It holds live session tokens, so patchrome writes it
with mode 0600; delete it once loaded. The site covers its subdomains. It reads storage from every origin
Chrome keeps on disk for the site, every origin a session in the same cookie jar visited, and every cookie host.

The file is Playwright's storageState with its `indexedDB` field, so `newContext({ storageState })` loads it,
and `state load` takes a file Playwright wrote with `storageState({ indexedDB: true })`. Google logins are
refused: Google binds them to the device. Sites that tie a session to an IP address or a browser fingerprint may
sign the other machine out.

### Approving login copies

`state import`, `state load` and `state export` move whole logins, so they wait for a person. The daemon shows
one prompt at a time and refuses the copy with `copy_denied` when the person cancels or a minute passes.

- **macOS:** Touch ID, or the account password on a Mac without it, through LocalAuthentication.
- **WSL:** Windows Hello, through `powershell.exe`. Without Hello set up, copies are refused.
- **Linux:** no prompt a script cannot click exists, so copies go through on the audit record and a
  `notify-send` notification alone, logged as `unprompted`. Without `notify-send` (the `libnotify-bin`
  package on Debian and Ubuntu), the notification only reaches the daemon log.
- **Other platforms:** copies are refused.

`state save` does not ask. Every copy, approved or not, is appended to
`~/.cache/patchrome/copy-audit.jsonl`, and `patchrome audit` lists the recent ones. A notification
appears for every copy the person did not answer themselves: saves, timeouts and prompts that could
not be shown. No setting skips the prompt.

These are guard rails for agents that follow the skill, not a security boundary. An agent running as
your user can copy Chrome's cookie files and open them itself, and none of this would see it.

Limits:

- Google accounts sign in with device-bound sessions, so an imported Google login may be refused.
  Use `login` in patchrome for those.
- Session cookies exist only in Chrome's memory, so they do not come across.
- IndexedDB values that are Blobs, Maps or Sets are not copied; Dates and binary arrays are.
- `PATCHROME_CHROME_USER_DATA_DIR` points at another Chrome, such as Chrome Beta.

### Debug profile

A profile's mode is fixed when it is created. `--profile debug` is a debug profile unless you create
it otherwise; every other name defaults to stealth. The two profiles run separate daemons and separate
Chromes side by side.

```bash
patchrome --profile debug open http://localhost:3000
patchrome --profile debug console --level warning
patchrome --profile debug errors
patchrome --profile debug devtools-url
# http://127.0.0.1:62819
npx chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:62819
```

A debug Chrome enables `Runtime` on every tab and listens on a random `127.0.0.1` port. Any site can
detect both, and any local process can take over the browser through the port. Keep it to your own
apps, and keep your logins in the stealth profile. A stealth profile refuses debug commands with
`unsupported_in_stealth` and never turns instrumentation on.

`console --follow` streams outside your session's command queue, so the same session can keep
clicking while it runs. A trace records the whole browser context, every session's tabs included, so
only one session traces at a time.

## Stealth

The launch follows Patchright's recommended setup: persistent context, `channel: "chrome"`, headed,
`viewport: null`, and no custom user agent or headers. It also sets `chromiumSandbox: true`, since
Playwright otherwise passes `--no-sandbox`.

Tested 13 September 2026, macOS, Chrome 152, patchright 1.63.0. "Busy" means 3 more tabs were open,
with network listeners reading every response body.

| Detector | Result, quiet and busy | Plain Chrome, same Mac |
|---|---|---|
| [bot.sannysoft.com](https://bot.sannysoft.com) | every row passed | not run |
| [BrowserScan bot detection](https://www.browserscan.net/bot-detection) | Normal on all checks, including WebDriver and CDP | not run |
| [CreepJS](https://abrahamjuliot.github.io/creepjs/) | 0% headless, 0% stealth, 31% like headless | 0%, 0%, 25% |

Two caveats:

- CreepJS rates the automated browser 6 points more "like headless" than plain Chrome on the same
  machine. Its red WebGL, Screen and Audio marks appear in plain Chrome too, with identical hashes.
- Cloudflare Turnstile and DataDome have not been tested against a live challenge yet.

Chrome shows a warning bar for `--disable-blink-features=AutomationControlled`. Page scripts cannot
see it. Removing the flag makes `navigator.webdriver` true, and BrowserScan then reports a robot. So
the flag stays.

`eval` runs in an isolated world by default, where page globals are invisible. `--main-world` sees
them, but runs inside the page's own JavaScript realm.

## Responsible use

patchrome drives your own browser, in your profile, on your machine. Stealth exists so that your
agents can use sites you already use, without tripping bot walls meant for bulk abuse. Do not use it
for unauthorized access, credential stuffing, mass account creation, or scraping against a site's
terms. You are responsible for what your agents do with it.

## Roadmap

- **M1, core loop** (done): daemon, sessions and tab ownership, `open`, `goto`, `snapshot`, `click`,
  `fill`, `press`, `screenshot`, `text`, `eval`, skill.
- **M2, network and scraping** (done): request log, response bodies, session-scoped HAR, `route`
  block/mock, `extract`, `login`, `cookies`, `state save/load`.
- **M3, debug profile** (done): profile modes, `console`, `errors`, `trace`, `cdp`, `devtools-url`,
  and `unsupported_in_stealth` in stealth profiles.
- **M4, hardening** (done): tabs reopen after a daemon restart, `--isolated` sessions with their own
  cookies, session folder pruning, an installable npm package.
- **M5, scripting** (done): locators, `--inline` and `--out`, `network get --url`, `pipe`, session
  history with refs rewritten as locators, the Node library, and examples in sh, Python, Node and Go.
- **Later:** WSL.

## Development

```bash
npm install
npm run format:check    # oxfmt; markdown is left as written
npm run lint            # oxlint, type-aware
npm run typecheck
npm test                  # unit tests plus integration tests against a local fixture server
```

The integration tests start a real headed Chrome. Linux CI runs it under Xvfb. They cover:

- 3 CLI processes starting the daemon at once
- concurrent sessions, popups, `tab_gone` and `ref_stale`
- timeouts, idle exit, and file output
- tabs reopening after `kill -9` of the daemon, isolated cookie jars, and a global install of the
  packed tarball
- Chrome tab groups per session, labels, popups joining their opener's group, and groups after a restart
- locators, output flags, `pipe` with ids and `--bail`, the Node library, and a flow recorded with refs
  replaying from its jsonl and sh exports

`spikes/` holds the throwaway scripts that settled the design: snapshot refs under Patchright, the
stealth baseline, isolated contexts, response bodies at 2,000 requests, and focus theft on macOS.

## License

[MIT](LICENSE)
