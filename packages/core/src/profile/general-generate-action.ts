import {
  FilesystemPatchInputSchema,
  FilesystemWriteInputSchema,
  ToolCallEnvelopeSchema,
  ToolResultSchema,
  type AgentAction,
  type ExecutionRecord,
  type Task,
  type ToolResult,
  type WorkingSet
} from "../../../contracts/src/index.js";
import type { HandlerDeps } from "../agent-loop/outcome.js";
import type { AgentLoopState } from "../agent-loop/state.js";
import type { GenerateActionOutcome } from "./types.js";
import { generateNaturalLanguageAction } from "./chat-generate-action.js";

const STRUCTURAL_DISCOVERY_TOOLS = new Set(["project.inspect", "filesystem.list"]);
const WORKSPACE_MUTATION_TOOLS = new Set(["filesystem.patch", "filesystem.write"]);
export const MAX_PRE_MUTATION_CONTEXT_EVIDENCE_CHARS = 6_000;
export const MAX_SUCCESSFUL_WORKSPACE_MUTATION_HISTORY_CHARS = 2_000;
export const MAX_EXPLICIT_SUCCESS_CRITERION_IDENTIFIERS = 32;
export const MAX_EXPLICIT_SUCCESS_CRITERION_IDENTIFIER_CHARS = 64;
export const MAX_EXPLICIT_SUCCESS_CRITERION_SCAN_CHARS = 12_000;
export const MAX_GROUNDED_SOURCE_FACTS_CHARS = 6_000;
const MAX_GROUNDED_SOURCE_FACTS_PER_KIND = 12;
const REPEATED_VALIDATION_REPAIR_CORRECTION_MARKER = "Do not reread it; make a concrete filesystem.patch or filesystem.write repair";

type SuccessfulWorkspaceMutationHistoryEntry =
  | { toolName: "filesystem.patch"; path: string; replacements: Array<{ find: string; replace: string }> }
  | { toolName: "filesystem.write"; path: string; mode: "create" | "overwrite" };

type GroundedSourceCoverage = "full" | "preview_only";
type GroundedDeclarationKind = "class" | "function" | "const" | "let" | "var" | "interface" | "type" | "enum" | "re_export";

export interface GroundedSourceFacts {
  coverage: GroundedSourceCoverage;
  truncated: { exportedDeclarations: boolean; publicMethods: boolean; calls: boolean };
  exportedDeclarations: Array<{ name: string; kind: GroundedDeclarationKind }>;
  publicMethods: Array<{ owner: string; name: string }>;
  calls: Array<{ callee: string; exactStringArguments: string[] }>;
}

export interface GroundedSourceFactsProjection {
  globalTruncated: boolean;
  sources: Record<string, GroundedSourceFacts>;
}

interface ParsedSourceSurface {
  declarations: Array<{ localName: string; exportedName: string; kind: GroundedDeclarationKind; position: number }>;
  methods: Array<{ owner: string; name: string; position: number }>;
  declarationNamePositions: Set<number>;
  localDeclarationNames: Set<string>;
  maskedCode: string;
  braceDepths: Int32Array;
}

interface ReadSourceRecord {
  path: string;
  text: string;
  coverage: GroundedSourceCoverage;
  surface: ParsedSourceSurface;
}

interface ImportedFunctionBinding {
  localName: string;
  exportedName: string;
  moduleSpecifier: string;
}

