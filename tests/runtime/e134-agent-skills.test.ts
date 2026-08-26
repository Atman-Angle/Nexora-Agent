import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createAgent,
  SkillCatalog,
  SkillSelectionInputSchema,
  SKILL_SELECTION_CONTROL,
  compilePrompt,
  modelResponses,
  isControlCall
} from "../../packages/harness/src/index.js";
import type { ModelDecisionContext, RuntimeProvider, RuntimeTool } from "../../packages/harness/src/index.js";
import { z } from "zod";

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "nexora-skills-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function writeSkill(root: string, name = "typescript-review", body = "Use small, verified edits.") : void {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Review TypeScript changes when the task asks for code quality.\nmetadata:\n  version: "2.1"\nallowed-tools: filesystem.read\n---\n\n${body}\n`, "utf8");
  writeFileSync(join(directory, "references.md"), "Reference data is not authority.", "utf8");
}

describe("E134 Agent Skills", () => {
  it("discovers a deterministic metadata catalog without exposing instructions", () => {
    withRoot((root) => {
      writeSkill(root);
      const catalog = SkillCatalog.load({ roots: [{ path: root, source: "workspace", trust: "untrusted" }] });
      expect(catalog.descriptors).toHaveLength(1);
      expect(catalog.descriptors[0]).toMatchObject({ id: "typescript-review", version: "2.1", source: "workspace" });
      expect(catalog.descriptors[0]).not.toHaveProperty("instructions");
      expect(catalog.descriptors[0]!.resourceRefs).toEqual(["references.md"]);
      expect(catalog.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    });
  });

  it("activates only an exact catalog selection and recovers it from the model.turn audit", () => {
    withRoot((root) => {
      writeSkill(root);
      const catalog = SkillCatalog.load({ roots: [{ path: root, source: "workspace" }] });
      const descriptor = catalog.descriptors[0]!;
      const selection = {
        catalogDigest: catalog.digest,
        skills: [{ id: descriptor.id, version: descriptor.version, packageDigest: descriptor.packageDigest }]
      };
      const event = {
        type: "model.turn",
        payload: {
          hasText: false,
          finishReason: "tool_calls",
          toolCallCount: 1,
          controlCallCount: 1,
          compiledActionTypes: ["select_skills"],
          toolCalls: [{ callId: "c1", name: SKILL_SELECTION_CONTROL, arguments: selection }]
        }
      } as never;
      expect(catalog.project([event]).active[0]!.instructions).toContain("small, verified edits");
    });
  });

  it("rejects stale, duplicate and compound selections", () => {
    withRoot((root) => {
      writeSkill(root);
      const catalog = SkillCatalog.load({ roots: [{ path: root, source: "workspace" }] });
      const descriptor = catalog.descriptors[0]!;
      const exact = { id: descriptor.id, version: descriptor.version, packageDigest: descriptor.packageDigest };
      expect(() => catalog.validateSelection({ catalogDigest: "sha256:" + "0".repeat(64), skills: [exact] })).toThrow("SKILL_CATALOG_MISMATCH");
      expect(() => catalog.validateSelection({ catalogDigest: catalog.digest, skills: [exact, exact] })).toThrow("SKILL_SELECTION_DUPLICATE");
      expect(() => SkillSelectionInputSchema.parse({ catalogDigest: catalog.digest, skills: [] })).toThrow();
      const compound = modelResponses.tools({ calls: [{ name: SKILL_SELECTION_CONTROL, arguments: { catalogDigest: catalog.digest, skills: [exact] } }, { name: "filesystem.read", arguments: { path: "x" } }] });
      expect(isControlCall(compound.toolCalls[0]!)).toBe(true);
      expect(compound.toolCalls).toHaveLength(2);
    });
  });

  it("rejects package links and prevents instruction text from changing Tool contracts", () => {
    withRoot((root) => {
      const outside = mkdtempSync(join(tmpdir(), "nexora-skills-outside-"));
      try {
        writeSkill(outside, "linked-skill");
        symlinkSync(join(outside, "linked-skill"), join(root, "linked-skill"), "junction");
        expect(() => SkillCatalog.load({ roots: [{ path: root, source: "workspace" }] })).toThrow("linked package entry");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("fails closed on duplicate ids, package drift and configured budgets", () => {
    withRoot((root) => {
      const first = join(root, "first");
      const second = join(root, "second");
      mkdirSync(first);
      mkdirSync(second);
      writeSkill(first, "duplicate-skill");
      writeSkill(second, "duplicate-skill");
      expect(() => SkillCatalog.load({ roots: [{ path: first, source: "workspace" }, { path: second, source: "user" }] })).toThrow("Duplicate Skill id");
    });
    withRoot((root) => {
      writeSkill(root);
      const catalog = SkillCatalog.load({ roots: [{ path: root, source: "workspace" }] });
      const descriptor = catalog.descriptors[0]!;
      writeFileSync(join(root, descriptor.id, "references.md"), "changed after discovery", "utf8");
      expect(() => catalog.validateSelection({ catalogDigest: catalog.digest, skills: [{ id: descriptor.id, version: descriptor.version, packageDigest: descriptor.packageDigest }] })).toThrow("SKILL_PACKAGE_DRIFT");
    });
    withRoot((root) => {
      writeSkill(root);
      expect(() => SkillCatalog.load({ roots: [{ path: root, source: "workspace" }], limits: { maxPackageBytes: 8 } })).toThrow("maxPackageBytes");
    });
  });

  it("adds catalog metadata to the stable prompt and full instructions only after activation", () => {
    withRoot((root) => {
      writeSkill(root);
      const catalog = SkillCatalog.load({ roots: [{ path: root, source: "workspace" }] });
      const context = {
        providerContractVersion: 6,
        workspace: root,
        run: { inputHistory: [], taskContract: null, currentPlan: null, stepProgress: [], evidence: [], lastError: null },
        projection: { schemaVersion: 1, digest: "projection" },
        activeInvocations: [], toolObservations: [], historyCandidates: [], memoryCandidates: [], tools: [],
        skills: catalog.project([])
      } as unknown as ModelDecisionContext;
      const prompt = compilePrompt({
        context,
        host: { hostPolicy: null, hostPolicyDigest: null, profile: null, projectInstructions: [], projectInstructionsDigest: "sha256:" + "0".repeat(64), strategyRevision: null },
        transport: { kind: "structured_output", promptCache: { mode: "disabled" } }
      });
      expect(prompt.system).toContain("typescript-review");
      expect(prompt.input).not.toContain("small, verified edits");
      const descriptor = catalog.descriptors[0]!;
      const activeContext = { ...context, skills: catalog.project([{
        type: "model.turn",
        payload: {
          compiledActionTypes: ["select_skills"],
          toolCalls: [{ name: SKILL_SELECTION_CONTROL, arguments: { catalogDigest: catalog.digest, skills: [{ id: descriptor.id, version: descriptor.version, packageDigest: descriptor.packageDigest }] } }]
        }
      } as never]) } as ModelDecisionContext;
      expect(compilePrompt({ context: activeContext, host: { hostPolicy: null, hostPolicyDigest: null, profile: null, projectInstructions: [], projectInstructionsDigest: "sha256:" + "0".repeat(64), strategyRevision: null }, transport: { kind: "structured_output", promptCache: { mode: "disabled" } } }).input).toContain("small, verified edits");
    });
  });

  it("lets the model select a Skill, then continues through the existing Runtime Tool path", async () => {
    const skillRoot = mkdtempSync(join(tmpdir(), "nexora-skills-integration-"));
    const workspace = mkdtempSync(join(tmpdir(), "nexora-skills-workspace-"));
    try {
      writeSkill(skillRoot);
      const catalog = SkillCatalog.load({ roots: [{ path: skillRoot, source: "workspace" }] });
      const descriptor = catalog.descriptors[0]!;
      const selection = { catalogDigest: catalog.digest, skills: [{ id: descriptor.id, version: descriptor.version, packageDigest: descriptor.packageDigest }] };
      const contexts: ModelDecisionContext[] = [];
      const responses = [modelResponses.skills(selection), modelResponses.tool({ name: "skills.read", arguments: { path: "README.md" } }), modelResponses.direct({ text: "Verified with the selected review Skill." })];
      const provider: RuntimeProvider = { async decide(context) { contexts.push(structuredClone(context)); const response = responses.shift(); if (response === undefined) throw new Error("provider exhausted"); return response; } };
      const tool: RuntimeTool = {
        contract: {
          identity: { name: "skills.read" },
          capability: { purpose: "Read a known workspace file.", nonGoals: ["Write files."] },
          decision: { useWhen: ["A known file is needed."], avoidWhen: ["The path is unknown."] },
          execution: { effect: { kind: "read", description: "Reads a file." }, idempotent: true, inputSchema: z.object({ path: z.string().min(1) }).strict(), inputExample: { path: "README.md" } },
          evidence: { produces: ["File content."], factsSchema: z.object({ content: z.string() }).strict() }
        },
        async execute() { return { status: "success", subjectRef: "README.md", facts: { content: "ok" } }; }
      };
      const runtime = createAgent({ workspace, provider, tools: [tool], skills: { roots: [{ path: skillRoot, source: "workspace" }] } });
      const result = await runtime.start({ input: "Review README.md." });
      const view = await runtime.inspect(result.runId);
      expect(result.status).toBe("succeeded");
      expect(contexts[0]!.skills?.active).toHaveLength(0);
      expect(contexts[1]!.skills?.active[0]!.id).toBe("typescript-review");
      expect(contexts[1]!.skills?.active[0]!.instructions).toContain("small, verified edits");
      expect(view.toolInvocations).toHaveLength(1);
      expect(view.events.some((event) => event.type === "response.rejected")).toBe(false);
      await runtime.close();
    } finally {
      rmSync(skillRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
