# Agent Skill Auto Selection Feature Contract

## Status

```yaml
feature: agent-skill-auto-selection
mode: DIRECT
risk: L3
status: accepted
owner: Harness
migration: not_required
```

## Goal

Allow a Nexora Host to configure local Agent Skills and let the existing Harness-owned Agent Loop select the smallest relevant Skill set for the current task. Only selected instructions enter later model context, while every effect continues through the existing Runtime Tool, Approval, Invocation, Evidence and Completion authorities.

## User value flow

```text
Host configures explicit local Skill roots
→ Harness validates and snapshots Skill packages
→ model sees bounded Skill metadata catalog
→ model emits nexora_select_skills with exact immutable identities
→ Harness validates and audits the selection
→ next model turn receives selected Skill instructions
→ ordinary Plan / Tool / Approval / Evidence / Completion path continues
```

## Scope

- Agent Skills-compatible `SKILL.md` packages with required `name` and `description` frontmatter.
- Optional `license`, `compatibility`, `metadata`, `allowed-tools`, `scripts/`, `references/` and `assets/` package content.
- Host-configured local roots with explicit source and trust labels.
- Deterministic metadata catalog, package digest and instruction digest.
- Model-owned, schema-validated, exclusive Skill selection control.
- Progressive disclosure: catalog metadata before selection; full Markdown instructions only after accepted selection.
- Selection recovery from append-only `model.turn` events and strategy continuity through existing Model Call manifests.
- Fail-closed validation for duplicate identity, traversal, links, package drift, unsupported frontmatter and resource budgets.

## Non-goals

- MCP, remote registries, marketplaces, downloads, dependency installation or automatic updates.
- Automatic execution of `scripts/` or any new Tool execution path.
- Skill-defined Tool registration, permissions, Approval, Evidence, Run state, Plan state or completion.
- A Runtime Skill table, second state machine, workflow graph or third-party Agent orchestration framework.
- UI management of Skill packages in this Feature.

## Authority and instruction order

```text
Nexora System Kernel
→ Host Policy
→ Project Policy
→ current user requirements
→ selected Skill strategy instructions
→ Tool observations, files, references and other untrusted data
```

Skill instructions are strategy-only. `allowed-tools` is a model guidance hint and never a permission grant or Runtime allowlist override. Files inside a Skill package remain content; embedded approval, permission, system-message or completion claims have no authority.

## Public configuration contract

The Harness accepts optional Skill configuration containing explicit roots, source/trust labels, allow/deny filters and bounded discovery limits. Creation fails before a Run starts when configuration or package validation fails. The model never receives absolute filesystem paths.

Each catalog descriptor exposes only:

```text
id
version
description
packageDigest
instructionDigest
source
trust
compatibility
allowedTools hint
resourceRefs (relative paths only)
```

## Selection contract

`nexora_select_skills` is a Harness control, not a Runtime Tool. It must be the only call in a Provider response. Its arguments include the current `catalogDigest` and one to four exact `{ id, version, packageDigest }` references. A stale, unknown, denied, duplicate or mismatched reference is rejected before activation and produces no Runtime Tool effect.

An accepted selection is recorded in the existing `model.turn` event with compiled action type `select_skills`. The next decision derives active Skills from the latest accepted event. Invalid responses are also audited but are not treated as accepted selections.

## Filesystem and budget rules

- Roots must be explicit existing directories.
- Only direct child Skill directories are discovered.
- Skill directory name must equal frontmatter `name`.
- Symbolic links, junctions and other reparse-point package entries are rejected.
- Resolved files must remain below the configured root and Skill directory.
- Duplicate IDs across roots are rejected, including packages later removed by allow/deny policy.
- Default limits bound roots, skills, files, package bytes, instruction bytes, active Skill count and active instruction bytes.
- The complete package digest covers relative file names and file content digests in deterministic order.
- A new process that observes a different catalog snapshot is subject to existing strategy continuity and requires an explicit strategy revision to continue the same Run.

## Failure semantics

| Failure | Result |
|---|---|
| Invalid root or frontmatter | Agent creation fails with `INVALID_CONFIGURATION` |
| Traversal, link or package budget violation | Agent creation fails closed |
| Duplicate or filtered selection | Provider response is rejected for bounded repair |
| Catalog/package digest mismatch | Provider response is rejected; no activation or effect |
| Active instructions exceed budget | Selection is rejected before audit acceptance |
| Provider context hard limit exceeded | Existing context capacity failure applies |
| Catalog changes on restart | Existing strategy continuity blocks without explicit revision |

## Acceptance

- A valid Skill catalog is deterministic and contains no absolute paths or full instruction bodies.
- The first Provider turn receives catalog metadata only.
- After a valid selection-only turn, the next Provider turn receives exact selected instructions and can use existing Runtime Tools.
- Unknown, stale, denied, duplicate and compound selections produce no Tool Invocation.
- Selection survives Runtime reopen through durable event projection.
- Malicious Skill text cannot change Tool availability, Approval, Evidence or Completion semantics.
- Traversal/link, duplicate ID and size/count limits are covered by deterministic tests.
- Context contraction preserves active Skill instructions; the hard context limit fails rather than silently dropping them.
- Harness build and relevant L3 Runtime regressions pass.

## Definition of done

Implementation, public types, focused tests and current user documentation agree with this Contract; `DEVELOPMENT.md` records actual evidence and the Feature stops without starting MCP or marketplace work.
