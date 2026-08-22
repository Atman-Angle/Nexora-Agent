import js from "@eslint/js";
import globals from "globals";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "dist/**",
      "apps/**/dist/**",
      "packages/runtime/dist/**",
      "packages/harness/dist/**",
      "node_modules/**",
      "tmp/**",
      "tests/fixtures/**",
      "harness/**/reports/**",
      "harness/**/datasets/**/fixture/**",
      ".nexora/**",
      ".nexora-docling/**",
      ".tmp-e001/**",
      ".tmp-e0013/**",
      ".tmp-e0014/**"
    ]
  },
  js.configs.recommended,
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
  },
  {
    files: ["apps/desktop/src/renderer/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },
  {
    files: ["apps/desktop/src/preload.cjs"],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  }
];
