const { fetchProduct } = require("./src/api.js");
const { renderProduct } = require("./src/view.js");

const product = fetchProduct("p1");
const rendered = renderProduct(product);
if (rendered !== "Product: Widget (id: p1)") {
  console.error(`Expected "Product: Widget (id: p1)" but got "${rendered}"`);
  process.exit(1);
}
console.log("contract test passed");
