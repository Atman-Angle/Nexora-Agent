import { Buffer } from "node:buffer";

import {
  createBuiltInTools,
  compilePrompt,
  resolvePromptHostConfiguration,
  type ModelDecisionContext
} from "../../packages/harness/src/index.js";
import { canonicalJson } from "../../packages/runtime/src/runtime-helpers.js";
import { providerJsonSchema } from "../../packages/harness/src/tool-schema.js";
import type { ProviderToolContract } from "../../packages/harness/src/prompt.js";

const context: ModelDecisionContext = {
  providerContractVersion: 6,
  workspace: "D:\\candidate-a-audit",
  run: {
    inputCount: 1,
    coveredInputCount: 0,
    inputHistory: [{ sequence: 1, text: "Audit the current native Tool definition duplication." }],
    taskContract: null,
    currentPlan: null,
    stepProgress: [],
    evidence: [],
    lastError: null
  },
  projection: { schemaVersion: 1, digest: "sha256:candidate-a-audit" },
  activeInvocations: [],
  toolObservations: [],
  rehydratedFacts: [],
  historyCandidates: [],
  memoryCandidates: [],
  repair: null,
  tools: createBuiltInTools().map(({ contract }) => ({
    identity: contract.identity,
    capability: contract.capability,
    decision: contract.decision,
    execution: {
      ...contract.execution,
      inputSchema: providerJsonSchema(contract.execution.inputSchema)
    },
    evidence: contract.evidence
  }))
};

const prompt = compilePrompt({
  context,
  host: resolvePromptHostConfiguration({}),
  transport: { kind: "native_tools", promptCache: { mode: "disabled" } },
  contextProjectionDedupe: "on"
});

const toolsSegment = `[TOOLS]\n${canonicalJson(prompt.toolCatalog)}`;
const reducedStablePrefix = prompt.stablePrefix.replace(`\n${toolsSegment}`, "");
const providerTools = providerFunctionSchema(prompt.tools);
const requestBodyWithCatalog = representativeRequestBody(prompt.stablePrefix, providerTools);
const requestBodyWithoutCatalog = representativeRequestBody(reducedStablePrefix, providerTools);
const withCatalogBytes = Buffer.byteLength(JSON.stringify(requestBodyWithCatalog), "utf8");
const withoutCatalogBytes = Buffer.byteLength(JSON.stringify(requestBodyWithoutCatalog), "utf8");
const toolsSegmentBytes = Buffer.byteLength(toolsSegment, "utf8");
const providerToolsBytes = Buffer.byteLength(JSON.stringify(providerTools), "utf8");
const stablePrefixBytes = Buffer.byteLength(prompt.stablePrefix, "utf8");
const requestByteDelta = withCatalogBytes - withoutCatalogBytes;

const controlTools = prompt.toolCatalog.filter((tool) => tool.kind === "control");
const runtimeTools = prompt.toolCatalog.filter((tool) => tool.kind === "runtime");
const controlSegment = `[TOOLS]\n${canonicalJson(controlTools)}`;
const runtimeSegment = `[TOOLS]\n${canonicalJson(runtimeTools)}`;

