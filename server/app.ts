import { logger } from '@navikt/navno-logger';
import { internal, traceRoutes } from '@navikt/navno-server';
import { failureOf } from '@navikt/navno-server/upstream';
import { Hono } from 'hono';
import { env } from './env.ts';
import { compat, identity } from './identity/route.ts';
import { userKeyWith } from './identity/userKey.ts';
import { metricsRegistry } from './metrics.ts';
import { IntrospectionError } from './texas.ts';

// The app's own path, which its own ingress has. Everything but /internal is under it.
export const OWN_PATH = '/navno/nav-dekoratoren-auth';

export const createApp = () => {
	const app = new Hono();

	// Registered first, so it hits all registrations afterward
	app.use(traceRoutes());

	// No CORS: dekoratøren's server is the caller, not a browser
	app.route(OWN_PATH, compat);
	// New functionality, off until there is a secret
	if (env.USER_KEY_SECRET) {
		app.route(OWN_PATH, identity(userKeyWith(env.USER_KEY_SECRET)));
	}
	app.route('/internal', internal({ registry: metricsRegistry }));

	// When we 404 just send the status code and nothing else
	app.notFound((c) => c.body(null, 404));

	// Texas couldn't say who the request is from, or something is broken.
	// Either way it isn't "nobody is logged in", so the answer is an error.
	app.onError((err, c) => {
		const request = { method: c.req.method, path: c.req.path };
		if (err instanceof IntrospectionError) {
			logger.error('Token introspection failed', request, failureOf(err.cause));
		} else {
			logger.error('Request failed', request, err);
		}
		return c.json({ error: 'Internal server error' }, 500);
	});

	return app;
};
