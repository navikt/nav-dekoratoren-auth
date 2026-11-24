import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { countRequest, type Endpoint } from '../metrics.ts';
import { nameOf } from '../names/names.ts';
import { recognise } from './identity.ts';
import type { UserKey } from './userKey.ts';

// Who the request is from, counted. When Texas can't say, the error goes on to app.onError, which answers 500.
const recogniseFor = async (endpoint: Endpoint, authorization: string | undefined) => {
	try {
		const recognised = await recognise(authorization);
		countRequest(endpoint, recognised.outcome);
		return recognised;
	} catch (e) {
		countRequest(endpoint, 'error');
		throw e;
	}
};

// Responses are for one user, do not cache
const noStore = createMiddleware(async (c, next) => {
	await next();
	c.header('Cache-Control', 'no-store');
});

// Keep the same date-time as nav-dekoratoren-api
const localDateTime = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString().slice(0, 19);

// /auth has fødselsnummer included
export const compat = new Hono()
	.use(noStore)
	.get('/auth', async (c) => {
		const { identity: user } = await recogniseFor('auth', c.req.header('authorization'));
		if (!user) {
			return c.json({ authenticated: false });
		}

		return c.json({
			authenticated: true,
			// As nav-dekoratoren-api did: the fødselsnummer is the name when PDL has none
			name: await nameOf(user.ident, user.ident),
			securityLevel: String(user.level),
			userId: user.ident,
		});
	})
	// Just read the token - no PDL
	.get('/summary', async (c) => {
		const { identity: user } = await recogniseFor('summary', c.req.header('authorization'));
		if (!user) {
			return c.json({ authenticated: false });
		}

		return c.json({
			authenticated: true,
			authLevel: user.level,
			oidc: {
				authLevel: user.level,
				issueTime: localDateTime(user.issuedAt),
				expiryTime: localDateTime(user.expiresAt),
			},
		});
	})

	// Any other method. GET covers HEAD.
	.all('/auth', (c) => c.body(null, 405, { Allow: 'GET, HEAD' }))
	.all('/summary', (c) => c.body(null, 405, { Allow: 'GET, HEAD' }));

// /identity does not contain fødselsnummer
export const identity = (userKey: UserKey) =>
	new Hono()
		.use(noStore)

		.get('/identity', async (c) => {
			const { identity: user } = await recogniseFor('identity', c.req.header('authorization'));
			if (!user) {
				return c.json({ authenticated: false });
			}

			return c.json({
				authenticated: true,
				// Never the fødselsnummer, not even as a fallback
				name: await nameOf(user.ident, ''),
				securityLevel: String(user.level),
				userKey: userKey(user.ident),
			});
		})
		.all('/identity', (c) => c.body(null, 405, { Allow: 'GET, HEAD' }));
