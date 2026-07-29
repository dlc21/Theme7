# Extension scope

Prefer fixes, deletion, and simplification over new concepts or surfaces.

Good changes include:

- correctness, security, accessibility, and cross-platform fixes;
- reducing visible decisions or duplicated explanations;
- data-only recipes and validated editions;
- improvements to existing reviewed panes;
- stronger containment, capability-signing, local-data, and package-boundary invariants;
- preserving Theme7's single application identity.

Propose a design before implementing a new runtime, provider, pane category, executable extension, or network surface. The proposal must explain the user action, durable state, security boundary, failure state, package boundary, and removal path.

Do not add:

- dynamic plugin loading or executable recipes;
- hosted control planes or remote agent managers;
- tasks, objectives, knowledge databases, or orchestration layers;
- telemetry or analytics;
- secrets, credentials, or sensitive data.

A change must preserve Shell-only operation when OMP is unavailable, ordinary folders and Git as canonical state, exact signed terminal ownership, Theme7's single application identity, and intentional Windows, macOS, and Linux behavior.
