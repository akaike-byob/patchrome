# Logins and state

Cookies and logins are shared by every session in a profile: sign in once and every agent is signed
in. Never log out of a site another agent may be using.

## Pick the way in

1. The user says they are signed in to the site in their everyday Chrome: `state import <site>`.
2. Otherwise, a person signs in: `login <url> --until <url-glob>`.
3. A saved state file from earlier: `state load <file>`.
4. A different account, or a clean cookie jar: `open --isolated` as your session's first tab.

## `state import`

```bash
patchrome state import github.com --from "Profile 1"
```

`--from` takes the name in Chrome's profile menu, the folder (`Default`, `Profile 1`) or the signed-in
email; without it, the last used profile. Ask which profile when the user has several; a wrong
`--from` lists them. The site covers its subdomains. Google accounts use device-bound sessions and
may refuse an imported login; use `login` for those.

## `login`

A visible tab for a person. Tell the user a Chrome window is waiting, and pass `--until` with a URL
the site reaches after sign-in. Without `--until` it returns when the user closes the tab. It waits
up to 10 minutes.

## `state export`

```bash
patchrome state export github.com github-login.json
```

For a user who wants a login on another machine: it writes the site's cookies, localStorage and IndexedDB to
a file, and on the other machine `state load <file>` puts them in. The user moves the file; do not copy it
anywhere yourself, and delete it once it is loaded. Google logins are refused. Some sites sign the other
machine out anyway; then a person runs `login` there.

## Approvals

`state import`, `state load` and `state export` wait up to a minute for the user to approve with Touch ID (Windows
Hello on WSL). Tell the user a prompt is coming before you run one. `copy_denied` means they refused:
do not retry, and never copy cookies or profile files another way. On desktop Linux there is no such
prompt, so the copy runs unasked and only shows the user a notification: say what you are copying and
why before you run it. `audit` lists past copies.

## `state save` and `state load`

`state save <file>` writes cookies and localStorage for the sites your session visited, in
Playwright's storageState format. The file holds live session tokens: keep it out of git.
`state load <file>` adds to the shared profile without clearing it, so every session sees the cookies.

## Isolated sessions

`open --isolated` on your session's first tab gives it an in-memory cookie jar. Its cookies vanish
when the session closes or the daemon restarts, and its tabs are not grouped in Chrome. `state load`
and `state import` in an isolated session fill only its own jar.
