import {
  createEvent,
  createTextArtifact,
  type Artifact,
  type Event,
  type Run,
  type Task,
  type ValidationResult
} from "../../contracts/src/index.js";
import type { ModelProvider } from "../../model-gateway/src/index.js";
import type { ArtifactStore } from "../../storage/src/artifact-store.js";
import type { EventStore } from "../../storage/src/event-store.js";
import type { RunStore } from "../../storage/src/run-store.js";
import { transitionRun } from "./state-machine.js";
import { validateArtifactForRun } from "./validation-gate.js";

export class DirectRunFailure extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export async function runDirect(input: {
  task: Task;
  run: Run;
  now: () => string;
  idGenerator: () => string;
  modelProvider: ModelProvider;
  runStore: RunStore;
  eventStore: EventStore;
  artifactStore: ArtifactStore;
}): Promise<{
  run: Run;
  artifact: Artifact;
  validation: ValidationResult;
}> {
  let activeRun = input.run;
  let nextSequence = 1;

  const appendEvent = (type: Event["type"], payload: Record<string, unknown>, timestamp: string) =>
    input.eventStore.appendEvent(
      createEvent({
        eventId: input.idGenerator(),
        runId: activeRun.runId,
        sequence: nextSequence++,
        type,
        timestamp,
        payload
      })
    );

  await appendEvent("run.created", { status: activeRun.status }, activeRun.createdAt);

  const runningAt = input.now();
  activeRun = transitionRun(activeRun, "running", runningAt);
  input.runStore.updateRun(activeRun);
  await appendEvent("run.started", { status: activeRun.status }, runningAt);
  await appendEvent("model.started", { text: input.task.input.text }, input.now());

  try {
    const modelResult = await input.modelProvider.generate({
      runId: activeRun.runId,
      text: input.task.input.text
    });

    await appendEvent(
      "model.completed",
      {
        provider: modelResult.provider,
        model: modelResult.model
      },
      input.now()
    );

    const artifact = createTextArtifact({
      artifactId: input.idGenerator(),
      runId: activeRun.runId,
      content: modelResult.text,
      createdAt: input.now()
    });
    input.artifactStore.insertArtifact(artifact);
    await appendEvent("artifact.created", { artifactId: artifact.artifactId }, artifact.createdAt);

    const verifyingAt = input.now();
    activeRun = transitionRun(activeRun, "verifying", verifyingAt);
    input.runStore.updateRun(activeRun);

    const validation = validateArtifactForRun(activeRun, artifact);
    await appendEvent(
      "validation.completed",
      {
        status: validation.status,
        evidence: validation.evidence
      },
      input.now()
    );

    if (validation.status === "failed") {
      const failedAt = input.now();
      activeRun = transitionRun(activeRun, "failed", failedAt, "VALIDATION_FAILED");
      input.runStore.updateRun(activeRun);
      await appendEvent(
        "run.failed",
        {
          code: "VALIDATION_FAILED",
          evidence: validation.evidence
        },
        failedAt
      );
      throw new DirectRunFailure("VALIDATION_FAILED", "Validation gate rejected the artifact.", false);
    }

    const succeededAt = input.now();
    activeRun = transitionRun(activeRun, "succeeded", succeededAt);
    input.runStore.updateRun(activeRun);
    await appendEvent("run.completed", { status: activeRun.status }, succeededAt);

    return {
      run: activeRun,
      artifact,
      validation
    };
  } catch (error) {
    if (error instanceof DirectRunFailure) {
      throw error;
    }

    const failedAt = input.now();
    activeRun = transitionRun(activeRun, "failed", failedAt, "MODEL_ERROR");
    input.runStore.updateRun(activeRun);
    await appendEvent(
      "run.failed",
      {
        code: "MODEL_ERROR",
        message: error instanceof Error ? error.message : "Unknown model error"
      },
      failedAt
    );
    throw new DirectRunFailure("MODEL_ERROR", "Model provider failed to generate a response.", true);
  }
}
