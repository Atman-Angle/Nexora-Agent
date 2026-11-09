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
      "**/.venv/**",
      "tmp/**",
      "**/.tmp/**",
      "**/.tmp-tb/**",
      "tests/fixtures/**",
      "harness/**/reports/**",
      "harness/**/reliability-reports/**",
      "harness/**/datasets/**/fixture/**",
      ".nexora/**",
      ".nexora-docling/**",
      ".tmp-e001/**",
      ".tmp-e0013/**",
      ".tmp-e0014/**",
      // ESLint does not read .gitignore, so local-only tooling needs an explicit entry.
      "scripts/**"
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
      // tsc reports undefined identifiers, and CI runs typecheck before lint.
      "no-undef": "off",
      "no-console": "off"
    }
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      "no-unused-vars": ["error", { ignoreRestSiblings: true }]
    }
  }
];
