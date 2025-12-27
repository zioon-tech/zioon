import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["**/node_modules/**", "dist/**", "extensions/**/node_modules/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,js}"],
    linterOptions: {
      reportUnusedDisableDirectives: false
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        fetch: "readonly",
        console: "readonly",
        crypto: "readonly",
        navigator: "readonly",
        alert: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        location: "readonly",
        indexedDB: "readonly",
        BroadcastChannel: "readonly",
        getComputedStyle: "readonly",
        requestAnimationFrame: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        requestIdleCallback: "readonly",
        cancelIdleCallback: "readonly",
        CustomEvent: "readonly",
        Event: "readonly",
        URL: "readonly",
        Blob: "readonly",
        WebSocket: "readonly",
        AbortController: "readonly",
        TextDecoder: "readonly",
        performance: "readonly",
        FileReader: "readonly",
        DOMParser: "readonly",
        XMLSerializer: "readonly",
        Element: "readonly",
        HTMLElement: "readonly",
        MouseEvent: "readonly",
        DataTransfer: "readonly"
      }
    },
    rules: {
      "no-empty": "off",
      "no-unused-vars": "off",
      "no-useless-escape": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/ban-ts-comment": "off"
    }
  }
];
