# Building and validation

## Source install

Use Node.js 24 LTS, npm 10 or 11, and Git.

```sh
npm ci
npm run setup
npm run doctor
npm run dev
```

The default configuration binds to loopback. Machine state belongs in ignored `.env.local`; the generated Compose-only terminal secret belongs in ignored `.env.compose`. Never commit either file.

Source setup does not install provider CLIs. Install and authenticate OMP through its supported flow. Shell remains the fallback.

## Application boundary

Theme7 has one application identity and one release surface. Its visual language, terminology, onboarding, OMP integration, and pane catalog are built in; there is no stock or themed build selector. OMP itself remains operator-supplied.

## Focused and full checks

Use the narrowest check that covers an edit while iterating:

```sh
npm test
npm run typecheck
npm run build
npm run check:public-surface
npm run check:release-surface
npm run check:source-package
```

Before handoff:

```sh
npm run validate:local
```

This runs worktree, runtime-target, recipe, release-surface, brand, build-surface, runtime-file, source-package, embedded identity, adapter, shell, terminal lifecycle, type, unit, and production-build gates. Browser and container checks remain explicit because they require their external runtimes.

## Browser acceptance

Browser acceptance starts isolated web and relay processes with isolated data. Run:

```sh
npm run test:browser
```

Browser acceptance exercises the same Theme7 application identity as source and container builds.

Optional isolated overrides:

- `OPERATOR_ENGINE_TEST_PORT`
- `OPERATOR_ENGINE_TEST_TERMINAL_PORT`
- `OPERATOR_ENGINE_TEST_DATA_DIR`

Never point browser checks at a runtime that owns real folders or sessions. Review UI changes at `1280×900` and `577×900` for overflow, reachable primary actions, and deliberate empty and error states.

## Standalone packages

```sh
npm run build
npm run start
npm run package:standalone
```

The standalone packager copies runtime files from the same central allowlist used by Docker. It refuses to overwrite an existing destination and writes a hashed `artifact.json` receipt. Production startup requires `OPERATOR_ENGINE_TERMINAL_SECRET`.

## Containers

Docker with Compose is required:

```sh
npm run setup
npm run check:container
```

The check builds and runs the single `runtime` target on isolated host ports. It verifies the Theme7 identity, pinned Bun, OMP, and Codex tooling, absence of bundled OMP credentials or authentication state, health endpoints, browser-to-relay port identity, packaged runtime files, and cleanup.

Compose builds the same `runtime` target. Its service reads only generated terminal-signing and access-control secrets from `.env.compose`; it has no static secret fallback.

## Developer-only local train

`npm run train` is maintainer tooling for isolated source iteration. It is not an application feature, deployment system, remote controller, or release authority.

The train keeps ignored state under `OPERATOR_ENGINE_TRAIN_ROOT` or `~/.operator-engine/dev-train` and uses three loopback-only profiles:

- Workshop: source/HMR on `4500/4501`
- Candidate: immutable local package on `4450/4451`
- Daily: durable local package on `4600/4601`

Common commands:

```sh
npm run train -- init
npm run train -- workshop start
npm run train -- candidate build
npm run train -- candidate start
npm run train -- status
```

Promotion, rollback, and Daily port moves require explicit confirmations. They operate only on the local train's owned processes and data. The train never pushes Git, publishes an image, changes shared infrastructure, changes DNS, or authorizes a release.

## Canonical environment variables

- `OPERATOR_ENGINE_HOST`: web bind host; defaults to loopback.
- `OPERATOR_ENGINE_TERMINAL_HOST`: relay bind host; defaults to the web host.
- `OPERATOR_ENGINE_PORT`: web port.
- `OPERATOR_ENGINE_TERMINAL_PORT`: terminal relay port.
- `OPERATOR_ENGINE_DATA_DIR`: local application data.
- `OPERATOR_ENGINE_DB_PATH`: SQLite path; defaults to `theme7.sqlite` under the data directory.
- `OPERATOR_ENGINE_WORKSPACE_ROOT`: primary allowed folder root.
- `OPERATOR_ENGINE_WORKSPACE_ROOTS`: additional allowed roots, separated by the platform path delimiter.
- `OPERATOR_ENGINE_TERMINAL_SECRET`: terminal capability signing secret.
- `OPERATOR_ENGINE_CODEX_BIN`: optional Codex executable override.
- `OPERATOR_ENGINE_OMP_BIN`: optional OMP executable override.
- `OPERATOR_ENGINE_T4_URL`: optional HTTP(S) endpoint for the built-in T4 pane.

Legacy environment aliases are not supported. Never commit secrets, credentials, populated data directories, provider authentication state, generated receipts from local runs, or local train state.
