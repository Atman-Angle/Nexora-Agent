# Nexora Release SOP

## Current state

Nexora is release-candidate source, not a published npm release. `@nexora/runtime` and
`@nexora/harness` are currently unavailable from the public npm registry, this machine is not
authenticated to npm. The repository and both packages are licensed under Apache-2.0, the first
public version is `0.1.0`, and the repository owner has confirmed publish access to the npm
`@nexora` scope.

## Repository gate

From a clean checkout with Node.js 20 and pnpm 11.7.0:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:supervisor-coordinator
```

CI runs the complete suite on Ubuntu and the packed external Consumer on Windows. Real Provider
canaries are not supplied credentials in CI and remain separately authorized external acceptance.

## Resolved release identity

The repository owner has explicitly selected:

1. Apache-2.0 for the repository and both npm packages;
2. npm `@nexora` scope ownership and publish permission;
3. `0.1.0` as the first public version.

## Pack verification

```powershell
$releaseOutput = Join-Path $env:TEMP 'nexora-release-pack'
New-Item -ItemType Directory -Force -Path $releaseOutput | Out-Null
pnpm --filter @nexora/runtime pack --pack-destination $releaseOutput
pnpm --filter @nexora/harness pack --pack-destination $releaseOutput
pnpm exec vitest run tests/runtime/d4-package-consumer.test.ts --no-file-parallelism
```

The packed Consumer is the authority for exports, installability and the trusted execution loop.
Tarballs must contain only package metadata, README and declared `dist` output; Harness must depend
on the concrete Runtime release version `0.1.0` rather than `workspace:*`. Each tarball must carry
its own Apache-2.0 `LICENSE`.

## Authorized publication

Publication is an external write and requires an authenticated npm owner with the configured 2FA
or trusted provenance. Do not disable tests or use force push to publish.

```powershell
npm whoami
npm publish .\packages\runtime --access public --provenance
npm publish .\packages\harness --access public --provenance
```

Publish Runtime first. Then install both versions from the public registry in a new empty directory
and repeat the package Consumer. Only after that verification create the matching signed Git tag and
GitHub Release. Record the two registry tarball digests and ensure tag, GitHub Release and npm versions
match.
