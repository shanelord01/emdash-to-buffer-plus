/**
 * What each Buffer service needs before it can take a blog entry: text, a
 * link and at most one image, never video.
 *
 * One rule per value of Buffer's `Service` enum (developers.buffer.com
 * /reference.md, Enums: Service). Each rule says:
 *
 * - whether an entry can be posted there at all, and if not, the named
 *   reason the setup page and the delivery record show;
 * - the `PostInputMetaData` key and the metadata Buffer requires on
 *   `createPost` (only fields the reference marks `!` or "Required on
 *   create");
 * - whether a link card (`metadata.<key>.linkAttachment`) is documented for
 *   it: Bluesky, Facebook, LinkedIn, Substack and Threads only
 *   (/guides/hosting-media.md, Link attachments);
 * - whether an image is needed, allowed, or not sent;
 * - the text limit and how Buffer counts it (/guides/character-limits.md).
 *
 * Where the documentation is silent, the rule says so in a comment and
 * takes the cautious side. Whatever Buffer still refuses is recorded with
 * Buffer's own `MutationError` message, never retried blind.
 *
 * Buffer's `configuration` query describes per-channel support (supported
 * properties, count and length rules). It is marked Experimental, so it is
 * used as a hint with this table as the fallback (Shane, 2026-10-03):
 * `ruleFor(service, hints)` refines the documented rule where the hint
 * answers and keeps it where it does not.
 */

import { isRecord } from "../values.js";

/** Why a channel cannot take an entry. Each has a sentence in `src/i18n.ts`. */
export type SkipReason =
	| "serviceUnsupported"
	| "videoOnly"
	| "needsBoard"
	| "needsImage"
	| "channelDisconnected"
	| "channelLocked"
	| "textTooLong"
	| "noUrl"
	/** Left out for this one entry in the editor panel. */
	| "editorSkipped";

export const SKIP_REASONS: readonly SkipReason[] = [
	"serviceUnsupported",
	"videoOnly",
	"needsBoard",
	"needsImage",
	"channelDisconnected",
	"channelLocked",
	"textTooLong",
	"noUrl",
	"editorSkipped",
];

/** How a service counts post text (character-limits.md, How Buffer counts characters). */
export type CountRule =
	/** UTF-16 code units: `string.length`. */
	| "utf16"
	/** UTF-16 units, every URL counts as 24. */
	| "linkedin"
	/** UTF-16 units, every line break counts as 2. */
	| "instagram"
	/** UTF-16 units, URLs count as 23. */
	| "mastodon"
	/** X's own weighted count: URLs 23, emoji 2. */
	| "twitter"
	/** Graphemes; a URL counts as its host plus up to 16 more characters. */
	| "bluesky";

export interface LinkContext {
	url: string;
	title: string;
	description: string;
}

/** Per-channel facts a rule may need: today only a Pinterest board. */
export interface ChannelChoices {
	boardServiceId?: string;
}

export interface ServiceRule {
	/** True, or the reason no blog entry can be posted to this service. */
	postable: true | { reason: SkipReason };
	/** The `PostInputMetaData` key, when the service has one. */
	metadataKey?: string;
	/** Metadata Buffer requires on create, under `metadataKey`. */
	metadata?: (link: LinkContext, choices: ChannelChoices) => Record<string, unknown>;
	/** A choice the admin must make per channel before posting (Pinterest's board). */
	needsBoard?: boolean;
	/** `metadata.<metadataKey>.linkAttachment` is documented for this service. */
	linkCard: boolean;
	/** "needed": skip when the entry has no usable image. "never": no image is sent. */
	image: "needed" | "allowed" | "never";
	/** The post text limit, when documented. */
	limit?: { max: number; count: CountRule };
	/** Where the rule comes from. */
	source: string;
}

const CL = "character-limits.md";

/** Pinterest's title limit (character-limits.md: "Pinterest and YouTube titles: 100 characters"). */
export const PIN_TITLE_MAX = 100;

/**
 * The rules, keyed by `Service` enum value. Supported platforms for creating
 * posts, per posts-and-scheduling.md: Instagram, Threads, LinkedIn, X,
 * Facebook, Google Business Profiles, Mastodon, YouTube, Pinterest, Bluesky.
 * TikTok and Substack are not on that list but have metadata inputs, so they
 * are allowed and Buffer's answer is recorded.
 */
