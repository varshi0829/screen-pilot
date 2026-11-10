// Flat config assembled directly from the plugins eslint-config-next depends on.
//
// `FlatCompat.extends("next/...")` no longer loads: eslint-config-next@15 pulls in
// @rushstack/eslint-patch, which throws "calling module was not recognized"
// under ESLint 9.39.
//
// Coverage (src/ only): all 21 @next/next rules, react-hooks, and
// typescript-eslint "recommended". NOT covered, unlike the legacy
// eslint-config-next preset: eslint-plugin-react, eslint-plugin-jsx-a11y and
// eslint-plugin-import rules.
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["**/.next/**", "**/dist/**", "next-env.d.ts", "extension/**", "eval/**", "tests/**", "node_modules/**"],
  },
  // No `files` key on purpose: this applies to every linted file, including
  // eslint.config.mjs itself. `next build` asks ESLint for that file's config to
  // look for the @next/next plugin, and warns "plugin was not detected" if the
  // plugin is only registered for src/**.
  // core-web-vitals lists only 2 rules and pulls in the rest through a legacy
  // "extends" that flat config ignores, so `recommended` is spread explicitly.
  {
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tsParser },
    plugins: {
      "react-hooks": reactHooks,
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...Object.assign({}, ...tsPlugin.configs["flat/recommended"].map((c) => c.rules ?? {})),
    },
  },
];
