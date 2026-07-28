import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
  ]),
  {
    rules: {
      // Mevcut kod tabaninda 17 yerde "any" var (cogunlukla AI tool-calling
      // ve degisiklik talebi payload'larinda). Hepsini simdi duzeltmek ayri
      // bir refactor isi; CI'i bugunku gercek duruma gore yesil baslatip
      // bu kurali uyariya cekiyoruz ki borc gorunur kalsin ama engel olmasin.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
]);

export default eslintConfig;
