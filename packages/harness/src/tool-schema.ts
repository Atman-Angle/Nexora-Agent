import { z } from "zod";

import { JsonValueSchema, RuntimeError } from "@nexora/runtime/internal";

export type JsonSchema = Readonly<Record<string, unknown>>;

type MutableJsonSchema = Record<string, unknown>;

export function providerJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const compiled = compileSchema(schema, new Set());
  return Object.freeze(JsonValueSchema.parse(compiled) as Record<string, unknown>);
}

function compileSchema(
  schema: z.ZodTypeAny,
  ancestors: Set<z.ZodTypeAny>
): MutableJsonSchema {
  if (ancestors.has(schema)) {
    throw unsupported(schema, "recursive schemas require JSON Schema references");
  }
  const nextAncestors = new Set(ancestors).add(schema);
  const typeName = schema._def.typeName as z.ZodFirstPartyTypeKind;
  let compiled: MutableJsonSchema;

  switch (typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      compiled = compileString(schema as z.ZodString);
      break;
    case z.ZodFirstPartyTypeKind.ZodNumber:
      compiled = compileNumber(schema as z.ZodNumber);
      break;
    case z.ZodFirstPartyTypeKind.ZodBigInt:
      compiled = { type: "integer" };
      break;
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      compiled = { type: "boolean" };
      break;
    case z.ZodFirstPartyTypeKind.ZodDate:
      compiled = { type: "string", format: "date-time" };
      break;
    case z.ZodFirstPartyTypeKind.ZodNull:
      compiled = { type: "null" };
      break;
    case z.ZodFirstPartyTypeKind.ZodAny:
    case z.ZodFirstPartyTypeKind.ZodUnknown:
      compiled = {};
      break;
    case z.ZodFirstPartyTypeKind.ZodNever:
      compiled = { not: {} };
      break;
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      compiled = compileLiteral(schema as z.ZodLiteral<unknown>);
      break;
    case z.ZodFirstPartyTypeKind.ZodEnum:
      compiled = { type: "string", enum: (schema as z.ZodEnum<[string, ...string[]]>)._def.values };
      break;
    case z.ZodFirstPartyTypeKind.ZodNativeEnum:
      compiled = compileNativeEnum(schema as z.ZodNativeEnum<z.EnumLike>);
      break;
    case z.ZodFirstPartyTypeKind.ZodObject:
      compiled = compileObject(schema as z.AnyZodObject, nextAncestors);
      break;
    case z.ZodFirstPartyTypeKind.ZodArray:
      compiled = compileArray(schema as z.ZodArray<z.ZodTypeAny>, nextAncestors);
      break;
    case z.ZodFirstPartyTypeKind.ZodTuple:
      compiled = compileTuple(schema as z.ZodTuple, nextAncestors);
      break;
    case z.ZodFirstPartyTypeKind.ZodRecord:
      compiled = compileRecord(schema as z.ZodRecord, nextAncestors);
      break;
    case z.ZodFirstPartyTypeKind.ZodUnion:
      compiled = {
        anyOf: (schema as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>)._def.options
          .map((option) => compileSchema(option, nextAncestors))
      };
      break;
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      compiled = {
        anyOf: [...(schema as z.ZodDiscriminatedUnion<string, z.ZodDiscriminatedUnionOption<string>[]>)._def.options.values()]
          .map((option) => compileSchema(option, nextAncestors))
      };
      break;
    case z.ZodFirstPartyTypeKind.ZodIntersection:
      compiled = {
        allOf: [
          compileSchema((schema as z.ZodIntersection<z.ZodTypeAny, z.ZodTypeAny>)._def.left, nextAncestors),
          compileSchema((schema as z.ZodIntersection<z.ZodTypeAny, z.ZodTypeAny>)._def.right, nextAncestors)
        ]
      };
      break;
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
    case z.ZodFirstPartyTypeKind.ZodDefault:
    case z.ZodFirstPartyTypeKind.ZodCatch:
    case z.ZodFirstPartyTypeKind.ZodBranded:
    case z.ZodFirstPartyTypeKind.ZodReadonly:
      compiled = compileWrapped(schema, typeName, nextAncestors);
      break;
    case z.ZodFirstPartyTypeKind.ZodEffects:
      compiled = compileSchema((schema as z.ZodEffects<z.ZodTypeAny>)._def.schema, nextAncestors);
      break;
    case z.ZodFirstPartyTypeKind.ZodLazy:
      compiled = compileSchema((schema as z.ZodLazy<z.ZodTypeAny>)._def.getter(), nextAncestors);
      break;
    case z.ZodFirstPartyTypeKind.ZodPipeline:
      compiled = compileSchema((schema as z.ZodPipeline<z.ZodTypeAny, z.ZodTypeAny>)._def.out, nextAncestors);
      break;
    default:
      throw unsupported(schema);
  }

  return schema.description === undefined
    ? compiled
    : { ...compiled, description: schema.description };
}

