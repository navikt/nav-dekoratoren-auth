import { defineConfig } from 'vitest/config';
import {
	NAIS_TOKEN_ENDPOINT,
	NAIS_TOKEN_INTROSPECTION_ENDPOINT,
	PDL_ORIGIN,
	PDL_TOKEN_TARGET,
	USER_KEY_SECRET,
} from './test/fixtures.ts';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		env: {
			// server/env.ts reads these when the app's modules load; test/app.ts loads fresh ones for every test
			NAIS_TOKEN_ENDPOINT,
			NAIS_TOKEN_INTROSPECTION_ENDPOINT,
			PDL_ORIGIN,
			PDL_TOKEN_TARGET,
			USER_KEY_SECRET,
		},
		// Under Vitest the logger writes through console, so only a failing test's logs are shown
		silent: 'passed-only',
		restoreMocks: true,
		unstubEnvs: true,
	},
});
