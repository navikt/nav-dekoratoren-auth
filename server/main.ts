import { serve } from '@navikt/navno-server';
import { createApp } from './app.ts';
import { env } from './env.ts';

serve(createApp(), { port: env.PORT });
