// ModuleX Studio workspace lint config (flat config). Type-aware rules stay off to keep `npm run lint`
// fast and independent of a prior build; `npm run typecheck` is the strict-types gate.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'app/src-tauri/target/**',
      'app/src-tauri/gen/**',
      'spikes/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (e.g. app/ui/scripts/*.mjs) run outside TypeScript; declare their runtime globals.
    // `document` appears only inside Playwright page.evaluate callbacks, which execute in the browser.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        document: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
);
