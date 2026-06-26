function createRunStore() {
  const runs = new Map();
  return {
    create(id) {
      runs.set(id, { id, status: "created" });
      return { id };
    },
    get(id) {
      return runs.get(id);
    }
  };
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function transition(store, id, next) {
  const run = store.get(id);
  if (run === undefined) {
    throw new Error("run not found");
  }
  run.status = next;
  return run;
}

function resume(store, id) {
  const run = store.get(id);
  if (run === undefined) {
    throw new Error("run not found");
  }
  run.status = "running";
  return run;
}

module.exports = { createRunStore, transition, resume };
