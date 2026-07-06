import type { BuilderPlanStep } from "../../../contracts/src/index.js";

export function selectCurrentPlanStep(planSteps: BuilderPlanStep[]): BuilderPlanStep | null {
  if (planSteps.length === 0) {
    return null;
  }
  const completedStepIds = new Set(planSteps.filter((step) => step.status === "completed").map((step) => step.stepId));
  for (const step of planSteps) {
    if (step.status === "completed" || step.status === "blocked") {
      continue;
    }
    if (!step.required) {
      continue;
    }
    const dependenciesMet = step.dependsOn.every((dependencyId) => completedStepIds.has(dependencyId));
    if (!dependenciesMet) {
      continue;
    }
    return step;
  }
  return null;
}
