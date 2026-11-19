import { networkError } from '@itsy/corgi/testing';
import { logger } from '@navikt/navno-logger';
import { describe, expect, test, vi } from 'vitest';
import { PATH, startApp } from '#test/app.ts';
import { installMockFetch } from '#test/fetch.ts';
import {
	activeToken,
	IDENT,
	inactiveToken,
	NAIS_TOKEN_ENDPOINT,
	NAIS_TOKEN_INTROSPECTION_ENDPOINT,
	navn,
	PDL_GRAPHQL_URL,
	pdlPerson,
	texasToken,
} from '#test/fixtures.ts';

const http = installMockFetch();

const AUTH = `${PATH}/auth`;
const SUMMARY = `${PATH}/summary`;
const IDENTITY = `${PATH}/identity`;
const LOGGED_OUT = { authenticated: false };

// The label each endpoint is counted under
const endpoints: Record<string, string> = { [AUTH]: 'auth', [SUMMARY]: 'summary', [IDENTITY]: 'identity' };

// Texas' answer about the token on the request
const texasSays = (answer: object) => http.post(NAIS_TOKEN_INTROSPECTION_ENDPOINT, { json: answer });

// PDL, and the token Texas hands out for it
const pdlKnows = (...names: ReturnType<typeof navn>[]) => {
	http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
	http.post(PDL_GRAPHQL_URL, { json: pdlPerson(...names) });
};

const askedOfTexas = () => http.callsTo(NAIS_TOKEN_INTROSPECTION_ENDPOINT).map((call) => call.json());

describe.each([AUTH, SUMMARY, IDENTITY])('%s, whoever asks', (path) => {
	const endpoint = endpoints[path] ?? '';

	test('without a token nobody is logged in, and Texas is not asked', async () => {
		const app = await startApp();

		const res = await app.request(path);

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/json');
		expect(await res.json()).toEqual(LOGGED_OUT);
		expect(http.calls).toEqual([]);
		expect(await app.metric('nav_dekoratoren_auth_requests_total', { endpoint, outcome: 'anonymous' })).toBe(1);
	});

	test.each([
		['Basic credentials', 'Basic dXNlcjpwYXNz'],
		['an empty Bearer', 'Bearer '],
		['a Bearer in two parts', 'Bearer one two'],
		['a token without a scheme', 'a-token'],
	])('with %s nobody is logged in, and Texas is not asked', async (_, authorization) => {
		const app = await startApp();

		const res = await app.request(path, { headers: { authorization } });

		expect(await res.json()).toEqual(LOGGED_OUT);
		expect(http.calls).toEqual([]);
	});

	test('asks Texas about the token as an ID-porten token', async () => {
		texasSays(inactiveToken());
		const app = await startApp();

		await app.loggedIn(path, 'the-token');

		expect(askedOfTexas()).toEqual([{ identity_provider: 'idporten', token: 'the-token' }]);
	});

	test('takes the scheme in any case', async () => {
		texasSays(inactiveToken());
		const app = await startApp();

		await app.request(path, { headers: { authorization: 'bearer the-token' } });

		expect(askedOfTexas()).toEqual([{ identity_provider: 'idporten', token: 'the-token' }]);
	});

	test("with a token Texas doesn't vouch for, nobody is logged in", async () => {
		texasSays(inactiveToken());
		const warn = vi.spyOn(logger, 'warn');
		const app = await startApp();

		const res = await app.loggedIn(path);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(LOGGED_OUT);
		// An expired token is nothing to warn about
		expect(warn).not.toHaveBeenCalled();
		expect(http.callsTo(PDL_GRAPHQL_URL)).toEqual([]);
		expect(await app.metric('nav_dekoratoren_auth_requests_total', { endpoint, outcome: 'invalid_token' })).toBe(1);
	});

	// ID-porten doesn't issue these. nav-dekoratoren-api answered them with an empty 404 from /auth and a 500 from /summary.
	test.each([
		['no fødselsnummer', { pid: undefined }, { acr: 'idporten-loa-high', hasPid: false, hasTimes: true }],
		['an empty fødselsnummer', { pid: '' }, { acr: 'idporten-loa-high', hasPid: false, hasTimes: true }],
		['a level we do not know', { acr: 'idporten-loa-low' }, { acr: 'idporten-loa-low', hasPid: true, hasTimes: true }],
		['no level', { acr: undefined }, { acr: 'undefined', hasPid: true, hasTimes: true }],
		['no time of issue', { iat: undefined }, { acr: 'idporten-loa-high', hasPid: true, hasTimes: false }],
	])('with a token that has %s, nobody is logged in, and it is logged', async (_, claims, logged) => {
		texasSays(activeToken(claims));
		const warn = vi.spyOn(logger, 'warn');
		const app = await startApp();

		const res = await app.loggedIn(path);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(LOGGED_OUT);
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			'Token without: a fødselsnummer, a known level, or known times',
			logged
		);
		expect(http.callsTo(PDL_GRAPHQL_URL)).toEqual([]);
		expect(await app.metric('nav_dekoratoren_auth_requests_total', { endpoint, outcome: 'unusable_token' })).toBe(1);
	});

	// "Nobody is logged in" would send a logged-in user to the front page of an app that redirects on that
	test.each([
		['answers an error', { status: 500, json: { error: 'server_error' } }, { status: 500 }],
		['is unreachable', networkError(), expect.any(Error)],
		[
			'answers something else than an introspection',
			{ json: { hello: 'there' } },
			{ issues: [expect.stringContaining('active')] },
		],
	] as const)('when Texas %s, the answer is an error and not "nobody is logged in"', async (_, reply, logged) => {
		http.post(NAIS_TOKEN_INTROSPECTION_ENDPOINT, reply);
		const error = vi.spyOn(logger, 'error');
		const app = await startApp();

		const res = await app.loggedIn(path, 'the-token');

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'Internal server error' });
		expect(error).toHaveBeenCalledExactlyOnceWith('Token introspection failed', { method: 'GET', path }, logged);
		// What Texas was asked about is never in the log
		expect(JSON.stringify(error.mock.calls)).not.toContain('the-token');
		expect(await app.metric('nav_dekoratoren_auth_requests_total', { endpoint, outcome: 'error' })).toBe(1);
	});

	test('tells caches to keep nothing', async () => {
		const app = await startApp();

		const res = await app.request(path);

		expect(res.headers.get('cache-control')).toBe('no-store');
	});

	test('answers HEAD as GET, without the body', async () => {
		const app = await startApp();

		const res = await app.request(path, { method: 'HEAD' });

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/json');
		expect(await res.text()).toBe('');
	});

	test.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])(
		'turns down %s, naming the methods it takes',
		async (method) => {
			const app = await startApp();

			const res = await app.request(path, { method });

			expect(res.status).toBe(405);
			expect(res.headers.get('allow')).toBe('GET, HEAD');
			expect(await res.text()).toBe('');
		}
	);
});

