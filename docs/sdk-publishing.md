# SDK publishing

The `Publish SDKs` workflow publishes `image-craft-client` to npm and PyPI when a `v0.9.x` GitHub release is published. It uses GitHub OIDC, so registry tokens are not stored in Actions secrets.

Before publishing:

1. Create the npm package and configure its Trusted Publisher as this GitHub repository with workflow `Publish SDKs`.
2. Create the PyPI project and configure its Trusted Publisher for this repository, workflow file `.github/workflows/publish-sdks.yml`, and environment `pypi`.
3. Confirm the JS and Python package versions match the release version.

The workflow regenerates the OpenAPI-derived files, builds the TypeScript SDK, then publishes both packages. Package versions on npm and PyPI are immutable; choose the release version only after review.
