import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadEnvFile, stdin, stderr, stdout } from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ModelConfigError,
  DEFAULT_RUNTIME_BUDGETS,
  createBuiltInTools,
  createAgent,
  createAgentProfileSnapshot,
  openAICompatibleProviderFromEnv,
  type ApprovalDecision,
  type CompletionRequirements,
  type RecoveryDecision,
  type RuntimeBudgetExtension,
  type RuntimeBudgets,
  type RunHandle,
  type RunInspection,
  type RuntimeEvent,
  type RuntimeProvider
} from "../../../packages/harness/src/index.js";

const CLI_AGENT_PROFILE = createAgentProfileSnapshot({
  schemaVersion: 1,
  id: "nexora-workspace-agent",
  version: "1",
  role: {
    identity: "Workspace development agent",
    objective: "Complete the user's workspace task while preserving repository contracts."
  },
  strategy: {
    principles: [
      "Inspect current workspace facts and existing conventions before changing files.",
      "Keep changes scoped to the requested outcome.",
      "Verify changed behavior proportionately."
    ]
  },
  communication: { audience: "Software project contributors", tone: "Direct and factual" }
}, { kind: "host", ref: "apps/cli" });

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let runtime: ReturnType<typeof createAgent> | undefined;
  try {
    const parsed = parseArguments(argv);
    if (parsed.command !== "inspect") loadCliEnvironment();
    const workspace = resolve(parsed.cwd ?? process.cwd());
    const provider = parsed.command === "inspect" ? inspectionProvider : openAICompatibleProviderFromEnv();
    runtime = createAgent({
      workspace,
      provider,
      profile: CLI_AGENT_PROFILE,
      tools: createBuiltInTools({ artifactDir: resolve(workspace, ".nexora", "artifacts") })
    });

    if (parsed.command === "inspect") {
      stdout.write(`${JSON.stringify(await runtime.inspect(parsed.runId))}\n`);
      return 0;
    }
    let run: RunHandle;
    let inspection: RunInspection;
    if (parsed.command === "resume") {
      run = runtime.openRun(parsed.runId);
      run.subscribe(renderEvent);
      if (parsed.input !== undefined) {
        await run.input(parsed.input);
      } else if (parsed.approvalDecision?.approved === true) {
        await run.approve({ requestId: parsed.approvalDecision.requestId });
      } else if (parsed.approvalDecision?.approved === false) {
        await run.deny({
          requestId: parsed.approvalDecision.requestId,
          ...(parsed.approvalDecision.reason === undefined
            ? {}
            : { reason: parsed.approvalDecision.reason })
        });
      } else {
        const current = await run.inspect();
        if (current.status === "blocked" || current.status === "running") {
          await run.resume({
            ...(parsed.budgetExtension === undefined
              ? {}
              : { budgetExtension: parsed.budgetExtension }),
            ...(parsed.recoveryDecision === undefined
              ? {}
              : { recovery: parsed.recoveryDecision })
          });
        } else if (parsed.recoveryDecision !== undefined) {
          throw new Error("Recovery requires a blocked or interrupted Run.");
        }
      }
      inspection = await run.wait();
    } else {
      const goal = parsed.goal ?? await prompt("What should Nexora do? ");
      run = runtime.run(goal, {
        ...(parsed.budgets === undefined ? {} : { budgets: parsed.budgets }),
        ...(parsed.completion === undefined ? {} : { completion: parsed.completion })
      });
      run.subscribe(renderEvent);
      inspection = await run.wait();
      if (parsed.interactive) {
        inspection = await continueInteractive(run, inspection);
      }
    }
    const result = toCliResult(inspection);
    stdout.write(`${JSON.stringify(result)}\n`);
    return exitCode(result.status);
  } catch (error) {
    const code = error instanceof ModelConfigError ? "MODEL_CONFIG_ERROR" : "CLI_ERROR";
    stderr.write(`${JSON.stringify({ code, message: error instanceof Error ? error.message : String(error) })}\n`);
    return 64;
  } finally {
    await runtime?.close();
  }
}

function loadCliEnvironment(directory = process.cwd()): void {
  const path = join(directory, ".env");
  if (existsSync(path)) loadEnvFile(path);
}