describe('/auth for a logged-in user', () => {
	test('answers who it is, with the name from PDL, in the shape nav-dekoratoren-api had', async () => {
		texasSays(activeToken());
		pdlKnows(navn('Kari', 'Marie', 'Hansen'));
		const app = await startApp();

		const res = await app.loggedIn(AUTH);

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/json');
		// The bytes, since the order of the keys is part of what was promised
		expect(await res.text()).toBe(
			`{"authenticated":true,"name":"Kari Marie Hansen","securityLevel":"4","userId":"${IDENT}"}`
		);
		expect(
			await app.metric('nav_dekoratoren_auth_requests_total', { endpoint: 'auth', outcome: 'authenticated' })
		).toBe(1);
	});

	test.each([
		['idporten-loa-high', '4'],
		['Level4', '4'],
		['idporten-loa-substantial', '3'],
		['Level3', '3'],
	])('at %s is security level %s, as a string', async (acr, securityLevel) => {
		texasSays(activeToken({ acr }));
		pdlKnows();
		const app = await startApp();

		const res = await app.loggedIn(AUTH);

		expect(await res.json()).toMatchObject({ authenticated: true, securityLevel });
	});

	test('is logged in without a name when PDL has none, and never with the fødselsnummer as the name', async () => {
		texasSays(activeToken());
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, { status: 500 });
		const app = await startApp();

		const res = await app.loggedIn(AUTH);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ authenticated: true, name: '', securityLevel: '4', userId: IDENT });
	});
});

