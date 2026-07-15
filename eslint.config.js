import js from "@eslint/js";
import globals from "globals";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "dist/**",
      "packages/runtime/dist/**",
      "node_modules/**",
      "tmp/**",
      "tests/fixtures/**",
      ".nexora/**",
      ".nexora-docling/**",
      ".local-tool-settings/**",
      ".tmp-e001/**",
      ".tmp-e0013/**",
      ".tmp-e0014/**",
      "agent-evaluation/runs/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-console": "off" }
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: false,
        sourceType: "module"
      },
      globals: {
        ...globals.node
      }
    },
    plugins: {
      "@typescript-eslint": tseslint
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ],
      "no-unused-vars": "off",
      "no-console": "off"
    }
  }
];
