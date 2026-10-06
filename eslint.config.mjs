import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    '.next/**',
    'node_modules/**',
    'public/preview-assets/**',
    'public/preview-table-worker.js',
    'next-env.d.ts',
  ]),
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Existing imperative data-fetching effects synchronize with external services.
      'react-hooks/set-state-in-effect': 'off',
      // Private original image bytes must bypass the Next.js optimizer.
      '@next/next/no-img-element': 'off',
      // Authentication transitions intentionally reload the server session.
      '@next/next/no-location-assign-relative-destination': 'off',
      // Block accidental imports of Node-only modules into client components.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/lib/server/*', '@/lib/server/**'],
              message: 'Use authenticated HTTP APIs from client components.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'app/**/*.ts',
      'app/**/*.tsx',
      'lib/server/**/*.ts',
      'scripts/**/*.ts',
      'tests/**/*.ts',
      'services/**/*.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
]);