describe('/summary for a logged-in user', () => {
	test('answers what the token says, in the shape nav-dekoratoren-api had', async () => {
		texasSays(activeToken());
		const app = await startApp();

		const res = await app.loggedIn(SUMMARY);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe(
			'{"authenticated":true,"authLevel":4,"oidc":{"authLevel":4,"issueTime":"2024-01-02T10:15:30","expiryTime":"2099-01-01T00:00:00"}}'
		);
		expect(
			await app.metric('nav_dekoratoren_auth_requests_total', { endpoint: 'summary', outcome: 'authenticated' })
		).toBe(1);
	});

	test('writes the times in UTC without a zone, with seconds even on the minute', async () => {
		// 2024-06-30T22:00:00Z, which is midnight in Oslo
		texasSays(activeToken({ iat: 1719784800, exp: 1719788400 }));
		const app = await startApp();

		const res = await app.loggedIn(SUMMARY);

		expect(await res.json()).toMatchObject({
			oidc: { issueTime: '2024-06-30T22:00:00', expiryTime: '2024-06-30T23:00:00' },
		});
	});

	test('at level 3', async () => {
		texasSays(activeToken({ acr: 'idporten-loa-substantial' }));
		const app = await startApp();

		const res = await app.loggedIn(SUMMARY);

		expect(await res.json()).toMatchObject({ authLevel: 3, oidc: { authLevel: 3 } });
	});

	test('never asks PDL', async () => {
		texasSays(activeToken());
		const app = await startApp();

		await app.loggedIn(SUMMARY);

		expect(http.calls.map((call) => call.url)).toEqual([NAIS_TOKEN_INTROSPECTION_ENDPOINT]);
	});
});

// Dekoratøren's plan splits its own /auth into identity and notifications. This is the identity it needs.
describe('/identity for a logged-in user', () => {
	test("answers who it is as dekoratøren's IdentityPayload has it: /auth with a user key for the fødselsnummer", async () => {
		texasSays(activeToken());
		pdlKnows(navn('Kari', 'Marie', 'Hansen'));
		const app = await startApp();

		const res = await app.loggedIn(IDENTITY);

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/json');
		// The key is userKey.test.ts's, for the fødselsnummer and the secret in test/fixtures.ts
		expect(await res.text()).toBe(
			'{"authenticated":true,"name":"Kari Marie Hansen","securityLevel":"4","userKey":"pvfCn3ybGT9VMf5w3CqfDm"}'
		);
		expect(
			await app.metric('nav_dekoratoren_auth_requests_total', { endpoint: 'identity', outcome: 'authenticated' })
		).toBe(1);
	});

	test('never has the fødselsnummer in it', async () => {
		texasSays(activeToken());
		pdlKnows();
		const app = await startApp();

		const res = await app.loggedIn(IDENTITY);

		const text = await res.text();
		expect(text).not.toContain(IDENT);
		expect(text).not.toContain('userId');
	});

	test('gives a user the same key every time, and another user another', async () => {
		http.post(NAIS_TOKEN_INTROSPECTION_ENDPOINT, (call) => ({
			json: activeToken({ pid: call.json<{ token: string }>().token }),
		}));
		pdlKnows();
		const app = await startApp();
		const keyOf = async (ident: string) =>
			((await (await app.loggedIn(IDENTITY, ident)).json()) as { userKey: string }).userKey;

		expect(await keyOf('10000000001')).toBe(await keyOf('10000000001'));
		expect(await keyOf('10000000002')).not.toBe(await keyOf('10000000001'));
	});

	test.each([
		['idporten-loa-high', '4'],
		['idporten-loa-substantial', '3'],
	])('at %s is security level %s, as a string', async (acr, securityLevel) => {
		texasSays(activeToken({ acr }));
		pdlKnows();
		const app = await startApp();

		const res = await app.loggedIn(IDENTITY);

		expect(await res.json()).toMatchObject({ authenticated: true, securityLevel });
	});

	test('is logged in without a name when PDL has none', async () => {
		texasSays(activeToken());
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, { status: 500 });
		const app = await startApp();

		const res = await app.loggedIn(IDENTITY);

		expect(await res.json()).toEqual({
			authenticated: true,
			name: '',
			securityLevel: '4',
			userKey: 'pvfCn3ybGT9VMf5w3CqfDm',
		});
	});

	test('has the name /auth asked PDL for, without asking again', async () => {
		texasSays(activeToken());
		pdlKnows();
		const app = await startApp();

		await app.loggedIn(AUTH);
		const res = await app.loggedIn(IDENTITY);

		expect(await res.json()).toMatchObject({ name: 'Kari Hansen' });
		expect(http.callsTo(PDL_GRAPHQL_URL)).toHaveLength(1);
	});
});

describe('/identity without the secret for the user keys', () => {
	test('is not there, and the rest is as before', async () => {
		vi.stubEnv('USER_KEY_SECRET', undefined);
		const app = await startApp();

		const identity = await app.request(IDENTITY);
		const auth = await app.request(AUTH);

		expect(identity.status).toBe(404);
		expect(await identity.text()).toBe('');
		expect(await auth.json()).toEqual(LOGGED_OUT);
	});
});
