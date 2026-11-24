import { afterEach, describe, expect, test, vi } from 'vitest';
import { PATH, startApp, type TestApp } from '#test/app.ts';
import { installMockFetch } from '#test/fetch.ts';
import {
	activeToken,
	NAIS_TOKEN_ENDPOINT,
	NAIS_TOKEN_INTROSPECTION_ENDPOINT,
	navn,
	PDL_GRAPHQL_URL,
	pdlNoPerson,
	pdlPerson,
	texasToken,
} from '#test/fixtures.ts';

const http = installMockFetch();

afterEach(() => {
	vi.useRealTimers();
});

const AUTH = `${PATH}/auth`;

// Texas vouches for every token, and says the token itself is the fødselsnummer of whoever is logged in
const everyTokenIsItsOwner = () => {
	http.post(NAIS_TOKEN_INTROSPECTION_ENDPOINT, (call) => ({
		json: activeToken({ pid: call.json<{ token: string }>().token }),
	}));
	http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });
};

const nameOf = async (app: TestApp, ident: string) => {
	const res = await app.loggedIn(AUTH, ident);
	return ((await res.json()) as { name: string }).name;
};

// The fødselsnummer PDL was asked about, in order
const askedOfPdl = () =>
	http.callsTo(PDL_GRAPHQL_URL).map((call) => call.json<{ variables: { ident: string } }>().variables.ident);

const names = (app: TestApp, source: string) => app.metric('nav_dekoratoren_auth_names_total', { source });

describe('the name of a logged-in user', () => {
	test('is asked of PDL once, and kept for the user who comes back', async () => {
		everyTokenIsItsOwner();
		http.post(PDL_GRAPHQL_URL, { json: pdlPerson(navn('Kari', null, 'Hansen')) });
		const app = await startApp();

		expect(await nameOf(app, '10000000001')).toBe('Kari Hansen');
		expect(await nameOf(app, '10000000001')).toBe('Kari Hansen');
		expect(await nameOf(app, '10000000001')).toBe('Kari Hansen');

		expect(askedOfPdl()).toEqual(['10000000001']);
		expect(await names(app, 'found')).toBe(1);
		expect(await names(app, 'cached')).toBe(2);
		expect(await app.metric('nav_dekoratoren_auth_name_cache_entries')).toBe(1);
	});

	test("is each user's own", async () => {
		everyTokenIsItsOwner();
		http.post(PDL_GRAPHQL_URL, (call) => ({
			json: pdlPerson(
				call.json<{ variables: { ident: string } }>().variables.ident === '10000000001'
					? navn('Kari', null, 'Hansen')
					: navn('Ola', null, 'Olsen')
			),
		}));
		const app = await startApp();

		expect(await nameOf(app, '10000000001')).toBe('Kari Hansen');
		expect(await nameOf(app, '10000000002')).toBe('Ola Olsen');
		expect(await nameOf(app, '10000000001')).toBe('Kari Hansen');
		expect(await nameOf(app, '10000000002')).toBe('Ola Olsen');

		expect(askedOfPdl()).toEqual(['10000000001', '10000000002']);
	});

	test('is asked of PDL once for requests that arrive together', async () => {
		everyTokenIsItsOwner();
		http.post(PDL_GRAPHQL_URL, { json: pdlPerson(navn('Kari', null, 'Hansen')), delay: 50 });
		const app = await startApp();

		const answers = await Promise.all(Array.from({ length: 5 }, () => nameOf(app, '10000000001')));

		expect(answers).toEqual(Array.from({ length: 5 }, () => 'Kari Hansen'));
		expect(askedOfPdl()).toEqual(['10000000001']);
		expect(await names(app, 'found')).toBe(1);
		expect(await names(app, 'shared')).toBe(4);
	});

	test('is kept when it is empty, which is what PDL had', async () => {
		everyTokenIsItsOwner();
		http.post(PDL_GRAPHQL_URL, { json: pdlPerson(navn(null, null, null)) });
		const app = await startApp();

		expect(await nameOf(app, '10000000001')).toBe('');
		expect(await nameOf(app, '10000000001')).toBe('');

		expect(askedOfPdl()).toEqual(['10000000001']);
	});

	test('is asked for again after the time it is kept', async () => {
		vi.stubEnv('NAME_CACHE_TTL_SECONDS', '60');
		everyTokenIsItsOwner();
		http.post(PDL_GRAPHQL_URL, [
			{ json: pdlPerson(navn('Kari', null, 'Hansen')) },
			{ json: pdlPerson(navn('Kari', null, 'Olsen')) },
		]);
		const app = await startApp();
		expect(await nameOf(app, '10000000001')).toBe('Kari Hansen');

		// lru-cache times a name by performance.now(), and reuses a clock reading for a millisecond
		vi.useFakeTimers({ toFake: ['performance'] });
		const later = async (ms: number) => {
			vi.advanceTimersByTime(ms);
			await new Promise((resolve) => setTimeout(resolve, 5));
		};

		await later(59_000);
		expect(await nameOf(app, '10000000001')).toBe('Kari Hansen');

		// The fake clock starts at zero, behind the real one the name was stored by, so "after" is well after
		await later(60 * 60 * 1000);
		expect(await nameOf(app, '10000000001')).toBe('Kari Olsen');

		expect(askedOfPdl()).toEqual(['10000000001', '10000000001']);
	});

	test('makes room for a new one when the cache is full, and counts that', async () => {
		vi.stubEnv('NAME_CACHE_MAX_ENTRIES', '2');
		everyTokenIsItsOwner();
		http.post(PDL_GRAPHQL_URL, { json: pdlPerson() });
		const app = await startApp();

		await nameOf(app, '10000000001');
		await nameOf(app, '10000000002');
		await nameOf(app, '10000000003');
		// The oldest went, the other two are still there
		await nameOf(app, '10000000002');
		await nameOf(app, '10000000003');
		await nameOf(app, '10000000001');

		expect(askedOfPdl()).toEqual(['10000000001', '10000000002', '10000000003', '10000000001']);
		expect(await app.metric('nav_dekoratoren_auth_name_cache_entries')).toBe(2);
		expect(await app.metric('nav_dekoratoren_auth_name_cache_evictions_total')).toBe(2);
	});

	test('does not count a name whose time was up as dropped to make room', async () => {
		vi.stubEnv('NAME_CACHE_MAX_ENTRIES', '2');
		vi.stubEnv('NAME_CACHE_TTL_SECONDS', '60');
		everyTokenIsItsOwner();
		http.post(PDL_GRAPHQL_URL, { json: pdlPerson() });
		const app = await startApp();
		await nameOf(app, '10000000001');
		await nameOf(app, '10000000002');

		// Well past the minute, as in the test above
		vi.useFakeTimers({ toFake: ['performance'] });
		vi.advanceTimersByTime(60 * 60 * 1000);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await nameOf(app, '10000000003');

		// One of the first two went, and wasn't counted
		expect(await app.metric('nav_dekoratoren_auth_name_cache_entries')).toBe(2);
		expect(await app.metric('nav_dekoratoren_auth_name_cache_evictions_total')).toBe(0);
	});
});

