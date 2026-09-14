# Contributing

## Setup

Requires macOS or desktop Linux, Node.js 24.2 or newer (see `.node-version`) and Google Chrome.

```bash
npm install
npm run format:check   # oxfmt; `npm run format` rewrites
npm run lint           # oxlint with type-aware rules
npm run typecheck
npm test        # unit tests plus integration tests, which open Chrome headless locally and headed in CI
```

## Pull requests

- `main` accepts changes only through pull requests, merged by squash. Direct pushes and force pushes
  are blocked.
- CI must pass: format, lint, typecheck, unit tests, build, integration tests and a gitleaks secret scan.
- The PR title becomes the commit message on `main`, so write it as one.
- Add or update tests with every behavior change. Integration tests live in `test/integration` and run
  against the local fixture server, never a live site.

## Releasing

Every merge to `main` releases. The Release workflow runs [semantic-release](https://semantic-release.gitbook.io),
which reads the squash commit, tags `v<version>`, creates the GitHub release with notes, and publishes to npm
through trusted publishing, with provenance. No npm token exists in the repo or on anyone's machine.

The PR title picks the version bump:

| PR title | Release |
| --- | --- |
| `Stop sending Dock clicks back to the editor` | patch |
| `docs: Explain tab groups`, `fix: ...`, any other [Conventional Commits](https://www.conventionalcommits.org) type | patch |
| `feat: Add a network export command` | minor |
| `feat!: Drop Node.js 22`, or a `BREAKING CHANGE:` line in the PR body | major |

The PR title check rejects an unknown prefix such as `Feat:` or `feature:`. `release.config.mjs` holds the
types and rules. `version` in `package.json` stays `0.0.0-development`; the tag holds the real version, and
semantic-release writes it into the package at publish time.

## Security issues

See [SECURITY.md](SECURITY.md).
