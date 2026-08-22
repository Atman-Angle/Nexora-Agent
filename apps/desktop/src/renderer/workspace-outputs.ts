export type WorkspaceOutput = {
  readonly path: string;
  readonly name: string;
  readonly kind: "website" | "document" | "file";
};

type InvocationResult = {
  readonly toolName: string;
  readonly status: string;
  readonly resultJson?: unknown;
};

const DOCUMENT_EXTENSIONS = new Set([
  ".csv", ".doc", ".docx", ".md", ".pdf", ".ppt", ".pptx", ".rtf", ".txt", ".xls", ".xlsx"
]);

export function workspaceOutputs(invocations: readonly InvocationResult[]): WorkspaceOutput[] {
  const outputs: WorkspaceOutput[] = [];
  const seen = new Set<string>();
  for (const invocation of invocations) {
    if (invocation.status !== "succeeded" || !["filesystem.write", "filesystem.patch"].includes(invocation.toolName)) continue;
    if (invocation.resultJson === null || Array.isArray(invocation.resultJson) || typeof invocation.resultJson !== "object") continue;
    const path = (invocation.resultJson as Record<string, unknown>).path;
    if (typeof path !== "string" || path.trim().length === 0 || seen.has(path)) continue;
    seen.add(path);
    const name = path.split(/[\\/]/u).at(-1) ?? path;
    const extension = /\.[^.]+$/u.exec(name.toLowerCase())?.[0] ?? "";
    outputs.push({
      path,
      name,
      kind: extension === ".html" || extension === ".htm"
        ? "website"
        : DOCUMENT_EXTENSIONS.has(extension) ? "document" : "file"
    });
  }
  return outputs;
}
