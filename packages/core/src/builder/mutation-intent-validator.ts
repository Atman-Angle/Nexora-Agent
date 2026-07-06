import type { MutationIntent, MutationRedirect, BuilderPlanStep, ToolCall } from "../../../contracts/src/index.js";
import { MutationIntentSchema } from "../../../contracts/src/index.js";

export type MutationIntentVerdict =
  | { kind: "accepted"; intent: MutationIntent }
  | { kind: "rejected"; code: string; message: string; reason: string; redirect: MutationRedirect }
  | { kind: "permitted_read" };

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isUnsafeWorkspacePath(path: string): boolean {
  if (path.length === 0) {
    return true;
  }
  if (path.includes("\\")) {
    return true;
  }
  if (path.startsWith("/")) {
    return true;
  }
  if (path.includes("..")) {
    return true;
  }
  if (path.includes("\0")) {
    return true;
  }
  return false;
}

function lookup(existence: Map<string, boolean>, path: string): boolean | undefined {
  const normalized = normalizePath(path);
  return existence.get(normalized) ?? existence.get(path);
}

function targetPathFromToolCall(toolCall: ToolCall): string | null {
  if (
    toolCall.toolName === "filesystem.patch" ||
    toolCall.toolName === "filesystem.write" ||
    toolCall.toolName === "filesystem.read"
  ) {
    const path = (toolCall.input as { path?: string }).path;
    return typeof path === "string" && path.length > 0 ? path : null;
  }
  return null;
}

export function isMutationToolCall(toolCall: ToolCall): boolean {
  return toolCall.toolName === "filesystem.patch" || toolCall.toolName === "filesystem.write";
}

function redirectForCurrentStep(step: BuilderPlanStep, reason: string): MutationRedirect {
  const target = step.targetFiles[0] ?? "";
  const isCreate = step.operation === "create";
  return {
    reason,
    permittedTools: isCreate ? ["filesystem.write"] : ["filesystem.patch", "filesystem.write"],
    targetFile: target.length === 0 ? null : target,
    suggestedOperation: isCreate ? "create" : "modify",
    requiresHashRead: !isCreate
  };
}

export function projectToolCallToMutationIntent(input: {
  toolCall: ToolCall;
  step: BuilderPlanStep;
}): MutationIntent | null {
  const toolCall = input.toolCall;
  if (toolCall.toolName === "filesystem.write") {
    const mode = (toolCall.input as { mode?: string }).mode;
    const operation = mode === "create" ? "create" : "modify";
    const path = (toolCall.input as { path?: string }).path;
    if (typeof path !== "string" || path.length === 0) {
      return null;
    }
    return MutationIntentSchema.parse({
      stepId: input.step.stepId,
      operation,
      targetFiles: [path],
      rationale: `Model emitted filesystem.write (${operation}) for ${path}.`,
      expectedEffects: [],
      requiredContext: [],
      preferredToolCategory: "write"
    });
  }
  if (toolCall.toolName === "filesystem.patch") {
    const path = (toolCall.input as { path?: string }).path;
    if (typeof path !== "string" || path.length === 0) {
      return null;
    }
    return MutationIntentSchema.parse({
      stepId: input.step.stepId,
      operation: "modify",
      targetFiles: [path],
      rationale: `Model emitted filesystem.patch for ${path}.`,
      expectedEffects: [],
      requiredContext: [],
      preferredToolCategory: "patch"
    });
  }
  return null;
}

export function validateMutationIntent(input: {
  intent: MutationIntent;
  step: BuilderPlanStep;
  existence: Map<string, boolean>;
}): { accepted: true } | { accepted: false; code: string; message: string; reason: string; redirect: MutationRedirect } {
  if (input.intent.stepId !== input.step.stepId) {
    return {
      accepted: false,
      code: "BUILDER_MUTATION_INTENT_WRONG_STEP",
      message: `MutationIntent stepId ${input.intent.stepId} does not match current step ${input.step.stepId}.`,
      reason: "intent_step_id_mismatch",
      redirect: redirectForCurrentStep(input.step, `Mutation intent targeted the wrong step; current step is ${input.step.stepId}.`)
    };
  }

  if (input.intent.operation === "delete" || input.intent.operation === "rename") {
    return {
      accepted: false,
      code: "BUILDER_MUTATION_OPERATION_NOT_EXECUTABLE",
      message: `${input.intent.operation} is declared but not executable in B001.`,
      reason: "operation_not_executable",
      redirect: {
        reason: `${input.intent.operation} is not executable in B001; defer or request an approved shell.execute.`,
        permittedTools: [],
        targetFile: input.intent.targetFiles[0] ?? null,
        suggestedOperation: null,
        requiresHashRead: false
      }
    };
  }

  if (input.intent.operation !== "create" && input.intent.operation !== "modify") {
    return {
      accepted: false,
      code: "BUILDER_MUTATION_OPERATION_INVALID",
      message: `Operation ${input.intent.operation} is not supported.`,
      reason: "operation_invalid",
      redirect: redirectForCurrentStep(input.step, `Operation ${input.intent.operation} is not supported in B001.`)
    };
  }

  const stepTargets = new Set(input.step.targetFiles.map(normalizePath));
  for (const target of input.intent.targetFiles) {
    if (isUnsafeWorkspacePath(target)) {
      return {
        accepted: false,
        code: "BUILDER_MUTATION_UNSAFE_PATH",
        message: `Target path ${target} is not a safe workspace-relative path.`,
        reason: "unsafe_path",
        redirect: redirectForCurrentStep(input.step, `Target path ${target} was unsafe; use the current step's target.`)
      };
    }
    if (!stepTargets.has(normalizePath(target))) {
      return {
        accepted: false,
        code: "BUILDER_MUTATION_TARGET_OUTSIDE_STEP",
        message: `Target ${target} is not among the current step's targets.`,
        reason: "target_outside_step",
        redirect: redirectForCurrentStep(input.step, `Target ${target} is outside the current step; mutate ${input.step.targetFiles.join(", ")}.`)
      };
    }
  }

  for (const target of input.intent.targetFiles) {
    const exists = lookup(input.existence, target);
    if (input.intent.operation === "create" && exists === true) {
      return {
        accepted: false,
        code: "BUILDER_MUTATION_CREATE_TARGET_EXISTS",
        message: `Create target ${target} already exists; cannot create.`,
        reason: "create_target_exists",
        redirect: {
          reason: `Create target ${target} already exists; use modify (filesystem.patch or filesystem.write overwrite with expectedHash) instead.`,
          permittedTools: ["filesystem.patch", "filesystem.write"],
          targetFile: target,
          suggestedOperation: "modify",
          requiresHashRead: true
        }
      };
    }
    if (input.intent.operation === "modify" && exists === false) {
      return {
        accepted: false,
        code: "BUILDER_MUTATION_MODIFY_TARGET_MISSING",
        message: `Modify target ${target} does not exist; cannot modify.`,
        reason: "modify_target_missing",
        redirect: {
          reason: `Modify target ${target} is missing; use create (filesystem.write mode=create) instead.`,
          permittedTools: ["filesystem.write"],
          targetFile: target,
          suggestedOperation: "create",
          requiresHashRead: false
        }
      };
    }
  }

  return { accepted: true };
}

