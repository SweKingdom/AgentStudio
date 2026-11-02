# [Project name] — requirements

<!--
How to use: replace the [brackets], delete what doesn't apply, and keep the defaults you agree with.
Every default you leave in is a decision the agents don't have to ask you about.
-->

## Goal

[One or two sentences: who it is for and what changes for them when it exists.]

## Users and roles

- **[Role, e.g. Member]:** [what they do]
- **[Role, e.g. Staff]:** [what they do]
- **Admin:** manages users and reference data.

## Defaults (change what doesn't fit)

- **Stack:** TypeScript on Node.js 22. API: Fastify. Web: React + Vite. Database: PostgreSQL (SQLite is fine for local development). Tests: Vitest. Lint and format: ESLint + Prettier.
- **Repository:** one repository with `api/` and `web/`, and npm scripts `typecheck`, `lint`, `test`, `build` and `seed` at the root.
- **Time zone and locale:** Europe/Stockholm. Times are stored in UTC and shown in local time. Swedish user interface, dates as 2026-11-02, amounts in SEK.
- **Sign-in:** email and password with server sessions, and roles as above. No social login, no self sign-up unless a feature asks for it.
- **Seed data:** `npm run seed` creates demo data and one admin. The admin's email is `admin@example.com`; the password is read from the `SEED_ADMIN_PASSWORD` environment variable and never committed.
- **CI:** a GitHub Actions workflow runs lint, typecheck, test and build on every pull request.
- **Accessibility:** keyboard use, labels on every field, and colour contrast at WCAG 2.1 AA.
- **Errors:** the user sees plain-language messages; the server logs the details.
- **Out of scope unless a feature below asks for it:** hosting and deployment, payments, sending email or SMS, mobile apps, and imports from other systems.

## Features

<!-- One heading per feature. Acceptance criteria are what QA tests, so make each one checkable. -->

### [Feature 1, e.g. Book a class]

- **User story:** As a [role], I want [goal], so that [benefit].
- **Rules:** [limits, who may do what, edge cases, e.g. "at most 1 booking per class", "cancel up to 2 hours before"].
- **Acceptance criteria:**
  1. [Observable outcome, e.g. "A member can book a class with free places; the place count goes down by one."]
  2. [Failure path, e.g. "Booking a full class shows 'Class is full' and books nothing."]

### [Feature 2]

- **User story:** …
- **Acceptance criteria:**
  1. …

## Data

- **[Entity, e.g. Class]:** [main fields, e.g. name, club, start time, capacity].
- **Existing data to import:** none. [If there is any: file format, an example row, and what counts as a duplicate.]

## Manual steps

<!-- Things agents can't do inside the repository. Say for each whether it should be automated (CI or a script) or done by hand. -->

- None. [Examples: create the production database, add secrets to GitHub, publish to an app store, load real member data.]

## Out of scope

- [What this project deliberately doesn't do.]

## Open decisions

- [Anything you haven't decided yet. The agents ask about these instead of guessing.]