export const SERVICE_RULES: Readonly<Record<string, ServiceRule>> = {
	bluesky: {
		postable: true,
		metadataKey: "bluesky",
		linkCard: true,
		image: "allowed",
		limit: { max: 300, count: "bluesky" },
		source: `reference.md BlueskyPostMetadataInput; ${CL}`,
	},
	facebook: {
		postable: true,
		metadataKey: "facebook",
		// FacebookPostMetadataInput.type: PostTypeFacebook! (post | reel | story).
		metadata: () => ({ type: "post" }),
		linkCard: true,
		image: "allowed",
		limit: { max: 5000, count: "utf16" },
		source: `reference.md FacebookPostMetadataInput; ${CL}`,
	},
	googlebusiness: {
		postable: true,
		metadataKey: "google",
		// GoogleBusinessPostMetadataInput.type: PostTypeGoogleBusiness! is
		// required. The input is marked "@deprecated: pending proposal for
		// specific GBP post types" with no replacement and no removal date, so
		// it is the only documented way to post here. `whats_new` with a
		// "learn more" button to the entry fits a blog entry.
		metadata: (link) => ({ type: "whats_new", detailsWhatsNew: { button: "learn_more", link: link.url } }),
		linkCard: false,
		image: "allowed",
		limit: { max: 4000, count: "utf16" },
		source: `reference.md GoogleBusinessPostMetadataInput, GoogleBusinessWhatsNewMetaDataInput; ${CL}`,
	},
	instagram: {
		postable: true,
		metadataKey: "instagram",
		// InstagramPostMetadataInput.type: PostType! and shouldShareToFeed: Boolean!.
		metadata: () => ({ type: "post", shouldShareToFeed: true }),
		linkCard: false,
		// Not documented either way; an Instagram post is sent only with an image.
		image: "needed",
		limit: { max: 2196, count: "instagram" },
		source: `reference.md InstagramPostMetadataInput; ${CL}`,
	},
	linkedin: {
		postable: true,
		metadataKey: "linkedin",
		linkCard: true,
		image: "allowed",
		limit: { max: 3000, count: "linkedin" },
		source: `reference.md LinkedInPostMetadataInput; ${CL}`,
	},
	mastodon: {
		postable: true,
		metadataKey: "mastodon",
		// The server sets the limit: MastodonMetadata.maxCharacters when
		// Buffer sends it (see `textLimit`), 500 by default, capped at 20,000.
		linkCard: false,
		image: "allowed",
		limit: { max: 500, count: "mastodon" },
		source: `reference.md MastodonPostMetadataInput, MastodonMetadata; ${CL}`,
	},
	pinterest: {
		postable: true,
		metadataKey: "pinterest",
		// PinterestPostMetadataInput.boardServiceId: "Required on create".
		// The board is picked per channel on the setup page, from
		// PinterestMetadata.boards. The entry's link and title go on the Pin.
		metadata: (link, choices) => ({
			boardServiceId: choices.boardServiceId,
			url: link.url,
			...(link.title && { title: cutTitle(link.title, PIN_TITLE_MAX) }),
		}),
		needsBoard: true,
		linkCard: false,
		// Not documented either way; a Pin is sent only with an image.
		image: "needed",
		limit: { max: 500, count: "utf16" },
		source: `reference.md PinterestPostMetadataInput, PinterestMetadata; ${CL}`,
	},
	startPage: {
		// Its metadata was removed on 26 May 2026 (changelog.md) and it is not
		// among the platforms the API can post to.
		postable: { reason: "serviceUnsupported" },
		linkCard: false,
		image: "never",
		source: "changelog.md; posts-and-scheduling.md",
	},
	substack: {
		postable: true,
		metadataKey: "substack",
		// No limit documented.
		linkCard: true,
		image: "allowed",
		source: "reference.md SubstackPostMetadataInput; hosting-media.md",
	},
	threads: {
		postable: true,
		metadataKey: "threads",
		linkCard: true,
		image: "allowed",
		limit: { max: 500, count: "utf16" },
		source: `reference.md ThreadsPostMetadataInput; ${CL}`,
	},
	tiktok: {
		postable: true,
		metadataKey: "tiktok",
		linkCard: false,
		// "photo and text posts" in the limit table; whether a post without
		// media is accepted is not documented, so one is sent only with an image.
		image: "needed",
		limit: { max: 4000, count: "utf16" },
		source: `reference.md TikTokPostMetadataInput; ${CL}`,
	},
	twitter: {
		postable: true,
		metadataKey: "twitter",
		// 280 on X's Free tier, 25,000 on paid tiers. The tier is not exposed in
		// a documented form, so the lower limit is checked.
		linkCard: false,
		image: "allowed",
		limit: { max: 280, count: "twitter" },
		source: `reference.md TwitterPostMetadataInput; ${CL}`,
	},
	whatsapp: {
		// No PostInputMetaData key and no documented way to post.
		postable: { reason: "serviceUnsupported" },
		linkCard: false,
		image: "never",
		source: "reference.md PostInputMetaData; posts-and-scheduling.md",
	},
	youtube: {
		// YoutubePostMetadataInput requires title and categoryId on create and
		// the limit table counts a "video description": a video service.
		postable: { reason: "videoOnly" },
		metadataKey: "youtube",
		linkCard: false,
		image: "never",
		limit: { max: 5000, count: "utf16" },
		source: `reference.md YoutubePostMetadataInput; ${CL}`,
	},
};

