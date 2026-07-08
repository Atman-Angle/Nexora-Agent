import { z } from "zod";

import type { ToolResult } from "../../../../contracts/src/index.js";
import type { ToolDefinition } from "../../../../tool-runtime/src/tool-definition.js";
import type { ToolRegistry } from "../../../../tool-runtime/src/tool-registry.js";
import {
  ProductFactsInlineOutputSchema,
  type ProductFact
} from "./yixiang-profile-state.js";

const PRODUCT_ANALYZE_ASSETS_INPUT_SCHEMA = z.object({ assetId: z.string().min(1) });
type ProductAnalyzeAssetsInput = z.infer<typeof PRODUCT_ANALYZE_ASSETS_INPUT_SCHEMA>;

const TOOL_NAME = "product.analyze_assets";

/**
 * product.analyze_assets — a STUB Yixiang tool (F030b). Returns deterministic
 * product facts derived from the assetId. Real VLM/asset analysis is out of
 * scope (F030b validates the tool-driven loop, not the real product).
 *
 * The returned ToolResult uses a CUSTOM output kind `product_facts_inline`:
 * envelope-valid (passes ToolResultEnvelopeSchema.parse), cast `as ToolResult`
 * by ToolRuntime.execute (the closed ToolResultSchema union is NOT opened —
 * F028 documented deviation, same pattern as the 12th-tool test), and validated
 * by the per-tool `resultSchema` (F028's output gate).
 */
export const productAnalyzeAssetsTool: ToolDefinition<ProductAnalyzeAssetsInput> = {
  name: TOOL_NAME,
  inputSchema: PRODUCT_ANALYZE_ASSETS_INPUT_SCHEMA,
  resultSchema: ProductFactsInlineOutputSchema,
  riskLevel: "read",
  requiresApproval: false,
  description: "Analyze a product asset and extract product facts (stub).",
  inputFields: [{ name: "assetId", type: "string", required: true, description: "Asset id to analyze." }],
  minimalExample: { assetId: "asset-1" },
  idempotencyKeyExtractor: (input) => input.assetId,
  targetPathExtractor: (input) => input.assetId,
  idempotentSemantics: (a, b) => a.input.assetId === b.input.assetId,
  async execute(_context, toolCall) {
    const assetId = toolCall.input.assetId;
    const facts: ProductFact[] = [
      { factId: `${assetId}-fact-1`, key: "category", value: "apparel", confidence: 0.92, source: "asset_analysis" },
      { factId: `${assetId}-fact-2`, key: "color", value: "navy", confidence: 0.88, source: "asset_analysis" },
      { factId: `${assetId}-fact-3`, key: "price_range", value: "mid", confidence: 0.75, source: "asset_analysis" }
    ];
    return {
      toolResult: {
        toolCallId: toolCall.toolCallId,
        toolName: TOOL_NAME,
        status: "success" as const,
        output: { kind: "product_facts_inline" as const, facts }
      } as unknown as ToolResult
    };
  }
};

/** Register the Yixiang tools on a ToolRegistry (mirrors registerCodingTools). */
export function registerYixiangTools(registry: ToolRegistry): void {
  registry.register(productAnalyzeAssetsTool);
}
