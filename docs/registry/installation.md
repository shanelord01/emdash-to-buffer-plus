You need EmDash 1.1.0 or later with a sandbox runner, a Buffer account with your channels connected, room in your Buffer account's API limit (shared by every key and connected assistant: 250 requests a day and 3,000 in 30 days on the Free plan, the plugin uses about 40 to 50 a day for 10 channels), and `EMDASH_ENCRYPTION_KEY` set on the site so the API key can be saved encrypted (`npx emdash secrets generate` makes one).

1. Install the plugin from the Registry and review its permissions: read content, read the schema, read media, and network requests to `api.buffer.com` only.
2. In Buffer, open Settings > API (`https://publish.buffer.com/settings/api`) and create a personal API key.
3. In EmDash, open Plugins, then this plugin's settings, and paste the key into Buffer API key. Set Time zone to your IANA zone (default Australia/Sydney): the reports count each post on its day there. Save.
4. Open Plugins > Buffer Plus and select Setup.
5. Select Discover channels.
6. Turn on each channel you want to post to, and choose when it posts (queue, share next, share now or a Buffer draft) and what it attaches (image, link card or nothing). Pinterest also needs a board.
7. Under Collections, tick the collections to share from and choose where each takes its image.
8. Publish an entry. It goes to Buffer straight away, or within a minute or two when many channels are on.

Each collection needs a URL Pattern (under Content Types) so entries have a public link. On Cloudflare Workers, the sync needs the Cron Trigger from EmDash's deployment guide.

To use the MCP tools, turn on Agent access for the plugin under Plugins. Turn it on again after an update that adds a tool or a permission.