type ParsedArguments =
  | { command: "start"; goal?: string; cwd?: string; interactive: boolean; budgets?: RuntimeBudgets; completion?: CompletionRequirements }
  | { command: "resume"; runId: string; cwd?: string; input?: string; approvalDecision?: ApprovalDecision; recoveryDecision?: RecoveryDecision; budgetExtension?: RuntimeBudgetExtension }
  | { command: "inspect"; runId: string; cwd?: string };

function parseArguments(argv: string[]): ParsedArguments {
  const values = [...argv];
  const cwd = takeOption(values, "--cwd");
  removeFlag(values, "--json");
  if (values[0] === "inspect") {
    if (values.length !== 2 || !values[1]?.trim()) throw new Error("Usage: nexora inspect <run-id> [--cwd <path>] [--json]");
    return { command: "inspect", runId: values[1], ...(cwd === undefined ? {} : { cwd }) };
  }
  if (values[0] === "resume") {
    const runId = values[1];
    if (!runId?.trim()) throw new Error("Usage: nexora resume <run-id> [options]");
    values.splice(0, 2);
    const input = takeOption(values, "--input");
    const approve = takeOption(values, "--approve");
    const deny = takeOption(values, "--deny");
    const reason = takeOption(values, "--reason");
    const confirmed = takePairOption(values, "--confirm-succeeded");
    const failed = takeOption(values, "--confirm-failed");
    const abandon = takeOption(values, "--abandon");
    const budgetExtension = budgetExtensionOptions(values);
    if (values.length > 0) throw new Error(`Unknown resume arguments: ${values.join(" ")}`);
    if (reason !== undefined && deny === undefined) throw new Error("--reason requires --deny.");
    const approvalDecision = approve
      ? { requestId: approve, approved: true }
      : deny && reason ? { requestId: deny, approved: false, reason }
      : deny ? { requestId: deny, approved: false }
      : undefined;
    const recoveryDecision: RecoveryDecision | undefined = confirmed
      ? { invocationId: confirmed[0], outcome: "confirmed_succeeded", subjectRef: confirmed[1] }
      : failed ? { invocationId: failed, outcome: "confirmed_failed" }
      : abandon ? { invocationId: abandon, outcome: "abandon_run" }
      : undefined;
    return { command: "resume", runId, ...(cwd === undefined ? {} : { cwd }), ...(input === undefined ? {} : { input }), ...(approvalDecision === undefined ? {} : { approvalDecision }), ...(recoveryDecision === undefined ? {} : { recoveryDecision }), ...(budgetExtension === undefined ? {} : { budgetExtension }) };
  }
  const directAnswer = removeFlag(values, "--direct-answer");
  const requiredToolNames = takeOptions(values, "--require-tool");
  const budgets = runtimeBudgetOptions(values);
  if (directAnswer && requiredToolNames.length > 0) throw new Error("--direct-answer cannot be combined with --require-tool.");
  const completion: CompletionRequirements | undefined = directAnswer
    ? { evidence: "optional", requiredToolNames: [] }
    : requiredToolNames.length > 0
      ? { evidence: "required", requiredToolNames }
      : undefined;
  const goal = values.join(" ").trim();
  return { command: "start", ...(goal ? { goal } : {}), ...(cwd === undefined ? {} : { cwd }), interactive: Boolean(stdin.isTTY), ...(budgets === undefined ? {} : { budgets }), ...(completion === undefined ? {} : { completion }) };
}

async function continueInteractive(
  run: RunHandle,
  initial: RunInspection
): Promise<RunInspection> {
  let inspection = initial;
  while (
    inspection.status === "waiting_for_input"
    || inspection.status === "waiting_for_approval"
  ) {
    const request = inspection.pendingRequest;
    if (request === null) return inspection;
    if (request.kind === "input") {
      await run.input(
        await prompt(`${request.prompt}\n> `),
        { requestId: request.id }
      );
    }
    else {
      const answer = (await prompt(
        `${request.prompt}\n${JSON.stringify({
          toolName: request.toolName,
          stepId: request.stepId,
          input: request.input
        })}\nApprove? [y/N] `
      )).trim().toLowerCase();
      const approved = answer === "y" || answer === "yes";
      const reason = approved ? "" : (await prompt("Why reject? (optional) ")).trim();
      if (approved) await run.approve({ requestId: request.id });
      else {
        await run.deny({
          requestId: request.id,
          ...(reason ? { reason } : {})
        });
      }
    }
    inspection = await run.wait();
  }
  return inspection;
}

