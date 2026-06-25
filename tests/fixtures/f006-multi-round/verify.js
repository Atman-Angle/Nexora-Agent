/* global console, process */
import { add } from "./src/math.js";

if (add() !== 5) {
  console.error(`expected 5 but received ${String(add())}`);
  process.exit(1);
}

console.log("verification passed");
