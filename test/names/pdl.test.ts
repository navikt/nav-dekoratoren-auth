import { networkError } from '@itsy/corgi/testing';
import { logger } from '@navikt/navno-logger';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PATH, startApp, type TestApp } from '#test/app.ts';
import { installMockFetch } from '#test/fetch.ts';
import {
	activeToken,
	IDENT,
	NAIS_TOKEN_ENDPOINT,
	NAIS_TOKEN_INTROSPECTION_ENDPOINT,
	navn,
	PDL_GRAPHQL_URL,
	PDL_TOKEN_TARGET,
	pdlErrorAnswer,
	pdlNoPerson,
	pdlPerson,
	texasToken,
} from '#test/fixtures.ts';

const http = installMockFetch();

afterEach(() => {
	vi.useRealTimers();
});

const AUTH = `${PATH}/auth`;

const loggedIn = () => http.post(NAIS_TOKEN_INTROSPECTION_ENDPOINT, { json: activeToken() });

const nameOf = async (app: TestApp) => {
	const res = await app.loggedIn(AUTH);
	return ((await res.json()) as { name: string }).name;
};

const authorizations = () => http.callsTo(PDL_GRAPHQL_URL).map((call) => call.headers.get('authorization'));
const askedOfTexas = () => http.callsTo(NAIS_TOKEN_ENDPOINT).map((call) => call.json<Record<string, unknown>>());

const token = { identity_provider: 'entra_id', target: PDL_TOKEN_TARGET };
const newToken = { ...token, skip_cache: true };

// The lookup's 2 s deadline in 40 ms. The tests' own request timeout is left alone.
const shortDeadline = () => {
	const timeout = AbortSignal.timeout.bind(AbortSignal);
	return vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => timeout(ms === 2000 ? 40 : ms));
};

// Everything the lookup logged, as text, to look for what must never be in a log
const everythingLogged = (...spies: { mock: { calls: unknown[][] } }[]) =>
	JSON.stringify(spies.flatMap((spy) => spy.mock.calls));

describe('a PDL request', () => {
	test("is one POST of nav-dekoratoren-api's query, with the fødselsnummer as its variable", async () => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, { json: pdlPerson() });
		const app = await startApp();

		await nameOf(app);

		const [call, ...more] = http.callsTo(PDL_GRAPHQL_URL);
		expect(more).toEqual([]);
		expect(call?.method).toBe('POST');
		expect(call?.json()).toEqual({
			query: 'query ($ident: ID!) { person: hentPerson(ident: $ident) { navn { fornavn, mellomnavn, etternavn } } }',
			variables: { ident: IDENT },
		});
	});

	test('says who asks and what for', async () => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken('the-pdl-token') });
		http.post(PDL_GRAPHQL_URL, { json: pdlPerson() });
		const app = await startApp();

		await nameOf(app);

		const headers = http.callsTo(PDL_GRAPHQL_URL)[0]?.headers;
		expect(headers?.get('authorization')).toBe('Bearer the-pdl-token');
		expect(headers?.get('content-type')).toBe('application/json');
		expect(headers?.get('accept')).toBe('application/json');
		expect(headers?.get('nav-consumer-id')).toBe('nav-dekoratoren-auth');
		expect(headers?.get('tema')).toBe('GEN');
		expect(headers?.get('behandlingsnummer')).toBe('B328');
	});

	test('asks Texas for a token to PDL every time, and keeps none itself', async () => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, [{ json: texasToken('token-1') }, { json: texasToken('token-2') }]);
		http.post(PDL_GRAPHQL_URL, [{ status: 500 }, { json: pdlPerson() }]);
		const app = await startApp();

		await nameOf(app);
		await nameOf(app);

		expect(askedOfTexas()).toEqual([token, token]);
		expect(authorizations()).toEqual(['Bearer token-1', 'Bearer token-2']);
	});
});

