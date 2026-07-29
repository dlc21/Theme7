# Project context

## Read order

1. `NOW.md` for the current milestone, next actions, and blockers.
2. `README.md` for product outcome, users, and getting started.
3. `ARCHITECTURE.md` for system boundaries and consequential choices.
4. `BACKLOG.md` and `DECISIONS.md` for ready work and dated decisions.
5. Root `AGENTS.md` and this file for harness instructions.

## Source of truth

Ordinary repository files and Git are canonical. Do not invent a parallel task database, knowledge store, or control plane. Prefer small Markdown updates over new structure.

## Project orientation

Capture and keep current:

- **Outcome** — what shipping this product changes for users
- **Users** — who it serves and the jobs it must support
- **Architecture** — runtime, boundaries, and delivery target
- **Work status** — active milestone in `NOW.md`; ready/later work in `BACKLOG.md`

## Validation

Validate in proportion to the change. Prefer the repository's own commands and checks. Do not claim completion without observed proof from those checks or a direct smoke of the changed path.

## Decisions

Record consequential product and engineering choices in `DECISIONS.md` with enough context to reopen later. Leave transient scratch out of durable files.