async function prompt(question: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  try { return await reader.question(question); } finally { reader.close(); }
}

function takeOption(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (!value?.trim()) throw new Error(`${name} requires a value.`);
  values.splice(index, 2);
  return value;
}

function takePairOption(values: string[], name: string): [string, string] | undefined {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const first = values[index + 1]; const second = values[index + 2];
  if (!first?.trim() || !second?.trim()) throw new Error(`${name} requires invocation ID and subject reference.`);
  values.splice(index, 3);
  return [first, second];
}

function removeFlag(values: string[], name: string): boolean { const index = values.indexOf(name); if (index < 0) return false; values.splice(index, 1); return true; }

function takeOptions(values: string[], name: string): string[] {
  const output: string[] = [];
  while (values.includes(name)) output.push(takeOption(values, name)!);
  return output;
}

function takePositiveIntegerOption(values: string[], name: string): number | undefined {
  const raw = takeOption(values, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} requires a positive safe integer.`);
  return value;
}

function runtimeBudgetOptions(values: string[]): RuntimeBudgets | undefined {
  const maxIterations = takePositiveIntegerOption(values, "--max-iterations");
  const maxModelCalls = takePositiveIntegerOption(values, "--max-model-calls");
  const maxToolCalls = takePositiveIntegerOption(values, "--max-tool-calls");
  const maxRetries = takePositiveIntegerOption(values, "--max-retries");
  const maxDurationMs = takePositiveIntegerOption(values, "--max-duration-ms");
  if ([maxIterations, maxModelCalls, maxToolCalls, maxRetries, maxDurationMs].every((value) => value === undefined)) return undefined;
  return {
    maxIterations: maxIterations ?? DEFAULT_RUNTIME_BUDGETS.maxIterations,
    maxModelCalls: maxModelCalls ?? DEFAULT_RUNTIME_BUDGETS.maxModelCalls,
    maxToolCalls: maxToolCalls ?? DEFAULT_RUNTIME_BUDGETS.maxToolCalls,
    maxRetries: maxRetries ?? DEFAULT_RUNTIME_BUDGETS.maxRetries,
    maxDurationMs: maxDurationMs ?? DEFAULT_RUNTIME_BUDGETS.maxDurationMs
  };
}

function budgetExtensionOptions(values: string[]): RuntimeBudgetExtension | undefined {
  const iterations = takePositiveIntegerOption(values, "--add-iterations");
  const modelCalls = takePositiveIntegerOption(values, "--add-model-calls");
  const toolCalls = takePositiveIntegerOption(values, "--add-tool-calls");
  const retries = takePositiveIntegerOption(values, "--add-retries");
  if ([iterations, modelCalls, toolCalls, retries].every((value) => value === undefined)) return undefined;
  return {
    ...(iterations === undefined ? {} : { iterations }),
    ...(modelCalls === undefined ? {} : { modelCalls }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(retries === undefined ? {} : { retries })
  };
}
function renderEvent(event: RuntimeEvent): void { stderr.write(`${JSON.stringify({ event: event.type, runId: event.runId, sequence: event.sequence })}\n`); }

function toCliResult(inspection: RunInspection): {
  readonly runId: string;
  readonly status:
    | "running"
    | "waiting"
    | "blocked"
    | "cancelled"
    | "failed"
    | "succeeded";
  readonly stopReason: string | null;
  readonly summary: string | null;
  readonly resultArtifact: string | null;
  readonly evidence: RunInspection["evidence"];
  readonly lastError: RunInspection["error"];
} {
  const status = inspection.status === "waiting_for_input"
    || inspection.status === "waiting_for_approval"
    ? "waiting"
    : inspection.status;
  return {
    runId: inspection.runId,
    status,
    stopReason: inspection.stopReason,
    summary: inspection.result?.summary ?? null,
    resultArtifact: inspection.result?.resultArtifact ?? null,
    evidence: inspection.evidence,
    lastError: inspection.error
  };
}

function exitCode(status: ReturnType<typeof toCliResult>["status"]): number { return status === "succeeded" ? 0 : status === "waiting" ? 2 : status === "blocked" ? 3 : 4; }

const inspectionProvider: RuntimeProvider = {
  async decide() { throw new Error("Provider is unavailable in inspect mode."); }
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main().then((code) => { process.exitCode = code; });
}
