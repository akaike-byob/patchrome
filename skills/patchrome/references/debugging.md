# Debugging your own app

For localhost apps you are building, use the debug profile: a separate Chrome with console capture,
page errors, tracing, raw CDP and a `127.0.0.1` debugging port. Never use it for third-party sites:
all of that is detectable. Stealth profiles refuse these commands with `unsupported_in_stealth`.

```bash
patchrome --profile debug open http://localhost:3000
patchrome --profile debug console --level warning   # c4 t1 error Failed to load user (http://localhost:3000/app.js:88)
patchrome --profile debug console --follow          # streams until --timeout-ms (default 10 min)
patchrome --profile debug errors                    # uncaught exceptions with stacks
patchrome --profile debug trace start               # covers every tab in the profile; one session at a time
patchrome --profile debug trace stop                # prints the zip; npx playwright show-trace <file>
patchrome --profile debug cdp Performance.getMetrics
patchrome --profile debug cdp help Network          # what this Chrome implements
patchrome --profile debug devtools-url              # for chrome-devtools-mcp --browserUrl <url>, Lighthouse, heap snapshots
```

`watch --events console,error` streams the same events alongside navigation and responses.
`profile create <name> --mode debug` makes another debug profile; `debug` is one by default.
