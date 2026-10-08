/**
 * Turning a published entry into delivery records, one per turned-on channel.
 *
 * Everything a send needs is worked out here, once, and stored on the
 * record: the link (with UTM tags), the text fitted to the network's limit,
 * the image. A channel that cannot take the entry gets a `skipped` record
 * with a named reason, so nothing is dropped without a trace.
 *
 * Bridge calls: at most one `content.getPublicUrl` (none when the SEO
 * canonical is set, or the editor left out every channel). The image needs
 * none: its public address comes from the entry (`./image.ts`).
 *
 * A channel the editor left out for this entry in the editor panel gets a
 * `skipped` record with the reason `editorSkipped`, and its custom text
 * from the panel replaces the template.
 *
 * An Instagram channel whose image is known to be outside 4:5 to 1.91:1
 * (`./aspect.ts`) gets a `skipped` record with the reason `imageAspect`.
 * That record keeps the prepared text, link and image, so Send again can
 * send it once the entry's image has been changed.
 */

import type { PluginContext } from "emdash/plugin";

import { channelBlocker, ruleFor, textLimit, type SkipReason } from "../buffer/services.js";
import type { PluginSettings } from "../settings.js";
import { deliveryId, type Delivery } from "../store/deliveries.js";
import { channelConfig, type PluginConfig, type ChannelCache, type CollectionConfig } from "../store/kv.js";
import { isRecord, str } from "../values.js";
import { shapeProblem } from "./aspect.js";
import { resolveImage, type ImageResult, type ImageSource } from "./image.js";
import { fitText } from "./text.js";
import { canonicalUrl, httpUrl, withUtm } from "./url.js";

/** Excerpts longer than this are cut before fitting; no network takes more. */
const MAX_EXCERPT = 2000;

export interface EntryRef {
	collection: string;
	id: string;
	status: string;
	publishedAt: string | null;
	slug: string | null;
	data: Record<string, unknown>;
	seo?: unknown;
}

/** The entry from a hook event, or null when the event does not carry one. */
export function entryFromEvent(event: unknown): EntryRef | null {
	if (!isRecord(event) || typeof event.collection !== "string" || !isRecord(event.content)) return null;
	const content = event.content;
	if (typeof content.id !== "string") return null;
	return {
		collection: event.collection,
		id: content.id,
		status: typeof content.status === "string" ? content.status : "",
		publishedAt: typeof content.publishedAt === "string" ? content.publishedAt : null,
		slug: typeof content.slug === "string" ? content.slug : null,
		data: isRecord(content.data) ? content.data : {},
		...(content.seo !== undefined && { seo: content.seo }),
	};
}

export function entryTitle(entry: EntryRef, collection: CollectionConfig | undefined): string {
	const seo = isRecord(entry.seo) ? entry.seo : {};
	return (
		str(collection?.titleField ? entry.data[collection.titleField] : undefined) ||
		str(entry.data.title) ||
		str(seo.title) ||
		entry.slug ||
		entry.id
	);
}

export function entryExcerpt(entry: EntryRef): string {
	const seo = isRecord(entry.seo) ? entry.seo : {};
	const raw = str(entry.data.excerpt) || str(seo.description) || str(entry.data.description) || str(entry.data.summary);
	const plain = raw.replace(/<[^>]*>/g, "").replace(/[ \t]+/g, " ").trim();
	return [...plain].slice(0, MAX_EXCERPT).join("");
}

export function imageSourceOf(collection: CollectionConfig | undefined): ImageSource {
	const image = collection?.image ?? "none";
	if (image === "none") return { kind: "none" };
	if (image === "seo") return { kind: "seo" };
	return { kind: "field", field: image };
}

/**
 * The delivery records for an entry, ready to store. Channels that are off,
 * or no longer in the channel cache, get no record; channels left out in the
 * editor panel get a skipped one.
 */
