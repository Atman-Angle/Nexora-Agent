const { handleFetch } = require("./src/handler.js");

const result = handleFetch("missing");
if (result.status !== 404) {
  console.error(`Expected status 404 but got ${result.status}`);
  process.exit(1);
}
const ok = handleFetch("p1");
if (ok.status !== 200) {
  console.error(`Expected status 200 for existing but got ${ok.status}`);
  process.exit(1);
}
console.log("error mapping test passed");