// As nav-dekoratoren-api, /auth answers with the fødselsnummer as the name. Unlike it, that isn't kept for half an hour.
describe('when PDL has no name to give', () => {
	test.each([
		['fails', { status: 500 }, 'failed'],
		['does not know the user', { json: pdlNoPerson() }, 'missing'],
	] as const)('and %s, the name is the fødselsnummer and PDL is asked again next time', async (_, reply, source) => {
		everyTokenIsItsOwner();
		http.post(PDL_GRAPHQL_URL, [reply, reply, { json: pdlPerson(navn('Kari', null, 'Hansen')) }]);
		const app = await startApp();

		expect(await nameOf(app, '10000000001')).toBe('10000000001');
		expect(await nameOf(app, '10000000001')).toBe('10000000001');
		expect(await nameOf(app, '10000000001')).toBe('Kari Hansen');
		expect(await nameOf(app, '10000000001')).toBe('Kari Hansen');

		expect(askedOfPdl()).toEqual(['10000000001', '10000000001', '10000000001']);
		expect(await names(app, source)).toBe(2);
		expect(await names(app, 'found')).toBe(1);
		expect(await names(app, 'cached')).toBe(1);
	});

	test('requests that arrive together share the failure, and nothing is kept', async () => {
		everyTokenIsItsOwner();
		http.post(PDL_GRAPHQL_URL, [{ status: 500, delay: 50 }, { json: pdlPerson(navn('Kari', null, 'Hansen')) }]);
		const app = await startApp();

		const together = await Promise.all(Array.from({ length: 3 }, () => nameOf(app, '10000000001')));
		const after = await nameOf(app, '10000000001');

		expect(together).toEqual(['10000000001', '10000000001', '10000000001']);
		expect(after).toBe('Kari Hansen');
		expect(askedOfPdl()).toEqual(['10000000001', '10000000001']);
	});

	test('one user without a name does not hold up another', async () => {
		// The lookup's 2 s deadline in 100 ms. The tests' own request timeout is left alone.
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => timeout(ms === 2000 ? 100 : ms));
		everyTokenIsItsOwner();
		http.post(PDL_GRAPHQL_URL, (call) =>
			call.json<{ variables: { ident: string } }>().variables.ident === '10000000001'
				? { hang: true }
				: { json: pdlPerson(navn('Ola', null, 'Olsen')) }
		);
		const app = await startApp();

		const stuck = nameOf(app, '10000000001');
		expect(await nameOf(app, '10000000002')).toBe('Ola Olsen');

		// The stuck one is given up on after the lookup's deadline
		expect(await stuck).toBe('10000000001');
	});
});
