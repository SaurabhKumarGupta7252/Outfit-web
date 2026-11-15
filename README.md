# Outfit API

Express backend for the AI Outfit Changer app: PostgreSQL, custom JWT auth (guest, email/password, Google), credit wallet with an immutable ledger, clothing catalog, and Cloudinary image storage.

## Status

| Area | State |
| --- | --- |
| Guest sessions, email/password, Google sign-in, refresh tokens, password reset | Implemented |
| Device installations and one-time 25 free credits | Implemented |
| Guest-to-account linking with balance transfer | Implemented |
| Wallet, transaction history, usage | Implemented |
| Categories, templates, store products, profile, admin catalog | Implemented |
| Image upload for guests and users (private Cloudinary storage) | Implemented |
| Magic Hour clothes changer, 2-credit reservation, exact-once refund, result storage | Implemented (polling; no webhook) |
| Google Play purchase verification, RTDN webhook, Play Integrity | Not yet |
| Account deletion, OpenAPI document, automated tests | Not yet |
| Password reset email delivery | Token flow works; no email provider wired (token is logged in development only) |

## Local setup

```sh
docker compose up -d          # PostgreSQL 16 on localhost:5432 (databases outfit_dev and outfit_test)
cp .env.example .env          # then fill in the secrets
npm install
npm run db:migrate
npm run dev
```

Without Docker, create the databases yourself and point `DATABASE_URL` at them:

```sh
createuser outfit --pwprompt && createdb outfit_dev -O outfit && createdb outfit_test -O outfit
```

Generate `AUTH_TOKEN_SECRET` with `openssl rand -base64 48`. Make an account an admin with `npm run make-admin -- you@example.com`.

Migrations in `drizzle/` are hand-written SQL from `0002` onwards (they contain PL/pgSQL). Add new ones as a new numbered file plus an entry in `drizzle/meta/_journal.json`; do not run `drizzle-kit generate`.

## Response format

```json
{ "success": true, "data": { }, "meta": { "page": 1, "limit": 20, "total": 0, "totalPages": 1 } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [] } }
```

Send `Authorization: Bearer <accessToken>`. Access tokens last 15 minutes. Registered users renew with `POST /auth/refresh`; guests renew by calling `POST /auth/guest` again.

## Endpoints (`/api/v1`)

| Method and path | Who | Purpose |
| --- | --- | --- |
| `POST /auth/guest` | public | Create or resume the guest session for an installation; grants free credits once |
| `POST /auth/signup`, `POST /auth/login`, `POST /auth/google` | public | Sign in; pass `guest: { installationUuid, guestSecret }` to link the guest wallet in the same call |
| `POST /auth/refresh` | public | Rotate the refresh token |
| `POST /auth/merge-guest` | user | Link the guest wallet after sign-in |
| `POST /auth/logout`, `GET /auth/me` | user / any | End a session; current identity and wallet |
| `POST /auth/forgot-password`, `POST /auth/reset-password` | public | Password recovery |
| `POST /devices/register`, `GET /devices/current`, `GET /devices/eligibility`, `POST /devices/attest` | mixed | Installation tracking (`attest` is a placeholder until Play Integrity is added) |
| `GET /wallet`, `/wallet/transactions`, `/wallet/usage`, `/wallet/eligibility`, `POST /wallet/claim-free` | any | Balance and ledger |
| `GET /categories`, `/categories/:id`, `/categories/:id/templates` | public | Catalog |
| `GET /templates`, `/templates/:id` | public | Catalog (`categoryId`, `featured`, `garmentType`, `search`, `page`, `limit`) |
| `GET /store/products`, `/store/config` | public | Credit packs and payment configuration |
| `GET /profile`, `PATCH /profile`, `GET /profile/stats` | user | Profile |
| `POST/PATCH /admin/categories`, `GET/POST/PATCH/DELETE /admin/templates`, `GET /admin/wallets` | admin | Management |
| `POST /users` | public | Original registration endpoint; same as `/auth/signup` |
| `POST /images/upload`, `GET /images`, `GET /images/:id`, `GET /images/:id/content`, `DELETE /images/:id` | any | Photo upload (form field `image`, JPEG/PNG/WebP, max 10 MB) and owner-only access |
| `POST /generations`, `GET /generations`, `GET /generations/:id`, `GET /generations/:id/status`, `POST /generations/:id/retry` | any | Outfit generation. `POST` needs an `Idempotency-Key` header |
| `GET /admin/generations` | admin | All generations with provider details |

## Credit rules implemented so far

- An installation is identified by `installationUuid` plus a `guestSecret`, both generated once by the app and kept in secure storage. The secret is stored only as a hash.
- The 25 free credits are granted once per installation, inside `fn_grant_free_credits`, which locks the installation row. Logging out, registering or creating a second account on the same installation never grants again.
- Eligibility is decided in `src/services/device-eligibility.js`: not already claimed, device not flagged, and at most `maxGrantsPerIpPerDay` grants (default 3) for installations first seen from the same network in 24 hours. A reinstall produces a new UUID, so this is a limit, not a guarantee; Play Integrity plugs in here later.
- Linking a guest to an account (`fn_merge_guest_into_user`) moves the guest balance to the account. Each guest session can be linked once, and each account can receive a guest's free credits once, so reinstalling and signing in again does not add credits.
- Every balance change writes a row to `credit_transactions` with a unique idempotency key. Rows cannot be updated or deleted (database trigger). Balances cannot go negative (check constraints).

## Generation flow

1. `POST /images/upload` stores the photo privately and returns its `id`.
2. `POST /generations` with `{ "templateId", "imageId" }` and an `Idempotency-Key` header. In one database call (`fn_reserve_generation`) the server checks the balance, takes 2 credits (free credits first) and creates the generation as `RESERVED`. The same key always returns the same generation and never charges again. Not enough credits returns `402 INSUFFICIENT_CREDITS`.
3. In the background the server uploads the photo and the template's garment image to Magic Hour (`POST /v1/files/upload-urls` then `PUT`), calls `POST /v1/ai-clothes-changer`, stores the returned project id and moves to `SUBMITTED`.
4. A worker polls `GET /v1/image-projects/{id}` every few seconds: `rendering` becomes `PROCESSING`; `complete` copies the result into private storage and marks `COMPLETED`; `error`, `canceled` or a 10-minute timeout refunds the credits once (`fn_refund_generation`) and ends as `REFUNDED`.
5. The app polls `GET /generations/:id/status` until `isFinal` is true, then loads `output.contentUrl` with the bearer token (or `output.signedUrl` from `GET /generations/:id`).

Notes:

- A template can be generated only when its `garmentImagePath` is set to an `https` image URL (admin API).
- The Magic Hour create call is never repeated automatically. If it times out, the user is refunded and the job is named `generation-<id>` so it can be matched in the Magic Hour dashboard.
- Provider credits are read from Magic Hour's response (`credits_charged`) and stored per generation; nothing about provider pricing is hard-coded.
- The worker runs inside the API process. All state is in the database, so a restart resumes open jobs from their stored project id.
- Magic Hour also offers webhooks; they are not used yet because polling is still needed to detect cancelled jobs and works on a local machine.
