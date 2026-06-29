import { AgentActionSchema, ActionSchema, computeArtifactHash } from "../../contracts/src/index.js";
import type {
  AgentAction,
  AgentBudget,
  AgentBudgetUsage,
  Action,
  ProgressLedger,
  TaskPatchRequest,
  TaskValidationRequest,
  ToolResult,
  ValidationResult,
  WorkingSet
} from "../../contracts/src/index.js";
import type { ToolName } from "../../contracts/src/tool-call.js";
import type { ModelActionRejection } from "./model-provider.js";
import { buildAgentActionSchemaText, buildPlanActionSchemaText } from "./model-tool-definition.js";
import type {
  AgentLoopModelProvider,
  ModelProvider,
  ToolModeModelProvider
} from "./model-provider.js";

export class ModelConfigError extends Error {
  public readonly code = "MODEL_CONFIG_ERROR";
  public constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

export class ModelHttpError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "ModelHttpError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class ModelTimeoutError extends Error {
  public readonly code = "MODEL_TIMEOUT";
  public readonly retryable = true;
  public constructor(message: string) {
    super(message);
    this.name = "ModelTimeoutError";
  }
}

export class ModelJsonParseError extends Error {
  public readonly code = "MODEL_JSON_PARSE_ERROR";
  public readonly retryable = false;
  public constructor(message: string) {
    super(message);
    this.name = "ModelJsonParseError";
  }
}

export type OpenAICompatibleConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxProviderRetries: number;
};

export type OpenAICompatibleProviderOptions = Omit<OpenAICompatibleConfig, "maxProviderRetries"> & {
  fetchImpl?: typeof fetch;
  maxProviderRetries?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PROVIDER_RETRIES = 2;

export function resolveOpenAICompatibleConfig(env: Record<string, string | undefined>): OpenAICompatibleConfig {
  const baseUrl = env.NEXORA_MODEL_BASE_URL?.trim();
  const apiKey = env.NEXORA_MODEL_API_KEY?.trim();
  const model = env.NEXORA_MODEL_NAME?.trim();
  const timeoutMsRaw = env.NEXORA_MODEL_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutMsRaw === undefined || timeoutMsRaw.length === 0 ? DEFAULT_TIMEOUT_MS : parseTimeout(timeoutMsRaw);
  const maxProviderRetriesRaw = env.NEXORA_MODEL_MAX_PROVIDER_RETRIES?.trim();
  const maxProviderRetries = maxProviderRetriesRaw === undefined || maxProviderRetriesRaw.length === 0 ? DEFAULT_MAX_PROVIDER_RETRIES : parseNonNegativeInt(maxProviderRetriesRaw, "NEXORA_MODEL_MAX_PROVIDER_RETRIES");

  const missing: string[] = [];
  if (baseUrl === undefined || baseUrl.length === 0) {
    missing.push("NEXORA_MODEL_BASE_URL");
  }
  if (apiKey === undefined || apiKey.length === 0) {
    missing.push("NEXORA_MODEL_API_KEY");
  }
  if (model === undefined || model.length === 0) {
    missing.push("NEXORA_MODEL_NAME");
  }
  if (missing.length > 0) {
    throw new ModelConfigError(`OpenAI-compatible provider is not configured. Missing: ${missing.join(", ")}.`);
  }

  return { baseUrl: baseUrl as string, apiKey: apiKey as string, model: model as string, timeoutMs, maxProviderRetries };
}

function parseTimeout(rawValue: string): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ModelConfigError(`NEXORA_MODEL_TIMEOUT_MS must be a positive number, got: ${rawValue}.`);
  }
  return Math.floor(parsed);
}

function parseNonNegativeInt(rawValue: string, name: string): number {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ModelConfigError(`${name} must be a non-negative integer, got: ${rawValue}.`);
  }
  return parsed;
}

