# nav-dekoratoren-auth

A Hono app (Node.js, TypeScript) that answers who is logged in on nav.no. Dekoratøren's server asks it for every page
view, inside the cluster. No browser calls it.

The app takes over the login part of [nav-dekoratoren-api](https://github.com/navikt/nav-dekoratoren-api) (Kotlin/Ktor)
for dekoratøren. The answers are the same, byte for byte, except for the differences listed under
[Differences from nav-dekoratoren-api](#differences-from-nav-dekoratoren-api).

## Endpoints

| Route                                      | Response                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /navno/nav-dekoratoren-auth/auth`     | `{"authenticated":false}`, or `{"authenticated":true,"name":"Kari Hansen","securityLevel":"4","userId":"<fødselsnummer>"}`                              |
| `GET /navno/nav-dekoratoren-auth/summary`  | `{"authenticated":false}`, or `{"authenticated":true,"authLevel":4,"oidc":{"authLevel":4,"issueTime":"…","expiryTime":"…"}}`                            |
| `GET /navno/nav-dekoratoren-auth/identity` | `{"authenticated":false}`, or `{"authenticated":true,"name":"Kari Hansen","securityLevel":"4","userKey":"…"}`: like `/auth`, without the fødselsnummer. |

Everything is under `/navno/nav-dekoratoren-auth` (`OWN_PATH` in `server/app.ts`). Dekoratøren calls it on
`http://nav-dekoratoren-auth.navno/navno/nav-dekoratoren-auth` and passes the user's cookies on.

The app has an ingress on the same path (`.nais/vars-*.yml`), which nobody needs to call. It is there because Nais
won't deploy the login proxy without one (`idporten sidecar requires at least 1 ingress`). It is internal
(`nav-dekoratoren-auth.intern.dev.nav.no` and `nav-dekoratoren-auth.intern.nav.no`), so only naisdevice reaches it,
and the app is not on the internet. The login proxy reads the session from the cookie whatever the host, so calls
inside the cluster work without the ingress. `test/nais.test.ts` checks that the ingress has the app's path and is
internal. `/internal` is outside the path, and so can't be reached through the ingress.

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

## Rollback

[Roll back prod](https://github.com/navikt/nav-dekoratoren-auth/actions/workflows/rollback.prod.yml) -> Run workflow.
Without a release tag it rolls back to the release before the newest; give a tag to go further back.

The next push to main deploys main again, and so does the next "Refresh base image" (Sunday evening), so revert or fix
on main before anything else is merged.

## Questions

Questions about the code or the project can be directed to https://github.com/orgs/navikt/teams/navno

## For Nav employees

Internal questions can be sent on Slack in the channel #team-navno.