export function evaluateActToolCall(input: {
  toolCall: ToolCall;
  step: BuilderPlanStep;
  existence: Map<string, boolean>;
  requiresHashRead: boolean;
}): MutationIntentVerdict {
  const step = input.step;

  if (input.toolCall.toolName === "filesystem.search" || input.toolCall.toolName === "filesystem.list") {
    return {
      kind: "rejected",
      code: "BUILDER_MUTATION_EXPLORATION_IN_ACT",
      message: `${input.toolCall.toolName} is not productive in act phase once a step is bound.`,
      reason: "exploration_in_act",
      redirect: redirectForCurrentStep(step, `Broad search/list is not productive once step ${step.stepId} is bound; mutate ${step.targetFiles.join(", ")}.`)
    };
  }

  if (input.toolCall.toolName === "filesystem.read") {
    const path = targetPathFromToolCall(input.toolCall);
    if (path === null) {
      return {
        kind: "rejected",
        code: "BUILDER_MUTATION_READ_MISSING_PATH",
        message: "filesystem.read in act phase must target the current modify-target for hash acquisition.",
        reason: "read_missing_path",
        redirect: redirectForCurrentStep(step, "Read in act phase is only for hash acquisition of the current modify-target.")
      };
    }
    const normalized = normalizePath(path);
    const isStepTarget = step.targetFiles.map(normalizePath).includes(normalized);
    const exists = lookup(input.existence, normalized);
    const isModifyTarget = step.operation === "modify" && isStepTarget && exists === true;
    if (isModifyTarget) {
      return { kind: "permitted_read" };
    }
    if (step.operation === "create" && isStepTarget && exists === false) {
      return {
        kind: "rejected",
        code: "BUILDER_MUTATION_READ_CREATE_TARGET",
        message: `Create target ${normalized} does not exist; do not read it before creating.`,
        reason: "read_create_target",
        redirect: {
          reason: `Create target ${normalized} does not exist; do not read first. Use filesystem.write mode=create.`,
          permittedTools: ["filesystem.write"],
          targetFile: normalized,
          suggestedOperation: "create",
          requiresHashRead: false
        }
      };
    }
    return {
      kind: "rejected",
      code: "BUILDER_MUTATION_READ_OFF_TARGET",
      message: `filesystem.read in act phase must target the current modify-target for hash acquisition (target was ${normalized}).`,
      reason: "read_off_target",
      redirect: redirectForCurrentStep(step, `Read in act is only for hash acquisition of the current modify-target ${step.targetFiles.join(", ")}.`)
    };
  }

  if (isMutationToolCall(input.toolCall)) {
    const intent = projectToolCallToMutationIntent({ toolCall: input.toolCall, step });
    if (intent === null) {
      return {
        kind: "rejected",
        code: "BUILDER_MUTATION_INTENT_INVALID",
        message: "Model mutation tool call could not be projected to a MutationIntent.",
        reason: "intent_invalid",
        redirect: redirectForCurrentStep(step, "Emit a valid filesystem.write or filesystem.patch targeting the current step's target.")
      };
    }
    const verdict = validateMutationIntent({ intent, step, existence: input.existence });
    if (verdict.accepted) {
      return { kind: "accepted", intent };
    }
    return {
      kind: "rejected",
      code: verdict.code,
      message: verdict.message,
      reason: verdict.reason,
      redirect: verdict.redirect
    };
  }

  return {
    kind: "rejected",
    code: "BUILDER_MUTATION_TOOL_NOT_PRODUCTIVE",
    message: `${input.toolCall.toolName} is not a productive mutation tool in act phase.`,
    reason: "tool_not_productive",
    redirect: redirectForCurrentStep(step, `Use a productive mutation tool for ${step.targetFiles.join(", ")}.`)
  };
}
