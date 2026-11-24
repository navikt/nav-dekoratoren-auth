import { LRUCache } from 'lru-cache';
import { env } from '../env.ts';
import { countName, countNameCacheEviction, recordNameCacheEntries } from '../metrics.ts';
import { lookupName } from './pdl.ts';

/* Name cache */
const names: LRUCache<string, string> = new LRUCache<string, string>({
	max: env.NAME_CACHE_MAX_ENTRIES,
	ttl: env.NAME_CACHE_TTL_SECONDS * 1000,
	// Intentionally a function so it can be faked in tests
	perf: { now: () => performance.now() },
	// What to do when we don't have a cache hit for the name
	fetchMethod: async (ident) => {
		const answer = await lookupName(ident);
		countName(answer.result);
		return answer.result === 'found' ? answer.name : undefined;
	},
	dispose: (_name, ident, reason) => {
		if (reason === 'evict' && names.getRemainingTTL(ident) > 0) {
			countNameCacheEviction();
		}
	},
});

/**
 * The name of the person with the fødselsnummer `ident`, or `fallback` when PDL has no name to give (an error, a
 * timeout or an unknown person). The fallback is never cached: the next request asks PDL again. A name PDL has with
 * every part missing is found, and empty, not the fallback.
 */
export const nameOf = async (ident: string, fallback: string): Promise<string> => {
	const status: LRUCache.Status<string, string> = {};
	const name = await names.fetch(ident, { status });

	if (status.fetch === 'hit') {
		countName('cached');
	} else {
		if (status.fetch === 'inflight') {
			countName('shared');
		}
		recordNameCacheEntries(names.size);
	}

	return name ?? fallback;
};
