# CareerLift

CareerLift is a local job application workspace: discover jobs, create one owned application per job, inspect its form, prepare candidate information, resolve Human Review, execute controlled local fixtures, and independently verify submission outcomes. Greenhouse, Lever and Ashby reuse the existing resolver and browser execution engine. PostgreSQL and BullMQ remain authoritative; the UI presents their records and audit history.

Real execution is disabled by default. CAPTCHA, authentication and unsupported platforms stop automation. Unknown submissions are never automatically submitted again. Local email login is development behavior and does not verify email ownership.

Ashby submission uses its hosted GraphQL form engine, including approved answer values, résumé upload capabilities and a typed server response. The worker binds each request to the prepared application and sends it once. The verification worker reconciles Ashby's acceptance or validation rejection; a dropped response stays unknown. CAPTCHA-enabled Ashby forms support a visible browser flow when `ASHBY_BROWSER_ASSISTED_ENABLED=true` (the default) and real execution is enabled. Review the prepared answers, authorize submission, and click **Open assisted Ashby browser**. The worker opens a dedicated browser on its computer, fills the native fields, and uploads the selected résumé. Click the employer's Submit button and complete any verification yourself, then promptly click **Continue Ashby application** in CareerLift. The employer receives the final submission only after continuation. Verification stays in memory and is never saved to the database. Closed or expired browser sessions can be reopened before submission, restoring prepared values; uncertain submissions cannot be repeated. Surveys and unsupported controls retain the employer-site handoff. Existing Ashby inspections can be refreshed with **Retry form inspection**; preparation must then be rerun against the new requirements.

Set `EXECUTION_ALLOW_REAL=true` and `EXECUTION_AUTO_SUBMIT=true` to submit supported applications automatically after preparation and all required reviews complete. Set `EXECUTION_AUTO_SUBMIT_SINCE` to an ISO UTC activation timestamp so recovery survives restarts without submitting older prepared applications. API and worker must use the same configuration and restart after changing it. Without automatic submission, the application page exposes a confirmation checkbox and **Submit application**. Local fixtures remain isolated from real execution. Run `pnpm test:ashby`, `pnpm test:ashby:e2e` (with local PostgreSQL), and `pnpm typecheck:ashby` to check this path.

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
