import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { onTestFinished, vi } from 'vitest';

// The real fetch, kept before a test file installs corgi's mock as the global, for requests to the app itself
const realFetch = globalThis.fetch;

// The app's own path. test/app.test.ts asks under nav-dekoratoren-api's two as well.
export const PATH = '/navno/nav-dekoratoren-auth';

// A fresh copy of the app on a free port. The name cache, the metrics registry and the time of the last forced
// token are module state, so every test gets new modules.
export const startApp = async () => {
	vi.resetModules();
	const { createApp } = await import('#server/app.ts');

	const app = createApp();
	const port = await new Promise<number>((resolve) => {
		const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
			resolve(info.port)
		);
		onTestFinished(
			() =>
				new Promise<void>((done) => {
					if ('closeAllConnections' in server) {
						server.closeAllConnections();
					}
					server.close(() => done());
				})
		);
	});
	const origin = `http://127.0.0.1:${port}`;

	// A request the app never answers fails the test instead of hanging it
	const request = (path: string, init: RequestInit = {}) =>
		realFetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(5000) });

	// A request as ID-porten's login proxy passes it on for a logged-in user. Texas is mocked, so the token is a name.
	const loggedIn = (path: string, token = 'a-token') =>
		request(path, { headers: { authorization: `Bearer ${token}` } });

	// One sample from /internal/metrics; labels in the order the metric declares them
	const metric = async (name: string, labels: Record<string, string> = {}) => {
		const text = await (await request('/internal/metrics')).text();
		const labelText = Object.entries(labels)
			.map(([key, value]) => `${key}="${value}"`)
			.join(',');
		const series = labelText ? `${name}{${labelText}} ` : `${name} `;
		const line = text.split('\n').find((l) => l.startsWith(series));
		return line === undefined ? undefined : Number(line.slice(series.length));
	};

	return { origin, request, loggedIn, metric };
};

export type TestApp = Awaited<ReturnType<typeof startApp>>;
