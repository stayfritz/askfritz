# askfritz

Personal AI chief-of-staff — handles correspondence, organizes documents, surfaces decisions.

**Kernprinzip:** Der Agent sortiert, organisiert, führt aus. Der User trifft die Entscheidungen.

## Status

v0 — under construction. Started 2026-05-29.

## What it does

- Reads incoming email via Gmail API + Pub/Sub push
- Classifies into Domains (Lebensbereiche) and Topics (Vorgänge)
- Updates a structured Life State (Postgres)
- Files attachments to Dropbox under a known folder structure (`/fritzai/<Domain>/<Topic>/<Year>/`)
- Drafts replies; sends only with user approval
- Surfaces open decisions to the user

## Stack

- Node.js 20+ / TypeScript / ESM
- Hono (web server)
- Drizzle ORM + Postgres 16+ (with `pgvector` for later)
- Anthropic Claude SDK
- Gmail API + Dropbox API
- Zod for schemas, tool-use, config validation

## Architecture

High-level: one assistant, multiple Domains (StayFritz Spain, Privat, Familie, ...). Single inbox/memory across all life areas.

Sketch: `Documents/personal-assistant-skizze.md`. Detailed: `docs/architecture.md` (TBD).

## Setup

See `docs/setup.md` (TBD).

## License

TBD (MIT planned when extracting OSS core).

