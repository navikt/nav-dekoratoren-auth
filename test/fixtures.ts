// Texas' and PDL's answers in their wire shape, and the hosts the tests point the app at

export const NAIS_TOKEN_ENDPOINT = 'http://texas.test/api/v1/token';
export const NAIS_TOKEN_INTROSPECTION_ENDPOINT = 'http://texas.test/api/v1/introspect';
export const PDL_ORIGIN = 'http://pdl-api.test';
export const PDL_GRAPHQL_URL = `${PDL_ORIGIN}/graphql`;
export const PDL_TOKEN_TARGET = 'api://test-fss.pdl.pdl-api/.default';
// What the user keys in /identity are made with. Not a secret: it is only ever used here and in `pnpm dev`.
export const USER_KEY_SECRET = 'a-test-secret-of-at-least-32-characters';

// A fødselsnummer no person has
export const IDENT = '10000000001';

// Texas

// 2024-01-02T10:15:30Z and 2099-01-01T00:00:00Z
export const ISSUED = 1704190530;
export const EXPIRES = 4070908800;

// What Texas answers for an ID-porten token it vouches for: active, and the token's claims
export const activeToken = (overrides: Record<string, unknown> = {}) => ({
	active: true,
	iss: 'https://test.idporten.no',
	aud: 'nav.no',
	sub: 'sub-10000000001',
	pid: IDENT,
	acr: 'idporten-loa-high',
	amr: ['BankID'],
	iat: ISSUED,
	nbf: ISSUED,
	exp: EXPIRES,
	jti: 'jti-1',
	client_id: 'test-client',
	scope: 'openid',
	...overrides,
});

// What Texas answers for a token it doesn't vouch for, on HTTP 200
export const inactiveToken = (error = 'token is expired') => ({ active: false, error });

export const texasToken = (accessToken = 'texas-token', expiresIn = 3599) => ({
	access_token: accessToken,
	expires_in: expiresIn,
	token_type: 'Bearer',
});

// PDL

export type Navn = { fornavn: string | null; mellomnavn: string | null; etternavn: string | null };

export const navn = (
	fornavn: string | null = 'Kari',
	mellomnavn: string | null = null,
	etternavn: string | null = 'Hansen'
): Navn => ({ fornavn, mellomnavn, etternavn });

export const pdlPerson = (...names: Navn[]) => ({ data: { person: { navn: names.length > 0 ? names : [navn()] } } });

export const pdlNoPerson = () => ({ data: { person: null } });

export const pdlErrorAnswer = (code: string, message = 'Something went wrong') => ({
	errors: [{ message, locations: [{ line: 1, column: 22 }], path: ['person'], extensions: { code } }],
	data: { person: null },
});
