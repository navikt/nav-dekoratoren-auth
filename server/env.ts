import { logger } from '@navikt/navno-logger';
import { z } from 'zod';

const schema = z.object({
	// Texas, NAIS's token service. NAIS injects both for idporten and azure.application
	NAIS_TOKEN_INTROSPECTION_ENDPOINT: z.url(),
	NAIS_TOKEN_ENDPOINT: z.url(),
	// PDL's GraphQL API, without the /graphql path
	PDL_ORIGIN: z.url(),
	// The audience of PDL's tokens, e.g. api://dev-fss.pdl.pdl-api/.default
	PDL_TOKEN_TARGET: z.string().min(1),
	// The secret the user keys in /identity are made with (identity/userKey.ts), from the Nais secret
	// nav-dekoratoren-auth. Without it the app has no /identity.
	USER_KEY_SECRET: z.string().min(32).optional(),
	// How many names a pod keeps, and for how long. A name takes about 220 bytes, so 100,000 take about 21 MB.
	NAME_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(100_000),
	NAME_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
	PORT: z.coerce.number().int().positive().default(3004),
});

export const parseEnv = (source: Record<string, string | undefined>) => {
	const parsed = schema.safeParse(source);

	if (!parsed.success) {
		throw new Error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
	}

	return parsed.data;
};

const readEnv = () => {
	try {
		return parseEnv(process.env);
	} catch (e) {
		// It happens while the server's modules load, before main.ts runs. Logged and exited here, since Node would
		// print a thrown error as plain text.
		logger.error('Server failed to start', e);
		return process.exit(1);
	}
};

// Read when the server starts, so a misconfigured pod crashes before it takes traffic
export const env = readEnv();
