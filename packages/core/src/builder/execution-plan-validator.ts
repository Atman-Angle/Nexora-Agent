import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  BuilderPlanStep,
  BuilderState,
  ExecutionPlan,
  ExecutionPlanRepairContext,
  PlanValidationIssue,
  PlanValidationResult,
  PlanningPolicyContext,
  Task
} from "../../../contracts/src/index.js";
import {
  BuilderStateSchema,
  ExecutionPlanRepairContextSchema,
  ExecutionPlanSchema,
  PlanValidationResultSchema,
  PlanningPolicyContextSchema
} from "../../../contracts/src/index.js";
import { isUnsafeWorkspacePath } from "./mutation-intent-validator.js";
import { requiresMutationTaskType } from "../validation-gate.js";

export const EXECUTION_PLAN_REPAIR_BUDGET = 2;

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
}

function uniqueNormalized(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalizePath).filter((path) => path.length > 0))];
}

function validationCommandsForTask(task: Task): string[] {
  const request = task.input.validationRequest;
  if (request === undefined) {
    return [];
  }
  const commandName = request.command.replace(/\\/g, "/").split("/").pop() ?? request.command;
  return request.args.length === 0 ? [commandName] : [`${commandName} ${request.args.join(" ")}`];
}

export function buildPlanningPolicyContext(input: {
  task: Task;
  workspaceRoot: string;
  protectedFiles?: string[];
  knownExistingFiles?: string[];
}): PlanningPolicyContext {
  const explicitConstraints = input.task.input.executionConstraints;
  if (explicitConstraints !== undefined) {
    const knownExisting = new Set(uniqueNormalized(input.knownExistingFiles ?? []));
    for (const path of uniqueNormalized([
      ...explicitConstraints.allowedEditFiles,
      ...explicitConstraints.allowedNewFiles,
      ...explicitConstraints.requiredEditFiles,
      ...explicitConstraints.requiredNewFiles
    ])) {
      if (knownExisting.has(path) || existsSync(join(input.workspaceRoot, path))) {
        knownExisting.add(path);
      }
    }
    return PlanningPolicyContextSchema.parse({
      allowedEditFiles: explicitConstraints.allowedEditFiles,
      allowedNewFiles: explicitConstraints.allowedNewFiles,
      requiredEditFiles: explicitConstraints.requiredEditFiles,
      requiredNewFiles: explicitConstraints.requiredNewFiles,
      protectedFiles: explicitConstraints.protectedFiles,
      knownExistingFiles: [...knownExisting],
      validationCommands: validationCommandsForTask(input.task)
    });
  }

  const acceptancePaths = uniqueNormalized(
    input.task.input.acceptanceCriteria
      .map((criterion) => {
        const check = criterion.check;
        return "path" in check ? check.path : null;
      })
      .filter((path): path is string => path !== null)
  );
  const knownExisting = new Set(uniqueNormalized(input.knownExistingFiles ?? []));
  const requiredEditFiles: string[] = [];
  const requiredNewFiles: string[] = [];
  for (const path of acceptancePaths) {
    const exists = knownExisting.has(path) || existsSync(join(input.workspaceRoot, path));
    if (exists) {
      requiredEditFiles.push(path);
      knownExisting.add(path);
    } else {
      requiredNewFiles.push(path);
    }
  }
  return PlanningPolicyContextSchema.parse({
    allowedEditFiles: requiredEditFiles,
    allowedNewFiles: requiredNewFiles,
    requiredEditFiles,
    requiredNewFiles,
    protectedFiles: uniqueNormalized(input.protectedFiles ?? []),
    knownExistingFiles: [...knownExisting],
    validationCommands: validationCommandsForTask(input.task)
  });
}

function issue(input: {
  code: PlanValidationIssue["code"];
  message: string;
  repairHint: string;
  path?: string;
  stepId?: string;
}): PlanValidationIssue {
  return input;
}

