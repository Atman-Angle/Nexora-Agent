import type { PlanStepDefinition, ProgressLedger, ToolResult } from "../../../contracts/src/index.js";

export function applyLedgerPatch(input: {
  ledger: ProgressLedger;
  patch: {
    currentStep?: string | null | undefined;
    appendPlannedSteps?: string[] | undefined;
    appendPlanSteps?: PlanStepDefinition[] | undefined;
    appendCompletedSteps?: string[] | undefined;
    appendDecisions?: string[] | undefined;
    appendEvidenceRefs?: string[] | undefined;
    appendArtifactRefs?: string[] | undefined;
    appendOpenQuestions?: string[] | undefined;
  };
  now: string;
}): ProgressLedger {
  const unique = (values: string[]) => [...new Set(values)];
  const patched = {
    ...input.ledger,
    ...(input.patch.currentStep === undefined ? {} : { currentStep: input.patch.currentStep }),
    plannedSteps: unique([...input.ledger.plannedSteps, ...(input.patch.appendPlannedSteps ?? [])]),
    completedSteps: unique([...input.ledger.completedSteps, ...(input.patch.appendCompletedSteps ?? [])]),
    decisions: unique([...input.ledger.decisions, ...(input.patch.appendDecisions ?? [])]),
    evidenceRefs: unique([...input.ledger.evidenceRefs, ...(input.patch.appendEvidenceRefs ?? [])]),
    artifactRefs: unique([...input.ledger.artifactRefs, ...(input.patch.appendArtifactRefs ?? [])]),
    openQuestions: unique([...input.ledger.openQuestions, ...(input.patch.appendOpenQuestions ?? [])]),
    version: input.ledger.version + 1,
    updatedAt: input.now
  };
  return reconcilePlanSteps(patched, input.patch, input.now);
}

function reconcilePlanSteps(
  ledger: ProgressLedger,
  patch: {
    currentStep?: string | null | undefined;
    appendPlannedSteps?: string[] | undefined;
    appendPlanSteps?: PlanStepDefinition[] | undefined;
    appendCompletedSteps?: string[] | undefined;
  },
  now: string
): ProgressLedger {
  const planSteps = ledger.planSteps.map((step) => ({
    ...step,
    evidenceRefs: [...step.evidenceRefs],
    requiredTools: [...(step.requiredTools ?? [])],
    acceptanceCriteria: [...(step.acceptanceCriteria ?? [])]
  }));
  const ensureStep = (
    description: string,
    status: "planned" | "in_progress" | "completed",
    definition?: Pick<PlanStepDefinition, "required" | "requiredTools" | "acceptanceCriteria">
  ) => {
    const existing = planSteps.find((step) => step.description === description);
    const inferredEvidenceRefs =
      status === "completed"
        ? inferPlanStepEvidenceRefs(description, ledger.evidenceRefs).length > 0
          ? inferPlanStepEvidenceRefs(description, ledger.evidenceRefs)
          : [...ledger.evidenceRefs]
        : inferPlanStepEvidenceRefs(description, ledger.evidenceRefs);
    if (existing !== undefined) {
      if (definition !== undefined) {
        existing.required = definition.required;
        existing.requiredTools = [...new Set(definition.requiredTools ?? [])];
        existing.acceptanceCriteria = [...new Set(definition.acceptanceCriteria ?? [])];
      }
      if (existing.status !== "completed") {
        existing.status = status;
        existing.updatedAt = now;
        if (status === "completed" && existing.evidenceRefs.length === 0 && inferredEvidenceRefs.length > 0) {
          existing.evidenceRefs = inferredEvidenceRefs;
        }
      }
      return existing;
    }

    const created = {
      stepId: `plan-step-${planSteps.length + 1}`,
      description,
      required: definition?.required ?? true,
      status,
      evidenceRefs: status === "completed" ? inferredEvidenceRefs : [],
      requiredTools: [...new Set(definition?.requiredTools ?? [])],
      acceptanceCriteria: [...new Set(definition?.acceptanceCriteria ?? [])],
      createdAt: now,
      updatedAt: now
    };
    planSteps.push(created);
    return created;
  };

  for (const description of patch.appendPlannedSteps ?? []) {
    ensureStep(description, "planned");
  }
  for (const definition of patch.appendPlanSteps ?? []) {
    ensureStep(definition.description, "planned", definition);
  }
  if (patch.currentStep !== undefined && patch.currentStep !== null) {
    ensureStep(patch.currentStep, "in_progress");
  }
  for (const description of patch.appendCompletedSteps ?? []) {
    ensureStep(description, "completed");
  }

  return {
    ...ledger,
    planSteps
  };
}

function inferPlanStepEvidenceRefs(descriptionText: string, ledgerEvidenceRefs: string[]): string[] {
  const description = descriptionText.toLowerCase();
  if (description.includes("reproduction")) {
    return ledgerEvidenceRefs.filter((ref) => ref.startsWith("reproduction:"));
  }
  if (description.includes("inspect")) {
    return ledgerEvidenceRefs.filter((ref) => ref.startsWith("inspect:") || ref.startsWith("git-status:"));
  }
  return [];
}

