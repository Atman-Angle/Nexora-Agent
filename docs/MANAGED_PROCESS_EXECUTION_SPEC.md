# Managed Process Execution Spec

Feature: `managed-process-execution`
Risk: `L3`

## Goal

Nexora can start, inspect, read logs from, and stop a persistent local process
without misusing the bounded synchronous `shell.execute` capability. A process
that reports ready remains usable after its starting Tool Invocation completes
and after the Desktop Runtime worker is restarted.

## Authority and ownership

- Run status, Plan, Approval, Evidence, Completion, and recovery remain owned by
  the existing Runtime State Machine and Store.
- Every requested start, inspection, log read, and stop remains an ordinary
  persisted Tool Invocation. No process record may authorize a Run transition.
- The process supervisor owns only live operating-system process facts. Its
  workspace-local descriptor is an operational projection keyed by the start
  Invocation, not a second Run or Tool Effect ledger.
- A successful start Invocation is the authority that the process reached its
  declared readiness condition. Later inspect/log/stop Invocations are the
  authority for later observations and effects.

## Public capabilities

- `process.start`: protected, idempotent-by-key execute capability. It accepts one
  executable, explicit arguments, a workspace-relative cwd, a stable
  `serviceKey`, a readiness condition, and a bounded startup timeout.
- `process.inspect`: read capability over one exact process handle.
- `process.logs`: bounded read capability over one exact process handle; large
  output is stored as an Artifact.
- `process.stop`: protected, idempotent execute capability over one exact
  process handle and its process tree.

`shell.execute` continues to run only commands expected to exit. Its timeout
result must state that the process tree was terminated and that no background
process remains.

## Process identity and replay

The stable service identity is `(workspace, serviceKey)`. The command identity
is a digest of executable, arguments, cwd, and readiness input. The opaque
process handle binds the service key, start Invocation, command digest, random
generation token, supervisor PID, child PID, and creation time.

- A live matching service returns the existing handle with `replayed: true`, so
  Runtime crash recovery can safely replay the same prepared/started Invocation.
- A live service with the same key and a different command is rejected.
- An exited generation may be replaced by a new generation.
- An unknown start outcome is inspected by its persisted generation before a
  new process may be created.
- A PID without the matching generation/heartbeat is never sufficient to stop
  a process.

## Readiness and termination

Start succeeds only after one declared readiness condition passes:

- bounded stdout/stderr literal;
- loopback TCP port;
- loopback HTTP endpoint and allowed response status.

Exit before readiness, readiness timeout, descriptor corruption, or supervisor
loss cannot be reported as success. Startup failure terminates the process tree.
Stop waits for the supervisor to report a terminal state and fails explicitly
when termination cannot be confirmed.

## Safety

- Start and stop use the existing Approval path; inspect and logs are reads.
- Shell entrypoints remain rejected.
- cwd is workspace-bound and symlink checked.
- Readiness network probes are loopback-only.
- Child environment is an explicit operating-system/runtime allowlist rather
  than the complete Desktop/Provider secret environment.
- On Windows, known package-manager names are resolved to their JavaScript CLI
  and launched by `node.exe`; `.cmd`, `.bat`, `.ps1`, and interactive shells are
  rejected instead of being hidden behind `cmd.exe`.
- Logs are byte-bounded, secret-redacted before model projection, and moved to
  Artifact storage when large.

Provider adapters may decode a double-encoded nested JSON object or array only
when that exact field is declared composite by the advertised Tool JSON Schema.
The decoded value must still pass the authoritative Runtime Zod Schema;
JSON-looking fields declared as strings are never coerced.

## Recovery

- Runtime cancellation aborts an unconfirmed start and requests supervisor
  termination. A process already confirmed ready is not silently killed by a
  later model cancellation; it requires `process.stop`.
- Desktop or Runtime restart reconnects through the process handle and current
  descriptor without replaying `process.start`.
- OS restart, stale heartbeat, generation mismatch, or PID reuse produces a
  lost/exited observation, never a live result.
- A terminal generation at the same service key cannot satisfy the readiness
  wait for its replacement generation.
- Provider timeout/cancellation discards provisional model output and does not
  replay a successful process Invocation.

## Acceptance

1. A Vite-like server reaches readiness and remains reachable for at least ten
   minutes after `process.start` completes.
2. Reopening the Desktop preserves inspection and stop control of the service.
3. Repeating the same start does not create a second process.
4. Conflicting service keys, port conflicts, early exit, startup timeout, stale
   heartbeat, and malformed descriptors fail without false success.
5. Stop terminates descendants and confirms terminal state.
6. `shell.execute` timeout proves `processDisposition=terminated` and
   `processStillRunning=false`.
7. Approval, unknown Effect recovery, Artifact, Completion, cancellation,
   restart, build, typecheck, lint, package consumers, and full Runtime/Harness
   regression remain valid.
8. A real Qwen Desktop canary starts and opens the test application without a
   duplicate server, false background claim, or unbounded generic Resume.
