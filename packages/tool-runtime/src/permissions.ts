import { ToolRuntimeError } from "./errors.js";

export type Permission = {
  operation: "filesystem.read" | "filesystem.search" | "filesystem.patch" | "shell.execute";
  scope: "workspace";
};

export type RiskLevel = "read" | "write" | "execute";

export function classifyRisk(operation: Permission["operation"]): RiskLevel {
  if (operation === "filesystem.patch") {
    return "write";
  }

  if (operation === "shell.execute") {
    return "execute";
  }

  return "read";
}

export function assertFilesystemPermission(permission: Permission): void {
  if (
    (permission.operation !== "filesystem.read" &&
      permission.operation !== "filesystem.search" &&
      permission.operation !== "filesystem.patch" &&
      permission.operation !== "shell.execute") ||
    permission.scope !== "workspace"
  ) {
    throw new ToolRuntimeError("PERMISSION_DENIED", "Permission denied for filesystem operation.", false);
  }
}
