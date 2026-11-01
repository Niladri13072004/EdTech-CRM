# EdTech CRM & Inquiry Management System

A CRM for an education provider. Parents, students and schools submit inquiries (scholarships, concerts, admissions, general questions) through a public form. Staff sign in to a protected dashboard to search, filter, review, export and update those inquiries.

- **Frontend:** React 19 + Vite 8 (JavaScript), React Router, Axios, React Hook Form + Zod, Lucide icons
- **Backend:** Node.js + Express 5, Sequelize 6 with the `pg` driver, Zod, bcrypt, jsonwebtoken
- **Database:** Supabase PostgreSQL. Supabase is used **only as managed PostgreSQL**: no Supabase Auth, no Supabase client, and the browser never talks to the database.
- **Authentication:** custom bcrypt password hashes plus a JWT carried in an HttpOnly cookie
- **Deployment:** a single Render web service (`render.yaml`) that serves the API and the built React app from one origin

More detail: [Architecture](docs/ARCHITECTURE.md)

---

## Contents

1. [Features](#1-features)
2. [Architecture](#2-architecture)
3. [Supabase setup](#3-supabase-setup)
4. [Local installation and running](#4-local-installation-and-running)
5. [Environment variables](#5-environment-variables)
6. [Admin accounts](#6-admin-accounts)
7. [API reference](#7-api-reference)
8. [Authentication: how it works and how to test it](#8-authentication-how-it-works-and-how-to-test-it)
9. [Tests, lint and builds](#9-tests-lint-and-builds)
10. [Deployment](#10-deployment)
11. [Security notes](#11-security-notes)
12. [Known limitations](#12-known-limitations)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Features

### Core

| Feature | Where |
|---------|-------|
| Public inquiry form: User Type (Parent / Student / School), Category (Scholarship / Concert / Admission / General Query), Name, Email, Phone, Message | `/` · `POST /api/inquiries` |
| Validation in the browser **and** on the server, with field-level messages | `frontend/src/validation`, `backend/src/validators` |
| Submissions stored in PostgreSQL through Sequelize, status `New` by default | `backend/src/services/inquiry.service.js`, `schema.sql` |
| Custom admin authentication: bcrypt (cost 12) + JWT (HS256, explicit expiry, issuer and audience) in an HttpOnly cookie | `/login` · `/api/auth/*` |
| Protected admin dashboard and APIs | `/admin/dashboard` · `/api/inquiries` (except the public `POST`) |
| Table with Name, Phone, Email, User Type, Category, Date, Status | dashboard |
| Filter by Category, filter by User Type, search by name or phone, all combinable | dashboard · `GET /api/inquiries` |

### Dashboard

- **Status management** (New / In Progress / Resolved) from the table, with confirmation messages.
- **Pagination** on the server (20 per page by default), plus sorting by date or name.
- **Summary cards** (total, New, In progress, Resolved) and a **category bar chart**, counted in the database. Clicking a card or a bar filters the table.
- **CSV export** of the current filtered results. Values are escaped, spreadsheet formulas are neutralized, and only inquiry fields are included.
- **Filter chips** with per-filter remove and Clear all. The view (filters, search, page, sort) lives in the URL, so it survives a reload and can be shared.
- **Duplicate protection:** an identical submission within 10 minutes returns the existing inquiry instead of storing a copy.
- **Rate limiting** on the public form and on failed sign-ins.
- **Accessibility and responsiveness:** labelled controls, visible focus styles, a skip link, live status messages, light and dark themes, phone layouts, and a table that scrolls with a sticky name column.
- **Local mode without Supabase:** `npm run dev:memory` runs the real API on an in-memory PostgreSQL (PGlite) for trying the app.

---

## 2. Architecture

```
Browser ──HTTPS──▶ Render web service (Node.js, Express 5)                ──TLS──▶ Supabase PostgreSQL
                   ├─ /api/*   JSON API (Helmet, CORS allow-list, Zod,              (session pooler,
                   │           rate limits, cookie JWT auth, CSRF origin check)      certificate verified)
                   └─ /*       built React app (frontend/dist) + SPA fallback
```

In production, one service serves both the pages and the API, so they share an origin. The session cookie is first-party with `SameSite=Strict`, and no cross-site CORS is involved. In development, Vite serves the React app on port 5173 and proxies `/api` to Express on port 4000, which gives the same origin model.

### Repository structure

```
├── backend/
│   ├── src/
│   │   ├── app.js              Express app (middleware, /api router, optional React app serving)
│   │   ├── server.js           startup: config → DB connection (with retries) → listen on PORT → graceful shutdown
│   │   ├── config/             env.js (Zod-validated config), database.js (Sequelize, TLS), security and startup warnings
│   │   ├── models/             Admin, Inquiry, InquiryNote, InquiryActivity (explicit camelCase ↔ snake_case mappings)
│   │   ├── routes/ controllers/ services/   health, auth, inquiries (list, stats, export, status)
│   │   ├── middleware/         authenticate, requireTrustedOrigin (CSRF), rate limiters, validation, errors
│   │   ├── validators/         Zod request schemas
│   │   ├── frontend/           serves frontend/dist when SERVE_FRONTEND=true
│   │   └── utils/              jwt, password (bcrypt), cookies, CSV, query builder, logger
│   ├── scripts/                db-migrate, db-check, createAdmin, dev-memory
│   ├── tests/                  unit, api, schema, database (PGlite), integration (real PostgreSQL)
│   └── certs/README.md         where to put the Supabase CA certificate
├── frontend/
│   ├── src/                    pages (form, login, dashboard), components, auth, api (Axios), hooks, validation
│   ├── tests/                  Vitest + Testing Library
│   ├── vite.config.js          dev proxy, build chunking, preview with production headers
│   └── vercel.json             security headers + SPA rewrite (optional Vercel deployment)
├── schema.sql                  database schema (tables, constraints, indexes, trigger, RLS)
├── render.yaml                 Render Blueprint (single same-origin web service)
├── .env.example                backend configuration template
└── docs/                       technical documentation
```

### Data model (`schema.sql`)

- **`admins`**: `id` uuid PK, `email` unique (stored lower-case), `password_hash` (a CHECK accepts only bcrypt hashes), `created_at`.
- **`inquiries`**: `id`, `name`, `email`, `phone` (text), `user_type` and `category` (CHECK allow-lists), `message`, `status` (CHECK New / In Progress / Resolved, default New), `created_at`, `updated_at` (kept current by a trigger).
- **Indexes:** creation date, category + date, and user type + date.
- **Row Level Security** is enabled with no policies, so Supabase's public REST API cannot read any of the four tables. The backend connects as the table owner and is unaffected.

---

## 3. Supabase setup

1. Create a project at [supabase.com](https://supabase.com) and keep the database password.
2. **Connection string:** in **Connect** (or *Project Settings → Database*), copy the **Session pooler** URI:
   ```
   postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```
   Use the pooler, not `db.<ref>.supabase.co`, which is IPv6-only on most plans. Do not add `?sslmode=…`; TLS is configured separately.
3. **CA certificate:** go to *Project Settings → Database → SSL Configuration → Download certificate*. Supabase signs its certificates with its own root CA, so the backend needs this file to verify the server.
   - Locally: save it as `backend/certs/supabase-ca.crt`.
   - On Render: paste its contents into the `DATABASE_SSL_CA` environment variable.
4. **Create the tables** by running `schema.sql`, either way:
   - **SQL editor:** open *SQL Editor → New query*, paste the whole of [`schema.sql`](schema.sql), and click **Run**.
   - **From your machine,** after configuring `backend/.env` (next section):
     ```bash
     npm run db:migrate --prefix backend
     ```

   `schema.sql` runs in a transaction and is safe to run more than once.
5. Check that the tables match the application (read-only):
   ```bash
   npm run db:check --prefix backend
   ```

---

## 4. Local installation and running

**Prerequisites:** Node.js **22.22+ or 24** (`.nvmrc` says 24) and npm. For the full setup you also need a Supabase project; to try the app without one, see [Option B](#option-b-no-supabase-in-memory-database).

```bash
git clone <your-repository-url>
cd EdTech-CRM
npm ci --prefix backend
npm ci --prefix frontend
```

### Option A: with Supabase

```bash
cp .env.example backend/.env
```

Edit `backend/.env`: set `DATABASE_URL` (step 3.2) and `JWT_SECRET` (generate one as below), and keep `DATABASE_SSL_CA_PATH=./certs/supabase-ca.crt` (step 3.3).

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

```bash
npm run db:migrate --prefix backend
npm run admin:create --prefix backend
npm run dev --prefix backend
```

In a second terminal:

```bash
npm run dev --prefix frontend
```

Open **http://localhost:5173**. The form is at `/`, sign-in at `/login` and the dashboard at `/admin/dashboard`. The API runs on http://localhost:4000, and Vite proxies `/api` to it.

### Option B: no Supabase (in-memory database)

For trying the app only. Data disappears when the process stops, and the command refuses to run with `NODE_ENV=production`.

```bash
npm run dev:memory --prefix backend
```

In a second terminal, create an admin in that database:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres DATABASE_SSL_MODE=disable npm run admin:create --prefix backend
```

In a third terminal:

```bash
npm run dev --prefix frontend
```

### Same-origin production build locally

This serves the built app from Express exactly as on Render. It needs a configured `backend/.env`.

```bash
npm run build --prefix frontend
SERVE_FRONTEND=true FRONTEND_URL=http://localhost:4000 npm start --prefix backend
```

Then open http://localhost:4000.

---

## 5. Environment variables

The backend reads `backend/.env` (template: [`.env.example`](.env.example)) and validates it at startup. Missing or invalid values are listed together, and the process exits instead of running half-configured.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | **yes** | — | Supabase session-pooler connection string |
| `DATABASE_SSL_MODE` | no | `verify-full` | `verify-full` (certificate checked), `require` (encrypted, not verified; logs a warning), `disable` (local only; refused in production) |
| `DATABASE_SSL_CA_PATH` / `DATABASE_SSL_CA` | for Supabase | — | Supabase CA certificate as a file path or inline PEM |
| `JWT_SECRET` | **yes** | — | ≥ 32 random characters; the `.env.example` placeholder is refused |
| `JWT_EXPIRES_IN` | no | `1h` | session length (`15m`, `1h`, `7d`…) |
| `JWT_ISSUER` / `JWT_AUDIENCE` | no | `edtech-crm-api` / `edtech-crm-admin` | checked on every request |
| `FRONTEND_URL` | **yes**, except on Render | `RENDER_EXTERNAL_URL` | exact browser origin(s), comma-separated; used for CORS and the CSRF origin check |
| `PORT` | no | `4000` | hosting platforms set this |
| `NODE_ENV` | no | `development` | `production` enables Secure cookies, JSON logs and strict TLS |
| `SERVE_FRONTEND` / `FRONTEND_DIST_DIR` | no | `false` / `../frontend/dist` | serve the built React app from the API (same-origin deployment) |
| `TRUST_PROXY` | no | `0` | proxies in front of Express (`1` on Render); a warning is logged if left at 0 in production |
| `BCRYPT_SALT_ROUNDS` | no | `12` | 10–15 |
| `AUTH_COOKIE_SECURE` / `AUTH_COOKIE_SAMESITE` | no | `true` in production / `strict` | Secure cannot be turned off in production |
| `LOGIN_RATE_LIMIT_MAX` / `…_WINDOW_MINUTES` | no | `5` / `15` | failed sign-ins per IP |
| `INQUIRY_RATE_LIMIT_MAX` / `…_WINDOW_MINUTES` | no | `10` / `15` | public submissions per IP |
| `INQUIRY_DUPLICATE_WINDOW_MINUTES` | no | `10` | identical submissions within this window are not stored twice (`0` disables) |
| `LOG_LEVEL`, `DATABASE_POOL_MAX`, `DATABASE_CONNECT_RETRIES` | no | `info`, `5`, `5` | operational tuning |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | no | — | only for non-interactive `admin:create`; never set on the running service |
| `TEST_DATABASE_URL` | tests only | — | disposable database for `npm run test:integration` |

Frontend ([`frontend/.env.example`](frontend/.env.example)): `VITE_API_BASE_URL` stays empty for same-origin `/api`, and `DEV_API_PROXY_TARGET` sets the dev proxy target (default `http://localhost:4000`). The frontend holds **no** database or secret configuration.

---

## 6. Admin accounts

There is no sign-up page and no default admin. Create admins with the bootstrap script:

```bash
npm run admin:create --prefix backend
```

- It asks for the email and the password; the password is hidden and asked twice.
- **Password rules:** at least 12 characters, at most 72 bytes, at least 5 different characters, not a common password, and not containing the email name.
- Only a bcrypt hash (cost 12) is stored. Neither the password nor the hash is ever printed.
- A duplicate email (in any letter case) fails with exit code 1.
- **Non-interactive use** (for example in a Render shell) takes `ADMIN_EMAIL` plus `ADMIN_PASSWORD`, or reads the password as one line from stdin. A `--password` argument is refused, because arguments are visible in shell history.

```bash
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD && ADMIN_EMAIL=you@school.org npm run admin:create --prefix backend; unset ADMIN_PASSWORD
```

---

## 7. API reference

All responses are JSON unless noted. Errors look like `{ "success": false, "error": { "code", "message", "details"? } }`, and `details` holds `{ field, message }` per invalid field.

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| GET | `/api/health` | public | liveness: `{ status: "ok" }` (Render health check) |
| GET | `/api/health/db` | public | database reachability; 503 if down |
| POST | `/api/inquiries` | public (rate-limited) | submit an inquiry → `201 { success, message, data: { id, duplicate: false } }`; an identical recent submission → `200`, `duplicate: true` |
| POST | `/api/auth/login` | public (rate-limited, origin-checked) | `{ email, password }` → sets the session cookie; body `{ data: { admin: { id, email, role }, expiresAt } }` |
| POST | `/api/auth/logout` | origin-checked | revokes the token and clears the cookie |
| GET | `/api/auth/me` | admin | current admin |
| GET | `/api/inquiries` | admin | list: `category`, `userType`, `status`, `search` (name or phone), `page`, `pageSize` (≤ 100, default 20), `sortBy` (`createdAt`, `name`, `category`, `userType`, `status`), `sortDir` (`asc`, `desc`) → `{ data, meta: { page, pageSize, total, totalPages, hasNextPage, hasPreviousPage, … } }` |
| GET | `/api/inquiries/stats` | admin | `{ total, byStatus, byCategory }`, counted in the database |
| GET | `/api/inquiries/export` | admin | same filters and sort as the list → `text/csv` download (at most 5000 rows, otherwise 422) |
| GET | `/api/inquiries/:id` | admin | one inquiry, including the message |
| PATCH | `/api/inquiries/:id/status` | admin, origin-checked | `{ "status": "New" \| "In Progress" \| "Resolved" }` → updated inquiry |

**Public form validation:**
- every field is trimmed;
- name: 2–100 characters, must include a letter;
- email: valid, ≤ 254 characters, stored lower-case;
- phone: any country, an optional leading `+`, then digits, spaces, `-` and brackets, with 7–15 digits and ≤ 20 characters;
- message: 10–2000 characters;
- user type and category must match the allowed values exactly;
- any other field (for example `status`) is rejected.

---

## 8. Authentication: how it works and how to test it

### How it works

1. **Login:** `POST /api/auth/login` looks up the admin by email and checks the password with `bcrypt.compare`. An unknown email is compared against a dummy hash, so both failures take the same time and return the same `401 INVALID_CREDENTIALS`.
2. **Token:** on success the server signs a JWT (HS256) holding only `sub` (admin id), `role`, `jti`, `iat`, `exp` (`JWT_EXPIRES_IN`), `iss` and `aud`. It sets the token as an **HttpOnly, SameSite=Strict** cookie, which in production is also **Secure** and named with the `__Host-` prefix. The token never appears in a response body, and the frontend never stores it.
3. **Every admin request:** the `authenticate` middleware reads the cookie and checks:
   - the signature, with the algorithm pinned so other algorithms are refused;
   - expiry, issuer and audience;
   - that the token hasn't been revoked by logout;
   - that the admin still exists.

   The role comes from the server, never from the request. Failures return `401` (`AUTH_REQUIRED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`); a missing role returns `403 FORBIDDEN`.
4. **CSRF:** login, logout, status changes, and any other state-changing request that carries the cookie must send an `Origin` (or `Referer`) listed in `FRONTEND_URL`, otherwise they get `403 ORIGIN_NOT_ALLOWED`. CORS rejects other origins, and request bodies must be JSON.
5. **Logout:** `POST /api/auth/logout` revokes the token's `jti` and clears the cookie with the same attributes.
6. **In the frontend:** the session is restored with `GET /api/auth/me`; any later `401` returns you to `/login`. Route protection in the browser is only for convenience: the API checks every admin request itself.

### Testing protected endpoints with curl

Run the API (section 4) and create an admin first. curl doesn't send an `Origin` header by default, so add one on state-changing requests; `-c` / `-b` keep the cookie like a browser.

```bash
API=http://localhost:4000/api
ORIGIN='Origin: http://localhost:5173'
read -rs PW
```

```bash
curl -i $API/inquiries
```
→ `401 AUTH_REQUIRED`

```bash
curl -i -H "$ORIGIN" -H 'Content-Type: application/json' -d '{"email":"you@school.org","password":"wrong-password"}' $API/auth/login
```
→ `401 INVALID_CREDENTIALS` (the same as for an unknown email)

```bash
curl -i -c cookies.txt -H "$ORIGIN" -H 'Content-Type: application/json' -d "{\"email\":\"you@school.org\",\"password\":\"$PW\"}" $API/auth/login
```
→ `200` and `Set-Cookie: edtech_admin_session=…; HttpOnly; SameSite=Strict`

```bash
curl -b cookies.txt "$API/inquiries?category=Admission&search=asha"
curl -b cookies.txt $API/inquiries/stats
curl -b cookies.txt -o inquiries.csv "$API/inquiries/export?category=Admission"
```
→ `200` each

```bash
TOKEN=$(awk '/edtech_admin_session/ {print $7}' cookies.txt)
curl -i -H "Cookie: edtech_admin_session=${TOKEN%???}abc" $API/auth/me
```
→ `401 INVALID_TOKEN` (tampered signature)

```bash
ID=$(curl -s -b cookies.txt $API/inquiries | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).data[0]?.id??''))")
curl -i -b cookies.txt -X PATCH -H 'Content-Type: application/json' -d '{"status":"Resolved"}' $API/inquiries/$ID/status
curl -i -b cookies.txt -X PATCH -H "$ORIGIN" -H 'Content-Type: application/json' -d '{"status":"Resolved"}' $API/inquiries/$ID/status
curl -i -b cookies.txt -X PATCH -H "$ORIGIN" -H 'Content-Type: application/json' -d '{"status":"Closed"}' $API/inquiries/$ID/status
```
→ `403 ORIGIN_NOT_ALLOWED`, then `200`, then `400`

```bash
curl -i -b cookies.txt -c cookies.txt -X POST -H "$ORIGIN" $API/auth/logout
curl -i -H "Cookie: edtech_admin_session=$TOKEN" $API/auth/me
```
→ `200`, then `401 TOKEN_REVOKED` (the old token no longer works)

- **Expiry:** start the API with `JWT_EXPIRES_IN=10s`, log in, wait 11 seconds, and replay the token with `-H "Cookie: …"`. You get `401 TOKEN_EXPIRED`.
- **Rate limit:** the sixth wrong password from one IP within 15 minutes gets `429`.

Run `unset PW TOKEN` and delete `cookies.txt` and `inquiries.csv` afterwards.

---

## 9. Tests, lint and builds

| Command | What it runs |
|---------|--------------|
| `npm test --prefix backend` | unit, API (Supertest), schema (`schema.sql` in PGlite) and database tests (real Express + Sequelize + `pg` against an in-process PostgreSQL). No credentials needed. |
| `TEST_DATABASE_URL='postgresql://…' DATABASE_SSL_MODE=… npm run test:integration --prefix backend` | integration tests against a real, **disposable** PostgreSQL (for example a separate Supabase test project). Skipped when `TEST_DATABASE_URL` is unset. |
| `npm test --prefix frontend` | Vitest + Testing Library (forms, auth flow, dashboard, API client, security headers) |
| `npm run lint --prefix backend`, `npm run lint --prefix frontend` | ESLint (including React Compiler rules) |
| `npm run format:check --prefix backend`, `--prefix frontend` | Prettier |
| `npm run build --prefix frontend` | production build into `frontend/dist` |
| `npm run preview --prefix frontend` | serves the build locally with the production security headers |
| `npm run db:check --prefix backend` | read-only: verifies every model table (all four) against `schema.sql`: columns, nullability, PostgreSQL types, and Row Level Security |

GitHub Actions runs the test suites, lint, formatting and the production build on every push and pull request (`.github/workflows/ci.yml`). No Supabase credentials or repository secrets are needed, because everything runs against PGlite or in-process doubles.

Two items are deliberately **not** run in CI and must be run yourself: `npm run db:check`, which needs a live `DATABASE_URL`, and the opt-in integration suite (`TEST_DATABASE_URL`). The PGlite schema tests in CI execute `schema.sql` and compare it with the models, but they are not a substitute for `db:check` against your real database.

---

## 10. Deployment

### Recommended: one Render web service (`render.yaml`)

The Blueprint builds the backend (runtime dependencies only) and the React app, then starts Express with `SERVE_FRONTEND=true`.
- Pages and `/api` share one origin.
- Client routes such as `/admin/dashboard` survive a refresh.
- Unknown `/api/…` paths still return JSON 404s.
- Hashed assets are cached for a year.
- The service listens on the `PORT` that Render assigns.

1. Prepare Supabase (section 3) and run `schema.sql`.
2. In Render: **New → Blueprint**, then choose this repository. Render reads `render.yaml`.
3. When prompted, enter the secret values:
   - `DATABASE_URL`: the session-pooler URI;
   - `DATABASE_SSL_CA`: the full PEM text of the Supabase CA certificate.

   Render generates `JWT_SECRET` itself, and sets `NODE_ENV=production`, `SERVE_FRONTEND=true` and `TRUST_PROXY=1`. `FRONTEND_URL` defaults to the service URL (`RENDER_EXTERNAL_URL`); set it explicitly only to add a custom domain.
4. After the first deploy, open the service **Shell** and create an admin:
   ```bash
   cd backend && npm run admin:create
   ```
5. **Smoke test:**
   - `https://<service>.onrender.com/api/health` returns `{"status":"ok",…}`;
   - `/api/health/db` reports `"database":"up"`;
   - the form at `/` submits;
   - signing in at `/login` works;
   - the dashboard lists the submitted inquiry.

In production the cookie is `Secure`, `HttpOnly`, `SameSite=Strict` and `__Host-` prefixed (startup refuses `AUTH_COOKIE_SECURE=false`). TLS to the database is certificate-verified, and `DATABASE_URL` and `JWT_SECRET` come only from Render's environment. Render's free plan sleeps when idle, so the first request after a pause can take 30–60 seconds; the frontend allows 30 seconds per request.

### Alternative: Vercel frontend + Render API

`frontend/vercel.json` already sends the security headers and the SPA fallback. To use Vercel for the frontend:
1. Deploy only the API to Render, with `SERVE_FRONTEND` unset.
2. In `frontend/vercel.json`, add an `/api` rewrite **before** the SPA rewrite. The browser then talks only to Vercel, so the cookie stays first-party:
   ```json
   { "source": "/api/:path*", "destination": "https://<your-render-service>.onrender.com/api/:path*" }
   ```
3. On Render, set `FRONTEND_URL=https://<your-app>.vercel.app` (the CSRF origin check uses it) and `TRUST_PROXY=2` (Vercel plus Render).

Calling the API cross-site without a rewrite is **not recommended**. It would need `AUTH_COOKIE_SAMESITE=none` and `VITE_API_BASE_URL`, and browsers that block third-party cookies (Safari by default) would drop the session.

---

## 11. Security notes

- **Passwords:** bcrypt cost 12. The database CHECK rejects anything that isn't a bcrypt hash, and hashes never appear in responses, logs or exports.
- **Tokens:** HS256 with a ≥ 32-character secret (the placeholder is refused), explicit expiry, issuer and audience, revocation on logout, and an HttpOnly cookie that JavaScript cannot read.
- **Authorization:** every admin route sits behind `authenticate` + `requireRole('admin')`. A test walks the real routers and fails if a new route is added without them.
- **CSRF:** SameSite=Strict, an Origin/Referer allow-list on every cookie-carrying unsafe request, JSON-only bodies, and CORS restricted to `FRONTEND_URL`.
- **Input:** strict Zod schemas on every body, query and parameter (unknown fields rejected), a 20 kb body limit, and CHECK constraints in the database.
- **SQL:** Sequelize queries only. LIKE wildcards in searches are escaped, and SQL injection attempts are covered by tests.
- **Errors:** generic messages with no stack traces, SQL or connection details, in any environment.
- **Rate limits:** failed sign-ins (5 per 15 minutes per IP) and public submissions (10 per 15 minutes per IP).
- **CSV export:** every field is quoted, and values starting with `= + - @` (or a tab or carriage return) get a leading `'`, so spreadsheets treat them as text rather than formulas. This includes phone numbers such as `'+91…`; the quote is hidden in Excel, LibreOffice and Google Sheets.
- **Headers:**
  - API: Helmet with `default-src 'none'`.
  - Pages: CSP `default-src 'self'` with no inline or eval scripts, plus HSTS, `X-Frame-Options: DENY`, COOP, `nosniff` and a strict referrer policy.
- **Database:** TLS with certificate verification; RLS blocks Supabase's public REST access; `sync()` is never called.
- **Secrets:** environment variables only. `.gitignore` excludes every `.env*` file except the examples, plus private keys, dependencies, build output, coverage and logs.

---

## 12. Known limitations

- **Not verified on Supabase or live hosting:** tests and local runs use PostgreSQL through PGlite. A real Supabase connection and a live deployment still need your credentials and accounts.
- **Single instance:** logout revocation and rate limits are kept in memory. After a restart, a logged-out token works again until it expires (at most `JWT_EXPIRES_IN`). Running several instances would need a shared store.
- **One role:** there is a single admin role, so admin management (password change, deletion) is done through the scripts or the database.
- **Summary totals are unfiltered:** the summary cards and chart always cover all inquiries; only the table follows the filters.
- **Export cap:** CSV export stops at 5000 rows; narrow the filters for larger exports.
- **CI covers tests and static checks only:** GitHub Actions runs both test suites, ESLint, Prettier and the production build on every push and pull request. It does not touch Supabase or deploy anything.

---

## 13. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `SELF_SIGNED_CERT_IN_CHAIN` at startup | supply the Supabase CA (`DATABASE_SSL_CA_PATH` or `DATABASE_SSL_CA`) |
| `Tenant or user not found` | the pooler user must be `postgres.<project-ref>`, and the region in the host must match |
| `28P01` authentication failed | wrong database password; URL-encode special characters (`@` → `%40`) |
| `ENETUNREACH` / `EHOSTUNREACH` | you used the IPv6-only direct host; use the pooler URI |
| Startup lists invalid configuration | fix the listed variables (see `.env.example`) |
| Sign-in fails with "The server did not accept requests from this site" | add the exact browser origin to `FRONTEND_URL` |
| "We could not reach the server" in the form | start the backend (or `npm run dev:memory --prefix backend`) |
| `SERVE_FRONTEND: no index.html` | run `npm run build --prefix frontend` first |

---

