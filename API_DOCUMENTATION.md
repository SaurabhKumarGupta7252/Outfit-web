# Outfit API: endpoints with curl

Every endpoint the server currently has. Not yet built: Google Play purchases, webhooks, account deletion.

## Setup

```sh
BASE=http://localhost:3000/api/v1
TOKEN=paste_access_token_here          # guest or user token
ADMIN_TOKEN=paste_admin_access_token   # token of an account made admin with: npm run make-admin -- email
```

- **Auth header:** `Authorization: Bearer <accessToken>`. Tokens last 15 minutes (`ACCESS_TOKEN_TTL_SECONDS`).
- **Who can call:** *public* needs no token, *any* accepts a guest or user token, *user* needs a registered account, *admin* needs an admin account.
- **Success:** `{ "success": true, "data": { ... }, "meta": { "page", "limit", "total", "totalPages" } }` (`meta` only on lists).
- **Failure:** `{ "success": false, "error": { "code", "message", "details" } }`.
- **Lists** accept `?page=1&limit=20` (limit max 100).

## Health (no `/api/v1` prefix)

```sh
curl http://localhost:3000/health     # server is running
curl http://localhost:3000/ready      # database is reachable
```

## Auth

### Guest session: `POST /auth/guest` (public)
Creates or resumes the guest for an installation and grants 25 credits once. Call it again to get a fresh guest token.

```sh
curl -X POST $BASE/auth/guest -H 'Content-Type: application/json' -d '{
  "installationUuid": "11111111-1111-4111-8111-111111111111",
  "guestSecret": "this-is-a-test-secret-of-32-chars-min",
  "platform": "android",
  "appVersion": "1.0.0",
  "deviceModel": "Pixel 8"
}'
```
`platform`, `appVersion`, `deviceModel` are optional.

### Sign up: `POST /auth/signup` (public)
The optional `guest` block links the guest wallet to the new account in the same call.

```sh
curl -X POST $BASE/auth/signup -H 'Content-Type: application/json' -d '{
  "email": "test@example.com",
  "password": "a-long-password",
  "displayName": "Test User",
  "guest": {
    "installationUuid": "11111111-1111-4111-8111-111111111111",
    "guestSecret": "this-is-a-test-secret-of-32-chars-min"
  }
}'
```

### Log in: `POST /auth/login` (public)

```sh
curl -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{
  "email": "test@example.com",
  "password": "a-long-password"
}'
```
Accepts the same optional `guest` block as sign up.

### Google sign-in: `POST /auth/google` (public)
`idToken` is the Google ID token from native Google Sign-In. Needs `GOOGLE_OAUTH_CLIENT_IDS` in `.env`.

```sh
curl -X POST $BASE/auth/google -H 'Content-Type: application/json' -d '{
  "idToken": "GOOGLE_ID_TOKEN",
  "guest": {
    "installationUuid": "11111111-1111-4111-8111-111111111111",
    "guestSecret": "this-is-a-test-secret-of-32-chars-min"
  }
}'
```

### Refresh: `POST /auth/refresh` (public)
Returns a new access token and a new refresh token. Each refresh token works once.

```sh
curl -X POST $BASE/auth/refresh -H 'Content-Type: application/json' -d '{
  "refreshToken": "REFRESH_TOKEN"
}'
```

### Link guest wallet: `POST /auth/merge-guest` (user)

```sh
curl -X POST $BASE/auth/merge-guest -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "installationUuid": "11111111-1111-4111-8111-111111111111",
  "guestSecret": "this-is-a-test-secret-of-32-chars-min"
}'
```

### Log out: `POST /auth/logout` (user)
Send the refresh token to end this session, or `"allDevices": true` to end all.

```sh
curl -X POST $BASE/auth/logout -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "refreshToken": "REFRESH_TOKEN"
}'
```

### Current identity: `GET /auth/me` (any)

```sh
curl $BASE/auth/me -H "Authorization: Bearer $TOKEN"
```

### Forgot password: `POST /auth/forgot-password` (public)
Always returns success. No email is sent yet; in development the token is in the server log.

```sh
curl -X POST $BASE/auth/forgot-password -H 'Content-Type: application/json' -d '{
  "email": "test@example.com"
}'
```

### Reset password: `POST /auth/reset-password` (public)

