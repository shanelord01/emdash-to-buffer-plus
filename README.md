# EmDash to Buffer Plus

An unofficial plugin. It is not affiliated with, endorsed by or supported by Buffer.

Shares new EmDash entries to your Buffer channels, fitted to each
network, with delivery tracking, an engagement dashboard, an editor panel
and MCP tools. Each post carries the entry's image or a link card, every
delivery is followed from your site to the live post, and the Buffer Plus
page and dashboard card show how each post did.

The plugin uses the Buffer API with a personal API key.

Tested with the EmDash test host and Buffer's documented API. It has not
yet been run against a live Buffer account on every network: LinkedIn,
Facebook and Google Business Profile are the networks the plugin it is
based on reported working. If you use it with another network, please
report what you find in the repository's issues.

## What's new

**0.1.6, 9 October 2026**
- Instagram takes images from 4:5 (tall) to 1.91:1 (wide) only,
  and Buffer cannot crop. When the entry's image is known to be outside
  that range, Instagram is now skipped up front with the reason ("The
  image is 3:1. Instagram accepts 4:5 (tall) to 1.91:1 (wide).")
  instead of being sent to fail at Buffer. Other networks are not
  affected, and an image whose size the entry does not carry is sent as
  before.
- The editor panel warns before the first share, for example "My
  Instagram (instagram) will skip this entry: its image is 3:1." After you choose a differently shaped
  image and publish the change, Send again on that channel checks the
  image again and sends it.
- Send again is offered only once Buffer is done with a post (posted,
  could not publish, or no longer in Buffer), never while it is queued,
  sending, a draft or waiting for approval, so it cannot put a second
  post beside one still waiting.
- The engagement and impressions charts name each line and its colour
  underneath, since EmDash's charts draw no legend.
- Every line on a chart now looks different. Each channel has its own
  colour, and its Direct, Buffer and Not split lines are solid, dashed
  and dotted. Before, channels with only Not split lines took pink and
  orange in turn, so four channels drew two colours twice. Past six
  channels four more colours follow, and past ten the colours repeat
  with square, triangle and other point markers.
- Engagement rates show one decimal place ("3.0%" beside "4.2%"), the
  Setup view writes its dates like the rest of the admin, the range
  buttons no longer share one id (which logged a React warning), and a
  Setup note reads more plainly.
- No new permissions, settings or MCP tool changes, so Agent access stays
  on after the update.

**0.1.5, 9 October 2026**
- Days are now your local days. 0.1.4 and earlier counted every post on
  its UTC day, so in Sydney anything posted before about 10 or 11 am
  showed a day early, and "today" and every range turned over at UTC
  midnight. A new setting, "Time zone" (default `Australia/Sydney`),
  sets the zone for the charts, the ranges and the times the admin
  shows.
- After the update the first sync drops the daily figures stored by UTC
  day and reads them again from Buffer, as far back as your plan allows
  (31 days on the Free plan). Until then the figure charts are empty.
- A banner on the registry listing.
- No new permissions. The MCP tools now describe their days in your
  time zone, so EmDash turns Agent access off after the update. Turn it
  on again under Plugins.

**0.1.4, 3 October 2026**
- Images now use the site's public media address. 0.1.3 and earlier sent
  an address that needs signing in, so Buffer could not read the image.
  Retry on a delivery that failed this way works the image out again from
  the entry and sends it.
- Each channel keeps the same colour on the engagement and impressions
  charts, whichever lines a chart leaves out, and a line with nothing to
  draw no longer takes a colour.
- No new permissions and no MCP tool output changes, so Agent access
  stays on after the update.

**0.1.3, 3 October 2026**
- The engagement and impressions charts cover every day of the range. A
  day with no posts counts as 0, so one post on one day is a single peak
  instead of a line held flat between posts. Days Buffer has not given
  figures for, and figures a network does not report, are left as gaps.
- The sent and failed chart covers the whole range as well.
- Chart tooltips show the day ("23 Sept") without a time.
- Share now and Send again ask for confirmation inside the editor panel,
  naming the channels, instead of in a pop-up whose text ran into its
  edges.
- The Setup view now says older entries can be shared with Share now.
- No new permissions and no MCP tool output changes, so Agent access
  stays on after the update.

**0.1.2, 3 October 2026**
- Buffer limits how far back figures go by plan: the Free plan gives the
  last 31 days. The plugin now learns that limit from Buffer's answer,
  reads only what the plan allows, and says so on the Analytics page
  ("Your Buffer plan gives figures for the last 31 days"). The 90-day view
  labels its impressions and engagement "last 31 days" instead of showing
  "Buffer did not answer the last check" and no channel figures. Sent,
  queued and failed still cover 90 days.
- The engagement and impressions charts split each channel into posts
  made directly on the network and posts made through Buffer, for
  example "Facebook (Direct)" and "Facebook (Buffer)". The stat cards
  give the same split, and the Setup view says how each channel's split
  was worked out.
- `{description}` works in post text as another name for `{excerpt}`, for
  sites whose field is labelled Description.
- The plugin calls itself Buffer Plus in the admin: the sidebar page, the
  dashboard card and the editor panel. Buffer itself is still Buffer.
- When Buffer answers part of a request and refuses the rest, the parts
  it answered are kept.
- No new permissions and no MCP tool output changes, so Agent access
  stays on after the update.

**0.1.1, 3 October 2026**
- Buffer counts every API key and connected assistant on your account
  against one shared limit. The background reports now stop while less
  than the new "Leave for other tools" share is left (25% by default),
  and the Buffer page says when they resume. Posts still go out, and
  wait only when Buffer has no requests left at all.
- The recurring sync runs at a minute of its own on each site instead of
  on the hour and half hour.
- Share now in the editor panel sends an entry published before the
  plugin started watching, by hand, to the channels you choose.
- Tidier dashboard card and stat cards, an empty chart says so, and the
  Setup view marks each channel rule as documented or from Buffer.
- A new section, "Buffer's API limits", explains Buffer's limits and what
  happens when they are reached.
- No new permissions and no MCP tool output changes, so Agent access
  stays on after the update.

**0.1.0, 3 October 2026**
- First release: sharing to every network Buffer's API can post to, a
  Buffer page with analytics and setup, a dashboard card, an editor panel
  and four read-only MCP tools.

## What it adds to the admin

| Where | What you see |
|---|---|
| Plugins > Buffer Plus | Posts sent, queued and failed over 7, 30 or 90 days with a daily chart, impressions and engagement by day split into posts made directly on each network and through Buffer, top entries, a table per channel, and banners for anything that needs a person. Its Setup view holds the channels, collections, link tags and failed deliveries |
| Dashboard | A Buffer Plus card: the last seven days' sent and failed posts, what is queued, a line on engagement, and the next queued post |
| Entry editor | A Buffer Plus panel: before the first send, choose channels and write custom text for this entry; after, each channel's state and a link to the live post. An entry published before the plugin started watching can be shared by hand |
| MCP | Four read-only tools that give an AI agent the same information |

## What you need

| | |
|---|---|
| EmDash | 1.1.0 or later, with a plugin sandbox runner configured (registry plugins run in the sandbox) |
| A Buffer account | with the channels you want to post to connected in Buffer |
| A personal API key | from Buffer, see "Create the Buffer key" below |
| Room in Buffer's API limit | Buffer limits API requests per account, shared by every API key and connected assistant: 250 a day and 3,000 in 30 days on the Free plan. The plugin uses about 40 to 50 a day for 10 channels. See "Buffer's API limits" below |
| `EMDASH_ENCRYPTION_KEY` | set on the site, so the API key can be saved encrypted. Without it, saving the key fails. `npx emdash secrets generate` makes one |
| URL patterns | each collection you share from needs a URL Pattern (under Content Types), so its entries have a public link |
| Scheduled tasks | the sync runs as a plugin cron task. On Node, EmDash runs it. On Cloudflare Workers it needs the Cron Trigger from EmDash's Cloudflare deployment guide |

## Install

1. In the EmDash admin, open Registry.
2. Search for `@shane.bsky.shas.am/emdash-to-buffer-plus` and open it.
3. Review the permissions and select Install.

The plugin asks for four permissions: read content (to know when an entry
is published and find its link), read the schema (to list your
collections and their image fields), read media (no longer used since
0.1.4, and to be dropped in a later release) and make network requests to
`api.buffer.com` only.

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
| Post text | The text of each post. `{title}`, `{description}` (the entry's Description or SEO description, also written `{excerpt}`) and `{url}` are filled in and line breaks are kept. Only the description is shortened to fit a network. The default is the title, the description and the link on separate lines |
| Keep delivery history for | 180 days by default, 30 to 730. Older records are deleted a hundred at a time |
| Sync every | 30 minutes by default. How often the plugin checks Buffer for post status and figures and retries anything waiting. Each site runs it at a minute of its own, never on the hour or half hour |
| Leave for other tools | 25% by default, 10 to 75. The share of Buffer's daily and 30-day limits the background reports leave for your other API keys and connected assistants. See "What the plugin requests" |
| Time zone | `Australia/Sydney` by default. An IANA time zone name, such as `Australia/Perth` or `Europe/London`. The reports count each post on its day in this zone, "today" and every range end at its midnight, and the admin shows times in it. A name the server does not recognise falls back to `Australia/Sydney`. Changing it rebuilds the daily figures from Buffer, as far back as your plan allows. EmDash does not give plugins the site's own time zone, so it is set here |

## Setup page

Open Plugins > Buffer Plus and select Setup.

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
     Post text setting, with the same `{title}`, `{description}` (also
     written `{excerpt}`) and `{url}`;
   - for Pinterest, the board Pins go to.
3. **Collections.** Tick the collections to share from. Only collections
   with public pages are listed. For each, choose where the image comes
   from: one of its image fields (the first is the default) or the SEO
   image.
4. **Link tags.** Optionally add `utm_source`, `utm_medium` and
   `utm_campaign` to every link. The campaign is the channel's network.
   Tags already on a link are kept as they are.

Only entries first published after the plugin started watching are
shared automatically. An older entry can be shared by hand with Share now
in its editor panel. Republishing an entry never sends it again.

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

Instagram takes images from 4:5 (tall) to 1.91:1 (wide) only,
with no rounding (1024x536 is 1.9104:1 and refused), and Buffer cannot
crop. When the image field carries the image's width and height, as
EmDash stores them for media library images, an Instagram post whose
image is outside that range is skipped with the reason "The image is
3:1. Instagram accepts 4:5 (tall) to 1.91:1 (wide)." The editor
panel warns before the first share. Choose a differently shaped image,
publish the change, then use Send again on that channel. An image whose
size the entry does not carry, such as the SEO image, is sent as before,
since Buffer may still take it. Other networks always get the image as
it is.

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
which can be days later. A local image is sent at the site's public media
address, `/_emdash/api/media/file/<storage key>`, the one your pages use.
The media library's own address needs signing in and is never sent. When
an image field has no public address, the SEO image is used instead. An
image is sent only when its address is
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
| Waiting | not sent yet, or held because Buffer's API limit is used up. It goes out by itself when the limit refills (see "Buffer's API limits") |
| Sending | a request is on its way |
| Queued, posted, draft | Buffer took the post. The plugin follows it until the network publishes it, then links to the live post |
| Checking | the request may have reached Buffer (a timeout or a server error). The plugin looks for the post in Buffer before it sends anything again |
| Failed | Buffer refused the post. Its reason is shown |
| Skipped | the channel could not take this entry, with the reason |

Buffer offers no way to make a repeated request safe, so the plugin never
resends after an uncertain answer without first checking the channel's
recent posts. That is how it avoids double posts. A failed delivery is
sent again only when someone selects Retry, on the Buffer Plus page or in the
editor panel. Buffer's own publishing errors (for example an expired
connection) are shown with Buffer's message; fix those in Buffer.

## Buffer's API limits

Buffer limits how many API requests each Buffer account can make. The
limit belongs to the account, not to this plugin: every API key and every
assistant connected to Buffer (Claude, ChatGPT or another MCP client)
draws on the same allowance.

| Buffer plan | Every 15 minutes | Every 24 hours | Every 30 days |
|---|---|---|---|
| Free | 100 | 250 | 3,000 |
| Essentials | 100 | 250 | 7,500 |
| Team | 100 | 500 | 15,000 |

These figures are from Buffer's
[API limits guide](https://developers.buffer.com/guides/api-limits.md)
and can change. Every request counts, including one that fails. Only a
request Buffer turns away with "too many requests" is given back. The
windows roll: each one refills as its oldest requests age out.

The plugin reads how many requests are left from every answer Buffer
sends. The Setup view shows it ("Buffer requests left") and so does the
`channel_health` MCP tool.

Buffer also limits how far back figures go, by plan. The Free plan gives
figures for the last 31 days. Buffer does not document this: it shows up
only in Buffer's answer when the plugin asks for older days ("Free-plan
Insights are limited to the last 31 days of history"), and other plans
may allow more. The plugin learns the limit from that answer, asks only
for what the plan allows from then on, and checks once a week whether
the plan now goes further. Learning it costs one or two requests, once.

### What happens when the limit is reached

Posts are never dropped, but they can go out late.

- **New posts wait.** When Buffer has no requests left in any window, or
  answers "too many requests", a new entry's posts are not sent. Each
  delivery shows "waiting to be sent, next try" with a time, on the Buffer
  page and in the entry's editor panel. The plugin sends them by itself
  when that window refills, the longest-waiting first.
- **How late depends on the window.** A spent 15-minute window holds posts
  for at most 15 minutes, a spent daily window for up to a day, and a
  spent 30-day window for as long as Buffer says, which can be days. With
  "Add to the queue", Buffer then gives the post the next free slot after
  it arrives, so it may publish later than it would have.
- **Reports pause first.** Status checks, figures and the channel refresh
  stop well before the limit, while less than the "Leave for other tools"
  share (25% by default) of the daily or 30-day allowance is left, or
  fewer than 20 of the 15-minute window. The Analytics and Setup views say
  "Reports paused to leave Buffer requests for your other tools until"
  a time. Figures and post status are not updated while paused, and
  resume by themselves.
- **Nothing to retry.** Waiting posts need no action. Retry is only for
  posts Buffer refused.

### Buffer's posting limits are different

Buffer also limits how many posts each channel can publish a day. That is
a separate limit from API requests. The Buffer Plus page shows "At today's
posting limit in Buffer" for a channel that has reached it. If Buffer
refuses a post for that reason, the delivery shows Failed with Buffer's
message. Select Retry once the channel's day has rolled over.

### If you keep reaching the limit

- Check what else uses your Buffer account's API: other API keys and
  connected assistants count against the same allowance (Buffer lists them
  under Settings > API).
- Set "Sync every" to a longer interval, so status and figures are read
  less often.
- Share to fewer channels, or move to a Buffer plan with a higher limit.
- Raise "Leave for other tools" to keep more for your other tools, or
  lower it to give the plugin's reports more.
- Buffer asks anyone who needs more to write to
  developersupport@buffer.com.

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
those as "None yet" or "No figures yet".

Impressions, engagement and the engagement rate are Buffer's figures for
every post on the shared channels, not only this plugin's. The charts
split each channel into posts made directly on the network ("Facebook
(Direct)") and posts made through Buffer, this plugin and other API
tools included ("Facebook (Buffer)"). When two shared channels are on
the same network, the channel's name is added. The stat cards show the
channel-wide totals with the same split, and the Channels table stays
channel-wide. The split comes from Buffer's list of sent posts, which
says where each post was made. Buffer does not say whether that list
includes posts made directly on a network. When it lists none for a
channel, the direct figure is worked out as Buffer's total for the
channel that day minus the posts it listed, and the page says so. The
Setup view shows which way each channel was split and how many posts
Buffer listed by origin. Days the post list does not cover yet show as
"(Not split)".

The charts cover every day of the range, or of what your Buffer plan
gives. A day the post list covers with no posts of that origin is 0. A
day without figures yet, and a figure the network does not report, is a
gap, never a 0. Hovering shows the day and each line's figure, with "-"
for a gap. EmDash's charts have no legend, so a line under each chart
names its lines, their colours and their style: each channel has a
colour, and its Direct, Buffer and Not split lines are solid, dashed and
dotted. With many channels over a long range, each chart keeps its
busiest lines and says so.

Every day is a day in the "Time zone" setting: a post published at
8:15 am in Sydney counts on that Sydney day, and the plugin asks Buffer
for each day from that zone's midnight to the next. A day on which the
clocks change is 23 or 25 hours long, and so is its window.

They cover up to ten shared channels. Buffer refreshes figures about once
a day, so a new post shows figures a day or so after it goes out. The
comparison with the previous period appears once the stored history
reaches back that far.

Buffer limits how far back figures go by plan (the Free plan gives 31
days, from Buffer's own answer, not documented by Buffer). The plugin
learns the limit from Buffer and shows figures for what the plan allows:
the Analytics page says "Your Buffer plan gives figures for the last 31
days", and the 90-day view labels impressions, engagement and the
Channels table's figures "last 31 days". Sent, queued and failed come
from the plugin's own records and still cover the whole range.

## What the plugin requests

Only Buffer's GraphQL API at `https://api.buffer.com`, with your key.

| When | Requests |
|---|---|
| An entry is published | one per channel, plus a look-up if Buffer's answer was uncertain |
| Daily | the channel list, posting limits and configuration (four); the shared channels' sent posts over the last 30 days, with figures and where each was made, one request per 100 posts; and the last 30 days of channel figures |
| Hourly, while posts wait in Buffer | one status check |
| After install | a one-off backfill of up to 180 days of channel figures, or as far back as the plan allows |
| Weekly, under a history limit | one request for a day just beyond the limit |

A day's requests come to about 4 + P + A + S, where P is the sent posts
on the shared channels over the last 37 days divided by 100, rounded up,
at least one per Buffer organisation (posts made directly on the network
count as well as Buffer's); A is 1.1 times the number of shared channels,
rounded up (30 days and three ranges per channel, 30 to a request); and S
is the hourly status checks while posts wait in Buffer, up to 24. For 10
shared channels with a few hundred posts a month that is about 40 to 50
requests a day, about 1,200 to 1,500 a month, after a backfill of about
60 requests spread over the first hour. Splitting the figures by origin
reads nothing extra: it uses the posts list the figures already come
from.

Those requests come out of your Buffer account's shared API limit. See
"Buffer's API limits" for the numbers, how the plugin leaves room for your
other tools, and what happens when the limit is reached. The recurring
sync runs at a minute picked at random for each site, so sites do not all
ask Buffer at the same moment.

## Editor panel

Open a saved entry and expand the Buffer Plus panel in the sidebar. EmDash
shows editor panels on saved entries only, so it does not appear while
an entry is being created.

- For a collection that is not shared: a short note and a link to the
  Buffer Plus page.
- Before the entry is first sent: a switch per channel to leave it out
  for this entry, and a text field for custom text on that channel
  (`{title}`, `{description}` (the entry's Description or SEO
  description, also written `{excerpt}`) and `{url}` still work). Save,
  then publish. A warning says when Instagram will skip the entry
  because of its image's shape.
- An entry first published before the plugin started watching: a line
  saying it was not shared automatically. Administrators also get the
  same choices and Share now, which asks in the panel, naming the
  channels, and then sends
  this entry, and only this one, as if it had just been published. Its
  posts show "Shared by hand". Editors see the line and a link to the
  Buffer Plus page.
- After: each channel's state, the time a queued post is due (in the
  "Time zone" setting), a
  link to the live post, Buffer's reason when it failed, and the skip
  reason when it was skipped. Administrators also see Retry for a failed
  post and Send again for a post Buffer is done with (posted, could not
  publish, or no longer in Buffer), which asks in the panel first and
  then sends the same text as a new post. Send again is not offered
  while a post is still queued, sending, a draft or waiting for approval
  in Buffer. An Instagram post skipped for its image's shape also gets
  Send again, which works the image out again from the published entry
  and sends only when the shape fits.

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
- Viewing the Buffer Plus page, the card and the panel needs the editor role;
  discovering channels, saving settings, Retry, Send again and Share now need the
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
  only when an entry is published, when you act on the Buffer Plus page, and on
  a schedule well inside Buffer's documented limits.

Whether that fits your use is for you to decide with Buffer.

## Not in this version

- Video posts, threads, first comments and Buffer's tags and ideas.
- A tested run on every network. See the note at the top.
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
