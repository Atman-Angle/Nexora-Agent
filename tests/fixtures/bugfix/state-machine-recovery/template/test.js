const { createRunStore, transition, resume } = require("./src/run-state.js");

const store = createRunStore();
const run = store.create("run-1");
transition(store, run.id, "succeeded");
const before = store.get(run.id).status;
resume(store, run.id);
const after = store.get(run.id).status;
if (after !== before) {
  console.error(`Terminal run status changed from ${before} to ${after} after resume`);
  process.exit(1);
}
if (after !== "succeeded") {
  console.error(`Expected succeeded but got ${after}`);
  process.exit(1);
}
const store2 = createRunStore();
const run2 = store2.create("run-2");
resume(store2, run2.id);
if (store2.get(run2.id).status !== "running") {
  console.error(`Non-terminal run should resume to running but got ${store2.get(run2.id).status}`);
  process.exit(1);
}
console.log("state machine recovery test passed");
