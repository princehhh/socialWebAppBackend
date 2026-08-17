# SocialVoice Backend

## What This Project Is

- Language: TypeScript (Node.js)
- Framework: Express
- Database: PostgreSQL via Prisma ORM
- API Style: REST JSON with a standard envelope (`success`, `message`, `data`)
- Auth: JWT + session table
- Architecture: Modular service with provider adapters and config-driven business rules

## Why This Architecture

- Provider pattern makes voice backends replaceable (LiveKit/Zego/Agora).
- Config-first design keeps rules outside source code for easy updates.
- Prisma keeps data model portable across PostgreSQL providers.

## Key Folders

- `src/config`: env + app/failover config loading and validation
- `src/providers`: pluggable provider interfaces/adapters
- `src/middleware`: authentication middleware
- `src/utils`: logger, analytics, API envelope helpers
- `prisma`: schema for users, wallets, calls, reports, blocks, sessions
- `prisma`: schema for users, wallets, calls, reports, blocks, sessions, chat messages
- `config`: business config and failover config JSON files

## Run Locally

1. Copy `.env.example` to `.env`
2. Set `DATABASE_URL` and `JWT_SECRET`
3. Install: `npm install`
4. Generate Prisma client: `npx prisma generate`
5. Push schema: `npx prisma db push`
6. Start dev server: `npm run dev`

## API Docs (Swagger)

- Swagger UI: `http://localhost:4000/api-docs`
- OpenAPI JSON: `http://localhost:4000/api-docs.json`

## Key Auth + Calling Endpoints

- `POST /api/v1/auth/mobile-login`
- `POST /api/v1/auth/mobile-signup`
- `GET /api/v1/auth/session` (restore persisted mobile session)
- `POST /api/v1/calls/request`
- `GET /api/v1/calls/incoming`
- `POST /api/v1/calls/respond`
- `GET /api/v1/calls/status/:callId`
- `POST /api/v1/calls/complete`

## Chat Endpoints (Feature-flagged)

- `POST /api/v1/chat/messages`
- `GET /api/v1/chat/messages/:peerUserId`
- `GET /api/v1/chat/unread-count`

## Feature Flags and Call Types

- Feature flags are configured in `config/app.config.json`
- `enableChat`: enables/disables all chat APIs and chat UI in mobile app
- `enableVideoCall`: enables/disables video call requests and video UI in mobile app
- `POST /api/v1/calls/request` now accepts `callType` (`VOICE` or `VIDEO`)

## Quick Learning Keywords

- `Express middleware`
- `Prisma schema relations`
- `JWT auth flow`
- `Adapter pattern`
- `Config-driven architecture`
