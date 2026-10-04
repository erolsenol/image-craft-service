# Contributing

Thanks for helping improve image-craft-service. For substantial changes, open an issue first to discuss the API or security impact. Keep pull requests focused and include tests for behavior changes.

## Development

- Node.js 20 or later and npm are required.
- Run `npm ci` to install dependencies.
- Run `npm run lint`, `npm run typecheck`, and `npm test` before opening a pull request.
- Do not commit credentials, private images, or generated build output.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Local development checks

Install the repository's Git hooks once after cloning:

```sh
npm ci
npm run hooks:install
```

The pre-commit hook checks formatting and ESLint for staged files. The pre-push
hook runs the full local quality suite against the exact pushed `HEAD`; it
requires a clean worktree and pushes from the checked-out commit. Run the same
push checks manually with `npm run check:push`, and test the hook helpers with
`npm run test:local-checks`.

When Docker is running, push checks start temporary Redis and MinIO containers
for their integration tests and build the service and worker images. If Docker
is unavailable, those container-backed integration tests and image builds are
reported as skipped; all other local checks still run. Temporary test
containers are removed after the checks finish.

The push suite includes SDK generation consistency, client and docs builds,
`npm audit`, lint, typecheck, formatting, the Vitest suite, Python SDK and PDF
worker tests, Python package build, and Docker builds when available.
