const { findProduct } = require("./repository.js");

function handleFetch(id) {
  const result = findProduct(id);
  if (result instanceof Error) {
    return { status: 500, body: "internal error" };
  }
  return { status: 200, body: result };
}

module.exports = { handleFetch };
