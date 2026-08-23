# Risk-based Tool Approval

Status: implemented conservative Desktop slice; broader Runtime contract planned

Mode: DIRECT

Risk: L3

## Goal

Nexora Desktop should continue ordinary workspace work without asking the user to approve every bounded file edit, while operations that can escape the workspace safety boundary still require an explicit user decision.

Approval remains a Runtime-owned, persisted boundary. The model cannot approve an operation, and the Renderer cannot bypass or synthesize Tool state.

## Repository baseline

The current Tool contract exposes deterministic effect kinds: `read`, `write`, and `execute`.

- Read Tools already execute without Approval.
- `filesystem.write` and `filesystem.patch` are idempotent, reject absolute paths and symlink escapes, and can only affect the selected Workspace.
- `shell.execute` starts an arbitrary non-shell executable. It has no OS sandbox and may affect files, processes, credentials, the network, or external systems beyond the Workspace.
- Runtime persists the exact canonical Action before Approval and keeps Invocation, Evidence, recovery, and Completion authoritative.

## Adopted open-source pattern

Mature coding agents such as Codex separate two decisions:

1. what the process is technically contained from doing (sandbox/workspace boundary);
2. when a human must confirm an operation (approval policy).

The important property is deterministic containment and policy, not asking the model to judge whether its own command is safe. Nexora follows that shape without adding a speculative sandbox or natural-language risk classifier.

## Current Desktop policy

| Operation | Containment | Desktop behavior |
| --- | --- | --- |
| `filesystem.read/list/search` and Git reads | Read-only Workspace observation | Execute directly, as before |
| `filesystem.write` | Workspace-relative, symlink-safe, idempotent atomic write | Desktop Host automatically grants the persisted Approval |
| `filesystem.patch` | Workspace-relative, digest-guarded, idempotent exact patch | Desktop Host automatically grants the persisted Approval |
| `shell.execute` | No OS sandbox; process may have external effects | Require explicit user Approval |
| Input Request | User-exclusive information | Require user response |
| Unknown non-idempotent result / Recovery | Outcome cannot be inferred safely | Require user recovery decision |

The Desktop Host grants only the two named built-in workspace mutation Tools. Runtime still creates `approval.requested` and `approval.granted`, revalidates the canonical input, creates the Invocation, executes the Tool, records Evidence, and applies the Completion Gate. Renderer state is not involved.

CLI and third-party Hosts retain the existing explicit Approval behavior. This first slice does not silently change the public Runtime default.

## Minimal follow-up design

Only implement the following when a second Host or a new Tool requires it:

1. Add deterministic risk metadata to the Tool execution contract, with a small closed vocabulary such as `workspace_read`, `workspace_write`, `process`, `external_effect`, and `unknown`.
2. Let the Host select an approval policy from those Runtime-projected risk classes. Default must fail closed for unknown classes.
3. Persist whether an Approval was user-granted or policy-granted without creating a second Approval authority.
4. Keep `process`, `external_effect`, destructive operations, credential access, boundary escape, and unknown risk user-gated.
5. Do not auto-approve selected shell commands using command-name or argument allowlists. A safe process tier requires a real OS sandbox with filesystem and network containment first.

No Settings toggle is added in this slice. A global “approve everything” switch would be unsafe without sandboxing, and per-command exception lists would create a second, fragile permission system.

## Acceptance

- A Desktop `filesystem.write` or `filesystem.patch` proceeds to a successful Invocation without Composer interaction.
- Its exact Approval request and policy grant remain in Runtime audit history.
- The Action input used for execution is the same schema-validated canonical input that was requested.
- `shell.execute` remains `waiting_for_approval` with zero Tool Invocations before the user decision.
- Input Request and Recovery behavior are unchanged.
- CLI and package consumers retain explicit Approval by default.
- Typecheck, lint, build, focused Desktop integration tests, Runtime Approval regressions, and deterministic Desktop UAT pass.

## Non-goals

- model-generated risk scores;
- parsing commands to guess intent;
- bypassing Runtime Approval, Invocation, Evidence, or Completion;
- adding an OS sandbox in this feature;
- adding global or per-Tool Settings UI before the public risk contract exists;
- changing CLI or third-party Host defaults.

## Rollback

Remove the Desktop Host auto-grant policy and its event handler. Persisted Approval and Invocation data remain valid because the Runtime schema and Authority are unchanged.
