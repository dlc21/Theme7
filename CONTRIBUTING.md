# Contributing to Theme7

Thanks for helping. Keep changes small, direct, and easy to verify.
Repository commits are made only by David Lin-Clark through the DLC21 GitHub identity. Do not add AI authors, AI committers, or `Co-Authored-By` trailers.

## Setup

Theme7 requires Node.js 24 LTS, npm 10 or 11, and Git.

```sh
npm ci
npm run setup
npm run doctor
npm run dev
```

`npm run setup` creates ignored local configuration and data paths. It does not install or authenticate OMP or another provider.

## Before a pull request

Run the local gate:

```sh
npm run validate:local
```

If the change touches browser behavior, also run `npm run test:browser`. If it touches containers or deployment examples, run the matching explicit check documented in [BUILDING.md](BUILDING.md).

## Pull requests

- Keep one coherent change per pull request.
- Explain the behavior changed and the exact command or scenario used to verify it.
- Follow the existing implementation instead of adding a parallel mechanism.
- Add or update a test when behavior changes.
- Keep real folders and Git authoritative; never make local presentation state the only copy of user work.

## Logs, local data, and secrets

Redact diagnostics before attaching them. Never publish credentials, provider authentication, terminal-signing material, private paths, hostnames, project names, populated databases, OMP session content, or another person's data. Rotate any live credential that is exposed.

## Bugs and security reports

Normal defects may use GitHub issues. Include the version, operating system, install method, reproduction steps, and observed result.

Do not open a public issue for an unpatched security problem. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under Theme7's [MIT license](LICENSE).
