/*
 * Loaded with `node --import` by `pnpm dev`, so the server runs offline, at the hosts .env.development points it at.
 * In the cluster, ID-porten's login proxy puts a logged-in user's token on the request and Texas vouches for it.
 * Here the token is the user:
 *
 *   curl -H 'Authorization: Bearer 10000000001' localhost:3004/navno/nav-dekoratoren-auth/auth
 *
 * A token of eleven digits is a user with that fødselsnummer, logged in at level 4. Any other token is one Texas
 * doesn't vouch for. PDL knows everyone as Kari Hansen, except those whose id starts with 9, whom it doesn't know.
 * MOCKS=false turns this off; the server then needs a real Texas and PDL, which it only has in the cluster.
 */

import { mockFetch } from '@itsy/corgi/testing';
import { logger } from '@navikt/navno-logger';
import {
	activeToken,
	inactiveToken,
	NAIS_TOKEN_ENDPOINT,
	NAIS_TOKEN_INTROSPECTION_ENDPOINT,
	PDL_GRAPHQL_URL,
	pdlNoPerson,
	pdlPerson,
	texasToken,
} from '#test/fixtures.ts';

if (process.env.MOCKS !== 'false') {
	const http = mockFetch();

	http.post(NAIS_TOKEN_INTROSPECTION_ENDPOINT, (call) => {
		const { token } = call.json<{ token: string }>();
		return { json: /^\d{11}$/.test(token) ? activeToken({ pid: token, sub: `sub-${token}` }) : inactiveToken() };
	});

	http.post(NAIS_TOKEN_ENDPOINT, { json: texasToken() });

	http.post(PDL_GRAPHQL_URL, (call) => {
		const { ident } = call.json<{ variables: { ident: string } }>().variables;
		return { json: ident.startsWith('9') ? pdlNoPerson() : pdlPerson() };
	});

	http.install();
	logger.info('Mocks: Texas and PDL are answered from test/fixtures.ts (MOCKS=false turns this off)');
}
