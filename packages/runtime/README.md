# @nexora/runtime

Durable execution, persistence, Tool safety, Approval, Evidence, recovery and deterministic completion for embeddable AI agents.

Most applications should compose this package through `@nexora/harness`. Direct Runtime consumers can use the public lifecycle API and Tool builders without importing Store internals.

Documentation and source: [Nexora Agent](https://github.com/Atman-Angle/Nexora-Agent)

Version `0.1.0` is licensed under Apache-2.0. The package is not yet published to npm; until publication, install it from a locally produced tarball.

## Host read projections

Host applications can use `runtime.listRuns()` to restore a bounded list of persisted Runs, `RunHandle.inspect()` to read the current public state and input history, and `runtime.readArtifactText()` to read a digest-verified, size-limited text Artifact. These APIs are read-only projections; Store internals remain private.
