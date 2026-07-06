import type {
  Action,
  AgentAction,
  AgentBudget,
  AgentBudgetUsage,
  BuilderPromptContext,
  ContextSnapshot,
  ExecutionPlanRepairContext,
  PlanningPolicyContext,
  ProgressLedger,
  StrategyPromptContext,
  TaskPatchRequest,
  TaskValidationRequest,
  ToolResult,
  ValidationResult,
  WorkingSet
} from "../../contracts/src/index.js";
import type { ToolName } from "../../contracts/src/tool-call.js";
import type { AgentLoopModelProvider, ModelActionRejection, ModelProvider, ToolModeModelProvider } from "../../model-gateway/src/index.js";

export class FakeModelProvider implements ModelProvider, ToolModeModelProvider, AgentLoopModelProvider {
  public callCount = 0;
  public lastModelError: ModelActionRejection | null = null;
  public lastStrategyContext: StrategyPromptContext | null = null;
  public lastBuilderContext: BuilderPromptContext | null = null;
  public lastPlanningPolicyContext: PlanningPolicyContext | null = null;
  public lastExecutionPlanRepairContext: ExecutionPlanRepairContext | null = null;
  public lastValidationFailureSummary: ValidationResult["failureSummary"] | null = null;
  public readonly modelErrors: Array<ModelActionRejection | null> = [];
  public readonly strategyContexts: Array<StrategyPromptContext | null> = [];
  public readonly builderContexts: Array<BuilderPromptContext | null> = [];
  public readonly validationFailureSummaries: Array<ValidationResult["failureSummary"] | null> = [];
  private agentScriptIndex = 0;

  public constructor(
    private readonly options: {
      mode: "success" | "fail" | "empty";
      text: string;
      delayMs?: number;
      toolPlanMode?: "success" | "invalid_action" | "fail_action";
      toolFinalMode?: "success" | "empty" | "fail_action";
      toolTimeoutMs?: number;
      agentActions?: AgentAction[];
      agentRawResponses?: string[];
    }
  ) {}

