# SDK publishing

The `Publish SDKs` workflow builds and publishes TypeScript/JavaScript and
Python `image-craft-client` packages when a v1.x GitHub release is published.
It uses GitHub OIDC; registry API tokens are not stored as Actions secrets.

## npm Trusted Publisher

For the npm `image-craft-client` package, configure Trusted Publishing for:

- GitHub owner: `erolsenol`
- Repository: `image-craft-service`
- Workflow: `.github/workflows/publish-sdks.yml`
- Environment: none (the npm job does not declare one)

The job checks that the package version matches the release tag and skips a
version already on the registry. It publishes with provenance.

## PyPI Trusted Publisher

For first publication, create a PyPI Pending Publisher for project
`image-craft-client`; after the first publish it appears as the project's
Trusted Publisher. Configure:

- Owner: `erolsenol`
- Repository: `image-craft-service`
- Workflow: `publish-sdks.yml`
- GitHub environment: `pypi`

The `pypi` environment must exist in GitHub. The workflow verifies the
`pyproject.toml` version matches the release tag and skips a version already
on PyPI. A project name, workflow filename, owner, repository, or environment
mismatch causes PyPI to reject the OIDC exchange as `invalid-publisher`.

## Release steps

1. Merge the Changesets version PR after CI succeeds.
2. Confirm root, client, and Python package versions match the intended release.
3. Create and publish a GitHub release with a `v1.x.y` tag.
4. Wait for `Publish SDKs` and `Release images` workflows.
5. Verify the npm and PyPI package pages and the GHCR manifest for both
   `linux/amd64` and `linux/arm64`.

The `Changesets` workflow prepares package version/changelog PRs. The release
workflow publishes signed GHCR images and an SPDX SBOM; this SDK workflow
publishes npm and PyPI distributions.
