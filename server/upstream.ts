import { createUpstreamClient } from '@navikt/navno-server/upstream';
import { metricsRegistry } from './metrics.ts';

// Makes a corgi client for one upstream, with a timeout, counted and timed in the app's metrics under its name
export const upstreamClient = createUpstreamClient({ registry: metricsRegistry, prefix: 'nav_dekoratoren_auth_' });
