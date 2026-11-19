import { describe, expect, test } from 'vitest';
import { PATH, startApp } from '#test/app.ts';
import { installMockFetch } from '#test/fetch.ts';
import {
	activeToken,
	IDENT,
	NAIS_TOKEN_ENDPOINT,
	NAIS_TOKEN_INTROSPECTION_ENDPOINT,
	PDL_GRAPHQL_URL,
	pdlPerson,
	texasToken,
} from '#test/fixtures.ts';

const http = installMockFetch();

const loggedInAsKari = () => {
	http.post(NAIS_TOKEN_INTROSPECTION_ENDPOINT, { json: activeToken() });
	http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
	http.post(PDL_GRAPHQL_URL, { json: pdlPerson() });
};

describe("the app's own path", () => {
	test('answers /auth and /summary', async () => {
		loggedInAsKari();
		const app = await startApp();

		const auth = await app.loggedIn(`${PATH}/auth`);
		const summary = await app.loggedIn(`${PATH}/summary`);

		expect(await auth.json()).toEqual({
			authenticated: true,
			name: 'Kari Hansen',
			securityLevel: '4',
			userId: IDENT,
		});
		expect(await summary.json()).toMatchObject({ authenticated: true, authLevel: 4 });
	});
});

// Dekoratøren's server is the caller. A page on another origin gets an answer it isn't allowed to read.
describe('a request from a browser on another origin', () => {
	const headers = (res: Response) => [...res.headers.keys()].filter((name) => /^(access-control-|vary$)/.test(name));

	test.each(['https://www.nav.no', 'https://evil.example'])(
		'from %s is answered without CORS headers',
		async (origin) => {
			const app = await startApp();

			const res = await app.request(`${PATH}/auth`, { headers: { origin } });

			expect(res.status).toBe(200);
			expect(headers(res)).toEqual([]);
		}
	);

	test('gets no preflight: OPTIONS is a method the app does not have', async () => {
		const app = await startApp();

		const res = await app.request(`${PATH}/auth`, {
			method: 'OPTIONS',
			headers: { origin: 'https://www.nav.no', 'access-control-request-method': 'GET' },
		});

		expect(res.status).toBe(405);
		expect(headers(res)).toEqual([]);
	});
});

describe('a path the app does not have', () => {
	test.each([
		['the root', '/'],
		['its own path alone', '/navno/nav-dekoratoren-auth'],
		['/auth without its path', '/auth'],
		['a trailing slash', '/navno/nav-dekoratoren-auth/auth/'],
		['upper case', '/navno/nav-dekoratoren-auth/AUTH'],
		["nav-dekoratoren-api's /auth", '/person/nav-dekoratoren-api/auth'],
		["nav-dekoratoren-api's /summary", '/person/nav-dekoratoren-api/summary'],
		["nav-dekoratoren-api's old innloggingsstatus path", '/person/innloggingsstatus/auth'],
		["nav-dekoratoren-api's varsel proxy", '/person/nav-dekoratoren-api/varsel/proxy/some/path'],
		['the probes under its path', '/navno/nav-dekoratoren-auth/internal/alive'],
		['the metrics under its path', '/navno/nav-dekoratoren-auth/internal/metrics'],
	])('%s is a 404 without a body', async (_, path) => {
		const app = await startApp();

		const res = await app.request(path);

		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toBeNull();
		expect(await res.text()).toBe('');
	});
});

describe('the Nais routes', () => {
	test.each(['/internal/alive', '/internal/ready'])('%s answers 200', async (path) => {
		const app = await startApp();

		const res = await app.request(path);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('OK');
	});

	test('/internal/metrics has the app’s metrics from the first scrape, at zero', async () => {
		const app = await startApp();

		const res = await app.request('/internal/metrics');

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/plain');
		const text = await res.text();
		expect(text).toContain('nav_dekoratoren_auth_requests_total{endpoint="auth",outcome="authenticated"} 0');
		expect(text).toContain('nav_dekoratoren_auth_names_total{source="failed"} 0');
		expect(text).toContain('nav_dekoratoren_auth_name_cache_evictions_total 0');
		expect(text).toContain('nav_dekoratoren_auth_pdl_errors_total{code="other"} 0');
	});

	test('the metrics count the requests to Texas and PDL by how they went', async () => {
		loggedInAsKari();
		const app = await startApp();

		await app.loggedIn('/navno/nav-dekoratoren-auth/auth');

		const upstream = (name: string) =>
			app.metric('nav_dekoratoren_auth_upstream_requests_total', { upstream: name, status: '2xx' });
		expect(await upstream('texas_introspect')).toBe(1);
		expect(await upstream('texas_token')).toBe(1);
		expect(await upstream('pdl')).toBe(1);
	});
});
