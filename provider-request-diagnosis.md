# Provider Request Differential Diagnosis

Date: 2026-09-04
Endpoint: current workspace-dedicated Bailian OpenAI-compatible endpoint (URL intentionally omitted)
Model: `qwen3.8-flash`

## Exact fixture

- Sanitized structural fixture: `provider-request-sanitized.json`
- Original exact body was replayed locally during diagnosis; it contained 2 messages, 17 native tools, `tool_choice=auto`, `parallel_tool_calls=true`, `temperature=0`, `max_tokens=16384`.
- No `response_format`, `reasoning`, `thinking`, or `stream` field was present in the captured production request.
- API key was not included in the body. The retained sanitized fixture replaces system/user content with length-preserving redaction markers and is structural, not semantically equivalent.

## Standalone results

| Variant | Result | Response-header latency |
|---|---|---:|
| Exact body, host replay #1 | HTTP 200, valid JSON | ~107.3 s |
| Exact body, Docker replay | HTTP 200, valid JSON | ~26.9 s |
| Exact body, host replay #2 | HTTP 200, valid JSON | ~59.3 s |
| Full context + 17 tools, no tool controls | HTTP 200, valid JSON | ~74.1 s |
| Full context + one tool | HTTP 200, valid JSON | ~41.4 s |
| Reduced context + full tools | HTTP 200, valid JSON | ~4.1 s |
| Reduced context + no tools | HTTP 200, valid JSON | ~9.2 s |
| Full context + no tools | aborted at 150 s; no headers | >150 s |
| Full context + `max_tokens=4096` | aborted at 120 s; no headers | >120 s |
| Exact body + `stream=true` | HTTP 200 SSE | headers ~1.1 s; body ~71.0 s |

The exact production-shaped request therefore succeeds in standalone replay but has highly variable pre-header latency. No single one-variable removal produced a monotonic, deterministic fix; the data does not support claiming that tools, tool controls, output budget, or stream alone is the cause.

## Nexora trace

The traced Runtime request had `bodyChars=63682` and reached `POST .../chat/completions`. The fetch wrapper recorded `request_started` but no `headers`, `json_complete`, or `fetch_error` before the adapter's 180-second response-header timeout. The Runtime persisted two earlier successful model calls, then the third call had two `PROVIDER_CONNECT_TIMEOUT` attempts; the third was cancelled when the diagnostic process was stopped. No SSE/parser/response-validation boundary was reached for the failing attempt.

## Protocol comparison

`POST /responses` with the same model and a minimal diagnostic input returned HTTP 200 in ~1.0 s. This confirms the endpoint exposes a Responses-compatible surface. It is diagnostic only; Nexora production protocol remains Chat Completions. A full-content Responses-vs-Chat comparison was not run because it would not be necessary to identify the current first broken boundary and would add provider load.

## Classification

**UPSTREAM_PROVIDER** (medium confidence; not a deterministic compatibility defect).

First broken boundary: **before HTTP response headers / time-to-first-byte on the provider side** for the large production-shaped request. The same raw request succeeds through the same Node fetch path, including from Docker, so Nexora response parsing, SSE parsing, and response validation are not implicated in the observed failing attempt. The main observable is provider-side latency/variance under the large context/tool request.

A `PROVIDER_COMPATIBILITY_GAP` is not established: no unsupported field or stable minimal failing payload was isolated. An `NEXORA_ADAPTER` defect is not established: the failing trace never reached adapter response handling, while standalone raw fetches returned valid JSON/SSE.

## General adapter normalization candidate (not applied)

If provider mitigation is required, keep it generic: expose/record separate timings for request start, response headers, first SSE byte, stream idle, body/finish, parse, validation, and timeout class; preserve the original error boundary instead of mapping every fetch abort to connect timeout. Do not add benchmark-specific branches, retries, or budget changes.

## Remaining blocker before Harness A/B

- obtain a same-attempt body capture from the exact failing live request if a deterministic payload diagnosis is required;
- repeat the exact full request enough to estimate provider variance and test whether the >180 s pre-header tail recurs;
- capture Nexora adapter phase telemetry without changing production semantics;
- do not resume Harness/Terminal-Bench A/B until provider variance is bounded or the adapter boundary is proven.
