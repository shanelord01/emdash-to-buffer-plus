## 0.1.4, 3 October 2026

- Images now use the site's public media address. 0.1.3 and earlier sent an address that needs signing in, so Buffer could not read the image. Retry on a delivery that failed this way sends the image from the public address.
- Each channel keeps the same colour on the engagement and impressions charts, and a line with nothing to draw no longer takes a colour.
- No new permissions and no MCP tool output changes.

## 0.1.3, 3 October 2026

- The engagement and impressions charts cover every day of the range. A day with no posts counts as 0. Days without figures, and figures a network does not report, stay as gaps.
- The sent and failed chart covers the whole range too, and chart tooltips show the day without a time.
- Share now and Send again ask for confirmation inside the editor panel, naming the channels.
- The Setup view says older entries can be shared with Share now.
- No new permissions and no MCP tool output changes.

Full history: [CHANGELOG.md](https://github.com/shanelord01/emdash-to-buffer-plus/blob/main/CHANGELOG.md).
