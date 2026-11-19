import { schema } from '@itsy/corgi/schema';
import { z } from 'zod';
import { env } from './env.ts';
import { upstreamClient } from './upstream.ts';

const TEXAS_TIMEOUT_MS = 2000;

const introspection = upstreamClient('texas_introspect', { timeout: TEXAS_TIMEOUT_MS });
const tokens = upstreamClient('texas_token', { timeout: TEXAS_TIMEOUT_MS });

export type Claims = Record<string, unknown>;

// Texas answers 200 whether the token holds or not, and a token that holds comes back with its claims
const introspectionSchema = z.looseObject({ active: z.boolean() });

// Texas couldn't say whether a token holds -> look at `cause`
export class IntrospectionError extends Error {}

/**
 * Claims the ID-porten token contains:
 * its signature, its issuer and audience, and its times.
 * Undefined for a token it doesn't vouch for.
 * Throws an IntrospectionError when Texas gives up.
 */
export const introspect = async (token: string): Promise<Claims | undefined> => {
	try {
		const answer = await introspection.post(env.NAIS_TOKEN_INTROSPECTION_ENDPOINT, {
			body: { identity_provider: 'idporten', token },
			transform: schema(introspectionSchema),
		});
		return answer.active ? answer : undefined;
	} catch (e) {
		throw new IntrospectionError('Texas could not introspect the token', { cause: e });
	}
};

const tokenSchema = z.looseObject({ access_token: z.string().min(1) });

// Texas gave no token -> look at `cause`
export class TokenError extends Error {}

const askForPdlToken = async (signal: AbortSignal, skipCache: boolean) => {
	try {
		const { access_token } = await tokens.post(env.NAIS_TOKEN_ENDPOINT, {
			body: { identity_provider: 'entra_id', target: env.PDL_TOKEN_TARGET, ...(skipCache && { skip_cache: true }) },
			signal,
			transform: schema(tokenSchema),
		});
		return access_token;
	} catch (e) {
		throw new TokenError('Texas gave no token for PDL', { cause: e });
	}
};

// The token for a PDL request.
// Texas never hands out an expired token, so it's requested every time
export const pdlToken = (signal: AbortSignal) => askForPdlToken(signal, false);

const FORCED_TOKEN_INTERVAL_MS = 60_000;
let forcedTokenAt = -Infinity;

// A token Texas hasn't kept, for when PDL refused the one it had. At most one a minute for the whole process, so a PDL
// that keeps refusing doesn't turn every lookup into a request to Entra ID. Undefined when one was just made.
export const freshPdlToken = async (signal: AbortSignal) => {
	if (Date.now() - forcedTokenAt < FORCED_TOKEN_INTERVAL_MS) {
		return undefined;
	}

	forcedTokenAt = Date.now();
	return askForPdlToken(signal, true);
};
