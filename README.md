# nav-dekoratoren-auth

A Hono app (Node.js, TypeScript) that answers who is logged in on nav.no. Dekoratøren's server asks it for every page
view, inside the cluster. No browser calls it.

The app takes over the login part of [nav-dekoratoren-api](https://github.com/navikt/nav-dekoratoren-api) (Kotlin/Ktor)
for dekoratøren. The answers are the same, byte for byte, except for the differences listed under
[Differences from nav-dekoratoren-api](#differences-from-nav-dekoratoren-api).

## Endpoints

| Route                                      | Answer                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /navno/nav-dekoratoren-auth/auth`     | `{"authenticated":false}`, or `{"authenticated":true,"name":"Kari Hansen","securityLevel":"4","userId":"<fødselsnummer>"}`                                                                 |
| `GET /navno/nav-dekoratoren-auth/summary`  | `{"authenticated":false}`, or `{"authenticated":true,"authLevel":4,"oidc":{"authLevel":4,"issueTime":"…","expiryTime":"…"}}`                                                               |
| `GET /navno/nav-dekoratoren-auth/identity` | `{"authenticated":false}`, or `{"authenticated":true,"name":"Kari Hansen","securityLevel":"4","userKey":"…"}`: like `/auth`, without the fødselsnummer. Only when `USER_KEY_SECRET` is set |

Everything is under `/navno/nav-dekoratoren-auth` (`OWN_PATH` in `server/app.ts`). Dekoratøren calls it on
`http://nav-dekoratoren-auth.navno/navno/nav-dekoratoren-auth` and passes the user's cookies on.

The app has an ingress on the same path (`.nais/vars-*.yml`), which nobody needs to call. It is there because Nais
won't deploy the login proxy without one (`idporten sidecar requires at least 1 ingress`). `test/nais.test.ts` checks
that the ingress has the app's path. `/internal` is outside the path, and so can't be reached through the ingress.

The app sends no CORS headers. A page on another origin than the ingress's can't read an answer from it.

## How it works

1. ID-porten's login proxy (a sidecar, `idporten.sidecar` in `.nais/config.yml`) turns a logged-in user's session
   cookie into `Authorization: Bearer <token>`. A request without a session passes through without a token.
2. Without a token the app answers that nobody is logged in, without asking anyone.
3. With a token the app asks Texas (`NAIS_TOKEN_INTROSPECTION_ENDPOINT`) whether the token holds. Texas checks the
   signature, issuer, audience and time. The app itself checks that the token has a fødselsnummer (`pid`) and a level it
   knows (`acr`).
4. `/auth` gets the name from PDL, with the app's own token from Texas (`NAIS_TOKEN_ENDPOINT`). `/summary` never asks
   PDL.

When Texas can't answer, the app answers 500. That is not the same as nobody being logged in, and must not look like it.

### The name cache

The names are kept in memory in each pod, in an [lru-cache](https://github.com/isaacs/node-lru-cache)
(`server/names/names.ts`):

- A name is kept for 30 minutes (`NAME_CACHE_TTL_SECONDS`), and a pod has room for 100,000
  (`NAME_CACHE_MAX_ENTRIES`, measured at about 21 MB). When it is full, the name that was used longest ago goes.
- When several requests for the same user arrive at once, they wait for one and the same lookup.
- A lookup gets 2 seconds, including the token for PDL and a second try if there is one.
- When PDL has no name to give (an error, a timeout or an unknown person), the name is empty, and nothing is cached.
  The next request asks PDL again. During a PDL outage that means one call to PDL for every request from a logged-in
  user whose name the pod doesn't have.
- Nothing blocks: a slow PDL holds up those who are waiting for PDL, and nobody else. A cache hit waits for nothing.

A new pod starts with an empty cache and asks PDL for everyone it sees. The cache isn't shared between the pods, so
more pods mean more calls to PDL. `nav_dekoratoren_auth_names_total` shows the split.

## Development

### Installing pnpm

This project uses **pnpm** as its package manager. Node.js no longer comes with Corepack (from Node 25), so install
pnpm yourself, for example like this:

```bash
npm install --global pnpm
```

See https://pnpm.io/installation for other ways. pnpm reads the `packageManager` field in `package.json` and switches
to the right version automatically.

### Running locally

Install the dependencies (the `@navikt` packages come from GitHub Packages, so npm must be logged in to
`npm.pkg.github.com`):

```bash
pnpm install
```

Run it locally (Node runs the TypeScript code directly, without a build):

```bash
pnpm run dev
```

The app reads `.env.development`, and `test/mocks/dev.ts` answers for Texas and PDL, so you don't need naisdevice.
Locally the token is the user: a token of eleven digits is a logged-in user with that fødselsnummer.

```bash
curl -H 'Authorization: Bearer 10000000001' localhost:3004/navno/nav-dekoratoren-auth/auth
```

PDL knows everyone as Kari Hansen, except those whose fødselsnummer starts with 9.

### Linting, formatting and git hooks

`pnpm run lint` runs oxfmt (check), oxlint and `tsc`. `pnpm run format` formats.

The git hooks are set up by [lefthook](https://lefthook.dev) when you run `pnpm install` (`lefthook.yml`): before a
commit the staged files are fixed and formatted, and TypeScript is checked; before a push the tests run.

### Tests

`pnpm run test` runs Vitest. Each test starts a fresh copy of the app on a free port (`test/app.ts`) and asks it over
HTTP. Texas and PDL are answered by corgi's `mockFetch` (`test/fetch.ts`, `test/fixtures.ts`). All the tests are in
`test/`, in the same folders as the code they test has in `server/`.

## Environment variables

`server/env.ts` checks them with zod when the server starts, so a pod with a missing or invalid variable stops before
it gets traffic.

| Variable                            | From                   |                                                                                                                  |
| ----------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `NAIS_TOKEN_INTROSPECTION_ENDPOINT` | NAIS                   | Texas, for the token on the request                                                                              |
| `NAIS_TOKEN_ENDPOINT`               | NAIS                   | Texas, for the app's own token to PDL                                                                            |
| `PDL_ORIGIN`                        | `.nais/vars-*.yml`     | PDL without `/graphql`                                                                                           |
| `PDL_TOKEN_TARGET`                  | `.nais/vars-*.yml`     | The audience of the token to PDL, e.g. `api://prod-fss.pdl.pdl-api/.default`                                     |
| `USER_KEY_SECRET`                   | (optional) Nais secret | The secret the `userKey` in `/identity` is made with, at least 32 characters. Without it there is no `/identity` |
| `NAME_CACHE_MAX_ENTRIES`            | (optional, 100,000)    | How many names a pod keeps                                                                                       |
| `NAME_CACHE_TTL_SECONDS`            | (optional, 1800)       | How long a name is kept                                                                                          |
| `PORT`                              | (optional, 3004)       |                                                                                                                  |

The only secret is `USER_KEY_SECRET`, and the app starts without it.

## Metrics

`server/metrics.ts`, on `/internal/metrics`. Never a fødselsnummer or anything else about the user as a label.

| Metric                                                   | Type      | Labels                                                                                                     |
| -------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `nav_dekoratoren_auth_requests_total`                    | counter   | `endpoint` = auth/summary/identity, `outcome` = authenticated/anonymous/invalid_token/unusable_token/error |
| `nav_dekoratoren_auth_names_total`                       | counter   | `source` = cached/shared/found/missing/failed                                                              |
| `nav_dekoratoren_auth_name_cache_entries`                | gauge     | –                                                                                                          |
| `nav_dekoratoren_auth_name_cache_evictions_total`        | counter   | – (names that had to go before their time; more than a few means the cache is too small)                   |
| `nav_dekoratoren_auth_upstream_requests_total`           | counter   | `upstream` = texas_introspect/texas_token/pdl, `status` = 2xx/4xx/5xx/…, timeout, network_error            |
| `nav_dekoratoren_auth_upstream_request_duration_seconds` | histogram | `upstream`                                                                                                 |
| `nav_dekoratoren_auth_pdl_errors_total`                  | counter   | `code` = PDL's GraphQL error code, or other                                                                |

The share of cache hits is `cached / (cached + shared + found + missing + failed)`.

The alerts are in `.nais/alerts.yml` and are only deployed to prod.

## Logging

Log with `logger` from `@navikt/navno-logger`, never `console`. Keep the message fixed and put the values in fields.
Fødselsnummer, names, tokens and what PDL answers about a person are never logged.

## Deploy to dev

[Actions](https://github.com/navikt/nav-dekoratoren-auth/actions) -> Deploy to dev -> Run workflow -> Choose branch -> Run workflow

## Deploy to prod

Make a PR to main, and merge it after approval (a release is made automatically on deploy to main).

## Rollback

[Roll back prod](https://github.com/navikt/nav-dekoratoren-auth/actions/workflows/rollback.prod.yml) -> Run workflow.
Without a release tag it rolls back to the release before the newest; give a tag to go further back.

The next push to main deploys main again, and so does the next "Refresh base image" (Sunday evening), so revert or fix
on main before anything else is merged.

## The split of `/auth` in dekoratøren

The plan for dekoratøren splits its own `/auth` in two (phase 7): `/api/v2/identity` for who is logged in, and
`/api/v2/notifications` for the notifications. This app is built for that split:

| In the plan                         | Here                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notifications                       | Not here, and never were: dekoratøren gets them from tms-varsel-api. The varsel proxy in nav-dekoratoren-api was the old connection, and it is deleted                                |
| Identity                            | `GET /identity` answers with the `identity` part of `IdentityPayload`, as the plan has it. Dekoratøren's `/api/v2/identity` can pass the answer on and add `contract` and `versionId` |
| `userKey` instead of `userId` (D15) | Made here (`server/identity/userKey.ts`), exactly as the plan describes: base64url(HMAC-SHA256(secret, fødselsnummer)), 22 characters                                                 |
| v1 `/auth`, for older clients       | `GET /auth`, unchanged and with `userId`. It stays for as long as anyone calls it                                                                                                     |
| A failure is not "logged out" (G43) | When Texas can't answer, the answer is 500 from all three routes, never `authenticated: false`                                                                                        |

In one place this differs from the plan: there `userKey` is made in dekoratøren, from the `userId` this app gives it.
Here it is made at the source. Then the fødselsnummer goes no further than this app, and dekoratøren needs no secret.

`/identity` is off in the cluster until the secret exists:

1. Create the secret `nav-dekoratoren-auth` in Nais console, with `USER_KEY_SECRET` (e.g. `openssl rand -base64 48`).
2. Set `userKeySecret: nav-dekoratoren-auth` in `.nais/vars-dev.yml` or `.nais/vars-prod.yml`.

Change the secret only if it has leaked. Every user then gets a new key, and pages with `redirectOnUserChange` take
that as a change of user.

## Differences from nav-dekoratoren-api

The Kotlin app's behaviour was recorded as golden files (128 cases) before the rewrite, and this app answers the same
on everything but this:

| What                                                  | nav-dekoratoren-api                                                                                       | nav-dekoratoren-auth                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 64 name lookups in progress at once in one pod        | The pod stops answering, also to those who aren't logged in, and doesn't recover. The probes still answer | Each request waits only for its own lookup                          |
| The paths                                             | `/person/nav-dekoratoren-api` and `/person/innloggingsstatus`                                             | `/navno/nav-dekoratoren-auth` only. The old paths are 404           |
| CORS                                                  | Pages on `*.nav.no` may call with cookies. Any other origin gets 403                                      | None: no CORS headers, no 403, and a preflight gets 405             |
| PDL has no name to give                               | The fødselsnummer as `name`, cached for 30 minutes                                                        | `name: ""`, and nothing is cached                                   |
| A valid token without `pid`, or with an unknown `acr` | `/auth`: 404 without a body. `/summary`: 500                                                              | `{"authenticated":false}` from both, and a warning in the log       |
| Who validates the token                               | The app itself (token-support), which also requires `sub` and `iat`                                       | Texas. A token that isn't a JWT is no longer logged as a warning    |
| Probes and metrics                                    | Under `/person/nav-dekoratoren-api/internal`, so open on the ingress                                      | Under `/internal`. There is no `ping` or `selftest`                 |
| The varsel proxy and `POST /consent`                  | Existed                                                                                                   | 404                                                                 |
| Methods other than GET                                | 405 without `Allow`, for HEAD too                                                                         | 405 with `Allow: GET, HEAD`. HEAD is answered as GET without a body |
| `Accept` without JSON, e.g. only `text/html`          | 406                                                                                                       | JSON regardless                                                     |
| A doubled slash in the path                           | Answered as if it were single                                                                             | 404                                                                 |
| A character outside the BMP in a name (e.g. an emoji) | Written as two `\u` escapes                                                                               | Written as the character. The same JSON                             |
| `Cache-Control`                                       | None                                                                                                      | `no-store` on `/auth` and `/summary`                                |
| `Nav-Consumer-Id` to PDL                              | `nav-dekoratoren-api`                                                                                     | `nav-dekoratoren-auth`                                              |

The first row was measured locally, with one process of each app and a PDL that took from 0.1 to 1.5 seconds to
answer. How often it happens in prod isn't known.

## The move from nav-dekoratoren-api

The goal is to delete the Kotlin app. This app takes over the only part of it that dekoratøren uses. Five other apps
call the Kotlin app's `/auth` from the browser, and this app doesn't serve them: it has neither the old paths nor
CORS. The Kotlin app can't be deleted until they ask somewhere else (step 5). Nothing else needs a new home.

### What happens to each part of nav-dekoratoren-api

| Part                                                                     | What we know (18 November 2026)                                                                                                                                                | What we do                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `GET /auth`                                                              | Everything that calls the app calls this route (the list below)                                                                                                                | Taken over here for dekoratøren. The browser callers stay on the Kotlin app until they have moved (step 5)       |
| `GET /summary`                                                           | No code in the navikt organisation calls it                                                                                                                                    | Taken over here, since it is small. To be removed when the counter for `endpoint="summary"` has stood still      |
| The path `/person/innloggingsstatus`                                     | No code in the navikt organisation mentions it                                                                                                                                 | Not taken over. It goes away with the Kotlin app, once the ingress log shows that nobody uses it                 |
| The varsel proxy (five routes)                                           | Forwards to tms-varselbjelle-api, which is archived and was last changed in March 2023. Dekoratøren has fetched notifications straight from tms-varsel-api since November 2023 | Deleted. Nothing to move                                                                                         |
| `POST /consent`                                                          | Added for the cookie banner on 31 January 2025. It logged the consent and sent it nowhere. Dekoratøren stopped calling it on 12 February 2026 (Umami instead)                  | Deleted. Nothing to move                                                                                         |
| `ping`, `selftest` and the probes under the public path                  | For operations only                                                                                                                                                            | Deleted. `/auth` without a token answers 200, and can be used by anyone who wants to check that the app is alive |
| The HPA, the alerts, `nav-dekoratoren-api-secret`, the GitHub repository | Resources of their own, which don't go away by themselves when the app is deleted                                                                                              | Deleted and archived in the last step                                                                            |

Who calls `/auth`, according to a search of navikt's public repositories:

- **nav-dekoratoren**, from its server, on `http://nav-dekoratoren-api.navno`. It moves to this app (step 3).
- **nav-enonicxp-frontend**, **tilbakemeldinger**, **melosys-skjema-web**, **sosialhjelp-innsyn** and
  **sosialhjelp-soknad**, from the browser, on `https://www.nav.no/person/nav-dekoratoren-api/auth`. They stay on the
  Kotlin app until they have moved (step 5).
- The tests in sif-brukerdialog, amt-deltaker-flate and melosys-e2e-tests mock the same address.

The search only sees public repositories, so the traffic in Prometheus is what settles it (step 4).

### The order

1. **PDL must know the app.** `nav-dekoratoren-auth` has to be in `accessPolicy.inbound` at pdl-api (dev-fss and
   prod-fss), as nav-dekoratoren-api is today. Without it every logged-in user is without a name, and
   `NavDekoratorenAuthPdlRejectingRequests` fires.
2. **Deploy, and try it in dev.** Log in, and open `https://www.ekstern.dev.nav.no/navno/nav-dekoratoren-auth/auth` in
   the same browser. That is the first time the app meets the real login proxy, Texas and PDL.
3. **Dekoratøren.** Set `DEKORATOREN_API_URL` to `http://nav-dekoratoren-auth.navno/navno/nav-dekoratoren-auth` in all
   five `.nais/vars/*.yml`, and add `nav-dekoratoren-auth` to `accessPolicy.outbound` in all four `.nais/config*.yml`.
   If one of them is missed, those pods can't reach the app, and everyone looks logged out. Dekoratøren has called the
   Kotlin app this way all along, but the login proxy turning a cookie into a token on a call from inside the cluster
   is not tested for this app before this step, so do dev first.
4. **See who still uses the Kotlin app.** Per route:
   `sum by (route) (increase(ktor_http_server_requests_seconds_count{app="nav-dekoratoren-api"}[30d]))`.
   Expected: only `/auth`, and once step 3 is 168 hours old, only from browsers. If there is traffic on the varsel
   routes or `/consent`, find out who it is before step 7. Also check whether tms-varselbjelle-api still runs in
   `min-side`. If it doesn't, the varsel routes only answer errors.
5. **Move the browser callers.** Not decided, and the Kotlin app stays until it is done. Two ways:
   - They ask dekoratøren's own `/auth` (`https://www.nav.no/dekoratoren/auth`), which already answers pages on
     `*.nav.no` with cookies. Its answer has another shape (`{ auth, usermenuHtml }`), so each of the five has to
     change its code.
   - CORS and the two old paths come back here (they are in the git history, with their tests), and the Kotlin app's
     two ingresses are moved to this app. Then no caller has to change.
6. **Wait 168 hours after step 3 reached prod.** That is how long the pods with older versions of dekoratøren live
   (`ttlInternal`), and they still call the Kotlin app. If it is deleted before that, everyone looks logged out on
   pages that have an older version.
7. **Delete nav-dekoratoren-api.** Archive the repository first: otherwise "Refresh base image" deploys the app to prod
   again every Sunday evening. Then delete the app in dev-gcp and prod-gcp, the HPA `nav-dekoratoren-api` in both, the
   PrometheusRule `nav-dekoratoren-api-alert` in prod, and `nav-dekoratoren-api-secret` in both.
8. **Clean up afterwards.** Ask for `nav-dekoratoren-api` to be removed from `accessPolicy.inbound` at pdl-api. Tell
   melosys that their rule for `nav-dekoratoren-api` in `personbruker` no longer points at anything.

## Questions

Questions about the code or the project can be directed to https://github.com/orgs/navikt/teams/navno

## For Nav employees

Internal questions can be sent on Slack in the channel #team-navno.
