const { add } = require("./src/math.js");

// The production code is correct: add(2,3) returns 5.
// This test has a WRONG expectation (expects 6).
if (add(2, 3) !== 6) {
  console.error(`Expected 6 but got ${add(2, 3)}`);
  process.exit(1);
}
console.log("test-itself-wrong passed");