```sh
curl -X POST $BASE/auth/reset-password -H 'Content-Type: application/json' -d '{
  "token": "RESET_TOKEN_FROM_LOG",
  "newPassword": "another-long-password"
}'
```

### Original registration: `POST /users` (public)
Same as `/auth/signup`.

```sh
curl -X POST $BASE/users -H 'Content-Type: application/json' -d '{
  "email": "test2@example.com",
  "password": "a-long-password"
}'
```

## Devices

### Register installation: `POST /devices/register` (public)

```sh
curl -X POST $BASE/devices/register -H 'Content-Type: application/json' -d '{
  "installationUuid": "11111111-1111-4111-8111-111111111111",
  "guestSecret": "this-is-a-test-secret-of-32-chars-min",
  "platform": "android"
}'
```

### Current installation: `GET /devices/current` (any)

```sh
curl $BASE/devices/current -H "Authorization: Bearer $TOKEN"
```

### Free-credit eligibility of this installation: `GET /devices/eligibility` (any)

```sh
curl $BASE/devices/eligibility -H "Authorization: Bearer $TOKEN"
```

### Play Integrity attestation: `POST /devices/attest` (any)
Placeholder. Returns `NOT_CONFIGURED` until Play Integrity is added.

```sh
curl -X POST $BASE/devices/attest -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "integrityToken": "PLAY_INTEGRITY_TOKEN"
}'
```

## Wallet (any)

```sh
curl $BASE/wallet -H "Authorization: Bearer $TOKEN"                              # balance
curl "$BASE/wallet/transactions?page=1&limit=20" -H "Authorization: Bearer $TOKEN" # ledger
curl $BASE/wallet/usage -H "Authorization: Bearer $TOKEN"                        # totals used / granted / purchased / refunded
curl $BASE/wallet/eligibility -H "Authorization: Bearer $TOKEN"                  # can this guest still claim free credits
curl -X POST $BASE/wallet/claim-free -H "Authorization: Bearer $TOKEN"           # claim free credits (safe to repeat)
```

## Categories (public)

```sh
curl $BASE/categories
curl $BASE/categories/CATEGORY_ID
curl "$BASE/categories/CATEGORY_ID/templates?page=1&limit=20"
```

## Templates (public)

```sh
curl "$BASE/templates?page=1&limit=20"
curl "$BASE/templates?categoryId=CATEGORY_ID&featured=true&garmentType=upper_body&search=saree"
curl $BASE/templates/TEMPLATE_ID
```
All filters are optional. `garmentType` is `upper_body`, `lower_body` or `entire_outfit`.

## Store (public)

```sh
curl $BASE/store/products     # the five credit packs (product IDs and credits; prices come from Google Play)
curl $BASE/store/config       # generation cost, free credits, whether purchases are enabled
```

## Profile (user)

```sh
curl $BASE/profile -H "Authorization: Bearer $TOKEN"
curl $BASE/profile/stats -H "Authorization: Bearer $TOKEN"

curl -X PATCH $BASE/profile -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "displayName": "New Name",
  "avatarUrl": "https://example.com/avatar.jpg"
}'
```
Send either field or both. `avatarUrl` may be `null` to clear it.

## Images (any)

### Upload: `POST /images/upload`
Form field `image`. JPEG, PNG or WebP, max 10 MB. `POST /images` does the same.

```sh
curl -X POST $BASE/images/upload -H "Authorization: Bearer $TOKEN" -F 'image=@/path/to/person.jpg'
```

### List, details, bytes, delete

```sh
curl "$BASE/images?kind=upload&page=1&limit=20" -H "Authorization: Bearer $TOKEN"   # kind: upload (default) or result
curl $BASE/images/1 -H "Authorization: Bearer $TOKEN"                               # metadata (signedUrl only in development)
curl $BASE/images/1/content -H "Authorization: Bearer $TOKEN" --output image.jpg    # the image itself
curl -X DELETE $BASE/images/1 -H "Authorization: Bearer $TOKEN"
```

## Generations (any)

### Create: `POST /generations`
Reserves 2 credits and starts the job. `Idempotency-Key` is required (16 to 128 letters, digits, `-` or `_`); repeating the same key returns the same generation without charging again. Returns `402 INSUFFICIENT_CREDITS` when the balance is too low.

