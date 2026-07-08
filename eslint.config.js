// @ts-check
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config for Palestra Judge.
 *
 * General code-style linting only. The layered dependency-direction rule is
 * enforced separately by dependency-cruiser (see `.dependency-cruiser.cjs`),
 * which is purpose-built for module-boundary policy.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
