import { logger } from '@navikt/navno-logger';
import type { Outcome } from '../metrics.ts';
import { introspect } from '../texas.ts';

// Who is logged in, as the token on the request says
export type Identity = {
	/** The fødselsnummer or D-nummer, from the token's pid */
	ident: string;
	level: 3 | 4;
	/** When the token was issued and when it expires, in seconds since 1970 */
	issuedAt: number;
	expiresAt: number;
};

export type Recognised =
	| { outcome: 'authenticated'; identity: Identity }
	| { outcome: Exclude<Outcome, 'authenticated' | 'error'>; identity?: undefined };

// ID-porten's names for its two levels, and the names it had for them before
const levels: Record<string, 3 | 4> = {
	'idporten-loa-substantial': 3,
	Level3: 3,
	'idporten-loa-high': 4,
	Level4: 4,
};

// ID-porten's login proxy puts the token of a logged-in user on the request, as `Bearer <token>`
const BEARER = /^bearer (\S+)$/i;

/**
 * Who a request is from, by its Authorization header.
 *
 * - No Bearer token: nobody is logged in, and Texas isn't asked.
 * - A token Texas doesn't vouch for: nobody is logged in.
 * - A token Texas vouches for, without a fødselsnummer or with a level we don't know: nobody we can name is logged in.
 *   ID-porten doesn't issue those, so it is logged.
 *
 * Throws when Texas can't say. That is not "nobody is logged in", and the caller mustn't answer as if it were.
 */
export const recognise = async (authorization: string | undefined): Promise<Recognised> => {
	const token = authorization?.match(BEARER)?.[1];
	if (token === undefined) {
		return { outcome: 'anonymous' };
	}

	const claims = await introspect(token);
	if (!claims) {
		return { outcome: 'invalid_token' };
	}

	const { pid, acr, iat, exp } = claims;
	const level = typeof acr === 'string' ? levels[acr] : undefined;
	if (typeof pid !== 'string' || pid === '' || !level || typeof iat !== 'number' || typeof exp !== 'number') {
		logger.warn('Token without: a fødselsnummer, a known level, or known times', {
			acr: typeof acr === 'string' ? acr : typeof acr,
			hasPid: typeof pid === 'string' && pid !== '',
			hasTimes: typeof iat === 'number' && typeof exp === 'number',
		});
		return { outcome: 'unusable_token' };
	}

	return { outcome: 'authenticated', identity: { ident: pid, level, issuedAt: iat, expiresAt: exp } };
};