/** The default Agent leaves goal understanding, planning, and capability choice to one Action Protocol call. */
export function generateGeneralAction(
  state: AgentLoopState,
  deps: HandlerDeps
): Promise<GenerateActionOutcome> {
  const records = deps.input.toolRuntime.listExecutionRecords(state.activeRun.runId);
  const structuralDiscoveryComplete = records
    .some((record) => record.status === "success" && STRUCTURAL_DISCOVERY_TOOLS.has(record.toolName));
  const sourceReadPaths = [...new Set(records
    .filter((record) => record.status === "success" && record.toolName === "filesystem.read")
    .map((record) => record.targetPath)
    .filter((path): path is string => path !== undefined)
    .map(canonicalWorkspacePath))];
  const readPathSet = new Set(sourceReadPaths);
  const readPathKeys = new Set(sourceReadPaths.map((path) => workspacePathComparisonKey(path)));
  const successfulWorkspaceMutationRecorded = hasSuccessfulWorkspaceMutation(records);
  const preMutationContextPaths = successfulWorkspaceMutationRecorded
    ? []
    : requiredPreMutationContextPaths(deps.input.task);
  const unreadPreMutationContextPaths = preMutationContextPaths.filter((path) => !readPathKeys.has(workspacePathComparisonKey(path)));
  const contractEvidence = preMutationContextEvidence(deps.input.task, records);
  const mutationHistory = successfulWorkspaceMutationHistory(records);
  const durableValidationRepairCorrection = latestDurableValidationRepairCorrection(state);
  const storeCallerGaps = unresolvedStoreCallers(records);
  const requiredExactSuccessCriterionIdentifiers = explicitSuccessCriterionIdentifiers(deps.input.task.input.successCriteria ?? []);
  const groundedSourceFacts = sourceFactsFromReadRecords(records);
  const modelWorkingSet = withoutReadCandidates(state.currentWorkingSet, readPathSet);
  const modelDeps = structuralDiscoveryComplete
    ? { ...deps, availableTools: deps.availableTools.filter((tool) => !STRUCTURAL_DISCOVERY_TOOLS.has(tool.name)) }
    : deps;
  return generateNaturalLanguageAction(state, modelDeps, {
    startedAt: deps.input.now(),
    selectionAction: null as AgentAction | null,
    profileContext: {
      mode: "general",
      instructions: [
        "Understand the user's natural-language goal and decide the next Action Protocol action.",
        "The authorized workspace is already available through tools. Never ask the user to provide source files or paths that filesystem.search and filesystem.read can discover.",
        "Answer directly when sufficient information is available; otherwise ask a focused question or persist a plan with update_plan.",
        "Choose only from the available capabilities, inspect tool results and failures, then continue, repair, replan, or propose final.",
        "WorkingSet and search snippets are candidate locations, not proof that an implementation file was inspected. Read the relevant source before making implementation claims; in a read-only Run never repeat a successful Tool call or reread a path, because even a large-file preview will be identical. After mutation, reread only evidence made stale by that mutation.",
        "Prioritize current production source over reports, specs, generated artifacts, and tests when explaining repository implementation or runtime behavior.",
        "When a request spans multiple components, responsibilities, or call-flow claims, trace each hop with targeted filesystem.search and filesystem.read, and ground every conclusion in the implementation files read before final.",
        "A Store definition proves persistence mechanics, not which runtime caller invokes it. When tracing persistence, also search for and read the core caller or handler that uses the Store, then explain both roles.",
        `Unresolved Store caller evidence from completed reads: ${storeCallerGaps.length === 0 ? "none" : storeCallerGaps.join(", ")}. When this list is non-empty, search the exact Store symbol and read a returned non-storage core caller or handler before any final.`,
        "When the user requests functions, exports, methods, or runtime transitions, use groundedSourceFacts instead of inventing names, ownership, or status values from filenames or prose. exportedDeclarations contains only explicit module exports; publicMethods retains the exported class owner; calls contains only imported direct calls to functions exported by another completed source read and preserves exact direct string arguments. Imports, module-local declarations, nested functions, private/protected methods, and code-shaped comments/strings are intentionally absent. coverage=preview_only means the large-file read did not expose the full source. An absent fact has negative authority only when coverage=full, its per-kind truncated flag is false, and globalTruncated is false. Do not claim a transition string contradicted by the relevant grounded call facts. In final, preserve exact letter case for the user's terminology and Profile-named architectural boundaries such as Completion Gate.",
        `Exact identifier-like terms explicitly named by the Task success criteria and required verbatim in final: ${requiredExactSuccessCriterionIdentifiers.join(", ") || "none"}. These names come from the Task Contract; do not replace them with a filename-derived paraphrase.`,
        "sourceReadPaths are completed evidence and MUST NOT be read again unless a successful workspace mutation made that path stale. unreadCandidatePaths are options, not a queue: read only candidates that directly cover the next requested component; when none does, start a new targeted search for that component instead of draining unrelated candidates. Compare completed sources with every requested component and continue targeted search/read while any requested claim lacks a directly read implementation source.",
        "For repository changes, inspect once, read only the smallest relevant files, then patch, run the supplied validation, and propose final; if blocked, replan once or ask the user instead of broadening the same exploration.",
        ...(durableValidationRepairCorrection === null ? [] : [
          `Durable correction from the latest rejected validation-repair action: ${durableValidationRepairCorrection}`
        ]),
        `Before the first filesystem.patch or filesystem.write, read every required existing edit target and every protected contract/test file explicitly named by the user or Success criteria. Unread pre-mutation context paths: ${unreadPreMutationContextPaths.join(", ") || "none"}. Do not mutate until this list is empty; after a successful mutation, retain unmodified contract evidence and reread only paths made stale by that mutation before relying on their content.`,
        `Exact unmodified required contract evidence retained across iterations and successful mutations (evidence for mutated paths is removed; JSON-serialized representation globally capped at ${String(MAX_PRE_MUTATION_CONTEXT_EVIDENCE_CHARS)} characters):\n${contractEvidence || "none"}`,
        `Successful workspace mutation recorded: ${successfulWorkspaceMutationRecorded ? "yes" : "no"}; history [] means details were omitted by the cap, not that no mutation occurred.`,
        `Exact successful workspace mutation history retained from persisted execution records (globally capped at ${String(MAX_SUCCESSFUL_WORKSPACE_MUTATION_HISTORY_CHARS)} JSON characters): ${mutationHistory}`,
        "When the successful workspace mutation history is nonempty (not []), final must describe the successful mutation history; when Successful workspace mutation recorded is yes, final must not claim that no code change was needed.",
        "A final action only proposes completion; provide the work and evidence required by the Completion Gate."
      ],
      sourceReadPaths,
      groundedSourceFacts,
      unreadCandidatePaths: modelWorkingSet?.items.map((item) => item.path) ?? [],
      unreadPreMutationContextPaths
    },
    additionalSegments: [],
    workingSet: modelWorkingSet,
    recentToolResult: withoutReadSearchMatches(state.recentToolResult, readPathSet)
  });
}

export function latestDurableValidationRepairCorrection(state: AgentLoopState): string | null {
  if (state.previousSnapshot?.errorCode !== "REPEATED_VALIDATION_REPAIR_READ") return null;
  for (let index = state.ledger.decisions.length - 1; index >= 0; index -= 1) {
    const decision = state.ledger.decisions[index];
    if (decision?.includes(REPEATED_VALIDATION_REPAIR_CORRECTION_MARKER) === true) return decision;
  }
  return null;
}

