import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ToolRuntimeError } from "./errors.js";

const DOCUMENT_SUFFIX = /\.(pdf|docx|pptx|xlsx|png|jpe?g|tiff|bmp)$/i;
const MAX_OUTPUT_BYTES = 512 * 1024;

export type DocumentSegment = { path: string; mime: string; text: string; location: string; contentHash: string };

export async function searchDocuments(input: { workspaceRoot: string; paths: string[]; signal?: AbortSignal }): Promise<{ segments: DocumentSegment[]; readBytes: number; truncated: boolean; workerDurationMs: number; workerOutputBytes: number }> {
  const startedAt = performance.now();
  const files = input.paths.filter((path) => DOCUMENT_SUFFIX.test(path));
  if (files.length === 0) return { segments: [], readBytes: 0, truncated: false, workerDurationMs: 0, workerOutputBytes: 0 };
  const python = process.env.NEXORA_DOCLING_PYTHON;
  const modelDir = process.env.NEXORA_DOCLING_MODELS;
  if (python === undefined || modelDir === undefined) throw new ToolRuntimeError("RUNTIME_ERROR", "Docling Python or preloaded model directory is not configured.", true);
  const worker = fileURLToPath(new URL("../python/docling_worker.py", import.meta.url));
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(python, [worker], { shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    const abort = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } };
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > MAX_OUTPUT_BYTES) abort(); else chunks.push(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { if (Buffer.concat(errors).byteLength < 8_192) errors.push(chunk); });
    child.once("error", () => rejectPromise(new ToolRuntimeError("RUNTIME_ERROR", "Failed to launch Docling worker.", true)));
    child.once("close", (code) => {
      input.signal?.removeEventListener("abort", abort);
      if (input.signal?.aborted) return rejectPromise(new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true));
      if (bytes > MAX_OUTPUT_BYTES) return rejectPromise(new ToolRuntimeError("RUNTIME_ERROR", "Docling worker output exceeded its limit.", true));
      if (code !== 0) return rejectPromise(new ToolRuntimeError("RUNTIME_ERROR", Buffer.concat(errors).toString("utf8").slice(-8_192) || "Docling worker failed.", true));
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok: boolean; error?: string; segments?: DocumentSegment[]; readBytes?: number; truncated?: boolean };
        if (!result.ok || result.segments === undefined) throw new Error(result.error ?? "Docling worker failed.");
        resolvePromise({ segments: result.segments, readBytes: result.readBytes ?? 0, truncated: result.truncated ?? false, workerDurationMs: performance.now() - startedAt, workerOutputBytes: bytes });
      } catch (error) { rejectPromise(new ToolRuntimeError("RUNTIME_ERROR", error instanceof Error ? error.message : "Docling worker failed.", true)); }
    });
    child.stdin?.end(JSON.stringify({ workspaceRoot: input.workspaceRoot, files, modelDir }));
  });
}
