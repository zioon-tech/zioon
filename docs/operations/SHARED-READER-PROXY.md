# Shared reader production routes

`workbench.zioon.tech` serves Workbench assets directly and delegates `/v1` requests to Runtime. The public conversation reader also requires `/share` and `/share/*` to reach Runtime, including the content, image, access-request and visitor endpoints.

The `Shared reader proxy` workflow adds this bounded route using the existing production OIDC role. It accepts only a successful main-branch Zioon CI run for its own exact commit. It never uses a local build, a PR artifact or stored cloud keys.

```sh
gh workflow run share-proxy.yml --repo zioon-tech/zioon --ref main \
  -f ci-run=<successful-main-ci-run-id> -f check-only=true
# Once Runtime has been released from that CI run and preflight has passed:
gh workflow run share-proxy.yml --repo zioon-tech/zioon --ref main \
  -f ci-run=<same-main-ci-run-id> -f check-only=false
```

Preflight requires one unambiguous canonical Workbench site, preserves the existing routes and validates the planned Caddy JSON without changing active configuration. Application backs up the original source, replaces it atomically while preserving ownership and permissions, validates the complete Caddyfile, and reloads Caddy. It checks the public content and visitor endpoints with an unavailable link and verifies `/health`. A failure restores the original file and reloads the previous configuration.

Backups and an fsync-backed operation journal are retained under `/var/backups/zioon-share-proxy/`. Concurrent edits, an ambiguous site, an unexpected existing matcher or an unknown cloud invocation outcome require reconciliation rather than another blind command submission. Repeated application of the expected configuration performs validation without another reload.

Release Memory first, then Runtime, then the proxy route, then Workbench. Workbench and Runtime must continue to use the same successful main CI artifacts. This route operation does not restart either application service, change account data or modify another site's routing.