export async function prepareDeliveries(
	ctx: PluginContext,
	input: {
		entry: EntryRef;
		settings: PluginSettings;
		config: PluginConfig;
		channels: ChannelCache | null;
		now: Date;
		/** Channels to leave out, and per-channel text, set for this entry in the editor panel. */
		overrides?: { skip?: string[]; text?: Record<string, string> };
	},
): Promise<Array<{ id: string; data: Delivery }>> {
	const { entry, settings, config, channels, now } = input;
	const collection = config.collections[entry.collection];
	const left = new Set(input.overrides?.skip ?? []);
	const targets = (channels?.channels ?? []).filter((c) => channelConfig(config, c.id).enabled);
	if (targets.length === 0) return [];
	// A channel the editor left out needs no link or image: only the others count below.
	const sending = targets.filter((c) => !left.has(c.id));

	const title = entryTitle(entry, collection);
	const excerpt = entryExcerpt(entry);
	const seo = isRecord(entry.seo) ? entry.seo : {};

	let url = sending.length > 0 ? canonicalUrl(seo.canonical, ctx.site.url) : null;
	if (!url && sending.length > 0 && ctx.content?.getPublicUrl) {
		try {
			url = httpUrl(await ctx.content.getPublicUrl(entry.collection, entry.id));
		} catch {
			url = null;
		}
	}

	const wantsImage = sending.some((c) => {
		const rule = ruleFor(c.service, channels?.hints?.[c.id]);
		return rule.image === "needed" || (rule.image === "allowed" && channelConfig(config, c.id).attach !== "none");
	});
	let image: ImageResult = { ok: false, reason: "none" };
	if (url && wantsImage) {
		image = resolveImage(imageSourceOf(collection), { data: entry.data, seo: entry.seo }, ctx.site.url);
	}

	const stamp = now.toISOString();
	return targets.map((channel) => {
		const cfg = channelConfig(config, channel.id);
		const hints = channels?.hints?.[channel.id];
		const rule = ruleFor(channel.service, hints);
		const base: Delivery = {
			collection: entry.collection,
			entryId: entry.id,
			entryTitle: title,
			channelId: channel.id,
			organizationId: channel.organizationId,
			service: channel.service,
			channelName: channel.displayName || channel.name,
			status: "pending",
			text: "",
			url: "",
			mode: cfg.mode,
			attach: cfg.attach,
			attempts: 0,
			createdAt: stamp,
			updatedAt: stamp,
			nextAttemptAt: "",
		};
		const skip = (reason: SkipReason): { id: string; data: Delivery } => ({
			id: deliveryId(entry.collection, entry.id, channel.id),
			data: { ...base, status: "skipped", reason },
		});

		// The editor's choice for this entry comes first: it is the reason a person will look for.
		if (left.has(channel.id)) return skip("editorSkipped");
		const blocker = channelBlocker(channel.service, channel, { boardServiceId: cfg.boardServiceId }, hints);
		if (blocker) return skip(blocker);
		if (!url) return skip("noUrl");
		if (rule.image === "needed" && !image.ok) return skip("needsImage");

		const link = withUtm(url, config.utm, channel);
		const template = input.overrides?.text?.[channel.id] ?? cfg.template ?? settings.defaultTemplate;
		const fitted = fitText(template, { title, excerpt, url: link }, textLimit(channel.service, channel.maxCharacters, hints));
		if (!fitted.ok) return skip("textTooLong");

		const sent = image.ok && rule.image !== "never" ? image : null;
		const data: Delivery = {
			...base,
			text: fitted.text,
			url: link,
			...(fitted.shortened && { shortened: true }),
			...(sent && { imageUrl: sent.url, imageAlt: sent.alt }),
			...(excerpt && { linkDescription: excerpt.slice(0, 300) }),
			...(cfg.boardServiceId && rule.needsBoard && { boardServiceId: cfg.boardServiceId }),
			...(hints && { hints }),
		};
		// Instagram refuses a shape outside 4:5 to 1.91:1: skipped here, never sent to fail.
		const shape = sent ? shapeProblem(channel.service, sent) : null;
		if (shape) {
			return {
				id: deliveryId(entry.collection, entry.id, channel.id),
				data: { ...data, status: "skipped", reason: "imageAspect", imageWidth: shape.width, imageHeight: shape.height },
			};
		}
		return { id: deliveryId(entry.collection, entry.id, channel.id), data };
	});
}
