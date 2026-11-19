import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { NAIS_TOKEN_ENDPOINT, NAIS_TOKEN_INTROSPECTION_ENDPOINT, PDL_ORIGIN, PDL_TOKEN_TARGET } from './fixtures.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address() as net.AddressInfo;
			probe.close(() => resolve(port));
		});
	});

// The server as the image runs it, with test/mocks/dev.ts answering for Texas and PDL. A signal and an exit can
// only be seen from outside, so this is the one test that starts a process.
test('server/main.ts starts, answers, and stops on SIGTERM without dropping what it has', async () => {
	const port = await freePort();
	const child = spawn(process.execPath, ['--import', './test/mocks/dev.ts', 'server/main.ts'], {
		cwd: ROOT,
		// Without VITEST, so the logger writes the JSON lines it writes in the cluster
		env: {
			PATH: process.env.PATH,
			NODE_ENV: 'production',
			PORT: String(port),
			NAIS_TOKEN_ENDPOINT,
			NAIS_TOKEN_INTROSPECTION_ENDPOINT,
			PDL_ORIGIN,
			PDL_TOKEN_TARGET,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	child.stdout.on('data', (data) => (output += data));
	child.stderr.on('data', (data) => (output += data));
	const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;

	try {
		const origin = `http://127.0.0.1:${port}`;
		await expect
			.poll(
				() =>
					fetch(`${origin}/internal/ready`).then(
						(res) => res.status,
						() => 0
					),
				{ timeout: 10_000 }
			)
			.toBe(200);

		const res = await fetch(`${origin}/navno/nav-dekoratoren-auth/auth`, {
			headers: { authorization: 'Bearer 10000000001' },
		});
		expect(await res.json()).toEqual({
			authenticated: true,
			name: 'Kari Hansen',
			securityLevel: '4',
			userId: '10000000001',
		});

		child.kill('SIGTERM');
		const [code] = await exited;

		expect(code, output).toBe(0);
		const messages = output
			.split('\n')
			.filter((line) => line.startsWith('{'))
			.map((line) => (JSON.parse(line) as { message: string }).message);
		expect(messages).toEqual([
			'Mocks: Texas and PDL are answered from test/fixtures.ts (MOCKS=false turns this off)',
			'Server listening',
			'Server shutting down',
			'Shutdown complete',
		]);
	} finally {
		child.kill('SIGKILL');
	}
}, 20_000);
