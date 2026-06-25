import {
  ActionSchema,
  createEvent,
  createTextArtifact,
  type Action,
  type Artifact,
  type Event,
  type Run,
  type Task,
  type ToolResult,
  type ValidationResult
} from "../../contracts/src/index.js";
import type { ToolModeModelProvider } from "../../model-gateway/src/index.js";
import type { ArtifactStore } from "../../storage/src/artifact-store.js";
import type { EventStore } from "../../storage/src/event-store.js";
import type { RunStore } from "../../storage/src/run-store.js";
import type { ValidationResultStore } from "../../storage/src/validation-result-store.js";
import type { ToolRuntime } from "../../tool-runtime/src/index.js";
import { classifyRisk } from "../../tool-runtime/src/index.js";
import { transitionRun } from "./state-machine.js";
import { runCompletionGate, validateArtifactForRun } from "./validation-gate.js";

export class ToolModeRunFailure extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export async function runToolMode(input: {
  task: Task;
  run: Run;
  now: () => string;
  idGenerator: () => string;
  workspaceRoot: string;
  artifactRoot: string;
  modelProvider: ToolModeModelProvider;
  toolRuntime: ToolRuntime;
  runStore: RunStore;
  eventStore: EventStore;
  artifactStore: ArtifactStore;
  validationResultStore: ValidationResultStore;
}): Promise<{
  run: Run;
  artifact: Artifact;
  validation: ValidationResult;
  toolResult: ToolResult;
}> {
  let activeRun = input.run;
  let nextSequence = 1;

  const appendEvent = (type: Event["type"], payload: Record<string, unknown>, timestamp: string) =>
    Promise.resolve().then(() => {
      input.eventStore.appendEvent(
        createEvent({
          eventId: input.idGenerator(),
          runId: activeRun.runId,
          sequence: nextSequence,
          type,
          timestamp,
          payload
        })
      );
      nextSequence += 1;
    });

  await appendEvent("run.created", { status: activeRun.status }, activeRun.createdAt);
  const runningAt = input.now();
  activeRun = transitionRun(activeRun, "running", runningAt);
  input.runStore.updateRun(activeRun);
  await appendEvent("run.started", { status: activeRun.status }, runningAt);

  let plannedAction: Action;
  try {
    plannedAction = ActionSchema.parse(
      await input.modelProvider.plan({
        runId: activeRun.runId,
        text: input.task.input.text,
        ...(input.task.input.filePath === undefined ? {} : { filePath: input.task.input.filePath }),
        ...(input.task.input.searchQuery === undefined ? {} : { searchQuery: input.task.input.searchQuery }),
        ...(input.task.input.patchRequest === undefined ? {} : { patchRequest: input.task.input.patchRequest }),
        ...(input.task.input.validationRequest === undefined
          ? {}
          : { validationRequest: input.task.input.validationRequest })
      })
    );
  } catch {
    return failRun(input, activeRun, appendEvent, "MODEL_ACTION_INVALID", "Model produced an invalid planning action.", false);
  }

  await appendEvent("model.action.generated", { type: plannedAction.type }, input.now());
  if (plannedAction.type !== "tool_call") {
    if (plannedAction.type === "fail") {
      return failRun(input, activeRun, appendEvent, plannedAction.code, plannedAction.message, plannedAction.retryable);
    }

    return failRun(input, activeRun, appendEvent, "MODEL_ACTION_INVALID", "Model must return tool_call during planning.", false);
  }

  const waitingAt = input.now();
  activeRun = transitionRun(activeRun, "waiting_for_tool", waitingAt);
  input.runStore.updateRun(activeRun);
  await appendEvent(
    "tool.started",
    {
      toolName: plannedAction.toolCall.toolName,
      risk: classifyRisk(plannedAction.toolCall.toolName)
    },
    waitingAt
  );
  if (plannedAction.toolCall.toolName === "shell.execute") {
    await appendEvent(
      "command.started",
      {
        command: plannedAction.toolCall.input.command,
        args: plannedAction.toolCall.input.args,
        cwd: plannedAction.toolCall.input.cwd
      },
      waitingAt
    );
  }

  const toolExecution = await input.toolRuntime.execute({
    runId: activeRun.runId,
    toolCall: plannedAction.toolCall,
    workspaceRoot: input.workspaceRoot,
    artifactRoot: input.artifactRoot,
    now: input.now,
    idGenerator: input.idGenerator
  });

  if (toolExecution.toolResult.status === "error") {
    if (plannedAction.toolCall.toolName === "shell.execute") {
      await appendEvent(
        "command.failed",
        {
          command: plannedAction.toolCall.input.command,
          error: toolExecution.toolResult.error
        },
        input.now()
      );
    }
    await appendEvent("tool.failed", { error: toolExecution.toolResult.error }, input.now());
    return failRun(
      input,
      activeRun,
      appendEvent,
      toolExecution.toolResult.error.code,
      toolExecution.toolResult.error.message,
      toolExecution.toolResult.error.retryable
    );
  }

  if (toolExecution.artifacts !== undefined) {
    for (const artifact of toolExecution.artifacts) {
      await appendEvent("artifact.created", { artifactId: artifact.artifactId }, artifact.createdAt);
    }
  }

  if (toolExecution.toolResult.toolName === "filesystem.search" && toolExecution.toolResult.status === "success") {
    await appendEvent(
      "search.completed",
      {
        returnedMatches: toolExecution.toolResult.output.result.returnedMatches,
        truncated: toolExecution.toolResult.output.result.truncated
      },
      input.now()
    );
    await appendEvent(
      "working-set.built",
      {
        itemCount: toolExecution.toolResult.output.workingSet.itemCount
      },
      input.now()
    );
  }

  if (toolExecution.toolResult.toolName === "filesystem.patch" && toolExecution.toolResult.status === "success") {
    await appendEvent(
      "patch.applied",
      {
        path: toolExecution.toolResult.output.result.path,
        status: toolExecution.toolResult.output.result.status,
        changed: toolExecution.toolResult.output.result.changed
      },
      input.now()
    );
    await appendEvent(
      "tool.completed",
      {
        kind: toolExecution.toolResult.output.kind
      },
      input.now()
    );
  } else if (toolExecution.toolResult.toolName === "shell.execute" && toolExecution.toolResult.status === "success") {
    await appendEvent(
      "command.completed",
      {
        exitCode: toolExecution.toolResult.output.result.exitCode,
        timedOut: toolExecution.toolResult.output.result.timedOut,
        cancelled: toolExecution.toolResult.output.result.cancelled
      },
      input.now()
    );
    await appendEvent(
      "tool.completed",
      {
        kind: toolExecution.toolResult.output.kind
      },
      input.now()
    );
  } else {
    await appendEvent(
      "tool.completed",
      {
        kind: toolExecution.toolResult.output.kind
      },
      input.now()
    );
  }

  const resumedAt = input.now();
  activeRun = transitionRun(activeRun, "running", resumedAt);
  input.runStore.updateRun(activeRun);

  let finalAction: Action;
  try {
    finalAction = ActionSchema.parse(
      await input.modelProvider.finalize({
        runId: activeRun.runId,
        text: input.task.input.text,
        toolResult: toolExecution.toolResult
      })
    );
  } catch {
    return failRun(input, activeRun, appendEvent, "MODEL_FINAL_INVALID", "Model produced an invalid final action.", false);
  }

  if (finalAction.type === "fail") {
    await appendEvent("model.completed", { phase: "final", type: "fail" }, input.now());
    return failRun(input, activeRun, appendEvent, finalAction.code, finalAction.message, finalAction.retryable);
  }

  if (finalAction.type !== "final") {
    return failRun(input, activeRun, appendEvent, "MODEL_FINAL_INVALID", "Model must return final after tool execution.", false);
  }

  await appendEvent("model.completed", { phase: "final", type: "final" }, input.now());

  const artifact = createTextArtifact({
    artifactId: input.idGenerator(),
    runId: activeRun.runId,
    content: finalAction.text,
    createdAt: input.now()
  });
  input.artifactStore.insertArtifact(artifact);
  await appendEvent("artifact.created", { artifactId: artifact.artifactId }, artifact.createdAt);

  const verifyingAt = input.now();
  activeRun = transitionRun(activeRun, "verifying", verifyingAt);
  input.runStore.updateRun(activeRun);
  await appendEvent("validation.started", { status: activeRun.status }, verifyingAt);

  const validation =
    input.task.input.validationRequest !== undefined && toolExecution.toolResult.toolName === "shell.execute"
      ? (
          await runCompletionGate({
            run: activeRun,
            task: input.task,
            toolResult: toolExecution.toolResult,
            finalArtifact: artifact,
            artifacts: [
              artifact,
              ...(toolExecution.artifacts ?? [])
            ],
            now: input.now(),
            idGenerator: input.idGenerator
          })
        ).validation
      : validateArtifactForRun(activeRun, artifact);
  input.validationResultStore.upsertValidationResult({
    runId: activeRun.runId,
    result: validation,
    createdAt: input.now()
  });
  await appendEvent("validation.completed", { status: validation.status, evidence: validation.evidence }, input.now());
  if (validation.status === "failed") {
    return failRun(input, activeRun, appendEvent, "VALIDATION_FAILED", "Validation gate rejected the final artifact.", false);
  }

  const succeededAt = input.now();
  activeRun = transitionRun(activeRun, "succeeded", succeededAt);
  input.runStore.updateRun(activeRun);
  await appendEvent("run.completed", { status: activeRun.status }, succeededAt);

  return {
    run: activeRun,
    artifact,
    validation,
    toolResult: toolExecution.toolResult
  };
}

async function failRun(
  input: {
    now: () => string;
    runStore: RunStore;
  },
  activeRun: Run,
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => Promise<void>,
  code: string,
  message: string,
  retryable: boolean
): Promise<never> {
  const failedAt = input.now();
  const failedRun = transitionRun(activeRun, "failed", failedAt, code);
  input.runStore.updateRun(failedRun);
  await appendEvent("run.failed", { code, message }, failedAt);
  throw new ToolModeRunFailure(code, message, retryable);
}
