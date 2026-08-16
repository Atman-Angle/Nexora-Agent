import {
  createBuiltInTools,
  createAgent
} from "@nexora/harness";

import { createRuntimeHttpHost } from "./http-host.js";
import { createAcceptanceProvider } from "./provider.js";

const workspace = requiredEnvironment("NEXORA_ACCEPTANCE_WORKSPACE");
const dataDir = requiredEnvironment("NEXORA_ACCEPTANCE_DATA_DIR");
const runtime = createAgent({
  workspace,
  dataDir,
  provider: createAcceptanceProvider(),
  tools: createBuiltInTools()
});
const host = createRuntimeHttpHost({ runtime });

try {
  const address = await host.listen();
  console.log(JSON.stringify({ type: "ready", ...address }));
  await shutdownRequested();
} finally {
  await host.close();
}
console.log(JSON.stringify({ type: "closed" }));

function shutdownRequested(): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => {
      if (chunk.includes("shutdown")) resolve();
      else reject(new Error("Expected shutdown command."));
    });
    process.stdin.once("error", reject);
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