const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  source: "current Pure Native Function Calling Prompt Compiler and OpenAI-compatible wire projection",
  toolSet: {
    controlCount: controlTools.length,
    runtimeCount: runtimeTools.length,
    totalCount: prompt.toolCatalog.length,
    providerExposedCount: providerTools.length,
    names: prompt.toolCatalog.map((tool) => tool.name)
  },
  measurements: {
    stablePrefix: {
      bytes: stablePrefixBytes,
      estimatedTokens: Math.ceil(stablePrefixBytes / 4)
    },
    promptToolCatalogSegment: {
      bytes: toolsSegmentBytes,
      estimatedTokens: Math.ceil(toolsSegmentBytes / 4),
      controlBytes: Buffer.byteLength(controlSegment, "utf8"),
      runtimeBytes: Buffer.byteLength(runtimeSegment, "utf8")
    },
    providerFunctionSchemas: {
      bytes: providerToolsBytes,
      estimatedTokens: Math.ceil(providerToolsBytes / 4)
    },
    representativeNativeRequest: {
      withCatalogBytes,
      withoutCatalogBytes,
      exactByteDeltaFromRemovingPromptToolCatalog: requestByteDelta,
      estimatedTokenDelta: Math.ceil(requestByteDelta / 4)
    }
  },
  duplicationBoundary: {
    duplicatedSourceFacts: [
      "canonical Tool name is represented by the Provider function alias",
      "description is repeated in the Provider function description",
      "inputSchema is repeated as Provider parameters",
      "decision.useWhen is repeated in the Provider description",
      "decision.avoidWhen is repeated in the Provider description",
      "decision.nonGoals is repeated in the Provider description",
      "effect kind is repeated in the Provider description",
      "evidence.produces is repeated in the Provider description"
    ],
    promptOnlyFacts: [
      "ProviderToolContract.kind",
      "canonical runtime Tool name in the Prompt catalog"
    ],
    providerOnlyFacts: [
      "Provider-safe function alias",
      "OpenAI function wrapper and type field",
      "parameters field name"
    ],
    globalPromptContentThatMustRemain: [
      "kernel authority and safety rules",
      "native transport/control guidance",
      "control names and batch limits",
      "Host Policy",
      "Agent Profile",
      "Project Instructions",
      "Skills catalog"
    ]
  },
  perToolAudit: prompt.toolCatalog.map((tool) => {
    const providerTool = providerTools.find((candidate) => candidate.function.name === providerAlias(tool.name));
    return {
      name: tool.name,
      providerAlias: providerAlias(tool.name),
      kind: tool.kind,
      promptBytes: Buffer.byteLength(canonicalJson(tool), "utf8"),
      providerBytes: providerTool === undefined ? null : Buffer.byteLength(JSON.stringify(providerTool), "utf8"),
      descriptionDuplicated: providerTool?.function.description.startsWith(`${tool.name}: ${tool.description}`) === true,
      parametersDeepEqual: providerTool !== undefined && deepEqual(tool.inputSchema, providerTool.function.parameters),
      decisionGuidanceDuplicated: providerTool !== undefined
        && providerTool.function.description.includes(tool.decision.useWhen.join("; "))
        && providerTool.function.description.includes(tool.decision.avoidWhen.join("; "))
        && providerTool.function.description.includes(tool.decision.nonGoals.join("; ")),
      effectAndProducesDuplicated: providerTool !== undefined
        && providerTool.function.description.includes(`Effect: ${tool.effect}`)
        && providerTool.function.description.includes(`Produces: ${tool.produces.join("; ")}`)
    };
  })
};

const outputPath = process.argv[2] ?? "docs/evidence/decision-efficiency-candidate-a-tool-catalog-audit.json";
const { writeFileSync } = await import("node:fs");
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));

function providerFunctionSchema(
  tools: readonly ProviderToolContract[]
): readonly {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}[] {
  const used = new Set<string>();
  return tools.map((tool) => {
    const alias = providerAlias(tool.name, used);
    used.add(alias);
    return {
      type: "function" as const,
      function: {
        name: alias,
        description: toolDescription(tool),
        parameters: tool.inputSchema
      }
    };
  });
}

function providerAlias(name: string, used?: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool";
  if (used === undefined || !used.has(base)) return base;
  return `${base.slice(0, 55)}_audit`;
}

function toolDescription(tool: ProviderToolContract): string {
  return [
    `${tool.name}: ${tool.description}`,
    `Use when: ${tool.decision.useWhen.join("; ") || "not specified"}`,
    `Avoid when: ${tool.decision.avoidWhen.join("; ") || "not specified"}`,
    `Non-goals: ${tool.decision.nonGoals.join("; ") || "none"}`,
    `Effect: ${tool.effect}`,
    `Produces: ${tool.produces.join("; ") || "unspecified facts"}`
  ].join("\n");
}

function representativeRequestBody(
  system: string,
  tools: ReturnType<typeof providerFunctionSchema>
): Record<string, unknown> {
  return {
    model: "qwen3.8-flash",
    temperature: 0,
    max_tokens: 4_096,
    messages: [
      { role: "system", content: system },
      { role: "user", content: "Audit the current native Tool definition duplication." }
    ],
    tools,
    tool_choice: "auto",
    parallel_tool_calls: true
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
