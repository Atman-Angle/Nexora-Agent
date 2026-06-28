import { ToolRuntimeError } from "./errors.js";

export type Permission = {
  operation:
    | "filesystem.read"
    | "filesystem.search"
    | "filesystem.patch"
    | "shell.execute"
    | "filesystem.list"
    | "git.status"
    | "git.diff"
    | "git.show"
    | "project.commands"
    | "project.inspect";
  scope: "workspace";
};

export type RiskLevel = "read" | "write" | "execute";

const READ_OPERATIONS = new Set<Permission["operation"]>([
  "filesystem.read",
  "filesystem.search",
  "filesystem.list",
  "git.status",
  "git.diff",
  "git.show",
  "project.commands",
  "project.inspect"
]);

export function classifyRisk(operation: Permission["operation"]): RiskLevel {
  if (operation === "filesystem.patch") {
    return "write";
  }

  if (operation === "shell.execute") {
    return "execute";
  }

  return "read";
}

const ALL_OPERATIONS = new Set<Permission["operation"]>([
  "filesystem.read",
  "filesystem.search",
  "filesystem.patch",
  "shell.execute",
  "filesystem.list",
  "git.status",
  "git.diff",
  "git.show",
  "project.commands",
  "project.inspect"
]);

export function assertFilesystemPermission(permission: Permission): void {
  if (!ALL_OPERATIONS.has(permission.operation) || permission.scope !== "workspace") {
    throw new ToolRuntimeError("PERMISSION_DENIED", "Permission denied for filesystem operation.", false);
  }
}

export function isReadOperation(operation: Permission["operation"]): boolean {
  return READ_OPERATIONS.has(operation);
}
