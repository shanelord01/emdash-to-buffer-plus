# emdash-to-buffer-plus

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
