# Architecture

## Durable state

A lane is a reference to an ordinary folder. Its files and Git repository remain usable without Theme7 and are the canonical record of work. Removing a lane removes local presentation state and stops terminals owned by that lane; it does not delete the folder.

SQLite stores local indexes, lane references, terminal bindings, and presentation state in `theme7.sqlite` by default. It is not a knowledge store and does not replace ordinary files or Git history.

## Process and terminal boundary

The Next.js web process and terminal relay are separate listeners. The web process does not accept arbitrary terminal commands.

A terminal starts through a short-lived signed capability bound to one lane, pane, provider, action, and generation. The relay verifies the capability, resolves the selected folder through configured roots, and starts the process with that folder as its working directory. Existing ownership, exact-session attachment, and cleanup remain bound to the same lane and pane identities.

Path handling uses real-path containment and rejects symbolic-link escapes. A narrow loopback control endpoint can stop only sessions matching a validated lane identity; it cannot create a process or delete files.

Provider credentials remain owned by the provider command-line tool. Theme7 does not collect or copy them.

## Application identity

Theme7 has one built-in interface, terminology set, provider order, onboarding flow, and pane catalog. There is no stock application or selectable Theme Seven distribution. Source and standalone installs consume operator-supplied OMP; the container pins OMP and Codex binaries but never carries provider credentials. Shell remains available when OMP is absent.

The OMP adapter passes a reviewed identity extension explicitly on launch. OMP writes a nonce-bound identity record containing its real version, exact working directory, exact session id, and session-file path. Theme7 accepts that record only for the matching launch and uses OMP's real session metadata for exact resume. No product-level compatibility alias substitutes for this protocol.

## Panes, layouts, recipes, and editions

Reviewed panes provide terminal, Files and Git context, and Browser handoff. A layout is presentation state; it never becomes the durable location of user work.

Recipes are data-only declarations for initial files and pane layout. Editions are validated local presentation manifests. Neither can load arbitrary executable code, add a runtime, or bypass workspace containment.

## Browser handoff

Browser opens an explicitly selected workspace-local HTML file or an HTTP(S) URL. Local preview is contained to the workspace, rejects hidden and credential-like paths, and serves a narrow set of static types with restrictive headers. It is a review surface, not a hardened sandbox for untrusted code.

## Packaging and deployment examples

Source packages are generated from an explicit `package.json` allowlist. Docker uses a deny-by-default context and a separate exact runtime-file allowlist. One source package and one container target carry the same Theme7 application identity.

Compose consumes a generated secret-only environment file. Theme7 deliberately carries no Kubernetes, Helm, CloudFormation, ServerLab, or fleet-deployment surface; those belong to managed Operator Studio infrastructure.

## Invariants

- Ordinary folders and Git remain canonical.
- SQLite remains local index and presentation state.
- Terminal access requires signed, expiring, contained capabilities.
- Removing a lane never deletes its folder.
- Recipes and editions remain data-only.
- Theme7 has one application identity and release artifact.
- Shell-only operation remains supported when OMP is unavailable.
- Windows, macOS, and Linux behavior stays intentional.
- Build, package, and container inputs remain explicit and mechanically checked.
