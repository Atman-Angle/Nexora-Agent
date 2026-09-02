import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

type KnownProject = { readonly path: string };

export function resolveKnownWorkspaceEntry(
  projects: readonly KnownProject[],
  projectPath: string,
  entryPath: string
): string {
  const requestedProject = resolve(projectPath);
  const knownProject = projects.find((project) => resolve(project.path).toLowerCase() === requestedProject.toLowerCase());
  if (knownProject === undefined) throw new Error("Project is not managed by Nexora Desktop.");
  if (entryPath.trim().length === 0 || isAbsolute(entryPath)) {
    throw new Error("Workspace entry must be a non-empty workspace-relative path.");
  }
  const workspaceRoot = resolve(knownProject.path);
  const target = resolve(workspaceRoot, entryPath);
  const relativeTarget = relative(workspaceRoot, target);
  if (relativeTarget === "" || relativeTarget === ".." || relativeTarget.startsWith(`..\\`) || relativeTarget.startsWith("../") || isAbsolute(relativeTarget)) {
    throw new Error("Workspace entry resolves outside the Project workspace.");
  }
  if (!existsSync(target)) throw new Error("Workspace entry does not exist.");
  const realWorkspaceRoot = realpathSync.native(workspaceRoot);
  const realTarget = realpathSync.native(target);
  const realRelativeTarget = relative(realWorkspaceRoot, realTarget);
  if (realRelativeTarget === "" || realRelativeTarget === ".." || realRelativeTarget.startsWith(`..\\`) || realRelativeTarget.startsWith("../") || isAbsolute(realRelativeTarget)) {
    throw new Error("Workspace entry resolves outside the Project workspace through a symbolic link.");
  }
  return realTarget;
}

export function resolveExternalUrl(input: string): string {
  const url = new URL(input);
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
    throw new Error("Unsupported external link protocol.");
  }
  return url.toString();
}
