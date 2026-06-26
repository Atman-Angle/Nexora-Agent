const { submitJob } = require("./src/jobs.js");

const first = submitJob("task-A");
const second = submitJob("task-A");
if (first.id !== second.id) {
  console.error(`Duplicate submit created two jobs: ${first.id} and ${second.id}`);
  process.exit(1);
}
if (submitJob("task-B").id === first.id) {
  console.error("Different task reused the same job id");
  process.exit(1);
}
console.log("idempotency test passed");