export class OpenAICompatibleProvider implements ModelProvider, ToolModeModelProvider, AgentLoopModelProvider {
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (options.apiKey.length === 0) {
      throw new ModelConfigError("OpenAI-compatible provider requires a non-empty API key.");
    }
  }

  public async generate(input: { runId: string; text: string }): Promise<{
    text: string;
    provider: string;
    model: string;
  }> {
    const content = await this.chatCompletion([
      { role: "user", content: input.text }
    ]);
    return { text: content, provider: "openai-compatible", model: this.options.model };
  }

  public async plan(input: {
    runId: string;
    text: string;
    filePath?: string;
    searchQuery?: string;
    patchRequest?: TaskPatchRequest;
    validationRequest?: TaskValidationRequest;
  }): Promise<Action> {
    const prompt = buildPlanPrompt(input);
    const json = await this.chatCompletionJson(prompt);
    return ActionSchema.parse(json);
  }

  public async finalize(input: {
    runId: string;
    text: string;
    toolResult: ToolResult;
  }): Promise<Action> {
    const prompt = buildFinalizePrompt(input);
    const json = await this.chatCompletionJson(prompt);
    return ActionSchema.parse(json);
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
    lastModelError?: ModelActionRejection | null;
  }): Promise<AgentAction> {
    const prompt = buildNextActionPrompt(input);
    const json = await this.chatCompletionJson(prompt, () => {
      input.usage.providerRetryCount += 1;
    });
    return AgentActionSchema.parse(json);
  }

  private async chatCompletion(messages: Array<{ role: string; content: string }>, onRetry?: (attempt: number) => void): Promise<string> {
    const { body } = await this.postChatCompletion(messages, onRetry);
    const parsed = body as OpenAIChatResponse;
    const choice = parsed.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new ModelJsonParseError("Model response did not include a non-empty content string.");
    }
    return content;
  }

  private async chatCompletionJson(prompt: string, onRetry?: (attempt: number) => void): Promise<unknown> {
    const content = await this.chatCompletion([{ role: "user", content: prompt }], onRetry);
    return parseJsonFromModel(content);
  }

  private async postChatCompletion(messages: Array<{ role: string; content: string }>, onRetry?: (attempt: number) => void): Promise<{ body: unknown; attempts: number }> {
    const maxProviderRetries = this.options.maxProviderRetries ?? DEFAULT_MAX_PROVIDER_RETRIES;
    const maxAttempts = Math.max(1, maxProviderRetries + 1);
    let attempts = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      attempts += 1;
      try {
        const body = await this.singleChatCompletionRequest(messages);
        return { body, attempts };
      } catch (error) {
        const retryable = isProviderRetryable(error);
        if (!retryable || attempt === maxAttempts - 1) {
          throw error;
        }
        if (onRetry !== undefined) {
          onRetry(attempt + 1);
        }
        await sleep(PROVIDER_BACKOFF_MS[attempt] ?? PROVIDER_BACKOFF_MS[PROVIDER_BACKOFF_MS.length - 1]!);
      }
    }
    // Unreachable; satisfy TS.
    throw new ModelHttpError("MODEL_NETWORK_ERROR", "Provider retry loop exhausted.", true);
  }

  private async singleChatCompletionRequest(messages: Array<{ role: string; content: string }>): Promise<unknown> {
    const url = joinUrl(this.options.baseUrl, "/chat/completions");
    const body = JSON.stringify({
      model: this.options.model,
      messages,
      temperature: 0
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.options.apiKey}`
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === "AbortError") {
        throw new ModelTimeoutError(`Model request timed out after ${String(this.options.timeoutMs)}ms.`);
      }
      throw new ModelHttpError("MODEL_NETWORK_ERROR", "Network error while contacting the model endpoint.", true);
    }
    clearTimeout(timer);

    if (!response.ok) {
      throw mapHttpError(response.status);
    }

    let rawText: string;
    try {
      rawText = await response.text();
    } catch {
      throw new ModelHttpError("MODEL_NETWORK_ERROR", "Failed to read the model response body.", true);
    }

    try {
      return JSON.parse(rawText) as unknown;
    } catch {
      throw new ModelJsonParseError("Model endpoint returned a non-JSON response body.");
    }
  }
}

const PROVIDER_BACKOFF_MS = [500, 1000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProviderRetryable(error: unknown): boolean {
  if (error instanceof ModelTimeoutError) {
    return true;
  }
  if (error instanceof ModelHttpError) {
    return error.retryable;
  }
  return false;
}

function parseJsonFromModel(content: string): unknown {
  const trimmed = content.trim();
  const fenced = extractJsonFence(trimmed);
  const candidate = fenced ?? trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as unknown;
      } catch {
        // fall through
      }
    }
    throw new ModelJsonParseError("Model did not return a valid JSON action.");
  }
}

function extractJsonFence(content: string): string | null {
  const match = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1] ?? null;
}

function joinUrl(base: string, path: string): string {
  if (base.endsWith("/")) {
    return `${base}${path.replace(/^\//, "")}`;
  }
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function mapHttpError(status: number): ModelHttpError {
  if (status === 401 || status === 403) {
    return new ModelHttpError("MODEL_AUTH_ERROR", "Model endpoint rejected the API key (auth failed).", false);
  }
  if (status === 429) {
    return new ModelHttpError("MODEL_RATE_LIMITED", "Model endpoint returned 429 (rate limited). Retry later.", true);
  }
  if (status >= 500 && status < 600) {
    return new ModelHttpError("MODEL_SERVER_ERROR", `Model endpoint returned server error ${String(status)}.`, true);
  }
  return new ModelHttpError("MODEL_HTTP_ERROR", `Model endpoint returned HTTP ${String(status)}.`, false);
}

type OpenAIChatResponse = {
  choices?: Array<{
    message?: { content?: string };
  }>;
};

function buildPlanPrompt(input: {
  runId: string;
  text: string;
  filePath?: string;
  searchQuery?: string;
  patchRequest?: TaskPatchRequest;
  validationRequest?: TaskValidationRequest;
}): string {
  const context: string[] = [`Task text: ${input.text}`];
  if (input.filePath !== undefined) {
    context.push(`File path: ${input.filePath}`);
  }
  if (input.searchQuery !== undefined) {
    context.push(`Search query: ${input.searchQuery}`);
  }
  if (input.patchRequest !== undefined) {
    context.push(`Patch request: ${JSON.stringify(input.patchRequest)}`);
  }
  if (input.validationRequest !== undefined) {
    context.push(`Validation request: ${JSON.stringify({ command: input.validationRequest.command, args: input.validationRequest.args })}`);
  }
  return [
    buildPlanActionSchemaText(["filesystem.read", "filesystem.search", "filesystem.patch", "filesystem.write", "shell.execute"]),
    ...context,
    "Return a single JSON object, no prose, no markdown fence."
  ].join("\n");
}

function buildFinalizePrompt(input: {
  runId: string;
  text: string;
  toolResult: ToolResult;
}): string {
  const toolSummary = summarizeToolResultForPrompt(input.toolResult);
  const finalizeInstructions = buildFinalizeInstructions(input.toolResult);
  return [
    "You are a finalizing model for the Nexora agent runtime.",
    "Given the tool result, decide the final action and return ONLY a JSON object matching the Action union:",
    "type Action =",
    "  | { type: \"final\"; text: string; evidenceRefs?: string[] }",
    "  | { type: \"fail\"; code: string; message: string; retryable: boolean }",
    `Task text: ${input.text}`,
    `Tool result: ${toolSummary}`,
    finalizeInstructions,
    "Return a single JSON object, no prose, no markdown fence."
  ].join("\n");
}

function buildNextActionPrompt(input: {
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
  lastModelError?: ModelActionRejection | null;
}): string {
  const ledgerSummary = JSON.stringify({
    currentStep: input.ledger.currentStep,
    completedSteps: input.ledger.completedSteps,
    failedAttempts: input.ledger.failedAttempts,
    evidenceRefs: input.ledger.evidenceRefs,
    openQuestions: input.ledger.openQuestions
  });
  const workingSetSummary = input.workingSet === null ? "null" : JSON.stringify(input.workingSet.items.map((item) => ({ path: item.path, score: item.score })));
  const toolSummary = input.recentToolResult === null ? "null" : summarizeToolResultForPrompt(input.recentToolResult);
  const repairLines = renderLastModelError(input.lastModelError ?? null);
  return [
    buildAgentActionSchemaText(input.availableTools),
    "",
    `Goal: ${input.goal}`,
    `Constraints: ${input.constraints.join("; ")}`,
    `Success criteria: ${input.successCriteria.join("; ")}`,
    `Validation request: ${
      input.validationRequest === undefined
        ? "null"
        : JSON.stringify({
            command: input.validationRequest.command,
            args: input.validationRequest.args,
            cwd: input.validationRequest.cwd,
            purpose: input.validationRequest.purpose
          })
    }`,
    `Available tools: ${input.availableTools.join(", ")}`,
    `Budget: ${JSON.stringify(input.budget)}`,
    `Usage: ${JSON.stringify(input.usage)}`,
    `Ledger: ${ledgerSummary}`,
    `Working set: ${workingSetSummary}`,
    `Recent tool result: ${toolSummary}`,
    `Recent validation status: ${input.recentValidationResult?.status ?? "null"}`,
    `Reground requested: ${String(input.regroundRequested)}`,
    `Replan requested: ${String(input.replanRequested)}`,
    ...(repairLines.length === 0 ? [] : ["", ...repairLines]),
    "Return a single JSON object, no prose, no markdown fence."
  ].join("\n");
}

function renderLastModelError(rejection: ModelActionRejection | null): string[] {
  if (rejection === null) {
    return [];
  }
  const issueLines = (rejection.issues ?? []).slice(0, 5).map((issue) => `  - ${issue.path}: ${issue.message}`);
  return [
    `Previous attempt was rejected (category: ${rejection.category}, attempt ${String(rejection.attempt)}): ${rejection.message}`,
    ...(issueLines.length === 0 ? [] : ["Issues:", ...issueLines]),
    "Fix the error above and return a valid JSON object matching the schema."
  ];
}

function summarizeToolResultForPrompt(toolResult: ToolResult): string {
  if (toolResult.status === "error") {
    return JSON.stringify({ toolName: toolResult.toolName, status: "error", code: toolResult.error.code });
  }
  if (toolResult.toolName === "filesystem.read") {
    if (toolResult.output.kind === "inline_text") {
      return JSON.stringify({
        toolName: toolResult.toolName,
        status: "success",
        kind: toolResult.output.kind,
        path: toolResult.output.path,
        mimeType: toolResult.output.mimeType,
        byteLength: toolResult.output.byteLength,
        currentHash: computeArtifactHash(toolResult.output.content),
        content: toolResult.output.content
      });
    }
    return JSON.stringify({
      toolName: toolResult.toolName,
      status: "success",
      kind: toolResult.output.kind,
      path: toolResult.output.path,
      artifactId: toolResult.output.artifactId,
      mimeType: toolResult.output.mimeType,
      byteLength: toolResult.output.byteLength,
      reason: toolResult.output.reason,
      previewText: toolResult.output.previewText ?? null
    });
  }
  if (toolResult.toolName === "filesystem.search") {
    return JSON.stringify({ toolName: toolResult.toolName, status: "success", returnedMatches: toolResult.output.result.returnedMatches });
  }
  if (toolResult.toolName === "filesystem.patch") {
    return JSON.stringify({ toolName: toolResult.toolName, status: "success", path: toolResult.output.result.path, patchStatus: toolResult.output.result.status });
  }
  if (toolResult.toolName === "filesystem.write") {
    return JSON.stringify({
      toolName: toolResult.toolName,
      status: "success",
      path: toolResult.output.result.path,
      mode: toolResult.output.result.mode,
      hash: toolResult.output.result.hash,
      created: toolResult.output.result.created
    });
  }
  if (toolResult.toolName === "shell.execute") {
    return JSON.stringify({ toolName: toolResult.toolName, status: "success", exitCode: toolResult.output.result.exitCode });
  }
  return JSON.stringify({ toolName: toolResult.toolName, status: "success" });
}

function buildFinalizeInstructions(toolResult: ToolResult): string {
  if (toolResult.status === "error") {
    return "If the tool result is an error, return a fail action that preserves the tool error.";
  }
  if (toolResult.toolName === "filesystem.read") {
    return [
      "For filesystem.read, return a final action whose text summarizes the file contents.",
      "Do not merely say that the file was read successfully.",
      "Mention the file path and the most important code or text found in the file."
    ].join(" ");
  }
  if (toolResult.toolName === "filesystem.search") {
    return "For filesystem.search, summarize the best matching files and what they imply for the task.";
  }
  if (toolResult.toolName === "filesystem.patch") {
    return "For filesystem.patch, summarize what changed and the resulting status.";
  }
  if (toolResult.toolName === "filesystem.write") {
    return "For filesystem.write, summarize what file was written, whether it was created or overwritten, and the resulting status.";
  }
  return "For shell.execute, summarize the verification outcome using the command result.";
}
