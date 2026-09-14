---
name: patchrome
description: Drives a real, stealth, headed Google Chrome from the shell through the `patchrome` CLI - opens tabs, reads pages as accessibility snapshots with @refs, clicks, fills, extracts text and rows, reads network responses, signs in once and reuses the login, and exports a working flow as a script. Many agent sessions share one Chrome and one logged-in profile, each on its own tabs. Use whenever a task needs a real browser - a page behind a bot wall or login, JS-rendered content that curl cannot see, scraping, clicking through a web app, a repeatable scrape script, or checking what a site shows.
allowed-tools: Bash(patchrome:*)
---

# Browser from the CLI (`patchrome`)

One daemon owns one headed Chrome per profile. Every `patchrome` call is a short client; the first
starts Chrome. Other agent sessions browse the same Chrome at once, and you see only your own tabs.
If `patchrome` is not on PATH: `npm i -g patchrome`.

## The loop

```bash
patchrome session label "compare laptop prices"   # first: the user sees it on your Chrome tab group
patchrome open https://example.com                # new background tab, becomes your current tab
patchrome snapshot                                # accessibility tree to a file; prints its path
# grep the file for the node: - button "Sign in" [ref=f1e6]
patchrome fill @f1e5 "alice@example.com"
patchrome click @f1e6
patchrome wait --url '*/dashboard*'               # click returns before the next page loads
patchrome snapshot                                # refs from before a navigation are stale
```

Copy refs exactly from the latest snapshot, from a line that has `[ref=...]`. A locator works anywhere
a ref does and survives page changes: `--role button --name "Sign in"` (role and name as on the
snapshot line), `--text <text>`, `--label <form label>` or `--selector <css>`, with `--exact`,
`--nth <n>` and `--frame <iframe-css>`.

## Read the reference for the task

| Task | Read |
|---|---|
| Any flag or command not shown here | [references/commands.md](references/commands.md) |
| Scraping: JSON API responses, `extract` rows, globs, HAR, blocking or mocking requests | [references/scraping.md](references/scraping.md) |
| A repeatable script, `session history`, `pipe`, the Node library, sh/Python/Go callers | [references/scripting.md](references/scripting.md) |
| A site needs sign-in: `login`, `state import`, `state save`/`load`, a separate account | [references/logins.md](references/logins.md) |
| iframes, closed shadow roots, canvas, CAPTCHAs, bot-wall interstitials | [references/hard-pages.md](references/hard-pages.md) |
| Debugging your own localhost app: console, page errors, traces, CDP | [references/debugging.md](references/debugging.md) |

## Rules

- Never close, switch to or act on tabs you did not open. `tabs --all` is for looking only.
- Read snapshot and text files with your file tools and grep them; never `cat` a large one whole.
- Wait for a condition (`wait --url`, `wait --text`, `wait --selector`), never `sleep`. Quote globs:
  zsh expands `*` and `?` itself.
- A bot wall's interstitial ("Just a moment") often clears by itself. Only a
  `wait --title "<interstitial title>" --gone` that times out means blocked.
- Never solve a CAPTCHA yourself. When `challenge` reports `pending`, tell the user and run
  `challenge --handoff`.
- Logins are shared by every session in the profile: never log out of a site another agent may use.
- Never run `daemon stop` or `session close <other session>` unless the user asks; both end other
  agents' work.
- Keep request volume low on protected sites: no tight loops of `goto`.
- Session name comes from `--session`, `$PATCHROME_SESSION`, `$CLAUDE_CODE_SESSION_ID`, the tty, then
  the parent process. If `patchrome session` prints a new name on each call, export
  `PATCHROME_SESSION` for the whole task.

## Errors

Exit code 0 ok, 1 command error, 2 bad usage. `--json` errors carry a `code`:

| Code | Do |
|---|---|
| `tab_gone` | current tab closed or none yet: `patchrome open <url>`; never grab another session's tab |
| `ref_stale` | page changed since the snapshot: `patchrome snapshot`, pick the ref again, or use a locator |
| `timeout` | snapshot to see the page state; raise `--timeout-ms` if the site is slow |
| `navigation_failed` | DNS, TLS or connection failure: check the URL, retry once |
| `daemon_unreachable` | `patchrome daemon logs`; the next command restarts the daemon |
| `daemon_outdated` | tell the user; `daemon stop` closes Chrome for every session |
| `bad_args` | wrong usage, a JS error in `eval`, a bad schema or selector: read the message and hint |
| `unsupported_in_stealth` | the command needs `--profile debug`, which is only for your own apps |
| `copy_denied` | the user refused a login copy: tell them, do not retry, never copy cookies another way |
| `no_display` | Linux with no desktop in this shell: rerun as the hint says, e.g. `DISPLAY=:20 patchrome session` |
| `setup_required` | the machine needs a change, such as WSL networking mode: tell the user the message and hint, do not retry |
