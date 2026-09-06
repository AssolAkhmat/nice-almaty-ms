import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Инварианты из CLAUDE.md, которые проверяет линтер:
 *  - прямой `new Date()` / `Date.now()` в бизнес-логике запрещён (единственная точка — src/lib/time.ts);
 *  - `src/domain/**` не импортирует ничего из db / app / adapters / services.
 */
const forbidRawDate = {
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
};

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
  ...tseslint.configs.recommendedTypeChecked,

  {
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
      ...forbidRawDate.rules,
    },
  },

  // Единственное место, где разрешено обращаться к системным часам напрямую.
  {
    files: ['src/lib/time.ts'],
    rules: {
      'no-restricted-syntax': 'off',
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

  // Конфигурационные файлы в корне: без типовой проверки и без запрета на часы.
  {
    files: ['**/*.mjs', '**/*.js', '*.config.ts', '*.config.mts'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-restricted-syntax': 'off',
    },
  },

  prettier,
);
