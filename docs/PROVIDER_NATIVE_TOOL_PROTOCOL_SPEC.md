# Provider-native Tool Protocol Specification

Status: Accepted for implementation

## 1. Problem

Nexora currently exposes its internal Agent control-flow union as a model wire protocol:

```text
continue | request_input | finish
```

For JSON transports the model must select an `action`, shape the surrounding ModelTurn and then express the actual Tool call. Provider-native calls are also normalized back through that same model-authored contract whenever a Provider returns content instead of `tool_calls`. A model can therefore choose the correct Tool and arguments yet lose the entire turn because it omitted or invented an unrelated `action` field.

The retained real-Provider evidence demonstrates that an OpenAI-compatible HTTP surface does not imply compatible Tool Calling behavior. The unsupported Provider returned ordinary JSON intent instead of native Tool calls, produced repeated protocol repair turns and never executed a Tool.

## 2. Goal

Use the mature Provider Tool Calling model while preserving Nexora's execution authorities:

```text
Provider response items
-> Provider Adapter normalization
-> Harness deterministic routing
-> existing Runtime Action
-> Runtime validation, authorization, execution and persistence
```

The model selects Tools and supplies business arguments. Provider Adapter and Harness code, not the model, determine Nexora control flow.

## 3. Non-goals

- No second Agent Loop, Tool effect path, Run state or completion authority.
- No model-owned Run, Plan, Step, Invocation, Evidence, Approval or status identifiers.
- No global rule that every task must call a Tool; direct inquiry answers remain valid.
- No runtime fallback between transports after a Run starts.
- No Provider session state as an execution or recovery authority.
- No compatibility shim that continues accepting the retired `action` wire format.

## 4. Provider response contract

`RuntimeProvider.decide` returns one normalized response:

```ts
type ProviderToolCall = {
  callId: string;
  name: string;
  arguments: JsonValue;
};

type ModelResponse = {
  text: string | null;
  toolCalls: readonly ProviderToolCall[];
  finishReason: string | null;
};
```

The response contains Provider facts, not a Runtime command. It has no `action`, Plan field or input-request branch.

Harness routing is deterministic:

| Response | Harness compilation |
|---|---|
| one or more registered Runtime Tool calls | `call_tool` or `execute_step` |
| `nexora_update_plan` control call | `set_plan` |
| `nexora_request_input` control call | `request_input` |
| no calls and non-empty text | `propose_finish` |
| no calls and empty text | reject as a Provider response protocol error |

If text and Tool calls coexist, Tool calls take precedence and text is audit-only; it cannot finish the Run. A request-input control call must be the only call in its response. A Plan control call may precede Runtime Tool calls in the same response. Provider batches remain bounded to eight calls.

## 5. Control calls

Harness registers two reserved, effect-free control functions alongside Runtime Tools:

```text
nexora_update_plan
nexora_request_input
```

`nexora_update_plan` arguments use the existing objective-only Plan input:

```ts
{
  goal?: string;
  tasks: readonly { objective: string }[];
}
```

`tasks` 是当前有序的剩余工作快照。Provider 不提交 Step ID、status、Check 或 Evidence；Harness 协调等价 objective 的 identity，Runtime 持久化唯一当前 Plan。无 required mechanical Check 的 objective 不会被 Tool 成功自动完成，Provider 通过省略已结束 objective 的新快照推进导航。

`nexora_request_input` arguments are:

```ts
{
  question: string;
  reason: string;
}
```

Control calls are compiled by Harness and never become Tool Invocations. Registered Runtime Tools still pass through the single Runtime Tool Action path and retain Schema, permission, Approval, idempotency, recovery and Evidence semantics.

Provider-facing function names use deterministic readable aliases compatible with common Provider naming rules. Adapters preserve an exact alias-to-Tool mapping and never ask the model to submit Runtime-owned IDs.

## 6. Transport capabilities

Each Provider Adapter declares one transport for the entire Run:

