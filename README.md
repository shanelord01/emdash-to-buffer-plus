# EmDash to Buffer Plus

Shares newly published EmDash entries to your Buffer channels, and shows
how each post did. Each post's text is fitted to the network, it carries
the entry's image or a link card, and every delivery is tracked from the
moment it leaves your site to the live post.

The plugin uses the Buffer API with a personal API key. It is not made,
endorsed or supported by Buffer.

Tested with the EmDash test host and Buffer's documented API. It has not
yet been run against a live Buffer account on every network: LinkedIn,
Facebook and Google Business Profile are the networks the plugin it is
based on reported working. If you use it with another network, please
report what you find in the repository's issues.

## What's new

**0.1.0, 3 October 2026**
- First release: sharing to every network Buffer's API can post to, a
  Buffer page with analytics and setup, a dashboard card, an editor panel
  and four read-only MCP tools.

## What it adds to the admin

| Where | What you see |
|---|---|
| Plugins > Buffer | Posts sent, queued and failed over 7, 30 or 90 days with a daily chart, impressions and engagement by day, top entries, a table per channel, and banners for anything that needs a person. Its Setup view holds the channels, collections, link tags and failed deliveries |
| Dashboard | A Buffer card: the last seven days' sent and failed posts, engagement, and the next queued post |
| Entry editor | A Buffer panel: before the first send, choose channels and write custom text for this entry; after, each channel's state and a link to the live post |
| MCP | Four read-only tools that give an AI agent the same information |

## What you need

| | |
|---|---|
| EmDash | 1.1.0 or later, with a plugin sandbox runner configured (registry plugins run in the sandbox) |
| A Buffer account | with the channels you want to post to connected in Buffer |
| A personal API key | from Buffer, see "Create the Buffer key" below |
| `EMDASH_ENCRYPTION_KEY` | set on the site, so the API key can be saved encrypted. Without it, saving the key fails. `npx emdash secrets generate` makes one |
| URL patterns | each collection you share from needs a URL Pattern (under Content Types), so its entries have a public link |
| Scheduled tasks | the sync runs as a plugin cron task. On Node, EmDash runs it. On Cloudflare Workers it needs the Cron Trigger from EmDash's Cloudflare deployment guide |

## Install

1. In the EmDash admin, open Registry.
2. Search for `@shane.bsky.shas.am/emdash-to-buffer-plus` and open it.
3. Review the permissions and select Install.

The plugin asks for four permissions: read content (to know when an entry
is published and find its link), read the schema (to list your
collections and their image fields), read media (to turn an image into
its public address) and make network requests to `api.buffer.com` only.

## Create the Buffer key

1. Sign in to Buffer and open Settings > API
   (`https://publish.buffer.com/settings/api`).
2. Create a new API key and copy it.

A Buffer key acts for your whole account: every organisation and channel
in it. Buffer offers no narrower key. Post figures (impressions,
engagement) are only available with a personal key, which is why the
plugin uses one.

## Settings

Open Plugins in the admin, then the plugin's settings.

| Setting | What to enter |
|---|---|
| Buffer API key | The key from the step above. It is stored encrypted and never shown again |
| Share new entries | On by default. Turn it off to stop sending without losing channels, settings or history |
| Post text | The text of each post. `{title}`, `{excerpt}` and `{url}` are filled in and line breaks are kept. The default is the title, the excerpt and the link on separate lines |
| Keep delivery history for | 180 days by default, 30 to 730. Older records are deleted a hundred at a time |
| Sync every | 30 minutes by default. How often the plugin checks Buffer for post status and figures and retries anything waiting |

## Setup page

Open Plugins > Buffer and select Setup.

1. **Discover channels.** Reads your organisations, channels, today's
   posting limits and each channel's rules from Buffer. The plugin reads
   them again once a day.
2. **Channels.** Each channel shows its health (disconnected, locked,
   queue paused, at its daily limit) and the rules that apply. Turn a
   channel on, then choose:
   - when: add to the queue, share next, share now, or save as a draft in
     Buffer;
   - attach: the entry's image, a link card (only on networks where Buffer
     documents link cards), or nothing;
   - a text template for this channel only, if it should differ from the
     Post text setting;
   - for Pinterest, the board Pins go to.
3. **Collections.** Tick the collections to share from. Only collections
   with public pages are listed. For each, choose where the image comes
   from: one of its image fields (the first is the default) or the SEO
   image.
4. **Link tags.** Optionally add `utm_source`, `utm_medium` and
   `utm_campaign` to every link. The campaign is the channel's network.
   Tags already on a link are kept as they are.