export function completePlanStepFromTool(input: {
  ledger: ProgressLedger;
  toolResult: Extract<ToolResult, { status: "success" }>;
  executionEvidenceRefs: string[];
  validationEvidenceRefs: string[];
  /** Successful Tool names already persisted for this Run, including the current execution. */
  successfulToolNames: readonly string[];
  now: string;
}): ProgressLedger {
  if (input.ledger.planSteps.length === 0) {
    return input.ledger;
  }

  const matchingSteps = input.ledger.currentStep === null
    ? []
    : input.ledger.planSteps.filter(
      (step) =>
        step.description === input.ledger.currentStep &&
        step.status !== "completed" &&
        matchesBoundTool(step, input.toolResult.toolName, input.successfulToolNames) &&
        hasAcceptanceEvidence(step, [
          ...input.ledger.evidenceRefs,
          ...input.executionEvidenceRefs,
          ...input.validationEvidenceRefs
        ])
    );

  if (matchingSteps.length === 0) {
    return input.ledger;
  }

  const matchingStepIds = new Set(matchingSteps.map((step) => step.stepId));
  const planSteps = input.ledger.planSteps.map((step) =>
    matchingStepIds.has(step.stepId)
      ? {
          ...step,
          status: "completed" as const,
          evidenceRefs: [...new Set([...step.evidenceRefs, ...input.executionEvidenceRefs, ...input.validationEvidenceRefs])],
          updatedAt: input.now
        }
      : step
  );
  const completedSteps = [...new Set([...input.ledger.completedSteps, ...matchingSteps.map((step) => step.description)])];
  const nextCurrentStep =
    input.ledger.currentStep !== null && matchingSteps.some((step) => step.description === input.ledger.currentStep)
      ? planSteps.find((step) => step.status !== "completed")?.description ?? null
      : input.ledger.currentStep;
  const appendedEvidenceRefs = [
    ...new Set([
      ...input.ledger.evidenceRefs,
      ...matchingSteps.flatMap((step) => step.evidenceRefs),
      ...input.executionEvidenceRefs,
      ...input.validationEvidenceRefs
    ])
  ];

  return {
    ...input.ledger,
    currentStep: nextCurrentStep,
    completedSteps,
    planSteps,
    evidenceRefs: appendedEvidenceRefs,
    version: input.ledger.version + 1,
    updatedAt: input.now
  };
}

function matchesBoundTool(
  step: Pick<ProgressLedger["planSteps"][number], "description" | "requiredTools">,
  toolName: ToolResult["toolName"],
  successfulToolNames: readonly string[]
): boolean {
  const requiredTools = step.requiredTools ?? [];
  return requiredTools.length === 0
    ? stepMatchesTool(step.description, toolName)
    : successfulToolNames.some((successfulToolName) => requiredTools.includes(successfulToolName));
}

function hasAcceptanceEvidence(
  step: Pick<ProgressLedger["planSteps"][number], "acceptanceCriteria">,
  evidenceRefs: readonly string[]
): boolean {
  const acceptanceCriteria = step.acceptanceCriteria ?? [];
  if (acceptanceCriteria.length === 0) return true;
  const evidence = new Set(evidenceRefs);
  return acceptanceCriteria.every((criterionId) =>
    evidence.has(`acceptance:${criterionId}`) || evidence.has(criterionId)
  );
}

function stepMatchesTool(descriptionText: string, toolName: ToolResult["toolName"]): boolean {
  const description = descriptionText.toLowerCase();
  if (toolName === "filesystem.search") {
    return description.includes("search") || description.includes("find") || description.includes("locate");
  }
  if (toolName === "filesystem.read") {
    return description.includes("read") || description.includes("inspect");
  }
  if (toolName === "filesystem.patch") {
    return description.includes("patch") || description.includes("fix") || description.includes("modify") || description.includes("add");
  }
  if (toolName === "filesystem.write") {
    return description.includes("write") || description.includes("create") || description.includes("add file");
  }
  if (toolName === "shell.execute") {
    return (
      description.includes("verify") ||
      description.includes("verification") ||
      description.includes("validation") ||
      description.includes("build") ||
      description.includes("test") ||
      description.includes("run ") ||
      description.includes("acceptance") ||
      description.includes("reproduction")
    );
  }
  if (toolName === "project.inspect") {
    return description.includes("inspect") || description.includes("repository") || description.includes("understand");
  }
  if (toolName === "project.commands") {
    return description.includes("command");
  }
  if (toolName === "git.status") {
    return description.includes("git status") || description.includes("status");
  }
  if (toolName === "git.diff") {
    return description.includes("diff") || description.includes("review");
  }
  if (toolName === "git.show") {
    return description.includes("show") || description.includes("history");
  }
  if (toolName === "filesystem.list") {
    return description.includes("list");
  }
  return false;
}
