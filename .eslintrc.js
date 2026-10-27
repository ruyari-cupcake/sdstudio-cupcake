module.exports = {
  extends: 'erb',
  plugins: ['@typescript-eslint'],
  env: { es2021: true },
  rules: {
    // A temporary hack related to IDE not resolving correct package.json
    'import/no-extraneous-dependencies': 'off',
    'react/react-in-jsx-scope': 'off',
    'react/jsx-filename-extension': 'off',
    'import/extensions': 'off',
    'import/no-unresolved': 'off',
    'import/no-import-module-exports': 'off',
    'no-shadow': 'off',
    '@typescript-eslint/no-shadow': 'error',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { args: 'all', argsIgnorePattern: '^_', caughtErrors: 'all' },
    ],
    // ES2022 supports native iteration; keep the prototype-chain and control-flow guards.
    'no-restricted-syntax': [
      'error',
      {
        selector: 'ForInStatement',
        message:
          'Iterate over own Object.keys/values/entries instead of the prototype chain.',
      },
      {
        selector: 'LabeledStatement',
        message: 'Use structured control flow instead of labels.',
      },
      {
        selector: 'WithStatement',
        message: 'with is incompatible with strict module scope.',
      },
    ],
    // Sequential awaits and early continues preserve request ownership and bounded image IO.
    // Prettier owns layout; native counters and readable JSX conditionals are valid ES2022.
    'no-await-in-loop': 'off',
    'no-continue': 'off',
    'no-plusplus': 'off',
    // Export shape and typed prop forwarding are API choices, not runtime failures.
    'import/prefer-default-export': 'off',
    'no-underscore-dangle': 'off',
    'no-nested-ternary': 'off',
    'no-void': ['error', { allowAsStatement: true }],
    'no-console': ['error', { allow: ['warn', 'error'] }],
    // A nested control or an explicit htmlFor both associate a label correctly.
    'jsx-a11y/label-has-associated-control': [
      'error',
      { assert: 'either', depth: 25 },
    ],
    'react/function-component-definition': [
      'error',
      {
        namedComponents: [
          'function-declaration',
          'function-expression',
          'arrow-function',
        ],
        unnamedComponents: ['function-expression', 'arrow-function'],
      },
    ],
    // ESLint deprecated this rule in 8.46: return await preserves useful error stacks.
    'no-return-await': 'off',
    'react/require-default-props': [
      'error',
      {
        forbidDefaultForRequired: true,
        classes: 'defaultProps',
        functions: 'defaultArguments',
      },
    ],
  },
  // TS extension rules retain the checks while understanding types, overloads,
  // parameter properties and actual API overrides. tsc owns TS name resolution.
  overrides: [
    {
      files: ['**/*.test.ts', '**/*.test.tsx'],
      rules: {
        // Teardown assertions verify every test releases its listeners and stack entries.
        'jest/no-standalone-expect': [
          'error',
          { additionalTestBlockFunctions: ['afterEach', 'afterAll'] },
        ],
      },
    },
    {
      files: [
        'src/main/imageWatchService.ts',
        'src/main/rendererRecovery.ts',
        'src/renderer/backends/genVendors/nai*.ts',
        'src/renderer/models/requestTiming.ts',
        'src/renderer/models/TaskQueueService.ts',
        'src/renderer/models/TaskHandlers.ts',
        'src/renderer/models/externalImageEditor.ts',
        'src/renderer/componenets/useTitlebarAccount.ts',
      ],
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: __dirname },
      rules: {
        '@typescript-eslint/no-floating-promises': [
          'error',
          { ignoreVoid: false, ignoreIIFE: false },
        ],
        '@typescript-eslint/no-misused-promises': 'error',
      },
    },
    {
      files: ['**/*.ts', '**/*.tsx'],
      rules: {
        'class-methods-use-this': 'off',
        '@typescript-eslint/class-methods-use-this': [
          'error',
          {
            exceptMethods: [
              'render',
              'getInitialState',
              'getDefaultProps',
              'getChildContext',
              'componentWillMount',
              'UNSAFE_componentWillMount',
              'componentDidMount',
              'componentWillReceiveProps',
              'UNSAFE_componentWillReceiveProps',
              'shouldComponentUpdate',
              'componentWillUpdate',
              'UNSAFE_componentWillUpdate',
              'componentDidUpdate',
              'componentWillUnmount',
              'componentDidCatch',
              'getSnapshotBeforeUpdate',
            ],
            enforceForClassFields: true,
            ignoreOverrideMethods: true,
            ignoreClassesThatImplementAnInterface: 'public-fields',
          },
        ],
        'no-use-before-define': 'off',
        '@typescript-eslint/no-use-before-define': [
          'error',
          {
            functions: false, // Function declarations are hoisted; classes and variables are not.
            classes: true,
            variables: true,
            ignoreTypeReferences: true,
          },
        ],
        'no-empty-function': 'off',
        '@typescript-eslint/no-empty-function': [
          'error',
          {
            allow: ['arrowFunctions', 'functions', 'methods'],
          },
        ],
        'no-useless-constructor': 'off',
        '@typescript-eslint/no-useless-constructor': 'error',
        'no-redeclare': 'off',
        '@typescript-eslint/no-redeclare': [
          'error',
          {
            builtinGlobals: false,
            ignoreDeclarationMerge: true,
          },
        ],
        'no-dupe-class-members': 'off',
        '@typescript-eslint/no-dupe-class-members': 'error',
        'no-unused-expressions': 'off',
        '@typescript-eslint/no-unused-expressions': [
          'error',
          {
            allowShortCircuit: false,
            allowTernary: false,
            allowTaggedTemplates: false,
            enforceForJSX: false,
          },
        ],
        'no-undef': 'off',
        // Optional typed function props may intentionally remain absent. Do not invent no-op defaults.
        // Strict TypeScript checks optional/required props, including memo/observer components.
        // These JavaScript-only checks misclassify wrapped typed functions as classes.
        'react/require-default-props': 'off',
        'react/prop-types': 'off',
        'react/jsx-props-no-spreading': 'off', // The receiving component's TypeScript props remain checked.
      },
    },
    {
      files: ['src/renderer/models/index.ts'],
      // These ESM bindings are installed once behind a guard before UI evaluation.
      // Live named exports keep peer imports acyclic without proxies or API changes.
      rules: { 'import/no-mutable-exports': 'off' },
    },
    {
      files: ['src/renderer/backend.ts'],
      // Stateless default capabilities belong to the platform contract and are overridden per platform.
      rules: { '@typescript-eslint/class-methods-use-this': 'off' },
    },
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { generators: true },
  },
  settings: {
    'import/resolver': {
      // See https://github.com/benmosher/eslint-plugin-import/issues/1396#issuecomment-575727774 for line below
      node: {},
      webpack: {
        config: require.resolve('./.erb/configs/webpack.config.eslint.ts'),
      },
      typescript: {},
    },
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts', '.tsx'],
    },
  },
};
