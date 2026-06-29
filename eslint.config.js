import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      // TypeScript (with lib: ["DOM"]) already resolves globals like fetch/Headers/Response
      // and flags genuinely undefined references, so the core rule is redundant + wrong here.
      "no-undef": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
