import { readFileSync } from "node:fs";

if (readFileSync("result.txt", "utf8") !== "transient-service-value=ready\n") process.exit(1);
