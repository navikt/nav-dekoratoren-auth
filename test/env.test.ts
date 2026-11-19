import { describe, expect, test } from 'vitest';
import { parseEnv } from '#server/env.ts';

const valid = {
	NAIS_TOKEN_ENDPOINT: 'http://localhost:7164/api/v1/token',
	NAIS_TOKEN_INTROSPECTION_ENDPOINT: 'http://localhost:7164/api/v1/introspect',
	PDL_ORIGIN: 'https://pdl-api.dev-fss-pub.nais.io',
	PDL_TOKEN_TARGET: 'api://dev-fss.pdl.pdl-api/.default',
};

describe('the environment', () => {
	test('is taken as it is when everything is there, with defaults for the rest', () => {
		expect(parseEnv(valid)).toEqual({
			...valid,
			NAME_CACHE_MAX_ENTRIES: 100_000,
			NAME_CACHE_TTL_SECONDS: 1800,
			PORT: 3004,
		});
	});

	test('reads the numbers from text', () => {
		expect(
			parseEnv({ ...valid, PORT: '8080', NAME_CACHE_MAX_ENTRIES: '5000', NAME_CACHE_TTL_SECONDS: '60' })
		).toMatchObject({ PORT: 8080, NAME_CACHE_MAX_ENTRIES: 5000, NAME_CACHE_TTL_SECONDS: 60 });
	});

	test('takes the secret for the user keys when there is one', () => {
		const secret = 'a-secret-of-at-least-32-characters-long';

		expect(parseEnv({ ...valid, USER_KEY_SECRET: secret }).USER_KEY_SECRET).toBe(secret);
		expect(parseEnv(valid).USER_KEY_SECRET).toBeUndefined();
	});

	test('turns down a secret that is too short to be one', () => {
		expect(() => parseEnv({ ...valid, USER_KEY_SECRET: 'short' })).toThrow('USER_KEY_SECRET');
	});

	test.each(Object.keys(valid))('names %s when it is missing', (name) => {
		expect(() => parseEnv({ ...valid, [name]: undefined })).toThrow(name);
	});

	test.each([
		['PDL_ORIGIN', 'pdl-api'],
		['NAIS_TOKEN_ENDPOINT', 'not a url'],
		['PORT', 'http'],
		['NAME_CACHE_MAX_ENTRIES', '0'],
		['NAME_CACHE_TTL_SECONDS', '-1'],
	])('turns down a %s of %s', (name, value) => {
		expect(() => parseEnv({ ...valid, [name]: value })).toThrow(name);
	});
});
