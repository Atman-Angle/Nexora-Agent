import { JsonValueSchema } from "../contracts.js";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const failureDiagnostics = new WeakMap<object, JsonValue>();

export function attachToolFailureDiagnostics<Result extends object>(
  result: Result,
  details: unknown
): Result {
  failureDiagnostics.set(result, JsonValueSchema.parse(details) as JsonValue);
  return result;
}

export function toolFailureDiagnostics(result: unknown): JsonValue | undefined {
  if (result === null || typeof result !== "object") return undefined;
  return failureDiagnostics.get(result);
}