```sh
curl -X POST $BASE/generations -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: test-generation-0001' -d '{
  "templateId": "TEMPLATE_ID",
  "imageId": 1
}'
```

### List, details, status

```sh
curl "$BASE/generations?page=1&limit=20&status=COMPLETED" -H "Authorization: Bearer $TOKEN"  # status filter optional
curl $BASE/generations/GENERATION_ID -H "Authorization: Bearer $TOKEN"
curl $BASE/generations/GENERATION_ID/status -H "Authorization: Bearer $TOKEN"                # poll until isFinal is true
```
Statuses: `RESERVED`, `SUBMITTED`, `PROCESSING`, `COMPLETED`, `REFUNDED` (failed and credits returned). When completed, load `output.contentUrl` with the token.

### Retry a failed generation: `POST /generations/:id/retry`
Creates a new generation for the same photo and template. Needs a new `Idempotency-Key`.

```sh
curl -X POST $BASE/generations/GENERATION_ID/retry -H "Authorization: Bearer $TOKEN" \
  -H 'Idempotency-Key: test-generation-0002'
```

## Admin (admin)

### Categories

```sh
curl -X POST $BASE/admin/categories -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
  "name": "Party",
  "slug": "party",
  "description": "Party looks",
  "imageUrl": "https://example.com/party.jpg",
  "displayOrder": 6,
  "isActive": true
}'

curl -X PATCH $BASE/admin/categories/CATEGORY_ID -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
  "name": "Party Wear",
  "isActive": false
}'
```
`name` and `slug` are required on create; on update send only the fields to change.

### Templates

```sh
curl "$BASE/admin/templates?page=1&limit=20" -H "Authorization: Bearer $ADMIN_TOKEN"   # includes inactive and garmentImagePath

curl -X POST $BASE/admin/templates -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
  "categoryId": "CATEGORY_ID",
  "name": "Red Saree",
  "description": "Classic red saree",
  "previewImageUrl": "https://example.com/preview.jpg",
  "garmentImagePath": "https://example.com/garment.jpg",
  "garmentType": "entire_outfit",
  "isFeatured": true,
  "displayOrder": 1
}'

curl -X PATCH $BASE/admin/templates/TEMPLATE_ID -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
  "isFeatured": false,
  "garmentImagePath": "https://example.com/new-garment.jpg"
}'

curl -X DELETE $BASE/admin/templates/TEMPLATE_ID -H "Authorization: Bearer $ADMIN_TOKEN"   # deactivates, does not erase
```
`categoryId` and `name` are required on create. A template can be generated only when `garmentImagePath` is an `https` image URL.

### Wallets and generations

```sh
curl "$BASE/admin/wallets?page=1&limit=20" -H "Authorization: Bearer $ADMIN_TOKEN"
curl "$BASE/admin/generations?page=1&limit=20&status=REFUNDED" -H "Authorization: Bearer $ADMIN_TOKEN"   # status optional; shows error details
```

## Common error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | A field is missing or wrong; see `details` |
| `UNAUTHORIZED` | 401 | Token missing, malformed or expired |
| `SESSION_EXPIRED` | 401 | Guest session was linked to an account; use the account token |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `INVALID_REFRESH_TOKEN` | 401 | Refresh token used, expired or unknown; sign in again |
| `INSTALLATION_MISMATCH` | 401 | `guestSecret` does not match this `installationUuid` |
| `INSUFFICIENT_CREDITS` | 402 | Not enough credits to generate |
| `ACCOUNT_REQUIRED` | 403 | Guest token used on a user-only route |
| `FORBIDDEN` | 403 | Not an admin |
| `NOT_FOUND` | 404 | Wrong route or the item is not yours |
| `EMAIL_IN_USE` | 409 | Account already exists |
| `GUEST_ALREADY_CLAIMED` | 409 | Guest session belongs to another account |
| `TEMPLATE_UNAVAILABLE` | 409 | Template has no garment image yet |
| `PAYLOAD_TOO_LARGE` | 413 | Image over 10 MB |
| `RATE_LIMITED` | 429 | Too many requests |
| `GENERATION_UNAVAILABLE`, `STORAGE_NOT_CONFIGURED`, `GOOGLE_SIGN_IN_NOT_CONFIGURED` | 503 | A key is missing in `.env` |
