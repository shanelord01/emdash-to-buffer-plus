# emdash-to-buffer-plus

EmDash to Buffer Plus: the package `emdash-to-buffer-plus`, and
`@shane.bsky.shas.am/emdash-to-buffer-plus` in the EmDash registry once it
is published there. It shares newly published entries to Buffer channels
through Buffer's GraphQL API with a personal API key, and tracks each
delivery.

It is based on `emdash-to-buffer-plugin` by Justin Thompson (MIT). Ideas
were reused, code was not: see the list of that plugin's bugs in the build
spec before borrowing anything from it.

Before editing this plugin, read `skills/creating-plugins/SKILL.md` completely. Codex discovers the same directory through `.agents/skills`; Claude discovers it through `.claude/skills` and reads these instructions through `.claude/CLAUDE.md`.
Keep `emdash-plugin.jsonc` aligned with the runtime implementation, declare every capability and host the plugin uses, and run the validation, typecheck, test, and build scripts after changes.

## Toolchain

`emdash` is a peer with a floor and no ceiling (`>=1.1.0`, the same as
`env:emdash` in the manifest). Never write the floor as `>=1.0.0` or
`^1.0.0`: npm carries an accidental, deprecated `emdash@1.0.0` published in
April 2026. Built with `@emdash-cms/plugin-cli@0.13.2`,
`@emdash-cms/plugin-test@0.2.7` and `@emdash-cms/blocks@1.1.0` (types only,
never in the runtime bundle). A plain `pnpm install` is enough.

## Layout

- `src/plugin.ts`: hooks, the cron dispatcher, the admin route (page and
  dashboard widget), the editor panel's route, the MCP tools' routes and
  their declarations.
- `src/buffer/`: the GraphQL client (`client.ts`), RateLimit headers
  (`ratelimit.ts`), the per-service rule table (`services.ts`), and how
  post metrics are read (`metrics.ts`).
- `src/publish/`: from a published entry to delivery records
  (`prepare.ts`), text fitting (`text.ts`), links and UTM (`url.ts`),
  images (`image.ts`), sending and the delivery runs (`pipeline.ts`), and
  the bridge-call meter (`budget.ts`).
- `src/store/`: KV (config, channel snapshot, state, report progress),
  delivery records, the editor panel's per-entry overrides
  (`overrides.ts`), and the report snapshot rows (`report.ts`).
- `src/sync/`: the recurring sync, Refresh and catch-up runs (`sync.ts`)
  and their phases: channels, status, scan (ledger), metrics, aggregates.
- `src/report/`: the figures the page and widget show, worked out from the
  snapshot rows. Pure.
- `src/ui/`: Block Kit constructors, the Analytics view, the Setup view,
  the widget, the editor panel (`panel.ts`) and the route handler.
- `src/tools/`: the MCP tools. `declare.ts` holds the zod schemas and is
  referenced only from `src/plugin.ts`'s `mcp` property; `load.ts` holds
  the handlers.
- `docs/registry/`: the registry page's tabs, referenced from `sections`
  in the manifest.

## Things that will bite

- **Count your bridge calls: ten per invocation.** A sandboxed invocation
  gets ten subrequests and every `ctx` call spends one, `log` and `cron`
  included (sandbox-workerd DEFAULT_LIMITS, enforced on Cloudflare only;
  keep to it everywhere). The pipeline wraps the context in a meter
  (`src/publish/budget.ts`) and decides how many posts it can send from
  what is left; `tests/budget.test.ts` counts the real calls of every
  hook, cron task, page action, panel action and tool. Run it after any
  change that adds a `ctx` call. A publish already spends all ten when
  five channels are on and an image needs a media lookup.
- **Buffer's limits are per account and shared.** 100 requests per 15
  minutes, 250 a day and 3,000 in 30 days on the Free plan (Team: 500 a
  day, 15,000 in 30 days). Every API key and every MCP connection on the
  account draws on one bucket, every request counts whether it succeeds
  or fails, and only a 429 is refunded (api-limits.md,
  efficient-api-usage.md). The sync is shaped to stay at about 40 to 50 a
  day (1,200 to 1,500 a month) for 10 channels; a new phase that asks
  Buffer on every run changes that sum, and the README states it. Every
  background read asks `src/buffer/headroom.ts` before each request and
  stops while a window is below its reserve; publishing stops only at
  `r` = 0. Keep every response's RateLimit reading (the report state
  carries it for report runs), and keep the recurring sync off :00 and
  :30 (`syncSchedule`).
