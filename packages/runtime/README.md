# @nexora/runtime

Durable execution, persistence, Tool safety, Approval, Evidence, recovery and deterministic completion for embeddable AI agents.

Persistent local servers and watchers use the built-in `process.start`,
`process.inspect`, `process.logs`, and `process.stop` capabilities. They retain
the normal Approval and Tool Invocation path while a generation-bound local
supervisor owns only operating-system liveness. `shell.execute` remains bounded
to commands expected to exit and always terminates its process tree on timeout.

Most applications should compose this package through `@nexora/harness`. Direct Runtime consumers can use the public lifecycle API and Tool builders without importing Store internals.

Documentation and source: [Nexora Agent](https://github.com/Atman-Angle/Nexora-Agent)

Version `0.1.0` is licensed under Apache-2.0. The package is not yet published to npm; until publication, install it from a locally produced tarball.

## Host read projections

Host applications can use `runtime.listRuns()` to restore a bounded list of persisted Runs, `RunHandle.inspect()` to read the current public state and input history, and `runtime.readArtifactText()` to read a digest-verified, size-limited text Artifact. These APIs are read-only projections; Store internals remain private.

## Run continuation

Start an explicit continuation without changing the new user input:

```ts
const next = runtime.run(userInput, {
  continuation: { parentRunId: previousRunId }
});
```

The parent must exist in the same Runtime Store, be terminal or blocked with `NO_PROGRESS_DETECTED` for bounded recovery, and have no unresolved Tool effect. Runtime persists its revision and last-event boundary in the child snapshot and `run.created` event. Invalid lineage fails with `INVALID_CONTINUATION`; a normal `runtime.run(input)` remains an independent Run.
