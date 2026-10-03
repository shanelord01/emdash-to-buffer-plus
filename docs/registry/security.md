Report a security problem privately through the repository's advisory form: https://github.com/shanelord01/emdash-to-buffer-plus/security/advisories/new

**What the plugin can do**

- Read content, the schema and media, to find a published entry's link and image. It never changes your content.
- Make requests to `api.buffer.com` only. It sends Buffer each post's text, link, image address and alt text.

**How it handles your Buffer key**

- The key is saved as an encrypted setting (AES-GCM with `EMDASH_ENCRYPTION_KEY`). Without that key EmDash refuses to save it rather than store it in plain text.
- The key is never shown in the admin after saving and never logged.
- A Buffer key acts for your whole Buffer account. If you think it has leaked, create a new one in Buffer under Settings > API and paste it into the plugin's settings.

**Images**

Buffer fetches images itself. The plugin passes an image address only when it is `https` and on your site's own host, or an absolute `https` address from an external media provider. IP addresses, `localhost` and private names are refused.

**Who can do what**

Viewing the Buffer page, the dashboard card, the editor panel and the MCP tools needs the editor role. Discovering channels, saving setup, Retry and Send again need the administrator role.
