import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "eslint.config.js",
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "fixtures/android-test-app/.gradle/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["packages/web/src/**/*.tsx"],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^React$" }] },
  },
  {
    files: [
      "packages/core/test/**/*.ts",
      "packages/mcp/test/**/*.ts",
      "packages/server/test/**/*.ts",
      "scripts/**/*.mjs",
    ],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["packages/cli/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
);