- **Never resend after an uncertain answer.** Buffer documents no
  idempotency key for `createPost`. A timeout, lost connection, 5xx or
  `UNEXPECTED` may mean the post exists, so the record goes to `unknown`
  and the channel's recent posts are looked up and matched on text before
  anything is sent again. Only a definite refusal (`MutationError`, 4xx,
  `UNAUTHORIZED`) is `failed`, and that is retried only by the Retry button.
- **Claim before you send.** Records are written as `sending` before the
  request. A continuation claims a record with `updateIf` guarded on
  `status` and `updatedAt`, so two runs cannot send the same record.
- **One-shot tasks alternate names.** EmDash deletes a one-shot cron task
  when its run succeeds, including a row that run rescheduled under the same
  name, so continuations alternate `deliver-a` and `deliver-b`. A
  continuation scheduled by a hook while the same name is running can still
  be lost; the recurring `sync` task runs the delivery pass as well, which
  catches it.
- **An AbortSignal does not cross the sandbox bridge.** The wrapper
  marshals only method, headers, redirect and body. The client races each
  request against a timer instead (8 s).
- **The per-service table is documented fact only.** `src/buffer/services.ts`
  cites developers.buffer.com for every rule. Buffer's `configuration`
  query is Experimental and is used only as a hint that refines the table
  per channel; when it fails or answers in an unexpected shape, the table
  applies. Do not fill rules from memory.
- **The `configuration` query is Experimental.** It is the only
  machine-readable source of per-channel media rules, so it is read once a
  day with the channel refresh and parsed defensively (`__typename`
  switch, unknown rules ignored). Never let it override the table's
  "cannot post" verdicts, and never depend on it answering.
- **Link card or image, never both.** `linkAttachment` and a non-empty
  `assets` list are mutually exclusive at Buffer; a link card carries the
  image as its thumbnail.
- **Unknown deliveries are not failures.** `unknown` means the request
  may have reached Buffer. Resolve it by looking up the channel's posts
  since the attempt and matching the text; after 24 hours without an
  answer it becomes `failed` with `errorKind: "unconfirmed"`, and Retry
  puts it back to `unknown`, never to `pending`.
- **Send again makes a new record.** The editor panel's Send again
  writes a record under `<collection>:<entry>:<channel>:<time>` so the
  first post keeps its own record and figures, and it refuses while the
  channel's newest record is still open. Never overwrite a sent record.
- **Editor overrides are read once.** The publish hook reads the entry's
  `overrides` record when it prepares deliveries; after that the text
  lives on each delivery. A panel save after the first send is refused.
- **Block Kit keys are snake_case.** Use the constructors in
  `src/ui/blocks.ts`; the renderer silently ignores camelCase. Every route
  response is checked with `validateBlockResponse` in the tests.
