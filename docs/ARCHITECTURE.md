# Architecture

## Overview

The application is a single-page React client backed by a Node.js API and a PostgreSQL database. Visitors use the public inquiry form; administrators sign in to review, filter, update, and export inquiries.

In production, one Express service serves both the API and the built React application. This keeps the browser session cookie first-party and avoids cross-origin configuration.

```
Browser
  |
  | HTTPS
  v
Render web service
  |-- /api/*  Express API
  |-- /*       Built React application
  |
  | TLS + certificate verification
  v
Supabase PostgreSQL
```

During local development, Vite serves the frontend on port 5173 and proxies `/api` requests to Express on port 4000.

## Repository layout

```
backend/
  src/
    app.js                 Express application assembly
    server.js              Process startup and graceful shutdown
    config/                Environment, database, CORS and startup configuration
    controllers/           HTTP request and response handling
    middleware/            Authentication, validation, rate limits and errors
    models/                Sequelize models
    routes/                API route definitions
    services/              Inquiry and authentication business logic
    utils/                 Cookies, JWTs, CSV handling, logging and query helpers
    validators/            Zod request schemas
  scripts/                 Database, admin and local-development utilities
  tests/                   Unit, API, schema and database tests

frontend/
  src/
    api/                   Axios client and API modules
    auth/                  Session context and protected routes
    components/            Form, dashboard, layout and UI components
    hooks/                 Query state and debouncing helpers
    pages/                 Public form, login and admin dashboard
    validation/            Client-side Zod schemas
  tests/                   Component and integration tests

docs/                      Technical documentation
schema.sql                 PostgreSQL schema
render.yaml                Render deployment blueprint
```

## Frontend

The frontend is a React 19 application built with Vite. React Router handles the public form, login screen, and protected dashboard.

The public form collects inquiry type, category, name, email, phone, and message. React Hook Form and Zod validate input before submission, while the API performs its own validation.

The dashboard keeps its current filters, search term, page, and sort order in the URL. It supports:

- Filtering by category, user type, and status
- Searching by name or phone number
- Server-side pagination and sorting
- Summary totals and category breakdowns
- Inline status updates
- CSV export of the current result set

The API client sends cookies with every request. A `401` response clears the local session and returns the administrator to the login screen.

## Backend

Express exposes three route groups:

- `/api/health` for liveness and database checks
- `/api/auth` for login, logout, and current-session lookup
- `/api/inquiries` for public submission and administrator operations

The public `POST /api/inquiries` route validates and stores a submission. All other inquiry routes require an authenticated administrator.

The API is assembled separately from process startup so tests can exercise it without opening a network port or connecting to a real database.

## Data model

`admins` stores administrator accounts:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Primary key |
| `email` | text | Unique, lower-case |
| `password_hash` | text | bcrypt hash |
| `created_at` | timestamptz | Creation time |

`inquiries` stores public submissions:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Primary key |
| `name` | text | Submitter name |
| `email` | text | Submitter email |
| `phone` | text | Submitter phone number |
| `user_type` | text | Parent, Student, or School |
| `category` | text | Scholarship, Concert, Admission, or General Query |
| `message` | text | Inquiry content |
| `status` | text | New, In Progress, or Resolved |
| `created_at` | timestamptz | Submission time |
| `updated_at` | timestamptz | Maintained by a trigger |

Check constraints enforce allowed values and field limits. Indexes support date ordering and category/user-type filtering. Row Level Security is enabled without policies so Supabase's public REST API cannot read the tables.

## Authentication

Administrator passwords are hashed with bcrypt and stored in the `admins` table. A successful login issues a signed JWT in an HttpOnly cookie.

The token includes an expiry, issuer, and audience. Logout adds the token to an in-memory revocation list. Cookie-carrying unsafe requests are also checked against an allowed-origin list.

The frontend session state is only a convenience layer. Every administrator endpoint independently verifies the cookie and administrator role.

## Validation and errors

Zod schemas validate environment configuration and every request body, query, and route parameter. Unknown request fields are rejected.

Errors use a consistent JSON shape and do not expose stack traces or database details. The API returns appropriate status codes for validation failures, authentication failures, missing records, conflicts, and rate limits.

## Security

- Helmet sets security headers on API responses.
- CORS accepts only configured frontend origins.
- JSON request bodies are limited to 20 KB.
- Login attempts and public submissions are rate limited.
- Input is validated on the client and server.
- Sequelize parameterizes database access; search wildcards are escaped.
- CSV values are escaped and spreadsheet formulas are neutralized.
- Database connections use TLS with certificate verification.
- Secrets are read from environment variables and excluded from version control.

## Deployment

`render.yaml` defines one Render web service. The build installs backend dependencies, installs frontend dependencies, and builds the React application. Express then serves the API and static files from the same origin.

Required deployment secrets are `DATABASE_URL` and `DATABASE_SSL_CA`. Render generates `JWT_SECRET`. The service reads the platform-assigned `PORT` and trusts one reverse proxy.

The frontend configuration also supports deployment to Vercel, but the recommended setup keeps the API and frontend on one origin.

## Testing

Backend tests cover request validation, authentication, authorization, inquiry operations, CSV generation, schema constraints, and database behavior. They use Supertest and an in-process PostgreSQL-compatible database (PGlite), so no external credentials are required.

Frontend tests use Vitest and Testing Library to cover forms, authentication flows, dashboard behavior, API handling, and security headers.

Run all checks from the repository root:

```bash
npm test --prefix backend
npm test --prefix frontend
npm run lint --prefix backend
npm run lint --prefix frontend
npm run build --prefix frontend
```
