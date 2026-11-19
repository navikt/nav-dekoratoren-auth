import { defineConfig } from 'oxlint';

export default defineConfig({
	plugins: ['typescript', 'unicorn', 'oxc', 'vitest', 'promise'],
	categories: { correctness: 'error', suspicious: 'error', perf: 'error' },
	options: { reportUnusedDisableDirectives: 'warn', typeAware: true },
	rules: {
		'no-console': 'error',
		'typescript/no-explicit-any': 'error',
		// Test helpers stay next to the tests that use them
		'unicorn/consistent-function-scoping': 'off',
		// It would flag every deliberate cast, as in navno-search-frontend
		'typescript/no-unsafe-type-assertion': 'off',
		// Helpers like expectLoggedOut() hold a test's assertions
		'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expect*'] }],
		// Vitest's expect() takes a message to fail with as its second argument
		'vitest/valid-expect': ['error', { maxArgs: 2 }],
	},
	overrides: [
		{
			// A test asks for one thing at a time, in the order its mock answers
			files: ['**/*.test.ts'],
			rules: { 'no-await-in-loop': 'off' },
		},
	],
});
