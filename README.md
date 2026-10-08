# CareerLift

CareerLift is a local job application workspace: discover jobs, create one owned application per job, inspect its form, prepare candidate information, resolve Human Review, execute controlled local fixtures, and independently verify submission outcomes. Greenhouse, Lever and Ashby reuse the existing resolver and browser execution engine. PostgreSQL and BullMQ remain authoritative; the UI presents their records and audit history.

Real execution is disabled by default. CAPTCHA, authentication and unsupported platforms stop automation. Unknown submissions are never automatically submitted again. Local email login is development behavior and does not verify email ownership.

Start with [Local development](docs/local-development.md) for exact PostgreSQL/Redis, environment, migrations, API, worker and web commands. It also documents the complete controlled Chromium acceptance flow (`pnpm test:mvp:e2e`) and all regression commands.

The application contains Home, Jobs, Applications, Profile, Documents, Verified Answers and Human Review. Job descriptions are rendered as untrusted text. Candidate data and application operations remain authenticated and ownership scoped. Browser/session, storage and verification internals are excluded from public product views.

Sync Jobs supports the official free [Carrerlift MCP](https://github.com/prakhar1605/carrerlift-mcp), configured through `CAREERLIFT_MCP_URL` in `.env`. No API key is needed. The default sync reads up to 24 live Indian listings and their application details; optional search filters and page count are documented in [Local development](docs/local-development.md). With both MCP and REST URLs empty, sync uses the 15 demo fixtures.

| Workspace                     | Responsibility                                                        |
| ----------------------------- | --------------------------------------------------------------------- |
| apps/web                      | Next.js product UI and safe backend-derived progress                  |
| apps/api                      | Fastify authentication, owned commands and safe read projections      |
| apps/worker                   | Existing BullMQ lifecycle processors and recovery                     |
| packages/domain               | Plans, contracts, lifecycle and safety rules                          |
| packages/application-resolver | Existing resolver with Greenhouse, Lever and Ashby knowledge adapters |
| packages/browser              | Inspection, guarded execution, storage and independent verification   |
| packages/database             | Prisma persistence, migrations and concurrency controls               |
| packages/validation           | CareerLift ingestion and normalization                                |
| tests                         | Controlled local fixtures and regression/acceptance infrastructure    |

See [Phase 10 plan](docs/phase-10-plan.md), [architecture](docs/architecture.md), [execution safety](docs/application-execution.md), and [Phase 9 ATS integration](docs/phase-9-completion.md).

Production authentication, deployment, object storage, additional ATS platforms and other major features remain post-MVP work.

Email applications now have a Gmail OAuth connection, title-based resume selection, a Profile email template, Gemini personalization, and per-email approval controls. See [Email automation setup and workflow](docs/email-automation.md).

Candidate questions across ATS portals, employer portals, Google Forms, and email use the shared Gemini answer pipeline before Human Review. The full saved candidate profile, selected resume text, and questions provide context; supported generated answers at or above `ANSWER_CONFIDENCE_THRESHOLD_PERCENT=75` are used automatically. Approved review answers are saved immediately to Verified Answers. See [Shared candidate answers](docs/answer-pipeline.md).