function targetsForOperation(policy: PlanningPolicyContext, operation: BuilderPlanStep["operation"]): Set<string> {
  const existingSet = new Set(policy.knownExistingFiles.map(normalizePath));
  const existingAllowedNewFiles = policy.allowedNewFiles.map(normalizePath).filter((path) => existingSet.has(path));
  if (operation === "create") {
    return new Set(policy.allowedNewFiles.map(normalizePath));
  }
  if (operation === "modify") {
    return new Set([...policy.allowedEditFiles.map(normalizePath), ...existingAllowedNewFiles]);
  }
  return new Set([...policy.allowedEditFiles, ...policy.allowedNewFiles].map(normalizePath));
}

function hasExplicitFilePolicy(policy: PlanningPolicyContext): boolean {
  return policy.allowedEditFiles.length > 0 || policy.allowedNewFiles.length > 0;
}

function hasCycle(steps: BuilderPlanStep[]): boolean {
  const graph = new Map(steps.map((step) => [step.stepId, step.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (visited.has(stepId)) return false;
    if (visiting.has(stepId)) return true;
    visiting.add(stepId);
    for (const next of graph.get(stepId) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  };
  return [...graph.keys()].some(visit);
}

export function validateSubmittedExecutionPlan(input: {
  plan: ExecutionPlan;
  steps: BuilderPlanStep[];
  policy: PlanningPolicyContext;
  satisfiedRequiredTargets?: string[];
  task?: Task;
}): PlanValidationResult {
  const plan = ExecutionPlanSchema.parse({
    ...input.plan,
    targetFiles: uniqueNormalized(input.plan.targetFiles)
  });
  const steps = input.steps.map((step) => ({
    ...step,
    targetFiles: uniqueNormalized(step.targetFiles),
    dependsOn: uniqueNormalized(step.dependsOn)
  }));
  const issues: PlanValidationIssue[] = [];

  if (plan.targetFiles.length === 0) {
    issues.push(issue({
      code: "PLAN_TARGETS_EMPTY",
      message: "ExecutionPlan targetFiles is empty.",
      repairHint: "Submit targetFiles containing the exact required create/modify files."
    }));
  }
  if (steps.length === 0) {
    issues.push(issue({
      code: "PLAN_STEPS_EMPTY",
      message: "BuilderPlanStep[] is empty.",
      repairHint: "Submit at least one required create/modify step with targetFiles."
    }));
  }
  if (plan.validationCommands.length === 0 || !input.policy.validationCommands.every((command) => plan.validationCommands.includes(command))) {
    issues.push(issue({
      code: "VALIDATION_COMMANDS_MISSING",
      message: "ExecutionPlan validationCommands does not include the required validation command set.",
      repairHint: `Include all validation commands exactly: ${input.policy.validationCommands.join(", ")}.`
    }));
  }

  const protectedSet = new Set(input.policy.protectedFiles.map(normalizePath));
  const allowedAll = new Set([...input.policy.allowedEditFiles, ...input.policy.allowedNewFiles].map(normalizePath));
  const explicitFilePolicy = hasExplicitFilePolicy(input.policy);
  const existingSet = new Set(input.policy.knownExistingFiles.map(normalizePath));
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.stepId)) {
      issues.push(issue({
        code: "DUPLICATE_STEP_ID",
        message: `Duplicate stepId ${step.stepId}.`,
        repairHint: "Use unique stable stepId values.",
        stepId: step.stepId
      }));
    }
    stepIds.add(step.stepId);
    if (step.operation === "delete" || step.operation === "rename") {
      issues.push(issue({
        code: "UNSUPPORTED_OPERATION",
        message: `Operation ${step.operation} is declared but not executable in B002.`,
        repairHint: "Use create or modify steps only.",
        stepId: step.stepId
      }));
    }
    for (const target of step.targetFiles) {
      if (isUnsafeWorkspacePath(target)) {
        issues.push(issue({
          code: "UNSAFE_PATH",
          message: `Target path ${target} is not safe workspace-relative path.`,
          repairHint: "Use normalized workspace-relative paths without backslashes, absolute roots, NUL, or '..'.",
          path: target,
          stepId: step.stepId
        }));
        continue;
      }
      const normalized = normalizePath(target);
      if (protectedSet.has(normalized)) {
        issues.push(issue({
          code: "TARGET_PROTECTED",
          message: `Target ${normalized} is protected.`,
          repairHint: "Remove protected files from the plan.",
          path: normalized,
          stepId: step.stepId
        }));
      }
      if (explicitFilePolicy && !allowedAll.has(normalized)) {
        issues.push(issue({
          code: "TARGET_NOT_ALLOWED",
          message: `Target ${normalized} is outside allowedEditFiles/allowedNewFiles.`,
          repairHint: "Plan only files listed in PlanningPolicyContext allowedEditFiles or allowedNewFiles.",
          path: normalized,
          stepId: step.stepId
        }));
      }
      const operationAllowedTargets = targetsForOperation(input.policy, step.operation);
      if (operationAllowedTargets.size > 0 && !operationAllowedTargets.has(normalized)) {
        issues.push(issue({
          code: step.operation === "create" ? "CREATE_TARGET_EXISTS" : "MODIFY_TARGET_MISSING",
          message: `${step.operation} target ${normalized} does not match policy existence/allowed set.`,
          repairHint: "Use create for allowedNewFiles and modify for allowedEditFiles.",
          path: normalized,
          stepId: step.stepId
        }));
      }
      // Without an explicit file policy, `knownExistingFiles` is only a
      // bounded working-set snapshot, not an authoritative directory index.
      // Treat absence from that snapshot as unknown rather than rejecting a
      // legitimate workspace-relative target during plan bootstrap.
      if (explicitFilePolicy && step.operation === "create" && existingSet.has(normalized)) {
        issues.push(issue({
          code: "CREATE_TARGET_EXISTS",
          message: `Create target ${normalized} already exists.`,
          repairHint: "Change the step operation to modify or target an allowed new file.",
          path: normalized,
          stepId: step.stepId
        }));
      }
      if (explicitFilePolicy && step.operation === "modify" && !existingSet.has(normalized)) {
        issues.push(issue({
          code: "MODIFY_TARGET_MISSING",
          message: `Modify target ${normalized} does not exist.`,
          repairHint: "Change the step operation to create or target an existing allowed edit file.",
          path: normalized,
          stepId: step.stepId
        }));
      }
    }
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency) && !steps.some((candidate) => candidate.stepId === dependency)) {
        issues.push(issue({
          code: "INVALID_DEPENDENCY",
          message: `Step ${step.stepId} depends on unknown stepId ${dependency}.`,
          repairHint: "Each dependsOn entry must reference a submitted stepId.",
          stepId: step.stepId
        }));
      }
    }
  }
  if (hasCycle(steps)) {
    issues.push(issue({
      code: "DEPENDENCY_CYCLE",
      message: "Plan steps contain a dependency cycle.",
      repairHint: "Remove cyclic dependsOn references so the steps can be topologically selected."
    }));
  }

  const stepTargets = uniqueNormalized(steps.flatMap((step) => step.targetFiles));
  const requiredTargets = uniqueNormalized([...input.policy.requiredEditFiles, ...input.policy.requiredNewFiles]);
  const satisfiedRequiredTargets = new Set(uniqueNormalized(input.satisfiedRequiredTargets ?? []));
  for (const target of requiredTargets) {
    if (satisfiedRequiredTargets.has(target) && (plan.targetFiles.length > 0 || stepTargets.length > 0)) {
      continue;
    }
    if (!stepTargets.includes(target) || !plan.targetFiles.includes(target)) {
      issues.push(issue({
        code: "REQUIRED_TARGET_MISSING",
        message: `Required target ${target} is missing from the submitted plan.`,
        repairHint:
          "Include every unsatisfied requiredEditFiles and requiredNewFiles path in both plan.targetFiles and step targetFiles.",
        path: target
      }));
    }
  }
  const mismatch = [...new Set([...plan.targetFiles, ...stepTargets])].filter(
    (target) => !plan.targetFiles.includes(target) || !stepTargets.includes(target)
  );
  for (const target of mismatch) {
    issues.push(issue({
      code: "STEP_TARGET_MISMATCH",
      message: `Plan targetFiles and BuilderPlanStep targetFiles disagree on ${target}.`,
      repairHint: "Make plan.targetFiles equal the union of all step targetFiles.",
      path: target
    }));
  }

  if (input.task !== undefined && requiresMutationTaskType(input.task.input.taskType)) {
    const requiredSteps = steps.filter((step) => step.required);
    if (requiredSteps.length === 0) {
      issues.push(issue({
        code: "PLAN_STEPS_EMPTY",
        message: "Mutation tasks require at least one required structured plan step.",
        repairHint: "Submit required inspect, mutation, and validation steps instead of optional-only steps."
      }));
    }
    const mutationTools = new Set(["filesystem.patch", "filesystem.write"]);
    if (!requiredSteps.some((step) => (step.requiredTools ?? []).some((tool) => mutationTools.has(tool)))) {
      issues.push(issue({
        code: "REQUIRED_TARGET_MISSING",
        message: "Mutation tasks require a required step bound to filesystem.patch or filesystem.write.",
        repairHint: "Bind the mutation step to the exact filesystem.patch or filesystem.write Tool."
      }));
    }
    const acceptanceIds = input.task.input.acceptanceCriteria.map((criterion) => criterion.id);
    const mappedAcceptance = new Set(requiredSteps.flatMap((step) => step.acceptanceCriteria ?? []));
    for (const criterionId of acceptanceIds) {
      if (!mappedAcceptance.has(criterionId)) {
        issues.push(issue({
          code: "REQUIRED_TARGET_MISSING",
          message: `Acceptance criterion ${criterionId} is not bound to a required plan step.`,
          repairHint: `Map acceptance criterion ${criterionId} to a required structured plan step.`,
          path: criterionId
        }));
      }
    }
    if (input.task.input.validationRequest !== undefined &&
      !requiredSteps.some((step) => (step.requiredTools ?? []).includes("shell.execute"))) {
      issues.push(issue({
        code: "VALIDATION_COMMANDS_MISSING",
        message: "Validation tasks require a required plan step bound to shell.execute.",
        repairHint: "Add a required validation step with shell.execute in requiredTools."
      }));
    }
  }

  if (issues.length > 0) {
    return PlanValidationResultSchema.parse({ valid: false, issues });
  }
  return PlanValidationResultSchema.parse({ valid: true, plan, steps });
}

