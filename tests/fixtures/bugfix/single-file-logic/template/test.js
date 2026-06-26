const { add } = require("./src/math.js");

if (add(2, 3) !== 5) {
  console.error(`Expected 5 but got ${add(2, 3)}`);
  process.exit(1);
}

if (add(0, 0) !== 0) {
  console.error("Expected 0 for add(0,0)");
  process.exit(1);
}

console.log("math tests passed");
