# Qwen Decision Token A/B — 2026-08-09

## Setup

- Provider/model: DashScope OpenAI-compatible / `qwen3.7-flash`
- Reasoning: `dynamic`, with `enable_thinking` explicitly sent
- Arms: decision `max_tokens` 4096 versus 1536
- Schedule: two paired runs per scenario, first arm alternated
- Safety: isolated temporary workspaces; read-only tasks; all failures retained

## Results

| Dataset | Arm | Success | Input tokens | Output tokens | Model calls | Provider time |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| One known read | 4096 | 2/2 | 11,548 | 4,016 | 8 | 34.9 s |
| One known read | 1536 | 2/2 | 11,529 | 4,853 | 8 | 42.7 s |
| Three known reads | 4096 | 2/2 | 18,473 | 11,124 | 10 | 86.0 s |
| Three known reads | 1536 | 2/2 | 18,338 | 7,716 | 10 | 61.1 s |
| Combined | 4096 | 4/4 | 30,021 | 15,140 | 18 | 120.9 s |
| Combined | 1536 | 4/4 | 29,867 | 12,569 | 18 | 103.8 s |

`dynamic` was verified on every Run: the first planning request carried
`enable_thinking: true`; later decision and validation requests carried
`false`.

For the three-known-read task, both arms showed one four-model-call Run
(plan, `execute_step`, finish, validation) and one six-model-call Run
(separate Tool decisions). The batch capability is available and safe, but
model selection is not deterministic at this sample size.

## Decision

Do not change the production default from 4096 yet. Although the 1536 arm
used 17% fewer completion tokens and 14% less aggregate Provider time across
these eight Runs, the one-read sample regressed and DashScope reported a
reasoning completion longer than the requested 1536 limit once. The limit is
therefore not a reliable hard cap for Qwen reasoning output.

Run a broader, balanced benchmark over the fixed read/search, literal-search,
mutation and denial scenarios before changing the default. Keep dynamic
reasoning and the `execute_step` batching instruction enabled now.