export function requiredPreMutationContextPaths(task: Task): string[] {
  const constraints = task.input.executionConstraints;
  if (constraints === undefined) return [];
  const taskContractText = [task.input.text, ...(task.input.successCriteria ?? [])].join("\n");
  const namedProtectedPaths = constraints.protectedFiles.filter((path) => pathNameIsMentioned(path, taskContractText));
  return [...new Set([...constraints.requiredEditFiles, ...namedProtectedPaths].map(canonicalWorkspacePath))];
}

export function explicitSuccessCriterionIdentifiers(criteria: readonly string[]): string[] {
  const identifiers = new Set<string>();
  let remainingScanChars = MAX_EXPLICIT_SUCCESS_CRITERION_SCAN_CHARS;
  const addIdentifier = (identifier: string | undefined): boolean => {
    if (
      identifier === undefined ||
      identifier.length > MAX_EXPLICIT_SUCCESS_CRITERION_IDENTIFIER_CHARS ||
      identifiers.has(identifier)
    ) {
      return false;
    }
    identifiers.add(identifier);
    return identifiers.size >= MAX_EXPLICIT_SUCCESS_CRITERION_IDENTIFIERS;
  };
  for (const criterion of criteria) {
    if (remainingScanChars <= 0) break;
    const truncated = criterion.length > remainingScanChars;
    const scannedCriterion = criterion.slice(0, remainingScanChars);
    remainingScanChars -= scannedCriterion.length;
    const boundedCriterion = truncated
      ? scannedCriterion.replace(/[A-Za-z0-9_$`/]+$/u, "")
      : scannedCriterion;
    for (const match of boundedCriterion.matchAll(/`([A-Za-z_$][\w$]*)`/gu)) {
      if (addIdentifier(match[1])) return [...identifiers];
    }
    for (const match of boundedCriterion.matchAll(/\b([A-Za-z_$][\w$]*)\s*\/\s*([A-Za-z_$][\w$]*)\b/gu)) {
      const pair = [match[1], match[2]].filter((value): value is string => value !== undefined);
      if (!pair.some(distinctiveCodeIdentifier)) continue;
      for (const identifier of pair) {
        if (addIdentifier(identifier)) return [...identifiers];
      }
    }
    for (const match of boundedCriterion.matchAll(/\b[A-Za-z_$][\w$]*\b/gu)) {
      const identifier = match[0];
      if (distinctiveCodeIdentifier(identifier) && addIdentifier(identifier)) return [...identifiers];
    }
  }
  return [...identifiers];
}

function distinctiveCodeIdentifier(value: string): boolean {
  return /[a-z0-9_$][A-Z]/u.test(value) || /[A-Z].*[A-Z]/u.test(value.slice(1));
}

export function hasSuccessfulWorkspaceMutation(records: readonly ExecutionRecord[]): boolean {
  return records.some((record) => record.status === "success" && WORKSPACE_MUTATION_TOOLS.has(record.toolName));
}

export function successfulWorkspaceMutationHistory(records: readonly ExecutionRecord[]): string {
  const candidates: SuccessfulWorkspaceMutationHistoryEntry[] = [];
  for (const record of records) {
    if (record.status !== "success" || !WORKSPACE_MUTATION_TOOLS.has(record.toolName)) continue;
    try {
      const toolCall = ToolCallEnvelopeSchema.parse(JSON.parse(record.inputJson));
      if (toolCall.toolName !== record.toolName) continue;
      if (toolCall.toolName === "filesystem.patch") {
        const input = FilesystemPatchInputSchema.parse(toolCall.input);
        const patches = Array.isArray(input.patch) ? input.patch : [input.patch];
        candidates.push({
          toolName: toolCall.toolName,
          path: canonicalWorkspacePath(input.path),
          replacements: patches.map(({ find, replace }) => ({ find, replace }))
        });
      }
      if (toolCall.toolName === "filesystem.write") {
        const input = FilesystemWriteInputSchema.parse(toolCall.input);
        candidates.push({ toolName: toolCall.toolName, path: canonicalWorkspacePath(input.path), mode: input.mode });
      }
    } catch {
      continue;
    }
  }
  const retained: SuccessfulWorkspaceMutationHistoryEntry[] = [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const next = [candidate, ...retained];
    if (JSON.stringify(JSON.stringify(next)).length > MAX_SUCCESSFUL_WORKSPACE_MUTATION_HISTORY_CHARS) break;
    retained.unshift(candidate);
  }
  return JSON.stringify(retained);
}

export function canonicalWorkspacePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/gu, "/").split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export function workspacePathComparisonKey(
  path: string,
  caseSensitive = process.platform !== "win32"
): string {
  const canonical = canonicalWorkspacePath(path);
  return caseSensitive ? canonical : canonical.toLowerCase();
}

export function preMutationContextEvidence(task: Task, records: readonly ExecutionRecord[]): string {
  const requiredPaths = [...new Map(requiredPreMutationContextPaths(task)
    .map((path) => [workspacePathComparisonKey(path), path] as const)).values()];
  if (requiredPaths.length === 0) return "";
  const requiredPathKeys = new Set(requiredPaths.map((path) => workspacePathComparisonKey(path)));
  const latestReads = new Map<string, ExecutionRecord>();
  for (const record of records) {
    if (record.status !== "success" || record.targetPath === undefined) continue;
    const key = workspacePathComparisonKey(record.targetPath);
    if (!requiredPathKeys.has(key)) continue;
    if (WORKSPACE_MUTATION_TOOLS.has(record.toolName)) {
      latestReads.delete(key);
    } else if (record.toolName === "filesystem.read") {
      latestReads.set(key, record);
    }
  }
  const entries = requiredPaths.flatMap((path) => {
    const record = latestReads.get(workspacePathComparisonKey(path));
    return record === undefined ? [] : [{ path, text: readRecordText(record) }];
  });
  if (entries.length === 0) return "";

  const separator = "\n\n";
  const separatorEncodedLength = jsonEncodedStringContentLength(separator);
  const entryEncodedLimit = Math.max(0, Math.floor(
    (MAX_PRE_MUTATION_CONTEXT_EVIDENCE_CHARS - 2 - separatorEncodedLength * Math.max(0, entries.length - 1)) / entries.length
  ));
  return entries.map(({ path, text }) =>
    truncateToJsonEncodedStringContentLength(`[${path}]\n${text}`, entryEncodedLimit)
  ).join(separator);
}

function jsonEncodedStringContentLength(value: string): number {
  return JSON.stringify(value).length - 2;
}

function truncateToJsonEncodedStringContentLength(value: string, maxEncodedLength: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (jsonEncodedStringContentLength(value.slice(0, midpoint)) <= maxEncodedLength) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return value.slice(0, low);
}

export function sourceSymbolsFromReadRecords(records: readonly ExecutionRecord[]): Record<string, string[]> {
  return Object.fromEntries(currentReadSources(records).flatMap(({ path, surface }) => {
    const names = [...surface.declarations.map(({ exportedName: name, position }) => ({ name, position })), ...surface.methods]
      .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name, "en"))
      .map(({ name }) => name)
      .filter((name, index, values) => values.indexOf(name) === index)
      .slice(0, MAX_GROUNDED_SOURCE_FACTS_PER_KIND);
    return names.length === 0 ? [] : [[path, names] as const];
  }));
}

export function sourceFactsFromReadRecords(records: readonly ExecutionRecord[]): GroundedSourceFactsProjection {
  const sources = currentReadSources(records);
  const exportedFunctions = new Map<string, Array<{ path: string; localName: string }>>();
  for (const source of sources) {
    for (const declaration of source.surface.declarations) {
      if (declaration.kind !== "function") continue;
      const declarations = exportedFunctions.get(declaration.exportedName) ?? [];
      declarations.push({ path: source.path, localName: declaration.localName });
      exportedFunctions.set(declaration.exportedName, declarations);
    }
  }

  const bounded = Object.fromEntries(sources.map((source) => [source.path, capSourceFacts({
    coverage: source.coverage,
    truncated: { exportedDeclarations: false, publicMethods: false, calls: false },
    exportedDeclarations: source.surface.declarations.map(({ exportedName: name, kind }) => ({ name, kind })),
    publicMethods: source.surface.methods.map(({ owner, name }) => ({ owner, name })),
    calls: sourceCalls(source, exportedFunctions)
  })] satisfies [string, GroundedSourceFacts]));
  return capGroundedSourceFacts(bounded);
}

function capSourceFacts(facts: GroundedSourceFacts): GroundedSourceFacts {
  const capped: GroundedSourceFacts = {
    coverage: facts.coverage,
    truncated: { exportedDeclarations: false, publicMethods: false, calls: false },
    exportedDeclarations: [],
    publicMethods: [],
    calls: []
  };
  let retained = 0;
  for (let itemIndex = 0; retained < MAX_GROUNDED_SOURCE_FACTS_PER_KIND; itemIndex += 1) {
    let found = false;
    for (const key of ["exportedDeclarations", "publicMethods", "calls"] as const) {
      const item = facts[key][itemIndex];
      if (item === undefined) continue;
      found = true;
      if (retained < MAX_GROUNDED_SOURCE_FACTS_PER_KIND) {
        (capped[key] as Array<typeof item>).push(item);
        retained += 1;
      }
    }
    if (!found) break;
  }
  for (const key of ["exportedDeclarations", "publicMethods", "calls"] as const) {
    capped.truncated[key] = facts[key].length > capped[key].length;
  }
  return capped;
}

function currentReadSources(records: readonly ExecutionRecord[]): ReadSourceRecord[] {
  const sources = new Map<string, ReadSourceRecord>();
  for (const record of records) {
    if (record.status !== "success" || record.targetPath === undefined) continue;
    const path = canonicalWorkspacePath(record.targetPath);
    const key = workspacePathComparisonKey(path);
    if (WORKSPACE_MUTATION_TOOLS.has(record.toolName)) {
      sources.delete(key);
      continue;
    }
    if (record.toolName !== "filesystem.read" || !isJavaScriptSourcePath(path)) continue;
    const content = readRecordSource(record);
    if (content === null) continue;
    sources.set(key, { path, text: content.text, coverage: content.coverage, surface: parseSourceSurface(content.text) });
  }
  return [...sources.values()];
}

function parseSourceSurface(text: string): ParsedSourceSurface {
  const code = maskCommentsAndStrings(text);
  const depths = braceDepths(code);
  const localDeclarations = new Map<string, { kind: GroundedDeclarationKind; position: number }>();
  const exportBindings = new Map<string, { localName: string; exportedName: string }>();
  const classRanges = new Map<string, { open: number; close: number }>();
  const declarationNamePositions = new Set<number>();
  const declarations = /\b(export\s+(?:default\s+)?)?(?:(?:declare|abstract|async)\s+)*(class|function|const|let|var|interface|type|enum)\s*\*?\s+([A-Za-z_$][\w$]*)/gu;
  for (const match of code.matchAll(declarations)) {
    if (match.index === undefined || depths[match.index] !== 0 || match[2] === undefined || match[3] === undefined) continue;
    const kind = match[2] as GroundedDeclarationKind;
    const name = match[3];
    const namePosition = match.index + match[0].lastIndexOf(name);
    localDeclarations.set(name, { kind, position: match.index });
    declarationNamePositions.add(namePosition);
    if (match[1] !== undefined) exportBindings.set(name, { localName: name, exportedName: name });
    if (kind !== "class") continue;
    const classOpen = code.indexOf("{", match.index + match[0].length);
    if (classOpen < 0 || depths[classOpen] !== 0) continue;
    const classClose = matchingBrace(code, classOpen);
    if (classClose < 0) continue;
    classRanges.set(name, { open: classOpen, close: classClose });
  }

  const exportLists = /\bexport\s*\{([^{}]*)\}/gu;
  for (const match of code.matchAll(exportLists)) {
    if (match.index === undefined || depths[match.index] !== 0 || match[1] === undefined) continue;
    for (const item of match[1].split(",")) {
      const parts = item.trim().replace(/^type\s+/u, "").split(/\s+/u).filter(Boolean);
      if (parts.length === 0) continue;
      const asIndex = parts.indexOf("as");
      const localName = parts[0];
      const exportedName = asIndex >= 0 ? parts[asIndex + 1] : localName;
      if (
        localName !== undefined && exportedName !== undefined &&
        /^[A-Za-z_$][\w$]*$/u.test(localName) && /^[A-Za-z_$][\w$]*$/u.test(exportedName)
      ) exportBindings.set(exportedName, { localName, exportedName });
    }
  }

  const exportedDeclarations = [...exportBindings.values()].flatMap(({ localName, exportedName }) => {
    const declaration = localDeclarations.get(localName);
    return [{
      localName,
      exportedName,
      kind: declaration?.kind ?? "re_export",
      position: declaration?.position ?? code.indexOf(exportedName)
    }];
  }).sort((left, right) => left.position - right.position || left.exportedName.localeCompare(right.exportedName, "en"));
  const methods: ParsedSourceSurface["methods"] = [];
  for (const declaration of exportedDeclarations) {
    if (declaration.kind !== "class") continue;
    const range = classRanges.get(declaration.localName);
    if (range === undefined) continue;
    const matcher = /(?:^|[;{}\n])\s*((?:(?:public|protected|private|static|abstract|async|override|readonly|declare)\s+)*)((?:get|set)\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\??\s*(?:<[^>{}\n]*>)?\s*\(/gu;
    matcher.lastIndex = range.open;
    for (;;) {
      const method = matcher.exec(code);
      if (method === null || method.index >= range.close) break;
      const name = method[3];
      const nameIndex = name === undefined ? method.index : method.index + method[0].lastIndexOf(name);
      if (name === undefined || depths[nameIndex] !== 1 || name === "constructor") continue;
      if (/\b(?:private|protected)\b/u.test(method[1] ?? "")) continue;
      methods.push({ owner: declaration.exportedName, name, position: method.index });
    }
  }
  methods.sort((left, right) => left.position - right.position || left.name.localeCompare(right.name, "en"));
  return {
    declarations: exportedDeclarations,
    methods,
    declarationNamePositions,
    localDeclarationNames: new Set(localDeclarations.keys()),
    maskedCode: code,
    braceDepths: depths
  };
}

function sourceCalls(
  source: ReadSourceRecord,
  exportedFunctions: ReadonlyMap<string, ReadonlyArray<{ path: string; localName: string }>>
): GroundedSourceFacts["calls"] {
  const code = source.surface.maskedCode;
  const calls: Array<{ callee: string; exactStringArguments: string[]; position: number }> = [];
  const bindings = importedFunctionBindings(source, exportedFunctions);
  const callMatcher = /\b([A-Za-z_$][\w$]*)\s*\(/gu;
  for (const match of code.matchAll(callMatcher)) {
    if (match.index === undefined || match[1] === undefined) continue;
    const binding = bindings.get(match[1]);
    if (binding === undefined) continue;
    const namePosition = match.index + match[0].indexOf(binding.localName);
    const previousCode = code.slice(0, namePosition).match(/\S\s*$/u)?.[0]?.trim();
    if (previousCode === "." || previousCode === "#" || previousCode === "?") continue;
    if (callIsShadowed(source.surface, binding.localName, namePosition)) continue;
    const openingIndex = code.indexOf("(", namePosition + binding.localName.length);
    const closingIndex = matchingDelimiter(code, openingIndex, "(", ")");
    if (openingIndex < 0 || closingIndex < 0) continue;
    calls.push({
      callee: binding.exportedName,
      exactStringArguments: directStringArguments(source.text, code, openingIndex + 1, closingIndex),
      position: match.index
    });
  }
  calls.sort((left, right) => left.position - right.position || left.callee.localeCompare(right.callee, "en"));
  return calls.map(({ callee, exactStringArguments }) => ({ callee, exactStringArguments }));
}

function importedFunctionBindings(
  source: ReadSourceRecord,
  exportedFunctions: ReadonlyMap<string, ReadonlyArray<{ path: string; localName: string }>>
): Map<string, ImportedFunctionBinding> {
  const code = source.surface.maskedCode;
  const depths = source.surface.braceDepths;
  const bindings = new Map<string, ImportedFunctionBinding>();
  const imports = /\bimport\s+(?:type\s+)?\{([^{}]*)\}\s+from\s+(["'])([^"']+)\2/gu;
  for (const match of source.text.matchAll(imports)) {
    if (match.index === undefined || depths[match.index] !== 0 || code.slice(match.index, match.index + 6) !== "import") continue;
    if (match[1] === undefined || match[3] === undefined) continue;
    for (const item of match[1].split(",")) {
      const parts = item.trim().replace(/^type\s+/u, "").split(/\s+/u).filter(Boolean);
      const exportedName = parts[0];
      const asIndex = parts.indexOf("as");
      const localName = asIndex >= 0 ? parts[asIndex + 1] : exportedName;
      if (exportedName === undefined || localName === undefined) continue;
      const candidates = exportedFunctions.get(exportedName) ?? [];
      if (!candidates.some((candidate) => sourcePathMatchesModule(source.path, match[3]!, candidate.path))) continue;
      bindings.set(localName, { localName, exportedName, moduleSpecifier: match[3] });
    }
  }
  return bindings;
}

function callIsShadowed(surface: ParsedSourceSurface, localName: string, callPosition: number): boolean {
  const code = surface.maskedCode;
  const escapedName = escapeRegex(localName);
  const parameterName = new RegExp(`\\b${escapedName}\\b`, "u");
  const scopedParameterPatterns: Array<{ matcher: RegExp; parameterGroup: number; nameGroup?: number }> = [
    { matcher: /\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)\s*\{/gu, parameterGroup: 1 },
    { matcher: /\(([^)]*)\)\s*=>\s*\{/gu, parameterGroup: 1 },
    { matcher: /\b([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gu, parameterGroup: 2, nameGroup: 1 }
  ];
  for (const { matcher, parameterGroup, nameGroup } of scopedParameterPatterns) {
    for (const match of code.matchAll(matcher)) {
      if (match.index === undefined || !parameterName.test(match[parameterGroup] ?? "")) continue;
      if (nameGroup !== undefined && /^(?:if|for|while|switch|catch|with)$/u.test(match[nameGroup] ?? "")) continue;
      const opening = match.index + match[0].lastIndexOf("{");
      const closing = matchingBrace(code, opening);
      if (opening < callPosition && callPosition < closing) return true;
    }
  }
  const singleParameterArrow = new RegExp(`\\b${escapedName}\\s*=>\\s*\\{`, "gu");
  for (const match of code.matchAll(singleParameterArrow)) {
    if (match.index === undefined) continue;
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingBrace(code, opening);
    if (opening < callPosition && callPosition < closing) return true;
  }
  const declarations = new RegExp(`\\b(const|let|var|function|class)\\s+${escapedName}\\b`, "gu");
  for (const declaration of code.matchAll(declarations)) {
    if (declaration.index === undefined) continue;
    if (declaration[1] === "var") {
      const functionScope = enclosingFunctionScope(code, declaration.index);
      if (functionScope.start < callPosition && callPosition < functionScope.end) return true;
      continue;
    }
    const declarationDepth = surface.braceDepths[declaration.index] ?? 0;
    if ((surface.braceDepths[callPosition] ?? 0) < declarationDepth) continue;
    const block = enclosingBlock(code, surface.braceDepths, declaration.index, declarationDepth);
    if (block.start < callPosition && callPosition < block.end) return true;
  }
  return false;
}

function enclosingFunctionScope(code: string, position: number): { start: number; end: number } {
  let selected = { start: 0, end: code.length };
  const scopes: Array<{ matcher: RegExp; nameGroup?: number }> = [
    { matcher: /\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*\{/gu },
    { matcher: /\([^)]*\)\s*=>\s*\{/gu },
    { matcher: /\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gu, nameGroup: 1 },
    { matcher: /\b[A-Za-z_$][\w$]*\s*=>\s*\{/gu }
  ];
  for (const { matcher, nameGroup } of scopes) {
    for (const match of code.matchAll(matcher)) {
      if (match.index === undefined) continue;
      if (nameGroup !== undefined && /^(?:if|for|while|switch|catch|with)$/u.test(match[nameGroup] ?? "")) continue;
      const start = match.index + match[0].lastIndexOf("{");
      const end = matchingBrace(code, start);
      if (start < position && position < end && start >= selected.start && end <= selected.end) selected = { start, end };
    }
  }
  return selected;
}

function enclosingBlock(code: string, depths: Int32Array, position: number, depth: number): { start: number; end: number } {
  if (depth === 0) return { start: 0, end: code.length };
  let start = position;
  while (start > 0 && !(code[start] === "{" && depths[start] === depth - 1)) start -= 1;
  return { start, end: matchingBrace(code, start) };
}

function sourcePathMatchesModule(callerPath: string, moduleSpecifier: string, candidatePath: string): boolean {
  if (!moduleSpecifier.startsWith(".")) return false;
  const callerSegments = canonicalWorkspacePath(callerPath).split("/");
  callerSegments.pop();
  const resolved = canonicalWorkspacePath([...callerSegments, moduleSpecifier].join("/"));
  const comparableResolved = resolved.replace(/\.(?:[cm]?[jt]sx?)$/iu, "");
  const comparableCandidate = canonicalWorkspacePath(candidatePath).replace(/\.(?:[cm]?[jt]sx?)$/iu, "");
  return workspacePathComparisonKey(comparableResolved) === workspacePathComparisonKey(comparableCandidate) ||
    workspacePathComparisonKey(`${comparableResolved}/index`) === workspacePathComparisonKey(comparableCandidate);
}

function directStringArguments(source: string, code: string, start: number, end: number): string[] {
  const ranges: Array<[number, number]> = [];
  let argumentStart = start;
  let nesting = 0;
  for (let index = start; index < end; index += 1) {
    const character = code[index];
    if (character === "(" || character === "[" || character === "{") nesting += 1;
    else if (character === ")" || character === "]" || character === "}") nesting = Math.max(0, nesting - 1);
    else if (character === "," && nesting === 0) {
      ranges.push([argumentStart, index]);
      argumentStart = index + 1;
    }
  }
  ranges.push([argumentStart, end]);
  return ranges.flatMap(([rangeStart, rangeEnd]) => {
    const argument = source.slice(rangeStart, rangeEnd).trim();
    const match = argument.match(/^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`([^`$\\]*(?:\\.[^`$\\]*)*)`)$/u);
    if (match === null) return [];
    return [match[1] ?? match[2] ?? match[3] ?? ""];
  });
}

function capGroundedSourceFacts(facts: Record<string, GroundedSourceFacts>): GroundedSourceFactsProjection {
  const projection: GroundedSourceFactsProjection = { globalTruncated: false, sources: {} };
  let serializedLength = JSON.stringify(projection).length;
  let retainedSourceCount = 0;
  const markGlobalTruncated = () => {
    if (projection.globalTruncated) return;
    projection.globalTruncated = true;
    serializedLength -= 1;
  };
  for (const [path, sourceFacts] of Object.entries(facts)) {
    const empty: GroundedSourceFacts = {
      coverage: sourceFacts.coverage,
      truncated: { ...sourceFacts.truncated },
      exportedDeclarations: [],
      publicMethods: [],
      calls: []
    };
    const addedLength = JSON.stringify(path).length + 1 + JSON.stringify(empty).length + (retainedSourceCount === 0 ? 0 : 1);
    if (serializedLength + addedLength > MAX_GROUNDED_SOURCE_FACTS_CHARS) {
      markGlobalTruncated();
      continue;
    }
    projection.sources[path] = empty;
    retainedSourceCount += 1;
    serializedLength += addedLength;
  }
  for (let itemIndex = 0; itemIndex < MAX_GROUNDED_SOURCE_FACTS_PER_KIND; itemIndex += 1) {
    for (const key of ["exportedDeclarations", "publicMethods", "calls"] as const) {
      for (const [path, sourceFacts] of Object.entries(facts)) {
        if (projection.sources[path] === undefined) continue;
        const item = sourceFacts[key][itemIndex];
        if (item === undefined) continue;
        const current = projection.sources[path]!;
        const addedLength = JSON.stringify(item).length + (current[key].length === 0 ? 0 : 1);
        if (serializedLength + addedLength > MAX_GROUNDED_SOURCE_FACTS_CHARS) {
          markGlobalTruncated();
          if (!current.truncated[key]) serializedLength -= 1;
          current.truncated[key] = true;
          continue;
        }
        (current[key] as Array<typeof item>).push(item);
        serializedLength += addedLength;
      }
    }
  }
  return projection;
}

function braceDepths(code: string): Int32Array {
  const depths = new Int32Array(code.length + 1);
  let depth = 0;
  for (let index = 0; index < code.length; index += 1) {
    depths[index] = depth;
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}") depth = Math.max(0, depth - 1);
  }
  depths[code.length] = depth;
  return depths;
}

function matchingBrace(code: string, openingIndex: number): number {
  return matchingDelimiter(code, openingIndex, "{", "}");
}

function matchingDelimiter(code: string, openingIndex: number, opening: string, closing: string): number {
  let depth = 0;
  for (let index = openingIndex; index < code.length; index += 1) {
    if (code[index] === opening) depth += 1;
    else if (code[index] === closing && --depth === 0) return index;
  }
  return -1;
}

function maskCommentsAndStrings(text: string): string {
  const output = text.split("");
  let state: "code" | "line_comment" | "block_comment" | "single_quote" | "double_quote" | "template" | "regex" = "code";
  let regexCharacterClass = false;
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index]!;
    const next = output[index + 1];
    if (state === "code") {
      if (character === "/" && next === "/") {
        output[index] = output[index + 1] = " ";
        index += 1;
        state = "line_comment";
      } else if (character === "/" && next === "*") {
        output[index] = output[index + 1] = " ";
        index += 1;
        state = "block_comment";
      } else if (character === "'") {
        output[index] = " ";
        state = "single_quote";
      } else if (character === '"') {
        output[index] = " ";
        state = "double_quote";
      } else if (character === "`") {
        output[index] = " ";
        state = "template";
      } else if (character === "/" && startsRegexLiteral(text, index)) {
        output[index] = " ";
        regexCharacterClass = false;
        state = "regex";
      }
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (state === "line_comment") state = "code";
      continue;
    }
    output[index] = " ";
    if (character === "\\") {
      if (index + 1 < output.length) output[index + 1] = " ";
      index += 1;
    } else if (state === "block_comment" && character === "*" && next === "/") {
      if (index + 1 < output.length) output[index + 1] = " ";
      index += 1;
      state = "code";
    } else if (state === "regex" && character === "[") {
      regexCharacterClass = true;
    } else if (state === "regex" && character === "]") {
      regexCharacterClass = false;
    } else if (state === "regex" && character === "/" && !regexCharacterClass) {
      while (/[A-Za-z]/u.test(output[index + 1] ?? "")) {
        output[index + 1] = " ";
        index += 1;
      }
      state = "code";
    } else if (
      (state === "single_quote" && character === "'") ||
      (state === "double_quote" && character === '"') ||
      (state === "template" && character === "`")
    ) {
      state = "code";
    }
  }
  return output.join("");
}