```ts
type ProviderTransportProfile =
  | { kind: "native_tools"; promptCache?: ProviderPromptCachePolicy }
  | { kind: "structured_output"; promptCache?: ProviderPromptCachePolicy };
```

### 6.1 Native Tools

- Register each Runtime and control Tool through the Provider's native function-calling field.
- Do not send JSON response-format instructions while Tools are registered.
- Read calls only from the Provider's native Tool Call channel.
- Ordinary content is never parsed as a Tool call or Nexora Action.
- Preserve Provider call IDs in the normalized response and audit payload.
- Disable parallel Provider calls when the Provider supports that switch; Harness still accepts a bounded batch for compatible Providers and custom adapters.

### 6.2 Structured Output

- Register no Provider-native Tools.
- Require a real strict JSON Schema response capability, not JSON-object mode plus prompt convention.
- The Schema describes `ModelResponse` directly and enumerates the available Runtime and control call variants with their true input schemas.
- The Adapter generates stable call IDs when the Provider format has none.
- A Provider that cannot enforce the structured response contract is unsupported, not silently downgraded.

OpenAI-compatible means HTTP payload compatibility only. Tool capability is explicit configuration and is validated by adapter contract tests. A transport violation is a Provider protocol error; Harness does not reinterpret the other transport mid-Run.

## 7. Prompt contract

The stable transport segment describes only the active Provider mechanism:

- native mode: use Provider-native functions; return normal user-facing text only when no call is needed;
- structured mode: return the strict `ModelResponse` Schema supplied by the Adapter.

The prompt does not teach or mention `continue`, `request_input`, `finish`, `ModelTurn`, JSON `toolCalls` actions or Runtime internal commands. Plan and HITL guidance refer to their control functions.

Delivery-only calls register no Tools and request ordinary final text in native mode. Structured mode continues to use its strict response envelope with an empty call list.

## 8. Runtime and audit boundaries

Runtime Actions, State Machine, Tool Invocation, Approval, Evidence, Completion Gate and Result contracts remain authoritative and unchanged except for model-response audit terminology.

The model audit event records normalized response facts:

```ts
{
  hasText: boolean;
  finishReason: string | null;
  toolCallCount: number;
  controlCallCount: number;
  compiledActionTypes: readonly string[];
}
```

Rejected output is recorded as a Provider response protocol failure. Field-local Action repair is removed because the retired Action envelope no longer exists. Runtime Tool argument rejection and mechanical retry behavior remain unchanged.

## 9. Migration and deletion

This is an intentional breaking migration of the Provider-facing contract. Implementation must delete, not deprecate:

- `ModelTurnSchema` and the `continue | request_input | finish` wire union;
- `ModelToolCall` and Action-field parsers;
- `json_actions` transport and environment value;
- implicit JSON-object response formatting;
- native-call normalization into an Action object;
- Action-specific prompt instructions, repair parsing and field-rejection audit events;
- production and test callers that return the old wire shape.

Testing helpers may keep ergonomic `plan`, `tool`, `input` and `finish` builders, but they must materialize the new response/control-call contract.

## 10. Acceptance

- A native Provider Tool Call succeeds with null/empty assistant content and no model-authored Action.
- Native Tool turns do not send `response_format` and do send deterministic function aliases, true input schemas and control functions.
- Ordinary JSON or `thought` content is treated as text, never as a Tool Action.
- Structured mode uses strict `json_schema`, rejects unsupported or malformed responses and never accepts the old Action union.
- Plan, Tool batch, HITL, Approval, cancellation, recovery, Evidence and finish paths retain their existing Runtime semantics.
- Tool call IDs and normalized response facts are durable in model-call/audit evidence without becoming a new Authority.
- The public testing kit and all repository/packed consumers use the new response contract.
- Targeted protocol tests, Runtime/Harness release tests, full L3 regression, build, typecheck and lint pass.
- A real Provider capability probe records the selected transport honestly.
- A compatible real Provider completes a complex frontend workspace task with actual file effects and verification; an incompatible Provider fails explicitly without an Action-repair loop or false success.
