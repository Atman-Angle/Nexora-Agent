import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { DesktopRuntimeService } from "./runtime-service.js";

type WorkerRequest = {
  readonly id: number;
  readonly method: string;
  readonly args: readonly unknown[];
};

const workspace = resolve(process.argv[2] ?? process.cwd());
const service = new DesktopRuntimeService({
  workspace,
  onSnapshot: (snapshot) => send({ type: "snapshot", snapshot }),
  onError: (message) => send({ type: "runtime-error", message }),
  onPublicOutput: (event) => send({ type: "public-output", event })
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  void handle(JSON.parse(line) as WorkerRequest);
});

async function handle(request: WorkerRequest): Promise<void> {
  try {
    let result: unknown;
    if (request.method === "snapshot") result = await service.snapshot();
    else if (request.method === "addProject") result = await service.addProject(requireString(request.args[0]));
    else if (request.method === "removeProject") result = await service.removeProject(requireString(request.args[0]));
    else if (request.method === "setWorkspace") result = await service.setWorkspace(requireString(request.args[0]));
    else if (request.method === "stageAttachments") result = await service.stageAttachments(requireStringArray(request.args[0]));
    else if (request.method === "startSession") result = await service.startSession(request.args[0] as Parameters<typeof service.startSession>[0]);
    else if (request.method === "continueSession") result = await service.continueSession(requireString(request.args[0]), request.args[1] as Parameters<typeof service.continueSession>[1]);
    else if (request.method === "compactSession") result = await service.compactSession(requireString(request.args[0]));
    else if (request.method === "openSession") result = await service.openSession(requireString(request.args[0]), requireString(request.args[1]));
    else if (request.method === "archiveSession") result = await service.archiveSession(requireString(request.args[0]), requireString(request.args[1]), requireBoolean(request.args[2]));
    else if (request.method === "removeSession") result = await service.removeSession(requireString(request.args[0]), requireString(request.args[1]));
    else if (request.method === "saveModelProfile") result = await service.saveModelProfile(request.args[0] as Parameters<typeof service.saveModelProfile>[0]);
    else if (request.method === "deleteModelProfile") result = await service.deleteModelProfile(requireString(request.args[0]));
    else if (request.method === "selectModelProfile") result = await service.selectModelProfile(requireString(request.args[0]));
    else if (request.method === "setSelectedModelReasoning") result = await service.setSelectedModelReasoning(requireReasoning(request.args[0]));
    else if (request.method === "control") {
      await service.control(requireString(request.args[0]), request.args[1] as Parameters<typeof service.control>[1]);
      result = null;
    } else if (request.method === "readArtifact") result = await service.readArtifact(requireString(request.args[0]));
    else if (request.method === "readDeliverable") result = await service.readDeliverable(
      requireString(request.args[0]),
      requireString(request.args[1]),
      requirePositiveInteger(request.args[2]),
      requireString(request.args[3])
    );
    else if (request.method === "close") {
      await service.close();
      result = null;
    } else throw new Error(`Unknown Desktop worker method: ${request.method}`);
    send({ type: "response", id: request.id, result });
    if (request.method === "close") process.exit(0);
  } catch (error) {
    send({ type: "response", id: request.id, error: errorMessage(error) });
  }
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Desktop worker expected a non-empty string.");
  return value;
}

function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Desktop worker expected a string array.");
  return value as string[];
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Desktop worker expected a boolean.");
  return value;
}

function requirePositiveInteger(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error("Desktop worker expected a positive integer.");
  return Number(value);
}

function requireReasoning(value: unknown): "off" | "dynamic" | "on" {
  if (value !== "off" && value !== "dynamic" && value !== "on") throw new Error("Desktop worker expected a reasoning preference.");
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
