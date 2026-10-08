## 0.1.5, 9 October 2026

- Days are now your local days. 0.1.4 counted each post on its UTC day, so in Sydney a post before about 10 or 11 am showed a day early, and ranges turned over at UTC midnight. A new setting, Time zone (default Australia/Sydney), sets the zone for charts, ranges and times.
- After the update the first sync drops the daily figures stored by UTC day and reads them again from Buffer, as far back as your plan allows (31 days on the Free plan). Until then the figure charts are empty.
- A banner on the registry listing.
- No new permissions and no MCP tool changes, so Agent access stays on.

## 0.1.4, 3 October 2026

- Images now use the site's public media address. 0.1.3 and earlier sent an address that needs signing in, so Buffer could not read the image. Retry on a delivery that failed this way sends the image from the public address.
- Each channel keeps the same colour on the engagement and impressions charts, and a line with nothing to draw no longer takes a colour.
- No new permissions and no MCP tool output changes.

Full history: [CHANGELOG.md](https://github.com/shanelord01/emdash-to-buffer-plus/blob/main/CHANGELOG.md).
