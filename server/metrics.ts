import { Counter, Gauge, Registry } from '@prometheus-io/client';

export const metricsRegistry = new Registry();

export const endpoints = ['auth', 'summary', 'identity'] as const;
export type Endpoint = (typeof endpoints)[number];

// What a request turned out to be
// authenticated  - a token Texas vouches for, with a fødselsnummer and a level we know
// anonymous      - no token: nobody is logged in
// invalid_token  - a token Texas doesn't vouch for (expired, wrong audience, not a token)
// unusable_token - a token Texas vouches for, but without a fødselsnummer or with a level we don't know
// error          - Texas couldn't say (5xx)
export const outcomes = ['authenticated', 'anonymous', 'invalid_token', 'unusable_token', 'error'] as const;
export type Outcome = (typeof outcomes)[number];

const requestsCounter = new Counter({
	name: 'nav_dekoratoren_auth_requests_total',
	help: 'Requests answered, by endpoint and by what the request turned out to be',
	labelNames: ['endpoint', 'outcome'] as const,
	registers: [metricsRegistry],
});

// Initialize all label combinations to 0, so rate()/increase() work from the first scrape
for (const endpoint of endpoints) {
	for (const outcome of outcomes) {
		requestsCounter.inc({ endpoint, outcome }, 0);
	}
}

export const countRequest = (endpoint: Endpoint, outcome: Outcome) => {
	requestsCounter.inc({ endpoint, outcome });
};

// Where a logged-in user's name came from
// cached  - this pod had it
// shared  - another request for the same user was already asking PDL, and this one waited for its answer
// found   - PDL had it
// missing - PDL answered, without a name for the user
// failed  - PDL or its token failed, or took too long
export const nameSources = ['cached', 'shared', 'found', 'missing', 'failed'] as const;
export type NameSource = (typeof nameSources)[number];

const namesCounter = new Counter({
	name: 'nav_dekoratoren_auth_names_total',
	help: "Names looked up for /auth and /identity, by where the name came from. found, missing and failed are requests to PDL; cached and shared aren't",
	labelNames: ['source'] as const,
	registers: [metricsRegistry],
});

for (const source of nameSources) {
	namesCounter.inc({ source }, 0);
}

export const countName = (source: NameSource) => {
	namesCounter.inc({ source });
};

const nameCacheEntriesGauge = new Gauge({
	name: 'nav_dekoratoren_auth_name_cache_entries',
	help: 'Names this pod keeps, counting the ones that have expired and not yet made room for a new one, and the lookups in progress',
	registers: [metricsRegistry],
});

const nameCacheEvictionsCounter = new Counter({
	name: 'nav_dekoratoren_auth_name_cache_evictions_total',
	help: 'Names dropped before they expired, to make room for a new one. More than a few means the cache is too small',
	registers: [metricsRegistry],
});

nameCacheEvictionsCounter.inc(0);

export const recordNameCacheEntries = (entries: number) => {
	nameCacheEntriesGauge.set(entries);
};

export const countNameCacheEviction = () => {
	nameCacheEvictionsCounter.inc();
};

// PDL GraphQL error-codes.
const pdlErrorCodes = new Set(['unauthenticated', 'unauthorized', 'not_found', 'bad_request', 'server_error']);

const pdlErrorsCounter = new Counter({
	name: 'nav_dekoratoren_auth_pdl_errors_total',
	help: "GraphQL errors in PDL's answers, by PDL's error code. PDL reports some failures on HTTP 200",
	labelNames: ['code'] as const,
	registers: [metricsRegistry],
});

for (const code of [...pdlErrorCodes, 'other']) {
	pdlErrorsCounter.inc({ code }, 0);
}

export const recordPdlErrors = (codes: string[]) => {
	for (const code of codes) {
		pdlErrorsCounter.inc({ code: pdlErrorCodes.has(code) ? code : 'other' });
	}
};
