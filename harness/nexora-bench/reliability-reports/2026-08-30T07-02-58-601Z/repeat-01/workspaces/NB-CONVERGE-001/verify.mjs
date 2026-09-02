import { readFileSync } from "node:fs";

const value = JSON.parse(readFileSync("service.json", "utf8"));
const failures = [];
if (value.schemaVersion !== 2) failures.push("schemaVersion must be numeric 2");
if (value.service !== "nexora-worker") failures.push("service name must remain nexora-worker");
if (value.port !== 8080) failures.push("port must be numeric 8080");
if (value.healthCheck !== true) failures.push("healthCheck must be true");
if (Object.keys(value).sort().join(",") !== "healthCheck,port,schemaVersion,service") {
  failures.push("configuration contains unexpected keys");
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("service configuration verified");
