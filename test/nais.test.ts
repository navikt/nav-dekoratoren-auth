import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { OWN_PATH } from '#server/app.ts';
import { parseEnv } from '#server/env.ts';

const read = (file: string) => readFileSync(new URL(`../.nais/${file}`, import.meta.url), 'utf-8');

const config = read('config.yml');

// What the pods get besides .nais/config.yml's env: NAIS injects Texas' two endpoints
const fromPlatform = {
	NAIS_TOKEN_ENDPOINT: 'http://texas.test/api/v1/token',
	NAIS_TOKEN_INTROSPECTION_ENDPOINT: 'http://texas.test/api/v1/introspect',
};

describe.each(['vars-dev.yml', 'vars-prod.yml'])('%s', (file) => {
	const vars = read(file);
	const variable = (name: string) => vars.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1] ?? '';

	// config.yml's env, with the file's values where the template has a variable
	const fromConfig: Record<string, string> = Object.fromEntries(
		[...config.matchAll(/- name: (\w+)\n\s+value: (.+)/g)].map(([, name, value]) => [
			name,
			(value ?? '').replaceAll(/\{\{(\w+)\}\}/g, (_, key: string) => variable(key)),
		])
	);

	// The lines under `ingresses:`, as URLs
	const ingresses = [...(vars.match(/^ingresses:\n((?: {2}- .+\n)+)/m)?.[1] ?? '').matchAll(/- (.+)/g)].map(
		([, url]) => new URL(url ?? '')
	);

	test('gives the server all it needs', () => {
		expect(parseEnv({ ...fromConfig, ...fromPlatform })).toMatchObject({
			PDL_ORIGIN: `https://${variable('pdlHost')}`,
			PDL_TOKEN_TARGET: variable('pdlTokenTarget'),
		});
	});

	// Nais won't deploy the login proxy without an ingress, and dekoratøren calls the app on the same path
	test("has one ingress, on the app's own path", () => {
		expect(ingresses.map((ingress) => ingress.pathname)).toEqual([OWN_PATH]);
	});

	test('asks Texas for a token to the PDL it calls', () => {
		const cluster = variable('pdlHost').match(/^pdl-api\.((?:dev|prod)-fss)-pub\.nais\.io$/)?.[1];

		expect(cluster).toBeDefined();
		expect(variable('pdlTokenTarget')).toBe(`api://${cluster}.pdl.pdl-api/.default`);
	});
});
