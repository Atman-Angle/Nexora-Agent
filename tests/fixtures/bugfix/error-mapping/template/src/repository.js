const store = { p1: "Widget" };

function findProduct(id) {
  if (store[id] === undefined) {
    const error = new Error("not found");
    error.code = "NOT_FOUND";
    return error;
  }
  return store[id];
}

module.exports = { findProduct };