/**
 * A service added to Buffer after this table: text with the link in the
 * text, nothing else, and Buffer's answer recorded.
 */
export const UNKNOWN_SERVICE_RULE: ServiceRule = {
	postable: true,
	linkCard: false,
	image: "never",
	source: "not in this plugin's table",
};

/**
 * What Buffer's `configuration` query said about one channel's posts
 * (reference.md: ChannelConfiguration, ContentConfiguration, ContentProperty,
 * CountRule, LengthRule). The query is marked Experimental, so it is read as
 * a hint only: whatever it does not answer, or answers in a shape this code
 * does not recognise, falls back to the documented table above. Every field
 * is optional for that reason.
 */
export interface ChannelHints {
	/** `supportedProperties` includes `text`. */
	text?: boolean;
	/** `supportedProperties` includes `image`. */
	image?: boolean;
	/** `supportedProperties` includes `linkAttachment`. */
	linkAttachment?: boolean;
	/** A CountRule on `image` with `min` of 1 or more: an image is required. */
	imageRequired?: boolean;
	/** A LengthRule on `text`. */
	textMaxLength?: number;
}

/** Where each refined part of a rule came from: Buffer's configuration, or the documented table. */
export interface RuleOrigin {
	image: "configuration" | "documented";
	linkCard: "configuration" | "documented";
	limit: "configuration" | "documented";
	text: "configuration" | "documented";
}

export interface ResolvedRule extends ServiceRule {
	origin: RuleOrigin;
}

/**
 * The rule for one channel: the documented rule for its service, refined by
 * the channel's configuration hints where they answer. A service the
 * documented table rules out (video only, unsupported, no board) stays ruled
 * out; hints can tighten or loosen what is sent, not override those.
 */
export function ruleFor(service: string, hints?: ChannelHints): ResolvedRule {
	const base = Object.hasOwn(SERVICE_RULES, service) ? SERVICE_RULES[service]! : UNKNOWN_SERVICE_RULE;
	const origin: RuleOrigin = { image: "documented", linkCard: "documented", limit: "documented", text: "documented" };
	const rule: ResolvedRule = { ...base, origin };
	if (!hints) return rule;

	if (hints.image === false) {
		rule.image = "never";
		origin.image = "configuration";
	} else if (hints.imageRequired === true) {
		rule.image = "needed";
		origin.image = "configuration";
	} else if (hints.image === true) {
		rule.image = "allowed";
		origin.image = "configuration";
	}

	// A link card lives under the service's metadata key, so only a service
	// with one can carry it, whatever the hint says.
	if (typeof hints.linkAttachment === "boolean" && base.metadataKey) {
		rule.linkCard = hints.linkAttachment;
		origin.linkCard = "configuration";
	}

	if (typeof hints.textMaxLength === "number" && hints.textMaxLength > 0) {
		rule.limit = { max: hints.textMaxLength, count: base.limit?.count ?? "utf16" };
		origin.limit = "configuration";
	}

	if (hints.text === false && rule.postable === true) {
		rule.postable = { reason: "serviceUnsupported" };
		origin.text = "configuration";
	}
	return rule;
}

/**
 * Read one channel's hints out of a `ChannelConfiguration`. Defensive by
 * design: rules are matched on `__typename` and unknown rule types are
 * ignored; anything not shaped as documented yields no hint for that part.
 * Only the content entry for `post` is used, since that is what a blog
 * entry becomes.
 */
