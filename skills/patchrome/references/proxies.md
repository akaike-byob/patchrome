# Proxies

A profile can send chosen sites through HTTPS proxies. Rules belong to the profile, not your session:
every agent browsing that profile goes through them, and a change applies to their next request.
Only add, change or remove a proxy or rule when the user asks for it.

## Set up a proxy

```bash
printf %s "$DE_PROXY_PASS" | patchrome proxy add de https://gw.example.net:8000 --username alice --password-stdin
patchrome proxy add corp https://proxy.corp:3128 --username svc --password-env CORP_PROXY_PASS
patchrome proxy add open https://10.0.0.5:8443          # a proxy with no password
```

- Only `https://` proxies. `http://` and `socks5://` are refused: they send the password and every
  site name unencrypted. If the user only has an `http://` endpoint, tell them; do not look for a way round.
- The password never goes in the command's words, where `ps` and shell history keep it. Use
  `--password-env <VAR>` with a variable the user set, or `--password-stdin` from a pipe. In `pipe` and
  the Node library only `--password-env` works. Never echo, print or log a password.
- `proxy add` with an existing name replaces that proxy, which is how a password is rotated.
- `proxy list` shows each proxy, whether a password is set, and its rules. It never shows passwords.

## Route sites

```bash
patchrome proxy rule add example.de de          # that host only
patchrome proxy rule add '*.example.de' de      # its subdomains, not example.de itself
patchrome proxy rule add '*' corp               # every host no other rule matches
patchrome proxy rule add intranet.corp direct   # straight to the site, past a '*' rule
patchrome proxy rule add ads.example.de block   # never load it
patchrome proxy rule list                       # in the order they are checked
patchrome proxy rule remove '*.example.de'
patchrome proxy clear                           # every proxy and rule; Chrome's own settings return
```

- The exact host wins, then the longest `*.domain`, then `*`. Without a `*` rule, unmatched hosts go
  direct. Quote patterns with `*`.
- Patterns are hosts only: no scheme, port or path.
- A proxy that rules still use cannot be removed; remove its rules first.
- When a rule moves a site that has cookies to a new route, the command prints a warning. A site may
  challenge or sign out a login that suddenly comes from another address: tell the user.
- `localhost` and `127.0.0.1` always go direct.

## Check a route

```bash
patchrome proxy test https://shop.example.de/
# shop.example.de  matched *.example.de  via de (gw.example.net:8000)
# exit ip 85.214.1.2  DE  Europe/Berlin  (from ipinfo.io)
# warning: Chrome's timezone is Asia/Kolkata, the exit ip is in Europe/Berlin; ...
```

`proxy test` checks the proxy and its password without loading the page, and asks an IP echo service
(ipinfo.io, or `PATCHROME_IP_ECHO_URL`) for the exit address. That request leaves the machine through
the route. A timezone warning means sites that compare the two may flag the session: tell the user.
`daemon status` shows how many rules are on.

## Errors

| Code | Means | Do |
|---|---|---|
| `proxy_auth_failed` | the proxy refused the stored password, or asked for one and none is stored | tell the user; do not retry |
| `proxy_unreachable` | the proxy is down, its certificate is invalid, or it refused the site | `proxy test <url>`; tell the user if it stays down |
| `navigation_failed` with `blocked by proxy rule` | a `block` rule matched | ask the user before changing the rule |

## Limits

- Isolated sessions cannot follow rules: Chrome keeps extensions out of them, so their tabs would use
  this machine's own address. `open --isolated` fails while rules exist, and a rule cannot be added
  while an isolated session is open. For a separate cookie jar behind a proxy, the user needs a separate
  profile with its own rules.
- WebRTC stays off the network outside the proxy while rules exist.
- Chrome's own background traffic (updates, Safe Browsing) is not routed.
