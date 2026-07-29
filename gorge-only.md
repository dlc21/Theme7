# Theme7

Theme7 is one installable MIT-licensed application for operating AI-assisted work in real folders. Its interface, terminology, providers, onboarding, and visual identity are built in; there is no separate theme or stock distribution to select.
## What is included

- Folder-backed lanes with contained Files, Git, terminal, and Browser access.
- Short-lived signed terminal capabilities bound to one lane, pane, provider, and generation.
- OMP and Shell provider choices. Source installs consume operator-supplied OMP; the container pins OMP and Codex binaries but never carries provider credentials.
- Data-only recipes and editions, saved pane layouts, local HTML preview, and explicit HTTP(S) Browser handoff.
- Source, standalone, and Docker Compose paths.

## See theme7 in motion

[![Watch the full 23-second theme7 showpiece preview](https://raw.githubusercontent.com/dlc21/video-factory/main/media/theme7-showpiece-preview.gif)](https://github.com/dlc21/video-factory/blob/main/media/theme7-showpiece.mp4)

**[Open the full-resolution standalone theme7 MP4](https://github.com/dlc21/video-factory/blob/main/media/theme7-showpiece.mp4)**

The 23-second source-driven cut shows three real interaction patterns: switching jobs, moving between folder-scoped Files and Git tools, and dragging a Browser pane into a working job. The Gorge comedy film and complete Remotion/TTS source live in the standalone [Video Factory](https://github.com/dlc21/video-factory).

## Source setup

Prerequisites:

- Windows, macOS, or glibc-based Linux
- Node.js 24 LTS
- npm 10 or 11
- Git
- Optional OMP CLI for the Agent terminal

### Install prerequisites

On Windows or macOS, install [Node.js 24 LTS](https://nodejs.org/en/download) and [Git](https://git-scm.com/downloads), then confirm the versions below.

For a dependency-empty Ubuntu 24.04 machine, the reviewed path uses NodeSource's signed Node 24 apt repository. Run these commands in a root shell (`sudo -s` on a normal VM):

```sh
apt-get update
apt-get install -y ca-certificates curl gnupg git
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /tmp/nodesource-repo.gpg.key
gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg /tmp/nodesource-repo.gpg.key
rm /tmp/nodesource-repo.gpg.key
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs
```

Leave the root shell before continuing. Clone and run Theme7 as your normal user.

NodeSource is a third-party distribution channel. If local policy requires official Node.js binaries, use the Node.js download above instead.

Confirm Node 24, npm 10 or 11, and Git before continuing:

```sh
node --version
npm --version
git --version
```

### Install Theme7

Copy the HTTPS URL from the repository host, replace `REPOSITORY_URL` below, and enter the clone:

```sh
git clone REPOSITORY_URL theme7
cd theme7
```

From the repository root:

```sh
npm ci
npm run setup
npm run doctor
npm run dev
```

Open the loopback URL printed by the development server.

`npm run setup` creates ignored local data and environment files with terminal-signing material. It does not install tools, move workspace files, authenticate providers, or print secrets.

For a source install, manage provider CLIs and authentication yourself. For example:

```sh
npm install --global @openai/codex
```

Authenticate inside the relevant Agent terminal. Provider credentials remain owned by the provider CLI.

## Basic workflow

1. Choose the folder that contains the work.
2. Open an Agent terminal or Shell terminal.
3. Use Files and Git context to inspect changes.
4. Add, split, tab, or close panes without moving the folder's files.
5. Open a workspace-local HTML file or explicit HTTP(S) URL in Browser.

Removing a lane stops its owned terminals and removes local presentation state. It does not delete the folder or its Git history.

## Containers

Generate the ignored Compose secret, then start Theme7:

```sh
npm run setup
docker compose up --build --wait
```

`npm run check:container` builds, tests, and removes the Theme7 image. It verifies the application runtime, exact bundled OMP and Codex versions, absence of provider credentials, and cleanup.

## Local data and network safety

SQLite stores local indexes, folder references, terminal bindings, and presentation state. The default database is `theme7.sqlite` under the configured data directory. Workspace files and Git remain canonical.
Theme7 binds to loopback by default. Production mode requires an explicit open or password access mode; the supplied Compose path uses password sessions, but it is still a single-host community runtime rather than a hardened public service. Read [SECURITY.md](SECURITY.md) before changing network exposure or mounting credentials into a container.

## Status and licenses

Theme7 is MIT-licensed under [LICENSE](LICENSE), with copyright retained by its copyright holder. Dependencies retain their own licenses.
Development commands, the developer-only local train, and validation gates are documented in [BUILDING.md](BUILDING.md). Architecture and invariants are in [ARCHITECTURE.md](ARCHITECTURE.md); extension scope is in [EXTENDING.md](EXTENDING.md).