describe("the name, from PDL's answer", () => {
	test.each([
		['first, middle and last name', navn('Kari', 'Marie', 'Hansen'), 'Kari Marie Hansen'],
		['no middle name', navn('Kari', null, 'Hansen'), 'Kari Hansen'],
		['an empty middle name', navn('Kari', '', 'Hansen'), 'Kari Hansen'],
		['a middle name of spaces', navn('Kari', '   ', 'Hansen'), 'Kari Hansen'],
		['only a first name', navn('Kari', null, null), 'Kari'],
		['only a last name', navn(null, null, 'Hansen'), 'Hansen'],
		['no parts at all', navn(null, null, null), ''],
		// As nav-dekoratoren-api did: a part is left out or kept whole
		['spaces around a part', navn(' Kari ', null, ' Hansen '), ' Kari   Hansen '],
	])('%s', async (_, name, expected) => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, { json: pdlPerson(name) });
		const app = await startApp();

		expect(await nameOf(app)).toBe(expected);
	});

	test('is the first of several', async () => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, { json: pdlPerson(navn('Kari', null, 'Hansen'), navn('Kari', null, 'Olsen')) });
		const app = await startApp();

		expect(await nameOf(app)).toBe('Kari Hansen');
	});

	test('ignores what else PDL sends', async () => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, {
			json: {
				data: { person: { navn: [{ ...navn(), forkortetNavn: 'HANSEN KARI' }], kjoenn: [] } },
				extensions: { something: 'new' },
			},
		});
		const app = await startApp();

		expect(await nameOf(app)).toBe('Kari Hansen');
	});

	test("logs PDL's warnings about how we ask, and uses the name", async () => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, {
			json: {
				...pdlPerson(),
				extensions: {
					warnings: [
						{
							query: 'hentPerson',
							id: 'behandlingsnummer',
							code: 'ugyldig',
							message: 'Behandlingsnummer er ugyldig',
							details: { ident: IDENT },
						},
					],
				},
			},
		});
		const warn = vi.spyOn(logger, 'warn');
		const app = await startApp();

		expect(await nameOf(app)).toBe('Kari Hansen');

		expect(warn).toHaveBeenCalledExactlyOnceWith('PDL answered with warnings', {
			warnings: [{ id: 'behandlingsnummer', code: 'ugyldig', message: 'Behandlingsnummer er ugyldig' }],
		});
	});
});

describe('a lookup with no name to show for it', () => {
	test.each([
		['has no person', { json: pdlNoPerson() }],
		['has a person without names', { json: { data: { person: { navn: [] } } } }],
		['answers not_found', { json: pdlErrorAnswer('not_found', `Fant ikke person ${IDENT}`) }],
	])('when PDL %s, is logged as a user without a name', async (_, reply) => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, reply);
		const warn = vi.spyOn(logger, 'warn');
		const app = await startApp();

		expect(await nameOf(app)).toBe('');

		expect(warn).toHaveBeenCalledExactlyOnceWith('PDL has no name for the user');
		expect(await app.metric('nav_dekoratoren_auth_names_total', { source: 'missing' })).toBe(1);
	});

	test.each([
		[
			'answers an HTTP error',
			{ status: 503, json: pdlErrorAnswer('server_error') },
			{ status: 503, errorCodes: ['server_error'] },
		],
		[
			'answers GraphQL errors on HTTP 200',
			{ json: pdlErrorAnswer('bad_request') },
			{ status: 200, errorCodes: ['bad_request'] },
		],
		[
			'answers something that is not JSON',
			{ text: '<html>Bad gateway</html>', status: 502 },
			{ status: 502, errorCodes: [] },
		],
		['is unreachable', networkError(), expect.any(Error)],
	] as const)('when PDL %s, is logged with the status and the codes only', async (_, reply, logged) => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, reply);
		const warn = vi.spyOn(logger, 'warn');
		const app = await startApp();

		expect(await nameOf(app)).toBe('');

		expect(warn).toHaveBeenCalledExactlyOnceWith('PDL request failed', logged);
		expect(await app.metric('nav_dekoratoren_auth_names_total', { source: 'failed' })).toBe(1);
	});

	test('when the answer is not the shape asked for, is logged with what was wrong', async () => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, { json: { data: { person: { navn: 'Kari Hansen' } } } });
		const warn = vi.spyOn(logger, 'warn');
		const app = await startApp();

		expect(await nameOf(app)).toBe('');

		expect(warn).toHaveBeenCalledExactlyOnceWith('PDL request failed', {
			issues: [expect.stringContaining('data.person.navn')],
		});
	});

	test("counts PDL's error codes", async () => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, [{ json: pdlErrorAnswer('bad_request') }, { json: pdlErrorAnswer('brand_new_code') }]);
		const app = await startApp();

		await nameOf(app);
		await nameOf(app);

		expect(await app.metric('nav_dekoratoren_auth_pdl_errors_total', { code: 'bad_request' })).toBe(1);
		expect(await app.metric('nav_dekoratoren_auth_pdl_errors_total', { code: 'other' })).toBe(1);
	});

	test('gives up on a PDL that takes longer than the deadline, and counts that', async () => {
		shortDeadline();
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, { hang: true });
		const app = await startApp();

		expect(await nameOf(app)).toBe('');

		expect(
			await app.metric('nav_dekoratoren_auth_upstream_requests_total', { upstream: 'pdl', status: 'timeout' })
		).toBe(1);
	});

	test('when Texas has no token for PDL, PDL is not asked', async () => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { status: 500, json: { error: 'server_error' } });
		const warn = vi.spyOn(logger, 'warn');
		const app = await startApp();

		expect(await nameOf(app)).toBe('');

		expect(http.callsTo(PDL_GRAPHQL_URL)).toEqual([]);
		expect(warn).toHaveBeenCalledExactlyOnceWith('Token request for PDL failed', { status: 500 });
		expect(await app.metric('nav_dekoratoren_auth_names_total', { source: 'failed' })).toBe(1);
	});

	test('never logs the fødselsnummer, or what PDL said about the person', async () => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, [
			{ status: 500, json: { message: `No access to ${IDENT}` } },
			{ json: pdlErrorAnswer('unauthorized', `Ikke tilgang til å se person ${IDENT}`) },
			{ json: pdlErrorAnswer('not_found', `Fant ikke person ${IDENT}`) },
		]);
		const warn = vi.spyOn(logger, 'warn');
		const error = vi.spyOn(logger, 'error');
		const app = await startApp();

		await nameOf(app);
		await nameOf(app);
		await nameOf(app);

		expect(warn).toHaveBeenCalledTimes(3);
		const logged = everythingLogged(warn, error);
		expect(logged).not.toContain(IDENT);
		expect(logged).not.toContain('tilgang');
	});
});

