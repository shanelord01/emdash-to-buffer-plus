## 0.1.1, 3 October 2026

- Buffer's API limit is shared by every API key and connected assistant on an account. Background reports now stop while less than the new "Leave for other tools" share is left (25% by default). Posts still go out, and wait only when Buffer has no requests left at all.
- The docs explain Buffer's limits and what happens when they are reached: posts wait and go out by themselves when the limit refills.
- Share now in the editor panel sends an entry published before the plugin started watching.
- The sync runs at a minute of its own on each site.
- Tidier dashboard card and stat cards, and the Setup view marks each channel rule as documented or from Buffer.
- No new permissions and no MCP tool output changes.

## 0.1.0, 3 October 2026

First release: sharing to every network Buffer's API can post to, delivery tracking without double posts, a Buffer page with analytics and setup, a dashboard card, an editor panel and four read-only MCP tools. Based on emdash-to-buffer-plugin by Justin Thompson (MIT).

Full history: [CHANGELOG.md](https://github.com/shanelord01/emdash-to-buffer-plus/blob/main/CHANGELOG.md).
