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
- An inquiry details drawer with the full message, internal notes, administrator assignment, follow-up date and outcome, and an activity timeline

The API client sends cookies with every request. A `401` response clears the local session and returns the administrator to the login screen.

## Backend

Express exposes three route groups:

- `/api/health` for liveness and database checks
- `/api/auth` for login, logout, and current-session lookup
- `/api/inquiries` for public submission and administrator operations

The public `POST /api/inquiries` route validates and stores a submission. All other inquiry routes require an authenticated administrator. Admin routes provide list, stats, export, detail, assignable-admin lookup, note creation, and workflow updates. Workflow updates can change status, assignment, follow-up date, and follow-up outcome; changes are recorded as activity rows in the same transaction as the corresponding change.

The API is assembled separately from process startup so tests can exercise it without opening a network port or connecting to a real database.

## Data model

The four tables are related as follows:

```text
admins (1) ──< inquiries          via inquiries.assigned_admin_id
admins (1) ──< inquiry_notes      via inquiry_notes.admin_id (nullable)
admins (1) ──< inquiry_activities via inquiry_activities.admin_id (nullable)
inquiries (1) ──< inquiry_notes      via inquiry_notes.inquiry_id
inquiries (1) ──< inquiry_activities via inquiry_activities.inquiry_id
```

An admin can be assigned to many inquiries. Deleting an assigned admin sets `inquiries.assigned_admin_id` to `NULL`. Notes and activity rows belong to one inquiry; deleting an inquiry cascades to those rows. Their optional `admin_id` references are set to `NULL` if an admin is deleted, while notes keep a required `admin_email` snapshot and activities keep an optional `admin_email` snapshot.

`admins` stores administrator accounts:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Primary key |
| `email` | text | Unique, lower-case |
| `password_hash` | text | bcrypt hash |
| `created_at` | timestamptz | Creation time |

`inquiries` stores public submissions and workflow state:

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
| `assigned_admin_id` | uuid, nullable | Foreign key to `admins.id`; set to null if that admin is deleted |
| `follow_up_date` | date, nullable | Scheduled follow-up date |
| `follow_up_outcome` | text, nullable | Recorded follow-up outcome |
| `created_at` | timestamptz | Submission time |
| `updated_at` | timestamptz | Maintained by a trigger |

`inquiry_notes` stores internal staff notes. Each row has an inquiry foreign key, optional author admin foreign key, required author-email snapshot, body, and creation time. Deleting the inquiry cascades to its notes; deleting an admin preserves a note and clears its author foreign key. An index orders notes by inquiry and creation time.

`inquiry_activities` stores timeline events with an inquiry foreign key, optional actor admin foreign key and email snapshot, event type, summary, and creation time. Deleting an inquiry cascades to its activities; deleting an admin preserves an activity and clears its actor foreign key. An index orders activities by inquiry and creation time. The initial “Inquiry received” event is synthesized from the inquiry's `created_at` when detail is read; subsequent status, note, assignment, and follow-up changes are written as activity rows in the same transaction as their corresponding change.

The Sequelize model and service treat activity records as append-only, but PostgreSQL permissions and constraints do not prevent UPDATE or DELETE. The table is therefore an activity timeline rather than a database-enforced immutable audit log. Check constraints enforce allowed values and field limits. Indexes support date ordering and category/user-type filtering. Row Level Security is enabled without policies on all four tables so Supabase's public REST API cannot read them; the backend connects as the table owner.

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

The frontend configuration also supports deployment to Vercel, but the recommended setup keeps the API and frontend on one origin. Repository configuration establishes deployment readiness, not verification of an actual deployment. Supabase and live-hosting behavior must be verified against the real credentials and service.

The production smoke check should cover database connectivity, all four tables and their RLS settings, admin creation and login, inquiry submission, note creation, assignment, follow-up updates, activity history, logout and token expiry, and data availability after a service restart. `render.yaml` alone does not establish any of these results. This repository contains no record of a Supabase connection check or live deployment smoke test; that does not establish whether checks were performed manually.

The schema checker compares table and column presence, supported types, nullability, and RLS. It skips unsupported Sequelize types and is not a complete schema-equivalence checker: foreign keys, unique/check constraints, index definitions, and default expressions are not comprehensively compared.

Rate-limit counters and token-revocation records live in process memory. A restart clears revoked-token records, and multiple instances do not share either state. This is an accepted single-instance trade-off; a shared store is needed if the deployment scales horizontally.

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