function startsRegexLiteral(text: string, slashIndex: number): boolean {
  const prefix = text.slice(0, slashIndex).trimEnd();
  if (prefix.length === 0) return true;
  if (prefix.endsWith("=>")) return true;
  if ("=(:,!&|?;{}[".includes(prefix.at(-1) ?? "")) return true;
  return /(?:^|\W)(?:return|case|throw|yield|await|typeof|instanceof|in|of|delete|void|new)$/u.test(prefix);
}

function unresolvedStoreCallers(records: readonly ExecutionRecord[]): string[] {
  const readRecords = records.filter((record) => record.status === "success" && record.toolName === "filesystem.read" && record.targetPath !== undefined);
  return readRecords.flatMap((record) => {
    const path = record.targetPath!;
    const normalized = path.replace(/\\/gu, "/");
    const match = normalized.match(/(?:^|\/)storage\/(?:.*\/)?([^/]+)-store\.[^.]+$/iu);
    if (match?.[1] === undefined) return [];
    const instance = `${match[1].replace(/-([a-z])/gu, (_whole, letter: string) => letter.toUpperCase())}Store`;
    const writeCall = new RegExp(`\\b${instance}\\s*\\.\\s*(?:insert|create|save|set|update|upsert|append|persist|put|delete|remove)\\w*\\s*\\(`, "u");
    const callerReadPaths = new Set(readRecords.filter((candidate) =>
      candidate.targetPath !== path &&
      candidate.targetPath !== undefined &&
      isImplementationSourcePath(candidate.targetPath) &&
      !/(?:^|[\\/])storage(?:[\\/]|$)/iu.test(candidate.targetPath)
    ).map((candidate) => candidate.targetPath!));
    const hasCaller = readRecords.some((candidate) => callerReadPaths.has(candidate.targetPath!) && writeCall.test(readRecordText(candidate))) ||
      records.some((candidate) => writeCall.test(searchRecordText(candidate, callerReadPaths)));
    const symbol = `${match[1].split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join("")}Store`;
    return hasCaller ? [] : [`${normalized} -> search ${symbol} write usage`];
  });
}

