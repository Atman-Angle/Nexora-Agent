import { readFileSync } from "node:fs";

const app = readFileSync("src/App.tsx", "utf8");
const required = ["Hero", "About", "Projects", "Skills", "Contact"];
const missing = required.filter((section) => !app.includes(section));
if (missing.length > 0) {
  console.error(`Missing sections: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("Build OK: all five sections present.");
process.exit(0);
