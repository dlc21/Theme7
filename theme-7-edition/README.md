# Theme7 application assets

This directory contains Theme7's built-in visual language, onboarding, starter, and OMP adapter. These assets are part of the Theme7 application; they are not a selectable theme or a separate distribution.

The application adapter consumes an installed OMP CLI but never authenticates it or reads its credentials. Source installs remain operator-supplied; the official Theme7 container pins and includes OMP, with authentication retained only in the container's persistent home.

The package test verifies the bounded application assets, adapter behavior, and exact OMP session-identity handshake used by the unified application.