export function createExecutionPlanRepairContext(input: {
  previous?: ExecutionPlanRepairContext | null;
  issues: PlanValidationIssue[];
  previousPlan: ExecutionPlan;
  previousSteps: BuilderPlanStep[];
}): { kind: "store" | "exhaust"; repair: ExecutionPlanRepairContext } {
  const attempt = (input.previous?.attempt ?? 0) + 1;
  const repair = ExecutionPlanRepairContextSchema.parse({
    code: "EXECUTION_PLAN_INVALID",
    issues: input.issues,
    previousPlan: input.previousPlan,
    previousSteps: input.previousSteps,
    requiredAction: "submit_execution_plan",
    attempt,
    remainingCorrectionAttempts: Math.max(0, EXECUTION_PLAN_REPAIR_BUDGET - attempt)
  });
  return { kind: attempt > EXECUTION_PLAN_REPAIR_BUDGET ? "exhaust" : "store", repair };
}

export function installAcceptedExecutionPlan(input: {
  state: BuilderState;
  plan: ExecutionPlan;
  steps: BuilderPlanStep[];
  policy: PlanningPolicyContext;
}): BuilderState {
  void input.plan;
  void input.policy;
  return BuilderStateSchema.parse({
    ...input.state,
    planSteps: input.steps,
    currentStepId: null,
    mutationIntent: null,
    redirect: null,
    planAccepted: true,
    planningPolicy: null,
    executionPlanRepair: null,
    version: input.state.version + 1
  });
}
