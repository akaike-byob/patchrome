# Contributing

## Setup

Requires macOS, Node.js 24.2 or newer (see `.node-version`) and Google Chrome.

```bash
npm install
npm run typecheck
npm test        # unit tests plus integration tests, which open a headed Chrome
```

## Pull requests

- `main` accepts changes only through pull requests, merged by squash. Direct pushes and force pushes
  are blocked.
- CI must pass: typecheck, unit tests, build, integration tests and a gitleaks secret scan.
- The PR title becomes the commit message on `main`, so write it as one.
- Add or update tests with every behavior change. Integration tests live in `test/integration` and run
  against the local fixture server, never a live site.

## Releasing

1. Bump `version` in `package.json` and `package-lock.json` in a pull request, via `npm version <patch|minor|major> --no-git-tag-version`.
2. After it merges, publish a GitHub release whose tag is `v` plus that version, such as `v0.2.0`.
3. The Release workflow publishes to npm through trusted publishing, with provenance. No npm token
   exists in the repo or on anyone's machine.

## Security issues

See [SECURITY.md](SECURITY.md).