export function parseChannelHints(raw: unknown): { channelId: string; hints: ChannelHints } | null {
	if (!isRecord(raw) || typeof raw.channelId !== "string" || !Array.isArray(raw.content)) return null;
	const entry = raw.content.find(
		(c) => isRecord(c) && Array.isArray(c.configurationContentTypes) && c.configurationContentTypes.includes("post"),
	);
	if (!isRecord(entry)) return null;
	const hints: ChannelHints = {};
	if (Array.isArray(entry.supportedProperties) && entry.supportedProperties.every((p) => typeof p === "string")) {
		const props = new Set(entry.supportedProperties as string[]);
		hints.text = props.has("text");
		hints.image = props.has("image");
		hints.linkAttachment = props.has("linkAttachment");
	}
	if (Array.isArray(entry.rules)) {
		for (const rule of entry.rules) {
			if (!isRecord(rule)) continue;
			switch (rule.__typename) {
				case "CountRule":
					if (rule.property === "image" && typeof rule.min === "number" && rule.min >= 1) hints.imageRequired = true;
					if (rule.property === "image" && rule.max === 0) hints.image = false;
					break;
				case "LengthRule":
					if (rule.property === "text" && typeof rule.maxLength === "number" && rule.maxLength > 0) {
						hints.textMaxLength = rule.maxLength;
					}
					break;
				default:
					// A rule type added after this code: ignored, as the guide asks.
					break;
			}
		}
	}
	return Object.keys(hints).length > 0 ? { channelId: raw.channelId, hints } : null;
}

/** The limit for one channel: Mastodon's server value when Buffer reported it. */
export function textLimit(
	service: string,
	maxCharacters?: number,
	hints?: ChannelHints,
): { max: number; count: CountRule } | undefined {
	const rule = ruleFor(service, hints);
	if (!rule.limit) return undefined;
	if (rule.origin.limit === "documented" && service === "mastodon" && typeof maxCharacters === "number" && maxCharacters > 0) {
		return { max: Math.min(maxCharacters, 20_000), count: rule.limit.count };
	}
	return rule.limit;
}

export interface ChannelHealth {
	isDisconnected: boolean;
	isLocked: boolean;
}

/**
 * Why a channel cannot take any entry right now, or null. Disconnected and
 * locked channels cannot post (reference.md Channel: "Locked channels can't
 * be used for posting").
 */
export function channelBlocker(
	service: string,
	health: ChannelHealth,
	choices: ChannelChoices = {},
	hints?: ChannelHints,
): SkipReason | null {
	const rule = ruleFor(service, hints);
	if (rule.postable !== true) return rule.postable.reason;
	if (health.isDisconnected) return "channelDisconnected";
	if (health.isLocked) return "channelLocked";
	if (rule.needsBoard && !choices.boardServiceId) return "needsBoard";
	return null;
}

export type AttachMode = "image" | "link" | "none";

export interface PostShape {
	metadata?: Record<string, unknown>;
	assets: Array<{ image: { url: string; metadata?: { altText: string } } }>;
}

/**
 * The metadata and assets for one post.
 *
 * A link card and a non-empty `assets` list are mutually exclusive
 * (CreatePostInput note; hosting-media.md), so "link" sends no image asset
 * and puts the image on the card as its thumbnail instead. "link" on a
 * service without a documented link card falls back to "image".
 * `ImageMetadataInput.altText` is `String!`, so image metadata goes only
 * with alt text. A service whose rule says "never" gets no image.
 */
export function postShape(
	service: string,
	attach: AttachMode,
	link: LinkContext,
	image: { url: string; alt: string } | null,
	choices: ChannelChoices = {},
	hints?: ChannelHints,
): PostShape {
	const rule = ruleFor(service, hints);
	const own: Record<string, unknown> = rule.metadata ? rule.metadata(link, choices) : {};
	const assets: PostShape["assets"] = [];
	const sendImage = rule.image !== "never" && image !== null;

	if (attach === "link" && rule.linkCard) {
		own.linkAttachment = {
			url: link.url,
			...(link.title && { title: link.title }),
			...(link.description && { description: link.description }),
			...(sendImage && { thumbnail: { url: image.url } }),
		};
	} else if (sendImage && (attach !== "none" || rule.image === "needed")) {
		assets.push({ image: { url: image.url, ...(image.alt && { metadata: { altText: image.alt } }) } });
	}

	const metadata = rule.metadataKey && Object.keys(own).length > 0 ? { [rule.metadataKey]: own } : undefined;
	return { ...(metadata && { metadata }), assets };
}

/** Whether "link card" can be offered for a channel on the setup page. */
export function supportsLinkCard(service: string, hints?: ChannelHints): boolean {
	return ruleFor(service, hints).linkCard;
}

/** A Pinterest channel's boards, from `PinterestMetadata.boards` (reference.md). */
export function boardsOf(metadata: unknown): Array<{ serviceId: string; name: string }> {
	if (!isRecord(metadata) || !Array.isArray(metadata.boards)) return [];
	return metadata.boards.flatMap((b) =>
		isRecord(b) && typeof b.serviceId === "string"
			? [{ serviceId: b.serviceId, name: typeof b.name === "string" ? b.name : b.serviceId }]
			: [],
	);
}

function cutTitle(title: string, max: number): string {
	const chars = [...title];
	return chars.length <= max ? title : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}
