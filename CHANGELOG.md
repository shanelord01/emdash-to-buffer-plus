# emdash-to-buffer-plus

## 0.1.1

Buffer's rate limits are per account, not per key: "MCP connections share one rate-limit bucket with your personal API keys", every request counts whether it succeeds or fails, and only a 429 is refunded (developers.buffer.com /guides/api-limits.md, /guides/efficient-api-usage.md). This release makes the plugin a considerate user of that shared bucket.

- A shared-bucket guard (`src/buffer/headroom.ts`, pure): the newest reading of each RateLimit window, matched by `w` and good until `t` seconds after it was taken, from the delivery state, the channel snapshot and the report state. Background reads (channel refresh with configuration, status, metrics, aggregates) check it before every request and stop while the 15-minute window has fewer than max(20, 20% of quota) left or the 24-hour or 30-day window has less than the new `headroomPercent` share. The pause is recorded as `report.headroom` (not `report.problem`), starts no catch-up chain, and lifts when the window resets. The aggregates backfill additionally runs only while the 24-hour window is at least half full.
- Publishing (the hooks, continuations, unknown look-ups, Retry, Send again, Share now) uses only the publish check: it holds while a window has `r` = 0 and waits for that window's reset, as after a 429. A continuation that waits for Buffer is scheduled for the reset, not a minute later.
- Every Buffer answer's RateLimit reading is kept: report runs carry it in the report state they already write (no extra bridge call).
- New setting `headroomPercent`, "Leave for other tools" (number, 25, 10 to 75), in the manifest and `src/settings.ts`. Settings fields need no re-approval.
- The recurring sync is staggered: each install picks a random minute offset once (`state.syncOffset`), and the cron expression is built from the interval and the offset (for example `8,38 * * * *`), never on :00 or :30. Existing installs move on their next activation or page load.
- The Analytics and Setup views show "Reports paused to leave Buffer requests for your other tools until ...". The Setup view's requests-left line uses the newest reading the plugin holds.
- Editor panel Share now: an entry first published before `watchSince`, with no records, offers administrators the per-channel choices and a confirmed Share now that runs the normal pipeline for that one entry (`shareNow` in `src/publish/pipeline.ts`), with `origin: "manual"` on its records ("Shared by hand"). It refuses an entry that is not published, one published after the watch, and a second press. `watchSince` is never changed. Editors see a line and the link to the Buffer page.
- UI: the dashboard card has three stats (sent, failed, queued) and engagement as a context line; a stat card without figures says "None yet"; a range with nothing sent shows an empty block instead of a 0 to 1 chart; the Setup view marks each rule "(documented)" or "(from Buffer)" and says when the configuration was read. Panel times stay UTC: EmDash 1.1 gives plugins no site time zone (`SiteInfo` and `routeCtx.ui` carry only the locale).
- The manifest description now names the dashboard, editor panel and MCP tools (132 graphemes, tested against the registry's 140 cap), and the README and registry description open the same way.
- Docs: a README section "Buffer's API limits" with the limits per plan, what happens when they are reached (posts wait and go out by themselves when the window refills, reports pause first, Buffer's separate per-channel posting limit needs Retry) and what to do if it keeps happening. The registry FAQ and Installation tabs say the same in short.
- `channel_health` reports the newest RateLimit reading of the three stored. Its output schema is unchanged, so Agent access stays on after the update. No permission or capability changed.

## 0.1.0

First release. Shares newly published EmDash entries to Buffer through Buffer's GraphQL API with a personal API key, and reports how each post did:

- sharing on publish (and on create-as-published) for the collections you choose, to every network Buffer's API can post to, following one rule table built from developers.buffer.com, with Buffer's Experimental per-channel configuration read daily as a hint only
- text fitted to each network's limit as Buffer counts it, shortening only the excerpt; the entry's image (public `https` on the site's host or a media provider's address) or a link card where Buffer documents one, never both; optional UTM tags
- tracked delivery per entry and channel: waiting, sending, sent (followed to the live post), unknown (looked up in Buffer before any resend), failed (Buffer's message, retried only on request) and skipped (with the reason); 429s wait out Retry-After
- a Buffer page: analytics over 7, 30 or 90 days (sent, queued, failed, impressions, engagement, top entries, per channel, banners) and a Setup view (channels, collections and image sources, link tags, failed deliveries)
- a dashboard card for the last seven days
- an editor panel on saved entries: per-channel skip and custom text before the first send, each channel's state after, Retry and a confirmed Send again for administrators
- four read-only MCP tools: `entry_status`, `recent_deliveries`, `channel_health`, `engagement_summary`
- registry page sections (description, installation, FAQ, changelog, security)

Every invocation stays within EmDash's ten bridge calls; `tests/budget.test.ts` counts each one.

Based on `emdash-to-buffer-plugin` by Justin Thompson, under the same MIT licence. Ideas were reused; the code is new.
