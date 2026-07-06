import type { BuilderPromptContext, BuilderState, ContextBundle, MutationRedirect, BuilderPlanStep } from "../../../contracts/src/index.js";
import { BuilderPromptContextSchema } from "../../../contracts/src/index.js";

export function describeProductiveAction(step: BuilderPlanStep, redirect: MutationRedirect | null): string {
  if (redirect !== null) {
    const target = redirect.targetFile ?? step.targetFiles[0] ?? "";
    const operationLabel = redirect.suggestedOperation ?? step.operation;
    const tools = redirect.permittedTools.length > 0 ? redirect.permittedTools.join(" or ") : "no mutation tool";
    if (redirect.requiresHashRead) {
      return `Redirect: ${redirect.reason} Perform one targeted filesystem.read of ${target} for hash acquisition, then use ${tools} (${operationLabel}).`;
    }
    return `Redirect: ${redirect.reason} Use ${tools} (${operationLabel}) on ${target}.`;
  }
  if (step.operation === "create") {
    return `The target ${step.targetFiles.join(", ")} does not exist. Do not read it first. Use filesystem.write with mode=create.`;
  }
  if (step.operation === "modify") {
    return `The target ${step.targetFiles.join(", ")} exists. If no current hash is available, perform one targeted filesystem.read for hash acquisition. Then use filesystem.patch or filesystem.write with mode=overwrite and expectedHash.`;
  }
  return `Execute step ${step.stepId} (${step.operation}) on ${step.targetFiles.join(", ")}.`;
}

export function buildBuilderPromptContext(input: {
  step: BuilderPlanStep | null;
  contextBundle: ContextBundle | null;
  redirect: MutationRedirect | null;
}): BuilderPromptContext {
  if (input.step === null) {
    return BuilderPromptContextSchema.parse({
      stepId: null,
      operation: null,
      targetFiles: [],
      rationale: "",
      expectedEffects: [],
      contextBundle: null,
      redirect: input.redirect,
      productiveAction: ""
    });
  }
  return BuilderPromptContextSchema.parse({
    stepId: input.step.stepId,
    operation: input.step.operation,
    targetFiles: input.step.targetFiles,
    rationale: input.step.rationale,
    expectedEffects: input.step.expectedEffects,
    contextBundle: input.contextBundle,
    redirect: input.redirect,
    productiveAction: describeProductiveAction(input.step, input.redirect)
  });
}

export function renderBuilderPromptContext(context: BuilderPromptContext | undefined): string {
  if (context === undefined) {
    return "null";
  }
  if (context.stepId === null) {
    return JSON.stringify({ stepBound: false, redirect: context.redirect ?? null });
  }
  return JSON.stringify({
    stepBound: true,
    stepId: context.stepId,
    operation: context.operation,
    targetFiles: context.targetFiles,
    rationale: context.rationale,
    expectedEffects: context.expectedEffects,
    contextBundle: context.contextBundle,
    redirect: context.redirect,
    productiveAction: context.productiveAction
  });
}

export function deriveBuilderRedirect(state: BuilderState): MutationRedirect | null {
  return state.redirect;
}
