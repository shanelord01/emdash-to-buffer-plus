## 0.1.0, 3 October 2026

First release.

- Shares newly published entries to Buffer, on every network Buffer's API can post to, with text fitted to each network's limit and the entry's image or a link card.
- Tracks every delivery: queued, posted with a link to the live post, failed with Buffer's reason and a Retry, or skipped with the reason. An uncertain answer is checked in Buffer before anything is sent again.
- A Buffer page with analytics (sent, queued, failed, impressions and engagement over 7, 30 or 90 days, top entries, per channel) and a Setup view for channels, collections and link tags.
- A dashboard card with the last seven days.
- An editor panel: leave out channels or write custom text before an entry is first sent, see each channel's state after, and Send again with a confirmation.
- Four read-only MCP tools: `entry_status`, `recent_deliveries`, `channel_health` and `engagement_summary`.

Based on emdash-to-buffer-plugin by Justin Thompson (MIT).