Only entries first published after the plugin was installed are shared.
Older entries never are, and republishing an entry never sends it again.

## Which networks work

From the plugin's rule table, which follows developers.buffer.com.

| Network | Posts entries | Link card | Image | Text limit | Skipped when |
|---|---|---|---|---|---|
| Bluesky | Yes | Yes | Optional | 300 | |
| Facebook | Yes | Yes | Optional | 5,000 | |
| Google Business Profile | Yes | No | Optional | 4,000 | |
| Instagram | Yes | No | Needed | 2,196 | When the entry has no image Buffer can fetch. |
| LinkedIn | Yes | Yes | Optional | 3,000 | |
| Mastodon | Yes | No | Optional | Server's own, 500 by default | |
| Pinterest | Yes | No | Needed | 500 | Until you choose a board. When the entry has no image Buffer can fetch. |
| Start Page | No | No | No | | Buffer cannot post to this service from the API. |
| Substack | Yes | Yes | Optional | Not documented | |
| Threads | Yes | Yes | Optional | 500 | |
| TikTok | Yes | No | Needed | 4,000 | When the entry has no image Buffer can fetch. |
| X | Yes | No | Optional | 280 | |
| WhatsApp | No | No | No | | Buffer cannot post to this service from the API. |
| YouTube | No | No | No | | This service takes video only. |

Buffer does not document whether Instagram, Pinterest and TikTok accept a
post without an image, so the plugin sends to them only when the entry
has one. Buffer also has a per-channel configuration query, which it
marks Experimental. The plugin reads it once a day as a hint: where it
answers, it can tighten or loosen a channel's image, link card and length
rules, and the Setup page marks those rules "from Buffer". When it fails
or answers in an unexpected shape, the table above applies.

Text limits are counted the way Buffer counts them for each network (for
example graphemes on Bluesky, and links as 23 characters on X). When the
text is too long, only the excerpt is shortened, with an ellipsis. The
title and the link are never cut; if they alone are too long, that
channel is skipped and says so. X is checked against its free-tier limit
of 280, because Buffer does not say which tier a channel is on.

Disconnected and locked channels are skipped with that reason. A network
Buffer adds later gets text with the link in it, and Buffer's answer is
recorded.

## How links and images are chosen

The link is the entry's SEO canonical URL when one is set, otherwise its
public address from the collection's URL pattern. An entry without either
is skipped with the reason "no public link"; the plugin never guesses a
path.

The image comes from the source chosen for the collection. Buffer has no
upload: it fetches the image from its address when the post goes out,
which can be days later. So an image is sent only when its address is
`https` and on your site's own host, or an absolute `https` address from
an external media provider. Addresses that are IP numbers, `localhost` or
private names are refused. Alt text goes with the image when the entry
has it.

A link card and an image are never sent together: Buffer refuses a post
with both. With "link card", the image becomes the card's thumbnail.

## What happens when sending fails

Each entry and channel has one delivery record, in one of these states:

| State | Meaning |
|---|---|
| Waiting | not sent yet, or waiting because Buffer asked the plugin to slow down |
| Sending | a request is on its way |
| Queued, posted, draft | Buffer took the post. The plugin follows it until the network publishes it, then links to the live post |
| Checking | the request may have reached Buffer (a timeout or a server error). The plugin looks for the post in Buffer before it sends anything again |
| Failed | Buffer refused the post. Its reason is shown |
| Skipped | the channel could not take this entry, with the reason |

Buffer offers no way to make a repeated request safe, so the plugin never
resends after an uncertain answer without first checking the channel's
recent posts. That is how it avoids double posts. A failed delivery is
sent again only when someone selects Retry, on the Buffer page or in the
editor panel. Buffer's own publishing errors (for example an expired
connection) are shown with Buffer's message; fix those in Buffer.

## Reports

| Figure | What it counts |
|---|---|
| Sent | this plugin's posts that the network published in the period |
| Queued | this plugin's posts waiting to be sent or waiting in Buffer now |
| Failed | this plugin's posts Buffer refused or could not publish |
| Impressions | how often posts were shown on screen, by the day each went out |
| Engagement | reactions, comments, shares, reposts, saves and quotes, as Buffer counts them |
| Engagement rate | Buffer's own figure per channel, never worked out by the plugin |

A missing figure is not zero. Buffer only lists the figures a network
reports, and a post Buffer has not read yet has none. The pages show
those as "No figures yet".

