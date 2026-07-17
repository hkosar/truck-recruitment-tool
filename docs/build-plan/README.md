# Build Plan — index

Execution-ready plan for the Twisted Nail Carrier Recruiter production build.
Executed by an Opus manager orchestrating Sonnet workers; owner gates: M0.4, M2.7, M6.

| File | What | Read when |
|---|---|---|
| `00-master-plan.md` | Milestones M0–M8, task cards, execution protocol, owner prereqs, risks | First, fully |
| `01-architecture.md` | Contract reconciliation (authoritative) · schema DDL/RPC/RLS/realtime · ingestion pipeline | M1/M2 tasks |
| `02-frontend-spec.md` | Screens v2, map integration, components, brand system, profile variants | M0/M3–M5 tasks |
| `03-feedback-resolution.md` | Owner-feedback contract (F1–F24 × resolution × landing spot) + decisions log | Before any UX judgment call |
| `04-costs.md` | Verified, cited service costs + cost-control rules | Provisioning + M6.5 |
| `05-verification.md` | DoD, gates, RLS matrix, E2E catalog, perf budgets, launch & email checklists | Every milestone gate |

Related: `../discovery-brief.md` (canonical requirements) · `../../mockup/` (clickable v1,
becomes v2 in M0) · `../../brand/` (logos + fonts).
