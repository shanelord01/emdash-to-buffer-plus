---
name: creating-plugins
description: Build, test, and publish this sandboxed EmDash plugin. Use for changes to emdash-plugin.jsonc, src/plugin.ts, hooks, routes, capabilities, storage, Block Kit admin UI, bundling, or releases.
---

# Creating EmDash plugins

Read `emdash-plugin.jsonc` and `src/plugin.ts` before editing. The manifest is the identity and trust contract; the source contains runtime hooks and routes.

## Runtime rules

- Assign the runtime definition to a `SandboxedPlugin`-typed constant and export it as default from `src/plugin.ts`.
- Use Web APIs. Do not import Node.js built-ins into plugin runtime code.
- Declare every runtime API in `capabilities` and every network destination in `allowedHosts`.
- Use `ctx.storage` for queryable records and `ctx.kv` for key-value state.
- Use Block Kit for sandboxed admin UI. Do not ship browser React components.
- Treat public routes as internet-facing and validate their inputs.

## Validation

Use the package scripts in this repository. The test script builds the plugin and runs it inside workerd through EmDash's production sandbox wrapper and host bridge. Use `createPluginTestHost()` to invoke hooks and routes, create content fixtures, and inspect plugin KV or declared storage. Dispose the host after each test so its bindings reset.

Before handing off a change, run validation, typecheck, tests, and build. A release also requires a version bump in `package.json` when runtime behavior or the trust contract changes.

## Publishing

Use the local publish script for a release started from this computer. Use the release-setup script for GitHub Actions. Setup detects a root Changesets configuration and offers to follow packages released by Changesets; otherwise it uses package tags. Connect the generated reusable workflow to the existing Changesets publish job by passing its published-package output. Changesets Action v1 names the step output `publishedPackages`; v2 names it `published-packages`. Expose it as a `published-packages` job output and pass it to the generated workflow from a dependent job when Changesets reports `published == 'true'`. The first automated release connects the repository workflow; later packages reuse it only when their signed profiles name the same repository.

For complete EmDash patterns and API details, use https://docs.emdashcms.com/plugins/creating-plugins/.
