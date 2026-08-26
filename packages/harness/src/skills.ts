import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync
} from "node:fs";
import path from "node:path";

import { digestCanonicalJson } from "@nexora/runtime/internal";
import { parseDocument } from "yaml";
import { z } from "zod";

import type { RunEvent } from "@nexora/runtime/internal";
import {
  SKILL_SELECTION_CONTROL,
  SkillSelectionInputSchema,
  type SkillSelectionInput
} from "./providers/model-response.js";

export const SkillSourceSchema = z.enum(["builtin", "host", "workspace", "user"]);
export const SkillTrustSchema = z.enum(["trusted", "untrusted"]);
export type SkillSource = z.infer<typeof SkillSourceSchema>;
export type SkillTrust = z.infer<typeof SkillTrustSchema>;

export const SkillRootSchema = z.object({
  path: z.string().trim().min(1),
  source: SkillSourceSchema,
  trust: SkillTrustSchema.optional().default("untrusted")
}).strict();
export type SkillRoot = z.input<typeof SkillRootSchema>;

export const SkillLimitsSchema = z.object({
  maxRoots: z.number().int().min(1).max(32).default(8),
  maxSkills: z.number().int().min(1).max(512).default(128),
  maxFilesPerSkill: z.number().int().min(1).max(2_000).default(256),
  maxPackageBytes: z.number().int().min(1).max(100_000_000).default(5_000_000),
  maxInstructionBytes: z.number().int().min(1).max(1_000_000).default(100_000),
  maxActiveSkills: z.number().int().min(1).max(8).default(4),
  maxActiveInstructionBytes: z.number().int().min(1).max(2_000_000).default(200_000)
}).strict();
export type SkillLimits = z.input<typeof SkillLimitsSchema>;

export const SkillConfigurationSchema = z.object({
  roots: z.array(SkillRootSchema).min(1).max(32),
  allow: z.array(z.string().trim().min(1)).max(512).optional(),
  deny: z.array(z.string().trim().min(1)).max(512).optional(),
  limits: SkillLimitsSchema.optional()
}).strict();
export type SkillConfiguration = z.input<typeof SkillConfigurationSchema>;

const SkillNameSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Skill name must use lowercase letters, digits and single hyphens.");

const SkillFrontmatterSchema = z.object({
  name: SkillNameSchema,
  description: z.string().trim().min(1).max(1_024),
  license: z.string().trim().min(1).max(500).optional(),
  compatibility: z.string().trim().min(1).max(500).optional(),
  metadata: z.record(z.string().max(1_000)).optional(),
  "allowed-tools": z.string().trim().min(1).max(2_000).optional()
}).passthrough();

export type SkillDescriptor = {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly packageDigest: string;
  readonly instructionDigest: string;
  readonly source: SkillSource;
  readonly trust: SkillTrust;
  readonly compatibility?: string;
  readonly license?: string;
  readonly allowedTools?: readonly string[];
  readonly resourceRefs: readonly string[];
};

export type ActiveSkill = SkillDescriptor & {
  readonly instructions: string;
};

export type SkillDecisionContext = {
  readonly catalogDigest: string;
  readonly catalog: readonly SkillDescriptor[];
  readonly active: readonly ActiveSkill[];
  readonly activeDigest: string;
};

type SkillPackage = {
  readonly descriptor: SkillDescriptor;
  readonly packagePath: string;
  readonly instructionPath: string;
};

type ParsedSkillConfiguration = {
  readonly roots: readonly z.output<typeof SkillRootSchema>[];
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly limits: z.output<typeof SkillLimitsSchema>;
};

export class SkillCatalog {
  readonly #packages: ReadonlyMap<string, SkillPackage>;
  readonly #limits: z.output<typeof SkillLimitsSchema>;
  readonly descriptors: readonly SkillDescriptor[];
  readonly digest: string;

  private constructor(packages: readonly SkillPackage[], limits: z.output<typeof SkillLimitsSchema>) {
    this.#packages = new Map(packages.map((item) => [item.descriptor.id, item]));
    this.#limits = limits;
    this.descriptors = Object.freeze(packages.map((item) => Object.freeze(item.descriptor)));
    this.digest = digestCanonicalJson(this.descriptors);
  }

