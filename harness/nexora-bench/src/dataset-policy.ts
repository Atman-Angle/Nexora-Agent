import type { NormalizedEvalTask } from "./contracts.js";

export type DatasetPolicyIssue = {
  readonly code:
    | "MISSING_SPLIT_FAMILY"
    | "MISSING_SPLIT_DIFFICULTY"
    | "LEGACY_TASK"
    | "RELEASE_TASK_COUNT"
    | "RELEASE_SPLIT_COUNT"
    | "RELEASE_FAMILY_QUOTA"
    | "RELEASE_DIFFICULTY_QUOTA"
    | "FAMILY_DIFFICULTY_COVERAGE"
    | "FAMILY_NON_ATOMIC_COVERAGE"
    | "ATOMIC_TASK_LIMIT"
    | "DUPLICATE_TASK_DIGEST"
    | "DUPLICATE_TASK_ID";
  readonly message: string;
};

const RELEASE_SPLIT_QUOTAS = { dev: 24, validation: 18, holdout: 18 } as const;
const RELEASE_FAMILY_QUOTAS = {
  coding_repository_change: { dev: 6, validation: 4, holdout: 4 },
  file_data_transformation: { dev: 4, validation: 3, holdout: 3 },
  local_information_discovery_analysis: { dev: 4, validation: 2, holdout: 2 },
  artifact_production: { dev: 4, validation: 2, holdout: 2 },
  batch_automation: { dev: 4, validation: 2, holdout: 2 },
  environment_configuration_operations: { dev: 2, validation: 2, holdout: 2 },
  complex_mixed_workflow: { dev: 0, validation: 3, holdout: 3 }
} as const;
const RELEASE_DIFFICULTY_QUOTAS = { basic: 6, standard: 6, advanced: 6 } as const;

/**
 * Validates the stratification policy. Historical/pilot datasets remain
 * permissive; pass `release: true` (or `requireFormalV1`) for the normative
 * 60-task V1 release gate.
 */
export function validateStratifiedSplits(input: {
  readonly tasks: readonly NormalizedEvalTask[];
  readonly majorFamilies: readonly string[];
  readonly requireV2?: boolean;
  readonly release?: boolean;
  readonly requireFormalV1?: boolean;
}): readonly DatasetPolicyIssue[] {
  const issues: DatasetPolicyIssue[] = [];
  const release = input.release === true || input.requireFormalV1 === true;
  const families = release ? Object.keys(RELEASE_FAMILY_QUOTAS) : [...input.majorFamilies];

  if (input.requireV2 || release) {
    for (const task of input.tasks.filter((item) => item.sourceSchemaVersion !== 2)) {
      issues.push({ code: "LEGACY_TASK", message: `${task.id} is V1 and cannot enter a formal V2 release cohort.` });
    }
  }

  const seenIds = new Set<string>();
  const seenDigests = new Set<string>();
  for (const task of input.tasks) {
    if (seenIds.has(task.id)) issues.push({ code: "DUPLICATE_TASK_ID", message: `Duplicate task id: ${task.id}.` });
    seenIds.add(task.id);
    if (seenDigests.has(task.suite.taskDigest)) {
      issues.push({ code: "DUPLICATE_TASK_DIGEST", message: `Duplicate task content digest: ${task.suite.taskDigest}.` });
    }
    seenDigests.add(task.suite.taskDigest);
  }

  for (const split of ["dev", "validation", "holdout"] as const) {
    const splitTasks = input.tasks.filter((task) => task.split === split);
    if (release && splitTasks.length !== RELEASE_SPLIT_QUOTAS[split]) {
      issues.push({ code: "RELEASE_SPLIT_COUNT", message: `${split} has ${splitTasks.length} tasks; expected ${RELEASE_SPLIT_QUOTAS[split]}.` });
    }
    for (const family of families) {
      const cohort = splitTasks.filter((task) => task.suite.family === family);
      if (release) {
        const expected = RELEASE_FAMILY_QUOTAS[family as keyof typeof RELEASE_FAMILY_QUOTAS][split];
        if (cohort.length !== expected) issues.push({ code: "RELEASE_FAMILY_QUOTA", message: `${split}/${family} has ${cohort.length}; expected ${expected}.` });
      } else if (cohort.length === 0 && (split === "validation" || split === "holdout")) {
        issues.push({ code: "MISSING_SPLIT_FAMILY", message: `${split} has no representative task for major family ${family}.` });
        continue;
      }
      // Difficulty quotas are enforced at split level below. A family may have
      // fewer tasks than the number of difficulty levels in one split.
    }
    if (release && (split === "validation" || split === "holdout")) {
      for (const difficulty of Object.keys(RELEASE_DIFFICULTY_QUOTAS) as Array<keyof typeof RELEASE_DIFFICULTY_QUOTAS>) {
        const count = splitTasks.filter((task) => task.suite.difficulty === difficulty).length;
        if (count !== RELEASE_DIFFICULTY_QUOTAS[difficulty]) issues.push({ code: "RELEASE_DIFFICULTY_QUOTA", message: `${split}/${difficulty} has ${count}; expected ${RELEASE_DIFFICULTY_QUOTAS[difficulty]}.` });
      }
    }
  }

  if (release) {
    if (input.tasks.length !== 60) issues.push({ code: "RELEASE_TASK_COUNT", message: `Release contains ${input.tasks.length} tasks; expected exactly 60.` });
    for (const family of families) {
      const familyTasks = input.tasks.filter((task) => task.suite.family === family);
      const difficulties = new Set(familyTasks.map((task) => task.suite.difficulty));
      if (difficulties.size < 2) issues.push({ code: "FAMILY_DIFFICULTY_COVERAGE", message: `${family} must cover at least two difficulty levels.` });
      if (!familyTasks.some((task) => task.horizon !== "atomic")) issues.push({ code: "FAMILY_NON_ATOMIC_COVERAGE", message: `${family} must include a non-atomic task.` });
    }
    const atomicCount = input.tasks.filter((task) => task.horizon === "atomic").length;
    if (atomicCount > Math.floor(input.tasks.length * 0.2)) issues.push({ code: "ATOMIC_TASK_LIMIT", message: `${atomicCount} atomic tasks exceed the 20% release limit.` });
  }
  return Object.freeze(issues);
}
