import { readFileSync, realpathSync } from "node:fs";

const actual = readFileSync("workdir.txt", "utf8").trim();
if (realpathSync.native(actual).toLowerCase() !== realpathSync.native(".").toLowerCase()) {
  process.stderr.write(`Expected current workspace path, received ${actual}\n`);
  process.exit(1);
}
