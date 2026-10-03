## 0.1.2, 3 October 2026

- Buffer limits how far back figures go by plan (the Free plan: 31 days). The plugin learns the limit from Buffer's answer, reads only what the plan allows and says so on the Analytics page, instead of showing an error and no channel figures.
- The engagement and impressions charts split each channel into posts made directly on the network and posts made through Buffer, such as "Facebook (Direct)" and "Facebook (Buffer)".
- `{description}` works in post text as another name for `{excerpt}`.
- The plugin is called Buffer Plus in the admin sidebar, on the dashboard and in the editor.
- Parts of a Buffer answer that came back are kept when other parts are refused.
- No new permissions and no MCP tool output changes.

## 0.1.1, 3 October 2026

- Buffer's API limit is shared by every API key and connected assistant on an account. Background reports now stop while less than the new "Leave for other tools" share is left (25% by default). Posts still go out, and wait only when Buffer has no requests left at all.
- The docs explain Buffer's limits and what happens when they are reached.
- Share now in the editor panel sends an entry published before the plugin started watching.
- The sync runs at a minute of its own on each site.
- No new permissions and no MCP tool output changes.

Full history: [CHANGELOG.md](https://github.com/shanelord01/emdash-to-buffer-plus/blob/main/CHANGELOG.md).