function pathNameIsMentioned(path: string, text: string): boolean {
  const basename = path.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  const stem = basename.replace(/\.[^.]+$/u, "");
  return [...new Set([basename, stem])]
    .filter((name) => name.length > 0)
    .some((name) => new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapeRegex(name)}($|[^\\p{L}\\p{N}_-])`, "iu").test(text));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isImplementationSourcePath(path: string): boolean {
  return !/(^|[\\/])(?:agent-evaluation|docs?|reports?|tests?)(?:[\\/]|$)/iu.test(path) &&
    !/(^|[\\/])packages[\\/]contracts(?:[\\/]|$)/iu.test(path) &&
    !/\.(?:md|json|ya?ml|toml)$/iu.test(path);
}

function isJavaScriptSourcePath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/iu.test(path);
}

function readRecordText(record: ExecutionRecord): string {
  return readRecordSource(record)?.text ?? "";
}

function readRecordSource(record: ExecutionRecord): { text: string; coverage: GroundedSourceCoverage } | null {
  try {
    const parsed = ToolResultSchema.parse(JSON.parse(record.outputJson));
    if (parsed.status !== "success" || parsed.toolName !== "filesystem.read") return null;
    if (parsed.output.kind === "inline_text") return { text: parsed.output.content, coverage: "full" };
    return parsed.output.previewText === undefined
      ? null
      : { text: parsed.output.previewText, coverage: "preview_only" };
  } catch {
    return null;
  }
}

function searchRecordText(record: ExecutionRecord, readPaths: ReadonlySet<string>): string {
  try {
    const parsed = ToolResultSchema.parse(JSON.parse(record.outputJson));
    if (parsed.status !== "success" || parsed.toolName !== "filesystem.search") return "";
    return parsed.output.result.matches
      .filter((match) => readPaths.has(match.path))
      .map((match) => match.snippet)
      .join("\n");
  } catch {
    return "";
  }
}

function withoutReadCandidates(workingSet: WorkingSet | null, readPaths: ReadonlySet<string>): WorkingSet | null {
  if (workingSet === null) return null;
  const items = workingSet.items.filter((item) => !readPaths.has(item.path));
  return { ...workingSet, itemCount: items.length, items };
}

function withoutReadSearchMatches(toolResult: ToolResult | null, readPaths: ReadonlySet<string>): ToolResult | null {
  if (toolResult === null || toolResult.status !== "success" || toolResult.toolName !== "filesystem.search") return toolResult;
  const matches = toolResult.output.result.matches.filter((match) => !readPaths.has(match.path));
  const workingSet = withoutReadCandidates(toolResult.output.workingSet, readPaths)!;
  const manifestItems = toolResult.output.contextManifest.items.filter((item) => !readPaths.has(item.path));
  return {
    ...toolResult,
    output: {
      ...toolResult.output,
      result: { ...toolResult.output.result, returnedMatches: matches.length, matches },
      workingSet,
      contextManifest: {
        ...toolResult.output.contextManifest,
        workingSetItemCount: manifestItems.length,
        items: manifestItems
      }
    }
  };
}
