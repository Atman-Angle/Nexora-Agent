import { readFile } from "node:fs/promises";

import {
  ArtifactSchema,
  EvidenceSchema,
  TestResultSchema,
  ValidationPlanSchema,
  computeArtifactHash,
  type Artifact,
  type Evidence,
  type Run,
  type Task,
  type TestResult,
  type ToolResult,
  ValidationResultSchema,
  type ValidationResult
} from "../../contracts/src/index.js";

export function validateArtifactForRun(run: Run, artifact: Artifact | null): ValidationResult {
  const evidence: ValidationResult["evidence"] = [];

  if (artifact === null) {
    evidence.push({
      code: "ARTIFACT_MISSING",
      message: "Artifact must exist before the run can succeed."
    });
  } else {
    const parsedArtifact = ArtifactSchema.parse(artifact);

    if (parsedArtifact.runId !== run.runId) {
      evidence.push({
        code: "ARTIFACT_RUN_MISMATCH",
        message: "Artifact must belong to the current run."
      });
    }

    if (parsedArtifact.type !== "text" || parsedArtifact.mimeType !== "text/plain") {
      evidence.push({
        code: "ARTIFACT_TYPE_INVALID",
        message: "Artifact must be plain text."
      });
    }

    if (parsedArtifact.content.trim().length === 0) {
      evidence.push({
        code: "ARTIFACT_CONTENT_EMPTY",
        message: "Artifact content must be non-empty."
      });
    }

    const recomputedHash = computeArtifactHash(parsedArtifact.content);
    if (recomputedHash !== parsedArtifact.hash) {
      evidence.push({
        code: "ARTIFACT_HASH_MISMATCH",
        message: "Artifact hash must match the persisted content."
      });
    }
  }

  return ValidationResultSchema.parse({
    status: evidence.length === 0 ? "passed" : "failed",
    evidence
  });
}

export async function runCompletionGate(input: {
  run: Run;
  task: Task;
  toolResult: ToolResult;
  finalArtifact: Artifact | null;
  artifacts: Artifact[];
  now: string;
  idGenerator: () => string;
}): Promise<{
  validation: ValidationResult;
  testResult: TestResult;
  evidenceRecords: Evidence[];
}> {
  const baseValidation = validateArtifactForRun(input.run, input.finalArtifact);
  const evidence = [...baseValidation.evidence];
  const validationRequest = input.task.input.validationRequest;
  const executedValidatorIds: string[] = [];

  if (validationRequest === undefined) {
    evidence.push({
      code: "VALIDATION_PLAN_MISSING",
      message: "Validation request and plan must exist."
    });
  }

  if (validationRequest !== undefined) {
    const parsedPlan = ValidationPlanSchema.parse(validationRequest.validationPlan);
    if (parsedPlan.validators.length === 0) {
      evidence.push({
        code: "VALIDATION_PLAN_EMPTY",
        message: "Validation plan must include at least one validator."
      });
    }
  }

  if (input.toolResult.toolName !== "shell.execute" || input.toolResult.status !== "success") {
    evidence.push({
      code: "VALIDATION_TOOL_RESULT_INVALID",
      message: "Completion Gate requires a successful shell.execute result."
    });
  }

  const commandResult =
    input.toolResult.toolName === "shell.execute" && input.toolResult.status === "success"
      ? input.toolResult.output.result
      : null;

  const artifactRefs = [commandResult?.stdoutArtifactRef, commandResult?.stderrArtifactRef].filter(
    (artifactRef): artifactRef is string => artifactRef !== undefined
  );
  for (const artifactRef of artifactRefs) {
    const artifact = input.artifacts.find((candidate) => candidate.artifactId === artifactRef);
    if (artifact === undefined) {
      evidence.push({
        code: "EVIDENCE_ARTIFACT_MISSING",
        message: `Artifact ${artifactRef} referenced by evidence was not found.`
      });
      continue;
    }

    if (artifact.runId !== input.run.runId) {
      evidence.push({
        code: "EVIDENCE_RUN_MISMATCH",
        message: `Artifact ${artifactRef} does not belong to the current run.`
      });
      continue;
    }

    if (artifact.filePath === undefined) {
      evidence.push({
        code: "EVIDENCE_ARTIFACT_INVALID",
        message: `Artifact ${artifactRef} must be file-backed for log evidence.`
      });
      continue;
    }

    const fileContent = await readFile(artifact.filePath, "utf8").catch(() => null);
    if (fileContent === null) {
      evidence.push({
        code: "EVIDENCE_ARTIFACT_FILE_MISSING",
        message: `Artifact file ${artifact.filePath} is missing.`
      });
      continue;
    }

    if (computeArtifactHash(fileContent) !== artifact.hash) {
      evidence.push({
        code: "EVIDENCE_ARTIFACT_HASH_MISMATCH",
        message: `Artifact ${artifactRef} hash does not match the persisted file content.`
      });
    }
  }

  if (validationRequest !== undefined && commandResult !== null) {
    for (const validator of validationRequest.validationPlan.validators) {
      executedValidatorIds.push(validator.validatorId);
      if (validator.type === "command_exit_code" && commandResult.exitCode !== validator.expectedExitCode) {
        evidence.push({
          code: validator.required ? "VALIDATOR_REQUIRED_FAILED" : "VALIDATOR_FAILED",
          message: `Validator ${validator.validatorId} expected exit code ${validator.expectedExitCode} but received ${String(commandResult.exitCode)}.`
        });
      }
    }
  }

  if (validationRequest !== undefined) {
    for (const validator of validationRequest.validationPlan.validators) {
      if (validator.required && !executedValidatorIds.includes(validator.validatorId)) {
        evidence.push({
          code: "REQUIRED_VALIDATOR_NOT_EXECUTED",
          message: `Required validator ${validator.validatorId} was not executed.`
        });
      }
    }
  }

  const evidenceRecords = [
    EvidenceSchema.parse({
      evidenceId: input.idGenerator(),
      runId: input.run.runId,
      type: "command_result",
      source: "shell.execute",
      status:
        commandResult === null ? "error" : commandResult.exitCode === 0 && evidence.length === 0 ? "passed" : "failed",
      summary:
        commandResult === null
          ? "Command result is unavailable."
          : commandResult.exitCode === 0
            ? "Command completed successfully."
            : `Command exited with ${String(commandResult.exitCode)}.`,
      artifactRefs,
      createdAt: input.now
    })
  ];

  const testResult = TestResultSchema.parse({
    status:
      commandResult === null ? "error" : evidence.length === 0 && commandResult.exitCode === 0 ? "passed" : "failed",
    command: validationRequest?.command ?? input.task.input.text,
    exitCode: commandResult?.exitCode ?? null,
    summary:
      commandResult === null
        ? "Verification command did not produce a valid result."
        : commandResult.exitCode === 0 && evidence.length === 0
          ? "Verification passed."
          : `Verification failed with exit code ${String(commandResult.exitCode)}.`,
    evidenceRefs: evidenceRecords.map((record) => record.evidenceId),
    startedAt:
      commandResult === null
        ? input.run.updatedAt
        : new Date(new Date(input.now).getTime() - commandResult.durationMs).toISOString(),
    completedAt: input.now
  });

  const validation = ValidationResultSchema.parse({
    status: evidence.length === 0 ? "passed" : "failed",
    evidence,
    executedValidatorIds,
    ...(validationRequest === undefined ? {} : { plan: validationRequest.validationPlan }),
    testResult,
    evidenceRecords
  });

  return {
    validation,
    testResult,
    evidenceRecords
  };
}