describe('a token PDL refuses', () => {
	test('after a 401, asks Texas for a token it has not kept and tries once more', async () => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, [{ json: texasToken('token-1') }, { json: texasToken('token-2') }]);
		http.post(PDL_GRAPHQL_URL, [{ status: 401 }, { json: pdlPerson() }]);
		const warn = vi.spyOn(logger, 'warn');
		const app = await startApp();

		expect(await nameOf(app)).toBe('Kari Hansen');

		expect(authorizations()).toEqual(['Bearer token-1', 'Bearer token-2']);
		expect(askedOfTexas()).toEqual([token, newToken]);
		expect(warn).toHaveBeenCalledExactlyOnceWith('PDL refused the token, trying once more with a new one');
	});

	test('does the same when PDL reports the refused token as a GraphQL error on HTTP 200', async () => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, [{ json: texasToken('token-1') }, { json: texasToken('token-2') }]);
		http.post(PDL_GRAPHQL_URL, [{ json: pdlErrorAnswer('unauthenticated') }, { json: pdlPerson() }]);
		const app = await startApp();

		expect(await nameOf(app)).toBe('Kari Hansen');

		expect(askedOfTexas()).toEqual([token, newToken]);
	});

	test('asks for a new token at most once a minute, however often PDL refuses', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, { status: 401 });
		const app = await startApp();

		await nameOf(app);
		expect(askedOfTexas()).toEqual([token, newToken]);

		vi.advanceTimersByTime(59_000);
		await nameOf(app);
		expect(askedOfTexas()).toEqual([token, newToken, token]);

		vi.advanceTimersByTime(1000);
		await nameOf(app);
		expect(askedOfTexas()).toEqual([token, newToken, token, token, newToken]);
	});

	test('answers without a name when the second try fails too', async () => {
		loggedIn();
		http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
		http.post(PDL_GRAPHQL_URL, { status: 401 });
		const app = await startApp();

		expect(await nameOf(app)).toBe('');

		expect(http.callsTo(PDL_GRAPHQL_URL)).toHaveLength(2);
	});
});
