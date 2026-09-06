import js from '@eslint/js';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'src/db/migrations/**',
      'next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...nextCoreWebVitals,

  // Типовая проверка — только для TypeScript. JS-конфиги парсятся без типов.
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  /*
   * Инварианты CLAUDE.md.
   * Часы: прямой new Date() / Date.now() запрещён — единственная точка src/lib/time.ts.
   * Тесты исключены: им нужны фиксированные моменты времени.
   */
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/lib/time.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Прямой new Date() запрещён. Используй src/lib/time.ts (зона Asia/Almaty).',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Date.now() запрещён. Используй src/lib/time.ts (зона Asia/Almaty).',
        },
      ],
    },
  },

  // Расчётные ядра: чистые функции без БД, приложения, адаптеров и сервисов.
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/db',
                '@/db/*',
                '@/app',
                '@/app/*',
                '@/adapters',
                '@/adapters/*',
                '@/services',
                '@/services/*',
                '**/db/*',
                '**/adapters/*',
                '**/services/*',
              ],
              message:
                'src/domain — чистые расчётные ядра: без БД, приложения, адаптеров и сервисов.',
            },
          ],
        },
      ],
    },
  },

  prettier,
);