Impressions, engagement and the engagement rate are Buffer's figures for
every post on the shared channels, including posts made in Buffer itself,
not only this plugin's. They cover up to ten shared channels. Buffer
refreshes figures about once a day, so a new post shows figures a day or
so after it goes out. The comparison with the previous period appears
once the stored history reaches back that far.

## What the plugin requests

Only Buffer's GraphQL API at `https://api.buffer.com`, with your key.

| When | Requests |
|---|---|
| An entry is published | one per channel, plus a look-up if Buffer's answer was uncertain |
| Daily | the channel list, posting limits and configuration (four), figures for the last 30 days of posts, and the last 30 days of channel figures |
| Hourly, while posts wait in Buffer | one status check |
| After install | a one-off backfill of up to 180 days of channel figures |

For 10 shared channels that comes to about 40 to 50 requests a day,
after a backfill of about 60 requests spread over the first hour. Buffer
allows 100 requests per 15 minutes and 250 a day on its Free plan (and
3,000 in 30 days), counted per API key. Any other tool that uses the same
key shares those limits. When Buffer asks the plugin to slow down, it
waits as long as Buffer says.

## Editor panel

Open a saved entry and expand the Buffer panel in the sidebar. EmDash
shows editor panels on saved entries only, so it does not appear while
an entry is being created.

- For a collection that is not shared: a short note and a link to the
  Buffer page.
- Before the entry is first sent: a switch per channel to leave it out
  for this entry, and a text field for custom text on that channel
  (`{title}`, `{excerpt}` and `{url}` still work). Save, then publish.
- After: each channel's state, the time a queued post is due (in UTC), a
  link to the live post, Buffer's reason when it failed, and the skip
  reason when it was skipped. Administrators also see Retry for a failed
  post and Send again for a post Buffer took, which asks for confirmation
  first and then sends the same text as a new post.

Editors and administrators can open the panel and save choices.

## MCP tools

| Tool | Answers |
|---|---|
| `entry_status` | One entry's deliveries per channel: state, Buffer's status, link, reason and figures |
| `recent_deliveries` | The newest deliveries across all entries, optionally only failed ones |
| `channel_health` | Each channel's health, rules and whether the plugin shares to it, the failed count and the rate-limit reading |
| `engagement_summary` | Sent, failed, queued, impressions and engagement over 7, 30 or 90 days, per channel and the top entries |

To use them, open the plugin under Plugins and turn on Agent access.
EmDash turns it off again after an update that adds a tool or a
permission, so check it after updating. A token needs the `mcp:tools`
scope, and its user needs to be an editor or administrator. The tools
answer from what the plugin stored and never call Buffer.

## Privacy and security

- The API key is saved as an encrypted setting (AES-GCM with
  `EMDASH_ENCRYPTION_KEY`), is never shown in the admin after saving, and
  is never logged.
- The plugin talks to `api.buffer.com` and nothing else. It sends Buffer
  each post's text, link, image address and alt text.
- Images are fetched by Buffer, not by the plugin, and only from the
  addresses described under "How links and images are chosen".
- Viewing the Buffer page, the card and the panel needs the editor role;
  discovering channels, saving settings, Retry and Send again need the
  administrator role.
- Delivery records and figures are stored in your site's database and
  pruned after the retention period.

## Buffer's terms

The plugin uses the Buffer API and is not affiliated with Buffer. Using
it means agreeing to [Buffer's API terms](https://buffer.com/legal) with
your own key. Two sections are worth reading:

- Section 5.5 restricts using Buffer's "Software", which the terms define
  as the SDKs, libraries and sample code Buffer provides, to build
  developer tools such as plug-ins. This plugin uses none of Buffer's
  Software. It calls the public API directly with your key.
- Section 4.2(n) restricts automated queries. The plugin sends a request
  only when an entry is published, when you act on the Buffer page, and on
  a schedule well inside Buffer's documented limits.

Whether that fits your use is for you to decide with Buffer.

## Not in this version

- Video posts, threads, first comments and Buffer's tags and ideas.
- A tested run on every network. See the note at the top.
- Sending an entry that was published before the plugin was installed.
- Choosing a different image per channel.
- Figures for more than ten channels.
- Languages other than English in the admin.
- Screenshots.

## Attribution

Based on [emdash-to-buffer-plugin](https://github.com/devjusty/emdash-to-buffer-plugin)
by Justin Thompson, MIT licence. These ideas come from that plugin:
sharing an entry when it is published, through a content hook and
Buffer's GraphQL API; a post template with `{title}`, `{excerpt}` and
`{url}`; an admin page that discovers your Buffer channels; and taking
the entry's featured or SEO image for the post. The code here is new.

## Licence

MIT. See `LICENSE`.