  public async generate(): Promise<{
    text: string;
    provider: string;
    model: string;
  }> {
    this.callCount += 1;

    if ((this.options.delayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }

    if (this.options.mode === "fail") {
      throw new Error("Fake model failure");
    }

    if (this.options.mode === "empty") {
      return {
        text: "",
        provider: "fake",
        model: "fake-empty"
      };
    }

    return {
      text: this.options.text,
      provider: "fake",
      model: "fake-success"
    };
  }

  public async plan(input: {
    runId: string;
    text: string;
    filePath?: string;
    searchQuery?: string;
    patchRequest?: TaskPatchRequest;
    validationRequest?: TaskValidationRequest;
  }): Promise<Action> {
    this.callCount += 1;

    if ((this.options.delayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }

    if (this.options.toolPlanMode === "invalid_action") {
      return { type: "final", text: "invalid planning action" };
    }

    if (this.options.toolPlanMode === "fail_action") {
      return {
        type: "fail",
        code: "MODEL_ACTION_FAILED",
        message: "Fake model requested failure during planning.",
        retryable: false
      };
    }

    if (input.searchQuery !== undefined) {
      return {
        type: "tool_call",
        toolCall: {
          toolCallId: `${input.runId}-tool-call`,
          toolName: "filesystem.search",
          input: {
            query: input.searchQuery,
            limit: 20
          },
          timeoutMs: this.options.toolTimeoutMs ?? 1_000
        }
      };
    }

    if (input.patchRequest !== undefined) {
      return {
        type: "tool_call",
        toolCall: {
          toolCallId: `${input.runId}-tool-call`,
          toolName: "filesystem.patch",
          input: input.patchRequest,
          timeoutMs: this.options.toolTimeoutMs ?? 1_000
        }
      };
    }

    if (input.validationRequest !== undefined) {
      return {
        type: "tool_call",
        toolCall: {
          toolCallId: `${input.runId}-tool-call`,
          toolName: "shell.execute",
          input: {
            command: input.validationRequest.command,
            args: input.validationRequest.args,
            cwd: input.validationRequest.cwd,
            environment: input.validationRequest.environment,
            purpose: input.validationRequest.purpose,
            idempotencyKey: input.validationRequest.idempotencyKey
          },
          timeoutMs: input.validationRequest.timeoutMs
        }
      };
    }

    return {
      type: "tool_call",
      toolCall: {
        toolCallId: `${input.runId}-tool-call`,
        toolName: "filesystem.read",
        input: {
          path: input.filePath ?? input.text
        },
        timeoutMs: this.options.toolTimeoutMs ?? 1_000
      }
    };
  }

  public async finalize(input: {
    runId: string;
    text: string;
    toolResult: ToolResult;
  }): Promise<Action> {
    this.callCount += 1;

    if ((this.options.delayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }

    if (this.options.toolFinalMode === "fail_action") {
      return {
        type: "fail",
        code: "MODEL_FINAL_FAILED",
        message: "Fake model requested failure during finalization.",
        retryable: false
      };
    }

    if (this.options.toolFinalMode === "empty") {
      return {
        type: "final",
        text: ""
      };
    }

    if (input.toolResult.status === "error") {
      return {
        type: "fail",
        code: input.toolResult.error.code,
        message: input.toolResult.error.message,
        retryable: input.toolResult.error.retryable
      };
    }

    if (input.toolResult.toolName === "filesystem.search" && input.toolResult.status === "success") {
      if (input.toolResult.output.kind === "search_inline") {
        const paths = input.toolResult.output.workingSet.items.map((item) => item.path).join(", ");
        return {
          type: "final",
          text:
            input.toolResult.output.workingSet.items.length === 0
              ? `No matches found for ${input.text}.`
              : `Search ${input.text}: ${paths}`
        };
      }

      const paths = input.toolResult.output.workingSet.items.map((item) => item.path).join(", ");
      return {
        type: "final",
        text: `Search ${input.text}: ${paths}. Full search results stored as artifact ${input.toolResult.output.artifactId}.`
      };
    }

    if (input.toolResult.toolName === "filesystem.patch" && input.toolResult.status === "success") {
      return {
        type: "final",
        text: `Patched ${input.toolResult.output.result.path} with status ${input.toolResult.output.result.status}.`
      };
    }

    if (input.toolResult.toolName === "filesystem.write" && input.toolResult.status === "success") {
      return {
        type: "final",
        text: `Wrote ${input.toolResult.output.result.path} with mode ${input.toolResult.output.result.mode}.`
      };
    }

    if (input.toolResult.toolName === "shell.execute" && input.toolResult.status === "success") {
      const exitCodeLabel = input.toolResult.output.result.exitCode === null ? "null" : String(input.toolResult.output.result.exitCode);
      return {
        type: "final",
        text:
          input.toolResult.output.result.exitCode === 0
            ? `Verification command passed with exit code ${exitCodeLabel}.`
            : `Verification command failed with exit code ${exitCodeLabel}.`
      };
    }

    if (input.toolResult.toolName === "filesystem.read" && input.toolResult.status === "success") {
      if (input.toolResult.output.kind === "inline_text") {
        return {
          type: "final",
          text: `Read ${input.toolResult.output.path}: ${input.toolResult.output.content}`
        };
      }

      if (input.toolResult.output.reason === "large_file") {
        return {
          type: "final",
          text: `Large file ${input.toolResult.output.path} stored as artifact ${input.toolResult.output.artifactId}. Preview: ${input.toolResult.output.previewText ?? ""}`.trim()
        };
      }

      return {
        type: "final",
        text: `Binary file ${input.toolResult.output.path} stored as artifact ${input.toolResult.output.artifactId}.`
      };
    }

    return {
      type: "final",
      text: `${input.toolResult.toolName} completed.`
    };
  }

  public async nextAction(input: {
    runId: string;
    goal: string;
    constraints: string[];
    successCriteria: string[];
    ledger: ProgressLedger;
    workingSet: WorkingSet | null;
    recentToolResult: ToolResult | null;
    recentValidationResult: ValidationResult | null;
    validationRequest?: TaskValidationRequest;
    budget: AgentBudget;
    usage: AgentBudgetUsage;
    availableTools: ToolName[];
    regroundRequested: boolean;
    replanRequested: boolean;
    contextSnapshot?: ContextSnapshot;
    strategyContext?: StrategyPromptContext;
    builderContext?: BuilderPromptContext;
    planningPolicyContext?: PlanningPolicyContext | null;
    executionPlanRepairContext?: ExecutionPlanRepairContext | null;
    lastModelError?: ModelActionRejection | null;
  }): Promise<AgentAction> {
    this.lastModelError = input.lastModelError ?? null;
    this.lastStrategyContext = input.strategyContext ?? null;
    this.lastBuilderContext = input.builderContext ?? null;
    this.lastPlanningPolicyContext = input.planningPolicyContext ?? null;
    this.lastExecutionPlanRepairContext = input.executionPlanRepairContext ?? null;
    this.lastValidationFailureSummary = input.recentValidationResult?.failureSummary ?? null;
    this.modelErrors.push(this.lastModelError);
    this.strategyContexts.push(this.lastStrategyContext);
    this.builderContexts.push(this.lastBuilderContext);
    this.validationFailureSummaries.push(this.lastValidationFailureSummary);
    void input;
    this.callCount += 1;

    if ((this.options.delayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }

    const rawResponse = this.options.agentRawResponses?.[this.agentScriptIndex];
    if (rawResponse !== undefined) {
      this.agentScriptIndex += 1;
      // Return parsed JSON WITHOUT AgentActionSchema validation so the runner's parse
      // is the gate that fails (mirrors how the real provider returns unknown).
      return JSON.parse(rawResponse) as AgentAction;
    }

    const scriptedAction = this.options.agentActions?.[this.agentScriptIndex];
    if (scriptedAction !== undefined) {
      this.agentScriptIndex += 1;
      return scriptedAction;
    }

    return {
      type: "fail",
      code: "AGENT_SCRIPT_EXHAUSTED",
      message: "Fake agent script ran out of actions.",
      retryable: false
    };
  }
}
