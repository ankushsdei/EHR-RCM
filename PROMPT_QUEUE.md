# Claude Desktop Execution Queue

## Batch 0: Repository Base Configuration & Tooling Setup
**Prompt to Copy into Claude Desktop:**
> You are a Staff Engineer. Generate the foundational boilerplate files for a Node.js (TypeScript) + React (Vite) + Prisma project:
> 1. `package.json` with Express, Prisma, @prisma/client, Zod, bcryptjs, jsonwebtoken, dotenv, Vitest, supertest, and React dependencies.
> 2. `tsconfig.json` configured for ES2022, strict mode, and path alias `@/` mapping to `./src/`.
> 3. `vitest.config.ts` configured for testing Node.js backend services and React UI components.
> 4. `.env.example` containing placeholder connection strings and API keys.
> 5. `.gitignore` ignoring node_modules, .env, build output, and dist.

---

## Batch 1: System Core & Shared Architecture (Tasks T01 - T04)
**Prompt to Copy into Claude Desktop:**
> Read `DEVELOPMENT_MATRIX.csv` in project root and implement **Tasks T01, T02, T03, and T04**:
>
> 1. **T01 (`prisma/schema.prisma`)**: Unified Prisma schema supporting `User`, `AuditLog`, `ConsentLog`, `Resource`, `Customer`, `ServiceItem`, `Appointment`, `Encounter`, `EncounterDiagnosis`, `EncounterProcedure`, and `Claim`. Include `pgvector` extension support for clinical RAG.
> 2. **T02 (`src/config/env.config.ts`)**: Zod schema validating required `.env` environment variables (`DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
> 3. **T03 (`src/config/pod.config.ts`)**: Type-safe configuration exporting `domainMode` ('HEALTHCARE' | 'SALON' | 'GENERIC'), `compliance` flags (hipaa, gdpr, dpdpa), and security settings (`encryptSensitiveData`).
> 4. **T04 (`src/shared/db/prisma.ts`)**: Extended Prisma Client using `$extends` middleware to perform dynamic AES-256-GCM encryption/decryption on sensitive fields (`ssn`, `phone`, `address`) whenever `podConfig.security.encryptSensitiveData === true`.
> 5. **Unit Tests**: Create `tests/schema.test.ts`, `tests/config/env.test.ts`, `tests/config/pod.test.ts`, and `tests/shared/prisma-crypto.test.ts`.

---

## Batch 2: Auth Pod & Compliance Middleware (Tasks T05 - T06)
**Prompt to Copy into Claude Desktop:**
> Implement **Tasks T05 and T06** inside `src/pods/auth/`:
>
> 1. **T05 (`src/pods/auth/backend/auth.router.ts`)**: Express router providing `POST /api/v1/auth/login`, `POST /api/v1/auth/register`, and `POST /api/v1/auth/logout`. Store JWTs in HttpOnly cookies with `sameSite: 'strict'`.
> 2. **T06 (`src/pods/auth/backend/auth.middleware.ts`)**: 
>    - `checkRole(allowedRoles)` middleware.
>    - `hipaaAuditLogger` middleware that automatically writes access records to the `AuditLog` database table whenever PHI routes are accessed.
> 3. **POD Manifest**: Create `src/pods/auth/POD_MANIFEST.json`.
> 4. **Tests**: Create `src/pods/auth/backend/__tests__/auth.test.ts` using Vitest and Supertest.

---

## Batch 3: Scheduling Pod & Domain Adapters (Tasks T07 - T10)
**Prompt to Copy into Claude Desktop:**
> Implement **Tasks T07, T08, T09, and T10** inside `src/pods/scheduling/`:
>
> 1. **T07 (`src/pods/scheduling/backend/slot-calculator.service.ts`)**: Time-slot calculation algorithm that calculates available appointment windows based on resource schedules, buffer times, and existing bookings.
> 2. **T08 (`src/pods/scheduling/backend/scheduling.router.ts`)**: REST endpoints (`GET /slots`, `POST /appointments`, `PATCH /appointments/:id/status`).
> 3. **T09 (`src/pods/scheduling/backend/adapters/health.adapter.ts`)**: Listens to appointment status transitions (`CHECKED_IN`). If `podConfig.domainMode === 'HEALTHCARE'`, automatically creates a clinical `Encounter` record in PostgreSQL.
> 4. **T10 (`src/pods/scheduling/backend/adapters/generic.adapter.ts`)**: Adapter for non-healthcare modes (e.g., handling Stripe deposit status or webhook notifications).
> 5. **Tests**: Unit and integration tests covering slot calculations and adapter events.

---

## Batch 4: Clinical Core & Ambient AI Scribe Pod (Tasks T11 - T12)
**Prompt to Copy into Claude Desktop:**
> Implement **Tasks T11 and T12** inside `src/pods/clinical/`:
>
> 1. **T11 (`src/pods/clinical/backend/scribe-ai.service.ts`)**: Service that streams audio input to OpenAI Whisper API, then pipes transcript text into Claude 3.5 Sonnet to output structured JSON SOAP notes (`subjective`, `objective`, `assessment`, `plan`).
> 2. **T12 (`src/pods/clinical/backend/rag-guidelines.service.ts`)**: Clinical decision support system utilizing Prisma `$queryRaw` to perform cosine similarity searches on `pgvector` embeddings for evidence-based guidelines.
> 3. **Tests**: Mock external OpenAI and Anthropic API calls in `src/pods/clinical/backend/__tests__/scribe.test.ts` to test parsing logic cleanly.

---

## Batch 5: Revenue Cycle Management (RCM) Pod (Tasks T13 - T16)
**Prompt to Copy into Claude Desktop:**
> Implement **Tasks T13, T14, T15, and T16** inside `src/pods/rcm/`:
>
> 1. **T13 (`src/pods/rcm/backend/cac-coder.service.ts`)**: Computer-Assisted Coding service using Claude 3.5 Sonnet to parse signed SOAP notes and populate `EncounterDiagnosis` (ICD-10) and `EncounterProcedure` (CPT) with `aiSuggested: true`.
> 2. **T14 (`src/pods/rcm/backend/claim-scrubber.service.ts`)**: Pre-submission validator that checks CCI mutually exclusive edit rules and calculates a `scrubRiskScore` (0.0 to 1.0).
> 3. **T15 (`src/pods/rcm/backend/edi837-generator.service.ts`)**: Constructs ANSI X12 EDI 837P (Professional Claim) batch string files from patient, encounter, and billing database records.
> 4. **T16 (`src/pods/rcm/backend/edi835-parser.service.ts`)**: Electronic Remittance Advice (ERA) parser that ingests incoming ANSI X12 EDI 835 text strings and posts payments or denials (`PAID` / `DENIED`).
> 5. **Tests**: Comprehensive unit tests covering X12 837 formatting and X12 835 remittance parsing.

---

## Batch 6: Compliance Erasure & Dynamic Frontend App Shell (Tasks T17 - T18)
**Prompt to Copy into Claude Desktop:**
> Implement **Tasks T17 and T18**:
>
> 1. **T17 (`src/pods/compliance/backend/anonymizer.service.ts`)**: Data Subject Right-to-be-Forgotten erasure pipeline adhering to GDPR/DPDPA. Replaces personal identifier fields with anonymous hashes while maintaining audit logs and clinical record retention policies.
> 2. **T18 (`src/app/client/AppShell.tsx`)**: React App Shell component that reads `podConfig.ts` to dynamically register navigation routes, sidebar menu options, and UI density depending on whether `domainMode` is set to `HEALTHCARE` or `SALON`.
> 3. **Tests**: Erasure pipeline logic tests and UI component rendering tests using React Testing Library/Vitest.
