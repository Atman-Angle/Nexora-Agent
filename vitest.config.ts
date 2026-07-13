import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Fixtures may contain installed third-party projects. They are test data,
    // not Nexora test suites; an explicit include would otherwise discover
    // their nested node_modules tests during `pnpm test`.
    exclude: ["tests/fixtures/**/node_modules/**"],
    environment: "node"
  }
});
