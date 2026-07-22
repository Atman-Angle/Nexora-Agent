import type { StructuredPlan, TaskContract } from "./contracts.js";

type ToolRequirement = { readonly toolName: string; readonly terms: readonly string[]; readonly exact: boolean };

const TOOL_PATTERNS: readonly [string, RegExp][] = [
  ["filesystem.list", /\bfilesystem\.list\b|列出|列表|\blist\b/iu],
  ["filesystem.search", /\bfilesystem\.search\b|搜索|查找|\bsearch\b/iu],
  ["filesystem.read", /\bfilesystem\.read\b|读取|阅读|\bread\b/iu],
  ["filesystem.write", /\bfilesystem\.write\b|写入|创建文件|\bwrite\b/iu],
  ["filesystem.patch", /\bfilesystem\.patch\b|修改|修复|\bpatch\b|\bedit\b/iu],
  ["shell.execute", /\bshell\.execute\b|执行命令|运行命令|\bexecute\b|\brun (?:the )?command\b/iu],
  ["git.status", /\bgit\.status\b|\bgit status\b/iu],
  ["git.diff", /\bgit\.diff\b|\bgit diff\b/iu],
  ["git.show", /\bgit\.show\b|\bgit show\b/iu]
];
const NO_WRITE = /不要(?:修改|写入|创建)|禁止(?:修改|写入)|do not (?:modify|write|edit|change)|must not (?:modify|write|edit|change)/iu;
const NO_EXECUTE = /不要(?:执行|运行)(?:任何)?命令|禁止(?:执行|运行)命令|do not (?:execute|run) commands?|must not (?:execute|run) commands?/iu;

export function validateExplicitRequirements(inputs: readonly string[], contract: TaskContract, plan: StructuredPlan): string[] {
  const text = inputs.join("\n");
  const noWrite = NO_WRITE.test(text);
  const noExecute = NO_EXECUTE.test(text);
  const requirements = extractTools(text, noWrite, noExecute);
  const contractText = [contract.goal, ...contract.constraints, ...contract.acceptanceCriteria].join("\n");
  const requiredTools = new Set<string>();
  for (const step of plan.orderedSteps) {
    for (const check of step.acceptanceChecks) {
      if (check.required && check.kind === "tool_result") requiredTools.add(check.toolName);
    }
  }
  const issues: string[] = [];
  for (const requirement of requirements) {
    if (!requirement.terms.some((term) => contractText.toLowerCase().includes(term.toLowerCase()))) {
      issues.push(`TASK_CONTRACT_REQUIREMENT_MISSING:${requirement.toolName}`);
    }
    if (![...requiredTools].some((name) => satisfiesTool(requirement, name))) issues.push(`PLAN_REQUIREMENT_MISSING:${requirement.toolName}`);
  }
  const constraintText = contract.constraints.join("\n");
  if (noWrite && !preservesConstraint(contract.constraints, constraintText, NO_WRITE, "write")) issues.push("TASK_CONTRACT_CONSTRAINT_MISSING:NO_WRITE");
  if (noExecute && !preservesConstraint(contract.constraints, constraintText, NO_EXECUTE, "execute")) issues.push("TASK_CONTRACT_CONSTRAINT_MISSING:NO_EXECUTE");
  if (noWrite && [...requiredTools].some((name) => /\.(?:write|patch)$/u.test(name))) issues.push("PLAN_CONSTRAINT_VIOLATION:NO_WRITE");
  if (noExecute && [...requiredTools].some((name) => /\.execute$/u.test(name))) issues.push("PLAN_CONSTRAINT_VIOLATION:NO_EXECUTE");
  return issues;
}

function preservesConstraint(constraints: readonly string[], text: string, naturalLanguage: RegExp, risk: string): boolean {
  return naturalLanguage.test(text) || constraints.some((constraint) => normalizeConstraint(constraint) === canonicalConstraint(risk));
}

function canonicalConstraint(risk: string): string {
  return `NO_${normalizeConstraint(risk)}`;
}

function normalizeConstraint(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function satisfiesTool(required: ToolRequirement, actual: string): boolean {
  if (required.toolName === actual) return true;
  if (required.exact) return false;
  const operation = required.toolName.split(".").at(-1);
  return operation !== undefined && actual.endsWith(`.${operation}`);
}

function extractTools(text: string, noWrite: boolean, noExecute: boolean): ToolRequirement[] {
  const requirements: ToolRequirement[] = [];
  for (const [toolName, pattern] of TOOL_PATTERNS) {
    if ((noWrite && (toolName === "filesystem.write" || toolName === "filesystem.patch")) || (noExecute && toolName === "shell.execute")) continue;
    const match = pattern.exec(text);
    if (match !== null) requirements.push({ toolName, terms: [toolName, match[0]!], exact: match[0]!.toLowerCase() === toolName });
  }
  return requirements;
}