  static load(input: SkillConfiguration): SkillCatalog {
    const parsed = parseSkillConfiguration(input);
    const discovered: SkillPackage[] = [];
    const seen = new Map<string, string>();
    for (const root of parsed.roots) {
      const packages = discoverRoot(root, parsed.limits);
      for (const item of packages) {
        const duplicate = seen.get(item.descriptor.id);
        if (duplicate !== undefined) {
          throw new Error(`Duplicate Skill id ${item.descriptor.id} was discovered in ${duplicate} and another configured root.`);
        }
        seen.set(item.descriptor.id, root.path);
        discovered.push(item);
        if (discovered.length > parsed.limits.maxSkills) {
          throw new Error(`Skill catalog exceeds maxSkills (${parsed.limits.maxSkills}).`);
        }
      }
    }
    const allow = parsed.allow === undefined ? null : new Set(parsed.allow);
    const deny = new Set(parsed.deny ?? []);
    const selected = discovered
      .filter((item) => (allow === null || allow.has(item.descriptor.id)) && !deny.has(item.descriptor.id))
      .sort((left, right) => compareStrings(left.descriptor.id, right.descriptor.id));
    return new SkillCatalog(selected, parsed.limits);
  }

  project(events: readonly RunEvent[]): SkillDecisionContext {
    const recovered = recoverSelection(events);
    const active = recovered === null ? [] : this.activate(recovered);
    return freezeSkillContext(this.digest, this.descriptors, active);
  }

  validateSelection(input: unknown): SkillSelectionInput {
    const selection = SkillSelectionInputSchema.parse(input);
    if (selection.catalogDigest !== this.digest) {
      throw new Error("SKILL_CATALOG_MISMATCH: The selected Skill catalog is stale; select again from the current catalog.");
    }
    if (selection.skills.length > this.#limits.maxActiveSkills) {
      throw new Error(`SKILL_SELECTION_LIMIT_EXCEEDED: Select at most ${this.#limits.maxActiveSkills} Skills.`);
    }
    this.activate(selection);
    return selection;
  }

