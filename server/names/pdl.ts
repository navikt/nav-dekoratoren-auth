import { isHttpError } from '@itsy/corgi';
import { schema } from '@itsy/corgi/schema';
import { logger } from '@navikt/navno-logger';
import { failureOf } from '@navikt/navno-server/upstream';
import { z } from 'zod';
import { env } from '../env.ts';
import { recordPdlErrors } from '../metrics.ts';
import { freshPdlToken, pdlToken, TokenError } from '../texas.ts';
import { upstreamClient } from '../upstream.ts';

// /auth waits for the name, and the dekoratør waits for /auth before it shows the user menu. The Kotlin app gave PDL
// the same 2 s.
export const LOOKUP_TIMEOUT_MS = 2000;

const pdlGraphQLUrl = `${env.PDL_ORIGIN}/graphql`;

const pdl = upstreamClient('pdl', {
	timeout: LOOKUP_TIMEOUT_MS,
	headers: {
		accept: 'application/json',
		'Nav-Consumer-Id': 'nav-dekoratoren-auth',
		// What the lookup is for, which PDL asks every caller to state: general case handling, under entry B328 of
		// Behandlingskatalogen. Both are as nav-dekoratoren-api sent them.
		Tema: 'GEN',
		Behandlingsnummer: 'B328',
	},
});

// The query nav-dekoratoren-api sent, character for character
const QUERY = 'query ($ident: ID!) { person: hentPerson(ident: $ident) { navn { fornavn, mellomnavn, etternavn } } }';

const answerSchema = z.looseObject({
	data: z
		.looseObject({
			person: z
				.looseObject({
					navn: z.array(
						z.looseObject({
							fornavn: z.string().nullish(),
							mellomnavn: z.string().nullish(),
							etternavn: z.string().nullish(),
						})
					),
				})
				.nullish(),
		})
		.nullish(),
	extensions: z.looseObject({ warnings: z.array(z.looseObject({})).nullish() }).nullish(),
});

type Answer = z.infer<typeof answerSchema>;

export type Lookup =
	// PDL has a name for the person. It can be empty: a name whose every part is missing.
	| { result: 'found'; name: string }
	// PDL answered, and has no name for the person
	| { result: 'missing' }
	// PDL or its token failed, or took too long
	| { result: 'failed' };

// PDL answered, with GraphQL errors.
// Codes only: PDL's messages are about a person.
class PdlErrors extends Error {
	codes: string[];

	constructor(codes: string[]) {
		super('PDL answered with errors');
		this.codes = codes;
	}
}

const errorsSchema = z.object({
	errors: z.array(z.looseObject({ extensions: z.looseObject({ code: z.unknown() }).nullish() })).min(1),
});

// The codes of the GraphQL errors in an answer from PDL. None when it has no errors, or isn't a GraphQL answer.
const errorCodesOf = (answer: unknown) => {
	const parsed = errorsSchema.safeParse(answer);
	return parsed.success
		? parsed.data.errors.map(({ extensions }) => (typeof extensions?.code === 'string' ? extensions.code : 'unknown'))
		: [];
};

// PDL reports a token it won't take as HTTP 401, or as a GraphQL error on HTTP 200
const isRefusedToken = (e: unknown) =>
	(isHttpError(e) && e.status === 401) || (e instanceof PdlErrors && e.codes.includes('unauthenticated'));

// PDL's way of saying it doesn't know the person
const isNotFound = (e: unknown) => e instanceof PdlErrors && e.codes.every((code) => code === 'not_found');

// The parts a person has, with one space between them, as nav-dekoratoren-api joined them
const fullName = ({ fornavn, mellomnavn, etternavn }: { [part: string]: unknown }) =>
	[fornavn, mellomnavn, etternavn]
		.filter((part): part is string => typeof part === 'string' && part.trim() !== '')
		.join(' ');

// A warning is about how we ask, such as a field PDL is about to remove. Its id, code and message say which.
const logWarnings = (answer: Answer) => {
	const warnings = answer.extensions?.warnings ?? [];
	if (warnings.length > 0) {
		logger.warn('PDL answered with warnings', {
			warnings: warnings.slice(0, 5).map(({ id, code, message }) => ({ id, code, message })),
		});
	}
};

// What to log about a failed lookup: a status and PDL's error codes, never the fødselsnummer or PDL's own words
const logFailure = (e: unknown) => {
	if (e instanceof TokenError) {
		logger.warn('Token request for PDL failed', failureOf(e.cause));
	} else if (e instanceof PdlErrors) {
		logger.warn('PDL request failed', { status: 200, errorCodes: e.codes });
	} else if (isHttpError(e)) {
		logger.warn('PDL request failed', { status: e.status, errorCodes: errorCodesOf(e.data) });
	} else {
		logger.warn('PDL request failed', failureOf(e));
	}
};

/**
 * Asks PDL for a person's name. The token, the query and a second try share one deadline. When PDL refuses the
 * token, the query is tried once more with a new one. Never throws: a lookup that fails is logged and answered as
 * failed, since /auth has an answer to give without the name.
 */
export const lookupName = async (ident: string): Promise<Lookup> => {
	const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);

	const ask = async (token: string) => {
		try {
			return await pdl.post(pdlGraphQLUrl, {
				body: { query: QUERY, variables: { ident } },
				headers: { authorization: `Bearer ${token}` },
				signal,
				// The errors first: an answer with errors can have data too, and isn't to be trusted
				transform: (answer) => {
					const codes = errorCodesOf(answer);
					if (codes.length > 0) {
						throw new PdlErrors(codes);
					}
					return schema(answerSchema)(answer);
				},
			});
		} catch (e) {
			let codes: string[] = [];
			if (e instanceof PdlErrors) {
				codes = e.codes;
			} else if (isHttpError(e)) {
				codes = errorCodesOf(e.data);
			}
			recordPdlErrors(codes);
			throw e;
		}
	};

	const askWithToken = async () => {
		try {
			return await ask(await pdlToken(signal));
		} catch (e) {
			const freshToken = isRefusedToken(e) ? await freshPdlToken(signal) : undefined;
			if (!freshToken) {
				throw e;
			}

			logger.warn('PDL refused the token, trying once more with a new one');
			return ask(freshToken);
		}
	};

	try {
		const answer = await askWithToken();
		logWarnings(answer);

		// Of several names, PDL lists the one in use first
		const navn = answer.data?.person?.navn[0];
		if (!navn) {
			logger.warn('PDL has no name for the user');
			return { result: 'missing' };
		}
		return { result: 'found', name: fullName(navn) };
	} catch (e) {
		if (isNotFound(e)) {
			logger.warn('PDL has no name for the user');
			return { result: 'missing' };
		}
		logFailure(e);
		return { result: 'failed' };
	}
};
