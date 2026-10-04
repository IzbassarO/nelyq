import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Architecture boundaries are enforced here as well as by each package's dependency list.
// See docs/architecture/overview.md before loosening either rule.
const RELATIVE_ONLY = '^(?!\\.{1,2}/)';
const RELATIVE_OR_CORE_PACKAGE = '^(?!\\.{1,2}/|@nelyq/(domain|policy)(/|$))';

export default defineConfig(
  globalIgnores(['**/node_modules/', '**/.next/', '**/next-env.d.ts', '**/coverage/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['packages/domain/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: RELATIVE_ONLY,
              message: 'The domain package must not depend on anything outside itself.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/policy/src/**/*.ts', 'packages/application/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: RELATIVE_OR_CORE_PACKAGE,
              message:
                'Policy and application code may depend only on @nelyq/domain and @nelyq/policy. Reach infrastructure through a port.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    settings: { next: { rootDir: 'apps/web' } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  {
    // Root-level tool configs are not part of any TypeScript project.
    files: ['*.mjs', '*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