- **Block Kit keeps no state.** A form's `action_id` carries what it saves
  (a channel's id).
- **The page route is `plugins:read`; changes need `plugins:manage`.** One
  Block Kit route serves both, so the handler checks `routeCtx.user.role`
  (ADMIN is 50) before Discover, Retry or a save.
- **Pages never call Buffer.** The Analytics view and the widget read the
  `ledger` and `aggregates` rows of the `reports` collection in one
  `getMany`; Refresh schedules the `refresh` run. A page that read
  deliveries or per-day rows directly would run out of bridge calls.
- **A missing metric is not zero.** Buffer lists only the metric types a
  network reported, and a post or day with `metricsUpdatedAt` null has not
  been read yet (post-metrics.md). Store and show those as missing ("No
  figures yet"). A Block Kit `number` column turns `null` into `0`, so a
  missing figure goes into a number column as text.
- **Aggregates are one channel per alias.** A filter over several networks
  drops every metric type one of them lacks, impressions and engagement
  rate included. Never compute an engagement rate: show Buffer's.
- **Report runs chain while work waits.** `catchup-a` and `catchup-b`
  alternate about 50 s apart (same reason as the delivery continuations)
  until no phase is due. A failed Buffer read sets `report.problem`, and
  Buffer phases then rest for 15 minutes, so a chain never hammers a
  failing API; a 429 pauses them for Retry-After.
- **Every settingsSchema key is in the manifest.** A setting that exists
  only in code is unusable on a registry install. The generated form
  takes only text, number, on/off, fixed select, secret, URL and email;
  anything listed from Buffer or the schema goes on the Setup view.
- **MCP schemas never reach the runtime.** `emdash-plugin build` strips
  the `mcp` property and writes the zod schemas into the manifest as
  JSON Schema. A schema imported by a handler would pull zod into the
  bundle. The handlers validate by hand, because the routes are reachable
  over HTTP without the MCP server's validation.
- **An MCP output schema is strict.** Every object becomes
  `additionalProperties: false` and the MCP server rejects an answer that
  does not match. Use `null`, not an absent key, for a missing value, and
  keep `src/tools/load.ts` and `declare.ts` in step; `tests/tools.test.ts`
  checks each answer against the schema the build wrote.
- **Updates that add tools or permissions need re-approval.** Adding a
  permission, a capability, an MCP tool or changing a tool's output asks
  the site's administrator to approve the update and turns Agent access
  off. Say so in the CHANGELOG and README "What's new". Settings fields do
  not.
- **The README's networks table is tested.** `tests/docs.test.ts` builds
  each row from `SERVICE_RULES` and fails until README.md carries it.
  The registry sections are capped at 20000 bytes and 2000 graphemes each
  and are tested too.
- **The suite runs inside workerd.** No `node:fs` or `typescript` in
  tests; read files with Vite `?raw` imports (`tests/raw.d.ts`).
- **Settings defaults are not applied on read.** `ctx.settings` returns
  null for an unset key; `src/settings.ts` applies every default again.
- **The test host serves Buffer at `https://api.buffer.com/`.** Requests are
  matched by URL to the character and `Request` adds the trailing slash.
  Answers queue in order.

## Conventions

- Tabs. Australian English in comments, docs and UI strings. No em or en
  dashes.
- ESM: internal imports carry `.js`; `import type` for types.
- Read EmDash APIs from the published release and Buffer's API from
  developers.buffer.com (append `.md` to a guide's URL), and say which.
- Anything that talks HTTP takes an injected `fetch`. Whole invocations go
  through the test host's `host.http.respond()`.
- A test must be able to fail on a real regression. Do not assert a config
  literal back at itself or restate the implementation.

## Checks

```sh
pnpm install
pnpm typecheck
pnpm test        # emdash-plugin validate, then vitest
pnpm build
pnpm exec emdash-plugin bundle   # writes the registry tarball locally, publishes nothing
./scripts/compat-matrix.sh 1.1.0 # the suite against other EmDash releases
```

On a busy machine run the suite as `nice pnpm vitest run --maxWorkers=2`,
and single test files while iterating.

## Releases

There is no automated release. Every release goes like this:

1. Changes go in by pull request from a `feat/` or `fix/` branch
   (`gh pr create --repo shanelord01/emdash-to-buffer-plus --base main`),
   merged with `--merge`. Use HTTPS for the remote and check a push
   really landed.
2. Bump `version` in `package.json` by hand, add the `CHANGELOG.md`
   entry, the README "What's new" line (dated, Sydney time, newest
   first) and `docs/registry/changelog.md`. That registry tab is capped at
   2000 graphemes (`emdash-plugin validate` and `tests/docs.test.ts` fail
   over it): keep only the last two releases there and link to
   `CHANGELOG.md` for the rest.
3. Tag the merge commit `vX.Y.Z` and push the tag.
4. Publish only with Shane's go, from a machine logged in to the
   registry as shane.bsky.shas.am. There is no dry run and versions are
   immutable:

```sh
pnpm registry:login     # once per machine
pnpm registry:publish   # builds, bundles and publishes to the EmDash registry
```

5. Follow the registry's checks with
   `pnpm exec emdash-plugin info shane.bsky.shas.am emdash-to-buffer-plus --version <v>`
   (add `--watch` to wait). Checks can take from minutes to hours, and the
   listing can 404 for about 15 minutes after publishing.

`package.json` is `private`, so nothing can be published to npm by
accident.

The registry refuses a manifest `description` over 140 graphemes, which
`emdash-plugin validate` does not check. Listing images go in `images/` and
are declared under `release.artifacts.screenshots`; never a `screenshots/`
folder (the bundle takes it whole and refuses over 256 KB).

Never name a script `publish`, `version` or `prepare`: npm and pnpm run
scripts with those names on their own. Here it is `registry:publish`, and
`prepublishOnly` builds before any publish.

The repository installs with pnpm 11; `allowBuilds` in `pnpm-workspace.yaml`
lets esbuild and workerd run their install scripts, which the test host
needs.
