import type { JsonValue } from "./providers/model-client.js";
import type { ModelResponse, ProviderToolCall } from "./providers/model-response.js";
import type { JsonSchema } from "./tool-schema.js";

const MAX_ENCODED_VALUE_CHARS = 1_000_000;
const MAX_DECODED_DEPTH = 32;
const MAX_DECODED_NODES = 50_000;

export type ToolArgumentNormalizationChange = {
  readonly path: string;
  readonly kind: "json_array" | "json_object" | "integer_string";
};

export type ToolArgumentNormalizationDiagnostic = {
  readonly callId: string;
  readonly toolName: string;
  readonly providerArguments: JsonValue;
  readonly normalizedArguments: JsonValue;
  readonly changes: readonly ToolArgumentNormalizationChange[];
};

export function normalizeProviderToolArguments(
  response: ModelResponse,
  schemas: ReadonlyMap<string, JsonSchema>
): {
  readonly response: ModelResponse;
  readonly diagnostics: readonly ToolArgumentNormalizationDiagnostic[];
} {
  const diagnostics: ToolArgumentNormalizationDiagnostic[] = [];
  const toolCalls = response.toolCalls.map((call): ProviderToolCall => {
    const schema = schemas.get(call.name);
    if (schema === undefined) return call;
    const changes: ToolArgumentNormalizationChange[] = [];
    const normalized = normalizeValue(call.arguments, [schema], "", changes, 0) as JsonValue;
    if (changes.length === 0) return call;
    diagnostics.push({
      callId: call.callId,
      toolName: call.name,
      providerArguments: call.arguments as JsonValue,
      normalizedArguments: normalized,
      changes
    });
    return { ...call, arguments: normalized };
  });
  return {
    response: diagnostics.length === 0 ? response : { ...response, toolCalls },
    diagnostics
  };
}

function normalizeValue(
  value: unknown,
  schemas: readonly JsonSchema[],
  path: string,
  changes: ToolArgumentNormalizationChange[],
  depth: number
): unknown {
  if (depth > MAX_DECODED_DEPTH) return value;
  const candidates = schemaBranches(schemas);
  const allowedTypes = schemaTypes(candidates);
  let normalized = value;

  if (typeof value === "string" && !allowedTypes.has("string")) {
    if (allowedTypes.has("integer")) {
      const integer = canonicalInteger(value);
      if (integer !== null) {
        normalized = integer;
        changes.push({ path: path || "/", kind: "integer_string" });
      }
    } else if (allowedTypes.has("array") || allowedTypes.has("object")) {
      const parsed = parseBoundedComposite(value);
      if (
        (allowedTypes.has("array") && Array.isArray(parsed))
        || (allowedTypes.has("object") && isJsonObject(parsed))
      ) {
        normalized = parsed;
        changes.push({ path: path || "/", kind: Array.isArray(parsed) ? "json_array" : "json_object" });
      }
    }
  }

  if (Array.isArray(normalized)) {
    return normalized.map((item, index) => {
      const itemSchemas = arrayItemSchemas(candidates, index);
      return itemSchemas.length === 0
        ? item
        : normalizeValue(item, itemSchemas, `${path}/${index}`, changes, depth + 1);
    });
  }
  if (!isJsonObject(normalized)) return normalized;

  const output: Record<string, unknown> = { ...normalized };
  for (const [key, current] of Object.entries(output)) {
    const propertySchemas = objectPropertySchemas(candidates, key);
    if (propertySchemas.length === 0) continue;
    output[key] = normalizeValue(
      current,
      propertySchemas,
      `${path}/${escapePointerSegment(key)}`,
      changes,
      depth + 1
    );
  }
  return output;
}

function parseBoundedComposite(value: string): unknown {
  if (value.length > MAX_ENCODED_VALUE_CHARS) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return withinStructureLimits(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function withinStructureLimits(value: unknown): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_DECODED_NODES || current.depth > MAX_DECODED_DEPTH) return false;
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
    } else if (isJsonObject(current.value)) {
      for (const item of Object.values(current.value)) pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return true;
}

function canonicalInteger(value: string): number | null {
  if (!/^-?(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function schemaTypes(schemas: readonly JsonSchema[]): Set<string> {
  const types = new Set<string>();
  for (const schema of schemas) {
    if (typeof schema.type === "string") types.add(schema.type);
    else if (Array.isArray(schema.type)) {
      for (const type of schema.type) if (typeof type === "string") types.add(type);
    }
  }
  return types;
}

function schemaBranches(schemas: readonly JsonSchema[]): readonly JsonSchema[] {
  const output: JsonSchema[] = [];
  const pending = [...schemas];
  const seen = new Set<JsonSchema>();
  while (pending.length > 0) {
    const schema = pending.pop()!;
    if (seen.has(schema)) continue;
    seen.add(schema);
    output.push(schema);
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const nested = schema[key];
      if (!Array.isArray(nested)) continue;
      for (const candidate of nested) if (isJsonSchema(candidate)) pending.push(candidate);
    }
  }
  return output;
}

function arrayItemSchemas(schemas: readonly JsonSchema[], index: number): readonly JsonSchema[] {
  const output: JsonSchema[] = [];
  for (const schema of schemas) {
    if (Array.isArray(schema.prefixItems) && isJsonSchema(schema.prefixItems[index])) {
      output.push(schema.prefixItems[index]);
    } else if (isJsonSchema(schema.items)) output.push(schema.items);
  }
  return output;
}

function objectPropertySchemas(schemas: readonly JsonSchema[], key: string): readonly JsonSchema[] {
  const output: JsonSchema[] = [];
  for (const schema of schemas) {
    if (isJsonObject(schema.properties) && isJsonSchema(schema.properties[key])) {
      output.push(schema.properties[key]);
      continue;
    }
    if (isJsonSchema(schema.additionalProperties)) output.push(schema.additionalProperties);
  }
  return output;
}

function escapePointerSegment(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return isJsonObject(value);
}