function compileString(schema: z.ZodString): MutableJsonSchema {
  const result: MutableJsonSchema = { type: "string" };
  for (const check of schema._def.checks) {
    switch (check.kind) {
      case "min": result.minLength = check.value; break;
      case "max": result.maxLength = check.value; break;
      case "length": result.minLength = result.maxLength = check.value; break;
      case "regex": result.pattern = check.regex.source; break;
      case "email": result.format = "email"; break;
      case "url": result.format = "uri"; break;
      case "uuid": result.format = "uuid"; break;
      case "datetime": result.format = "date-time"; break;
      case "date": result.format = "date"; break;
      case "time": result.format = "time"; break;
      case "duration": result.format = "duration"; break;
      case "ip": result.format = check.version === "v4" ? "ipv4" : check.version === "v6" ? "ipv6" : "ip"; break;
      case "startsWith": result.pattern = `^${escapeRegex(check.value)}`; break;
      case "endsWith": result.pattern = `${escapeRegex(check.value)}$`; break;
      case "includes": result.pattern = escapeRegex(check.value); break;
      case "emoji":
      case "cuid":
      case "cuid2":
      case "ulid":
      case "base64":
      case "nanoid":
      case "jwt":
      case "cidr":
      case "base64url":
      case "trim":
      case "toLowerCase":
      case "toUpperCase":
        break;
      default:
        throw unsupported(schema, `string check ${String((check as { kind?: unknown }).kind)}`);
    }
  }
  return result;
}

function compileNumber(schema: z.ZodNumber): MutableJsonSchema {
  const result: MutableJsonSchema = { type: "number" };
  for (const check of schema._def.checks) {
    switch (check.kind) {
      case "int": result.type = "integer"; break;
      case "min": result[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value; break;
      case "max": result[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value; break;
      case "multipleOf": result.multipleOf = check.value; break;
      case "finite": break;
      default:
        throw unsupported(schema, `number check ${String((check as { kind?: unknown }).kind)}`);
    }
  }
  return result;
}

function compileLiteral(schema: z.ZodLiteral<unknown>): MutableJsonSchema {
  const value = schema._def.value;
  const type = value === null ? "null" : typeof value;
  if (type !== "string" && type !== "number" && type !== "boolean" && type !== "null") {
    throw unsupported(schema, `literal type ${type}`);
  }
  return { type, const: value };
}

function compileNativeEnum(schema: z.ZodNativeEnum<z.EnumLike>): MutableJsonSchema {
  const values = [...new Set(Object.values(schema._def.values).filter((value) => (
    typeof value === "string" || typeof value === "number"
  )))];
  const types = [...new Set(values.map((value) => typeof value))];
  return {
    ...(types.length === 1 ? { type: types[0] } : {}),
    enum: values
  };
}

function compileObject(schema: z.AnyZodObject, ancestors: Set<z.ZodTypeAny>): MutableJsonSchema {
  const shape = schema._def.shape();
  const properties: Record<string, MutableJsonSchema> = {};
  const required: string[] = [];
  for (const key of Object.keys(shape)) {
    const property = shape[key] as z.ZodTypeAny;
    properties[key] = compileSchema(property, ancestors);
    if (!property.isOptional()) required.push(key);
  }

  let additionalProperties: boolean | MutableJsonSchema;
  if (!(schema._def.catchall instanceof z.ZodNever)) {
    additionalProperties = compileSchema(schema._def.catchall, ancestors);
  } else {
    additionalProperties = schema._def.unknownKeys === "passthrough";
  }
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties
  };
}

function compileArray(schema: z.ZodArray<z.ZodTypeAny>, ancestors: Set<z.ZodTypeAny>): MutableJsonSchema {
  const result: MutableJsonSchema = {
    type: "array",
    items: compileSchema(schema._def.type, ancestors)
  };
  if (schema._def.minLength !== null) result.minItems = schema._def.minLength.value;
  if (schema._def.maxLength !== null) result.maxItems = schema._def.maxLength.value;
  if (schema._def.exactLength !== null) {
    result.minItems = schema._def.exactLength.value;
    result.maxItems = schema._def.exactLength.value;
  }
  return result;
}

function compileTuple(schema: z.ZodTuple, ancestors: Set<z.ZodTypeAny>): MutableJsonSchema {
  const items = schema._def.items.map((item) => compileSchema(item, ancestors));
  return {
    type: "array",
    prefixItems: items,
    minItems: items.length,
    ...(schema._def.rest === null
      ? { maxItems: items.length }
      : { items: compileSchema(schema._def.rest, ancestors) })
  };
}

function compileRecord(schema: z.ZodRecord, ancestors: Set<z.ZodTypeAny>): MutableJsonSchema {
  const keySchema = compileSchema(schema._def.keyType, ancestors);
  const pattern = typeof keySchema.pattern === "string" ? keySchema.pattern : undefined;
  return {
    type: "object",
    ...(pattern === undefined
      ? { additionalProperties: compileSchema(schema._def.valueType, ancestors) }
      : {
          patternProperties: { [pattern]: compileSchema(schema._def.valueType, ancestors) },
          additionalProperties: false
        })
  };
}

function compileWrapped(
  schema: z.ZodTypeAny,
  typeName: z.ZodFirstPartyTypeKind,
  ancestors: Set<z.ZodTypeAny>
): MutableJsonSchema {
  const inner = (schema._def.innerType ?? schema._def.type) as z.ZodTypeAny;
  const compiled = compileSchema(inner, ancestors);
  if (typeName === z.ZodFirstPartyTypeKind.ZodNullable) {
    return { anyOf: [compiled, { type: "null" }] };
  }
  if (typeName === z.ZodFirstPartyTypeKind.ZodDefault) {
    const defaultValue = (schema as z.ZodDefault<z.ZodTypeAny>)._def.defaultValue();
    return { ...compiled, default: defaultValue };
  }
  return compiled;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unsupported(schema: z.ZodTypeAny, detail?: string): RuntimeError {
  const suffix = detail === undefined ? "" : ` (${detail})`;
  return new RuntimeError({
    code: "INVALID_CONFIGURATION",
    message: `Tool input Schema ${String(schema._def.typeName)} is not supported by the Provider JSON Schema compiler${suffix}.`
  });
}
