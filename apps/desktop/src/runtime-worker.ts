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
  onError: (message) => send({ type: "runtime-error", message })
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  void handle(JSON.parse(line) as WorkerRequest);
});

async function handle(request: WorkerRequest): Promise<void> {
  try {
    let result: unknown;
    if (request.method === "snapshot") result = await service.snapshot();
    else if (request.method === "setWorkspace") result = await service.setWorkspace(requireString(request.args[0]));
    else if (request.method === "startSession") result = await service.startSession(requireString(request.args[0]));
    else if (request.method === "openSession") result = await service.openSession(requireString(request.args[0]));
    else if (request.method === "control") {
      service.control(requireString(request.args[0]), request.args[1] as Parameters<typeof service.control>[1]);
      result = null;
    } else if (request.method === "readArtifact") result = await service.readArtifact(requireString(request.args[0]));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
