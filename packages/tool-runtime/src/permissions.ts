import { ToolRuntimeError } from "./errors.js";

export type RiskLevel = "read" | "write" | "execute";

export type Permission = {
  operation?: string;
  scope: string;
};

export function assertFilesystemPermission(permission: Permission): void {
  if (permission.scope !== "workspace") {
    throw new ToolRuntimeError("PERMISSION_DENIED", "Permission denied for filesystem operation.", false);
  }
}
