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

export const nameOf = async (ident: string): Promise<string> => {
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

	return name ?? '';
};
