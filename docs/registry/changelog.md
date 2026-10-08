## 0.1.6, 9 October 2026

- Instagram takes 4:5 (tall) to 1.91:1 (wide) only, and Buffer cannot crop. An image known to be outside that range now skips Instagram up front with the reason, instead of failing at Buffer. Other networks are not affected, and an image of unknown size is sent as before.
- The editor panel warns before the first share. After a differently shaped image is published, Send again checks it again and sends.
- Send again is offered only once Buffer is done with a post, never while it is queued.
- The charts name each line and its colour, engagement rates show one decimal place, and the Setup view's dates match the rest of the admin.
- No new permissions, settings or MCP tool changes.

## 0.1.5, 9 October 2026

- Days are now your local days. 0.1.4 counted each post on its UTC day, so in Sydney a post before about 10 or 11 am showed a day early, and ranges turned over at UTC midnight. A new setting, Time zone (default Australia/Sydney), sets the zone for charts, ranges and times.
- After the update the first sync drops the daily figures stored by UTC day and reads them again from Buffer, as far back as your plan allows (31 days on the Free plan). Until then the figure charts are empty.
- A banner on the registry listing.
- No new permissions. The MCP tools now describe their days in your time zone, so EmDash turns Agent access off after the update. Turn it on again under Plugins.

Full history: [CHANGELOG.md](https://github.com/shanelord01/emdash-to-buffer-plus/blob/main/CHANGELOG.md).