  private activate(selection: SkillSelectionInput): readonly ActiveSkill[] {
    const seen = new Set<string>();
    let instructionBytes = 0;
    const active = selection.skills.map((reference) => {
      if (seen.has(reference.id)) throw new Error(`SKILL_SELECTION_DUPLICATE: ${reference.id} was selected more than once.`);
      seen.add(reference.id);
      const item = this.#packages.get(reference.id);
      if (item === undefined) throw new Error(`SKILL_NOT_AVAILABLE: ${reference.id} is not in the configured catalog.`);
      if (item.descriptor.version !== reference.version || item.descriptor.packageDigest !== reference.packageDigest) {
        throw new Error(`SKILL_PACKAGE_MISMATCH: ${reference.id} no longer matches the selected immutable package.`);
      }
      const files = collectPackageFiles(item.packagePath, this.#limits);
      const currentPackageDigest = digestPackage(files);
      if (currentPackageDigest !== item.descriptor.packageDigest) {
        throw new Error(`SKILL_PACKAGE_DRIFT: ${reference.id} changed after catalog discovery.`);
      }
      const { instructions } = parseSkillDocument(readFileSync(item.instructionPath, "utf8"), reference.id);
      if (sha256(instructions) !== item.descriptor.instructionDigest) {
        throw new Error(`SKILL_INSTRUCTION_DRIFT: ${reference.id} SKILL.md changed after catalog discovery.`);
      }
      instructionBytes += Buffer.byteLength(instructions, "utf8");
      return Object.freeze({ ...item.descriptor, instructions });
    });
    if (instructionBytes > this.#limits.maxActiveInstructionBytes) {
      throw new Error(`SKILL_ACTIVE_INSTRUCTION_LIMIT_EXCEEDED: Selected instructions exceed ${this.#limits.maxActiveInstructionBytes} bytes.`);
    }
    return Object.freeze(active);
  }
}

function parseSkillConfiguration(input: SkillConfiguration): ParsedSkillConfiguration {
  const parsed = SkillConfigurationSchema.parse(input);
  const limits = SkillLimitsSchema.parse(parsed.limits ?? {});
  if (parsed.roots.length > limits.maxRoots) {
    throw new Error(`Skill configuration exceeds maxRoots (${limits.maxRoots}).`);
  }
  const allow = parsed.allow === undefined ? undefined : uniquePolicyIds(parsed.allow, "allow");
  const deny = parsed.deny === undefined ? undefined : uniquePolicyIds(parsed.deny, "deny");
  const overlap = allow?.find((id) => deny?.includes(id));
  if (overlap !== undefined) throw new Error(`Skill ${overlap} appears in both allow and deny policy.`);
  return { roots: parsed.roots, limits, ...(allow === undefined ? {} : { allow }), ...(deny === undefined ? {} : { deny }) };
}

function discoverRoot(
  root: z.output<typeof SkillRootSchema>,
  limits: z.output<typeof SkillLimitsSchema>
): readonly SkillPackage[] {
  const rootPath = path.resolve(root.path);
  const rootStat = lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Skill root must be a real directory: ${root.path}`);
  }
  const realRoot = realpathSync.native(rootPath);
  return readdirSync(realRoot, { withFileTypes: true })
    .filter((entry) => {
      if (entry.isSymbolicLink()) throw new Error(`Skill root contains a linked package entry: ${entry.name}`);
      return entry.isDirectory();
    })
    .sort((left, right) => compareStrings(left.name, right.name))
    .map((entry) => loadPackage(realRoot, entry.name, root.source, root.trust, limits));
}

function loadPackage(
  realRoot: string,
  directoryName: string,
  source: SkillSource,
  trust: SkillTrust,
  limits: z.output<typeof SkillLimitsSchema>
): SkillPackage {
  const packagePath = path.join(realRoot, directoryName);
  const packageStat = lstatSync(packagePath);
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
    throw new Error(`Skill package must be a real directory: ${directoryName}`);
  }
  const realPackage = realpathSync.native(packagePath);
  assertContained(realRoot, realPackage, `Skill package ${directoryName}`);
  const files = collectPackageFiles(realPackage, limits);
  const instructionFile = files.find((file) => file.relativePath === "SKILL.md");
  if (instructionFile === undefined) throw new Error(`Skill package ${directoryName} does not contain SKILL.md.`);
  if (instructionFile.bytes > limits.maxInstructionBytes) {
    throw new Error(`Skill ${directoryName} SKILL.md exceeds maxInstructionBytes (${limits.maxInstructionBytes}).`);
  }
  const skillDocument = readFileSync(instructionFile.absolutePath, "utf8");
  const { frontmatter, instructions } = parseSkillDocument(skillDocument, directoryName);
  if (frontmatter.name !== directoryName) {
    throw new Error(`Skill name ${frontmatter.name} must match its parent directory ${directoryName}.`);
  }
  const version = frontmatter.metadata?.version?.trim() || "1";
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) {
    throw new Error(`Skill ${directoryName} metadata.version is invalid.`);
  }
  const packageDigest = digestPackage(files);
  const descriptor: SkillDescriptor = {
    id: frontmatter.name,
    version,
    description: frontmatter.description,
    packageDigest,
    instructionDigest: sha256(instructions),
    source,
    trust,
    ...(frontmatter.compatibility === undefined ? {} : { compatibility: frontmatter.compatibility }),
    ...(frontmatter.license === undefined ? {} : { license: frontmatter.license }),
    ...(frontmatter["allowed-tools"] === undefined
      ? {}
      : { allowedTools: Object.freeze(frontmatter["allowed-tools"].split(/\s+/u).filter(Boolean)) }),
    resourceRefs: Object.freeze(files
      .map((file) => file.relativePath)
      .filter((relativePath) => relativePath !== "SKILL.md"))
  };
  return Object.freeze({
    descriptor: Object.freeze(descriptor),
    packagePath: realPackage,
    instructionPath: instructionFile.absolutePath
  });
}

function collectPackageFiles(
  realPackage: string,
  limits: z.output<typeof SkillLimitsSchema>
): readonly { readonly absolutePath: string; readonly relativePath: string; readonly bytes: number; readonly digest: string }[] {
  const files: Array<{ readonly absolutePath: string; readonly relativePath: string; readonly bytes: number; readonly digest: string }> = [];
  let packageBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareStrings(a.name, b.name))) {
      const absolutePath = path.join(directory, entry.name);
      const entryStat = lstatSync(absolutePath);
      if (entryStat.isSymbolicLink() || entryStat.nlink > 1) {
        throw new Error(`Skill package contains a linked entry: ${path.relative(realPackage, absolutePath)}`);
      }
      const resolved = realpathSync.native(absolutePath);
      assertContained(realPackage, resolved, "Skill package entry");
      if (entryStat.isDirectory()) {
        visit(resolved);
        continue;
      }
      if (!entryStat.isFile()) throw new Error(`Skill package contains a non-file entry: ${entry.name}`);
      const bytes = statSync(resolved).size;
      packageBytes += bytes;
      if (packageBytes > limits.maxPackageBytes) {
        throw new Error(`Skill package exceeds maxPackageBytes (${limits.maxPackageBytes}).`);
      }
      const content = readFileSync(resolved);
      files.push({
        absolutePath: resolved,
        relativePath: path.relative(realPackage, resolved).split(path.sep).join("/"),
        bytes,
        digest: createHash("sha256").update(content).digest("hex")
      });
      if (files.length > limits.maxFilesPerSkill) {
        throw new Error(`Skill package exceeds maxFilesPerSkill (${limits.maxFilesPerSkill}).`);
      }
    }
  };
  visit(realPackage);
  return Object.freeze(files.sort((left, right) => compareStrings(left.relativePath, right.relativePath)));
}

function parseSkillDocument(document: string, directoryName: string): {
  readonly frontmatter: z.infer<typeof SkillFrontmatterSchema>;
  readonly instructions: string;
} {
  const normalized = document.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/u.exec(normalized);
  if (match === null) throw new Error(`Skill ${directoryName} must begin with YAML frontmatter.`);
  const yaml = parseDocument(match[1]!, { schema: "core", strict: true, uniqueKeys: true });
  if (yaml.errors.length > 0) throw new Error(`Skill ${directoryName} frontmatter is invalid: ${yaml.errors[0]!.message}`);
  const value = yaml.toJS({ maxAliasCount: 0 });
  return {
    frontmatter: SkillFrontmatterSchema.parse(value),
    instructions: match[2]!.trim()
  };
}

function recoverSelection(events: readonly RunEvent[]): SkillSelectionInput | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "model.turn") continue;
    const actions = Array.isArray(event.payload.compiledActionTypes) ? event.payload.compiledActionTypes : [];
    if (!actions.includes("select_skills")) continue;
    const calls = Array.isArray(event.payload.toolCalls) ? event.payload.toolCalls : [];
    const call = calls.find((item) => (
      item !== null
      && typeof item === "object"
      && (item as { readonly name?: unknown }).name === SKILL_SELECTION_CONTROL
    )) as { readonly arguments?: unknown } | undefined;
    if (call === undefined) throw new Error("SKILL_SELECTION_AUDIT_INVALID: Accepted Skill selection event has no matching control call.");
    return SkillSelectionInputSchema.parse(call.arguments);
  }
  return null;
}

function freezeSkillContext(
  catalogDigest: string,
  catalog: readonly SkillDescriptor[],
  active: readonly ActiveSkill[]
): SkillDecisionContext {
  return Object.freeze({
    catalogDigest,
    catalog,
    active,
    activeDigest: digestCanonicalJson(active.map((item) => ({
      id: item.id,
      version: item.version,
      packageDigest: item.packageDigest,
      instructionDigest: item.instructionDigest
    })))
  });
}

function digestPackage(files: readonly { readonly relativePath: string; readonly bytes: number; readonly digest: string }[]): string {
  return digestCanonicalJson(files.map((file) => ({ path: file.relativePath, bytes: file.bytes, digest: file.digest })));
}

function assertContained(parent: string, candidate: string, label: string): void {
  const relative = path.relative(parent, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  throw new Error(`${label} escapes its configured root.`);
}

function uniquePolicyIds(values: readonly string[], label: string): readonly string[] {
  const parsed = values.map((value) => SkillNameSchema.parse(value));
  if (new Set(parsed).size !== parsed.length) throw new Error(`Skill ${label} policy contains duplicate ids.`);
  return Object.freeze(parsed);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
