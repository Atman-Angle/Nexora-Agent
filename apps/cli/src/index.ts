import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadEnvFile, stdin, stderr, stdout } from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ModelConfigError,
  createBuiltInTools,
  createRuntime,
  openAICompatibleProviderFromEnv,
  type ApprovalDecision,
  type RecoveryDecision,
  type RunResult,
  type RuntimeProvider
} from "../../../packages/runtime/src/index.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    const parsed = parseArguments(argv);
    if (parsed.command !== "inspect") loadCliEnvironment();
    const workspace = resolve(parsed.cwd ?? process.cwd());
    const provider = parsed.command === "inspect" ? inspectionProvider : openAICompatibleProviderFromEnv();
    runtime = createRuntime({
      workspace,
      provider,
      tools: createBuiltInTools({ artifactDir: resolve(workspace, ".nexora", "artifacts") })
    });

    if (parsed.command === "inspect") {
      stdout.write(`${JSON.stringify(await runtime.inspect(parsed.runId))}\n`);
      return 0;
    }
    let result: RunResult;
    if (parsed.command === "resume") {
      result = await runtime.resume({
        runId: parsed.runId,
        ...(parsed.input === undefined ? {} : { input: parsed.input }),
        ...(parsed.approvalDecision === undefined ? {} : { approvalDecision: parsed.approvalDecision }),
        ...(parsed.recoveryDecision === undefined ? {} : { recoveryDecision: parsed.recoveryDecision })
      }, renderEvent);
    } else {
      const goal = parsed.goal ?? await prompt("What should Nexora do? ");
      result = await runtime.start({ input: goal }, renderEvent);
      if (parsed.interactive) result = await continueInteractive(runtime, result);
    }
    stdout.write(`${JSON.stringify(result)}\n`);
    return exitCode(result.status);
  } catch (error) {
    const code = error instanceof ModelConfigError ? "MODEL_CONFIG_ERROR" : "CLI_ERROR";
    stderr.write(`${JSON.stringify({ code, message: error instanceof Error ? error.message : String(error) })}\n`);
    return 64;
  } finally {
    runtime?.close();
  }
}

function loadCliEnvironment(directory = process.cwd()): void {
  const path = join(directory, ".env");
  if (existsSync(path)) loadEnvFile(path);
}

type ParsedArguments =
  | { command: "start"; goal?: string; cwd?: string; interactive: boolean }
  | { command: "resume"; runId: string; cwd?: string; input?: string; approvalDecision?: ApprovalDecision; recoveryDecision?: RecoveryDecision }
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
    const confirmed = takePairOption(values, "--confirm-succeeded");
    const failed = takeOption(values, "--confirm-failed");
    const abandon = takeOption(values, "--abandon");
    if (values.length > 0) throw new Error(`Unknown resume arguments: ${values.join(" ")}`);
    const approvalDecision = approve ? { requestId: approve, approved: true } : deny ? { requestId: deny, approved: false } : undefined;
    const recoveryDecision: RecoveryDecision | undefined = confirmed
      ? { invocationId: confirmed[0], outcome: "confirmed_succeeded", subjectRef: confirmed[1] }
      : failed ? { invocationId: failed, outcome: "confirmed_failed" }
      : abandon ? { invocationId: abandon, outcome: "abandon_run" }
      : undefined;
    return { command: "resume", runId, ...(cwd === undefined ? {} : { cwd }), ...(input === undefined ? {} : { input }), ...(approvalDecision === undefined ? {} : { approvalDecision }), ...(recoveryDecision === undefined ? {} : { recoveryDecision }) };
  }
  const goal = values.join(" ").trim();
  return { command: "start", ...(goal ? { goal } : {}), ...(cwd === undefined ? {} : { cwd }), interactive: !goal };
}

async function continueInteractive(runtime: ReturnType<typeof createRuntime>, initial: RunResult): Promise<RunResult> {
  let result = initial;
  while (result.status === "waiting") {
    const view = await runtime.inspect(result.runId);
    const request = view.snapshot.pendingRequest;
    if (request === null) return result;
    if (request.kind === "input") result = await runtime.resume({ runId: result.runId, input: await prompt(`${request.prompt}\n> `) }, renderEvent);
    else {
      const answer = (await prompt(`${request.prompt} [y/N] `)).trim().toLowerCase();
      result = await runtime.resume({ runId: result.runId, approvalDecision: { requestId: request.id, approved: answer === "y" || answer === "yes" } }, renderEvent);
    }
  }
  return result;
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

function removeFlag(values: string[], name: string): void { const index = values.indexOf(name); if (index >= 0) values.splice(index, 1); }
function renderEvent(event: { type: string; runId: string; sequence: number }): void { stderr.write(`${JSON.stringify({ event: event.type, runId: event.runId, sequence: event.sequence })}\n`); }
function exitCode(status: RunResult["status"]): number { return status === "succeeded" ? 0 : status === "waiting" ? 2 : status === "blocked" ? 3 : 4; }

const inspectionProvider: RuntimeProvider = {
  async decide() { throw new Error("Provider is unavailable in inspect mode."); },
  async validate() { throw new Error("Provider is unavailable in inspect mode."); }
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main().then((code) => { process.exitCode = code; });
}
