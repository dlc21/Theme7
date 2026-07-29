# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Anything older | No |

## Reporting a vulnerability

**Do not open a public issue for an unpatched security problem.**

Use [GitHub private vulnerability reporting](https://github.com/DLC21/Theme7/security/advisories/new). Include the affected version and platform, reproduction steps or a proof of concept, impact, and redacted diagnostics. Never include credentials, provider authentication, terminal-signing material, private paths, project data, or another person's data.

This is a small project. Reports will be reviewed, but no fixed response time is promised.

## Network boundary

Theme7 has no public-internet authentication layer. It binds to `127.0.0.1` by default. Do not expose the web or terminal-relay port directly to an untrusted network.

A non-loopback bind is an explicit trust decision. Put both ports behind an authenticated boundary that supports WebSocket upgrades. A private address or TLS certificate alone is not application authentication.

## Command and folder authority

A terminal has the authority of the operating-system user running Theme7 within the selected folder. OMP and Shell may read that folder, execute commands, and use credentials already available to that process.

Folder selection, file access, previews, and terminal working directories are constrained to configured workspace roots. Real-path checks reject traversal and symbolic-link escapes. Adding a workspace root grants folder-selection and terminal authority beneath it.

Terminal startup requires a short-lived signed capability bound to one lane, pane, provider, action, and generation. Treat the terminal secret, provider authentication, SSH material, Git credentials, OMP session files, and persisted home directories as secrets.

Theme7 does not collect provider credentials. Source setup does not install or authenticate OMP. The official container image includes the pinned OMP CLI but contains no provider credentials or authentication state; authenticate from inside the persistent container home when OMP access is required.

## Local state and Browser

SQLite contains local references, terminal bindings, and presentation state. Workspace files remain outside the database. Do not publish populated data directories, database backups, generated environment files, local train state, or logs.

Local Browser file mode serves only an explicitly selected workspace-local HTML file and allowed static assets. It rejects traversal, symbolic links, hidden or credential-like files, and unsupported types. Restrictive response headers reduce risk, but Browser is not a hardened sandbox for untrusted code. A terminal process already has broader authority.

Removing a lane may stop only sessions belonging to that validated lane identity. It cannot create a process or delete workspace files.

## Packaging and deployment inputs

The Theme7 image contains the complete application but no OMP binary, provider credentials, or authentication state. Changes to dependency archives, package boundaries, containers, or deployment examples require the matching release checks. Never commit a real secret, credential, registry token, internal hostname, or deployment target.
