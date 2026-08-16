# Nexora Runtime package consumers

These examples are external application shapes, not additional Nexora runtime
entry points.

- `worker.ts` runs one persisted task, handles public Approval requests, reads
  the terminal Result, and closes the Runtime.
- `http-host.ts` maps a small Node HTTP/SSE boundary to `Runtime` and
  `RunHandle`. It stores no Run state and reopens every Run from its public ID.

Both files import only `@nexora/harness`. The D5 package tests copy them into
independent temporary projects, install locally packed `@nexora/runtime` and
`@nexora/harness` tarballs, compile them with strict NodeNext TypeScript, and
execute them outside the monorepo.

The HTTP routes are an example application's contract. They are not exported
by `@nexora/harness` and are not a Nexora remote-runtime or application
framework API.
