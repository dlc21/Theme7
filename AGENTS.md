# Operator Engine

- A lane is a folder reference; its ordinary files and Git repository are canonical.
- Durable user knowledge belongs in ordinary files and Git. Layout is presentation state.
- New capability should normally be a reviewed pane, a harness adapter, or a data-only recipe.
- Do not casually add tasks, objectives, knowledge databases, orchestrators, plugin runtimes, telemetry, or control planes.
- Preserve Windows, macOS, and Linux operation; directory containment; signed terminal access; deliberate empty and error states; Shell-only operation; and lane removal without file deletion.
- Never include secrets, credentials, or sensitive personal or business data.
- Keep repository validation explicit and reproducible. A passing source check does not authorize publication, deployment, routing, or runtime mutation.
- Run `npm run validate:local` before handoff. Run the browser and container checks in [BUILDING.md](BUILDING.md) when a change touches those boundaries.
- Every commit must be authored and committed only by David Lin-Clark using the DLC21 GitHub noreply identity. AI author, committer, and `Co-Authored-By` attribution is forbidden. `npm run check:commit-identity` enforces the complete reachable history.

Use isolated local processes and disposable data when reproducing behavior. Do not restart, deploy to, or alter an unrelated running instance from routine source development.

## Worktree ownership

- `worktree-policy.json` is the machine-checked source of truth. The clean root on `main` is the canonical application worktree; no repository anchor or temporary worktree is registered.
- Do not create a worktree unless the user explicitly requests parallel agent work. Before creation, commit a `temporaryWorktrees` entry naming the branch, owner, one bounded outcome, and absolute `removeAfter` date.
- The creator owns the full lifecycle: keep the worktree clean at handoff, merge or reject its result, remove the worktree and branch, and remove its declaration in the same task.
- Never leave uncommitted work in another worktree, retain a merged worktree, or bypass the checker with force-removal or an environment escape.
- Run `npm run check:worktrees` before handoff. It is also part of `npm run validate:local`.

## Low-cognitive-load product rule

Build for a tired power user. Present one obvious next action and the minimum information required to take it. Prefer deletion, strong defaults, and progressive disclosure.

- The shell or modal is usually the container. Establish hierarchy with typography, spacing, alignment, and quiet dividers rather than nested bordered cards.
- Do not require a decision when a safe default exists or the decision belongs at the point of use.
- Lead with the concrete action. Say “Choose a folder” before introducing product terminology.
- Give each line one job. Do not repeat the same idea in headings, helpers, and empty states.
- Describe results and material side effects, not implementation.
- Use **folder** in product copy and reserve **directory** for technical errors and documentation.
- Avoid minimizing words such as “just,” “simply,” and “obviously.”
- Name primary actions by outcome: “Choose folder,” “Open Codex,” or “Add Files,” not “Continue” or “Done.”
- Empty and error states must say what happened, what the operator can do next, and whether work is safe.
- Before handoff, review changed surfaces as a tired first-time user. Remove decisions, labels, borders, and repeated ideas that are not needed to understand what to do, what will happen, and what will not happen.
