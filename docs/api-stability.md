# API stability and deprecation policy

## `/v1` compatibility

Starting with v1.0.0, `/v1` is a stable major API. During the v1 lifetime, an
existing request accepted by a documented endpoint will not be made invalid,
and an existing response field, header, status code, or documented behavior
will not be removed or change meaning in a backward-incompatible way.

The following are compatible additions: new optional request fields, new
operations, new endpoints under `/v1`, and new response fields that clients
can safely ignore. Clients should ignore unknown response fields. A behavior
that changes security risk, limits, or correctness may be tightened through a
documented security release; such changes will be called out in the changelog.
Configured resource limits can continue to constrain requests.

## Deprecations

Before removing or changing a documented v1 feature, maintainers will:

1. Mark it deprecated in the OpenAPI schema and documentation.
2. Explain the replacement and migration steps in the changelog and upgrade
   guide.
3. Keep the feature available for at least 12 months after the deprecation
   announcement, except when a critical security issue requires faster action.
4. Remove it only in a new major API version. An emergency security change is
   documented as a security exception.

SDKs follow semantic versioning independently of the HTTP API. Fixes and
backward-compatible additions increment patch/minor versions; breaking SDK
surface changes increment the major version.

## Reporting compatibility issues

Open a GitHub issue with the request, response, OpenAPI version, and client
version. Do not include API keys, signed URLs, or private images. Report
security concerns through [SECURITY.md](../SECURITY.md) instead.
