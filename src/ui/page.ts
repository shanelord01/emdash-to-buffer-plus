/**
 * The Buffer admin page has two views. Analytics (`./analytics.ts`) opens
 * first; its Setup button opens this one: the API key's status, channel
 * discovery, the channels with their health and the rules that apply to
 * each, per-channel settings, the collections to share from and their image
 * source, UTM tags, and failed deliveries with a Retry button.
 *
 * Two views rather than a tab block: a tab block remembers its tab only in
 * the browser, so a form saved on a second tab would come back on the
 * first after every save. A view named by the action that rendered it
 * stays where the editor is, the way the Umami plugin's "Check setup"
 * screen does.
 *
 * Block Kit keeps no state between interactions, so each form's `action_id`
 * names what it saves (a channel's id travels in it).
 *
 * Reads only stored data: Buffer is asked live only by Discover.
 */

import type { PluginContext } from "emdash/plugin";

import type { BufferChannel } from "../buffer/client.js";
import { channelBlocker, ruleFor, supportsLinkCard, textLimit, type ResolvedRule } from "../buffer/services.js";
import { reasonText, t, type Lang } from "../i18n.js";
import type { PluginSettings } from "../settings.js";
import { channelConfig, hintsFor, latestRateLimit, limitFor, type CollectionConfig, type Stored } from "../store/kv.js";
import { AGGREGATES_ID, LEDGER_ID, ORIGINS_ID, parseAggregates, parseLedger, parseOrigins, REPORTS, type Aggregates, type Ledger, type Origins, type RangeDays } from "../store/report.js";
import { ANALYTICS_ACTION, headroomPausedUntil } from "./analytics.js";
import {
	actions,
	banner,
	button,
	checkbox,
	context,
	form,
	header,
	link,
	select,
	table,
	textInput,
	toggle,
	type ActionElement,
	type FormField,
	type PageBlock,
} from "./blocks.js";
import { isDay } from "../time/zone.js";
import { formatDay, formatTime } from "./format.js";

/** A collection as `ctx.schema.listCollections()` describes it. */
export type CollectionSchemaInfo = Awaited<ReturnType<NonNullable<PluginContext["schema"]>["listCollections"]>>[number];

export const PAGE_PATH = "/buffer";
export const DISCOVER_ACTION = "buffer:discover";
export const RETRY_ACTION = "buffer:retry";
export const CHANNEL_ACTION_PREFIX = "buffer:channel:";
export const COLLECTIONS_ACTION = "buffer:collections";
export const UTM_ACTION = "buffer:utm";
export const CHANNELS_TABLE_ACTION = "buffer:channels:page";

export interface PageInput {
	lang: Lang;
	settings: PluginSettings;
	stored: Stored;
	collections: CollectionSchemaInfo[];
	failed: number;
	canManage: boolean;
	/** The analytics range to return to. */
	range: RangeDays;
	now: Date;
}

/** Routable collections only: an entry without a public page has nothing to link to. */
export function routableCollections(all: CollectionSchemaInfo[]): CollectionSchemaInfo[] {
	return all.filter((c) => c.routable && !c.hidden);
}

export function imageFields(collection: CollectionSchemaInfo): Array<{ slug: string; label: string }> {
	return collection.fields.filter((f) => f.type === "image").map((f) => ({ slug: f.slug, label: f.label }));
}

/** The image source a collection starts with: its first image field, else the SEO image, else none. */
export function defaultImageSource(collection: CollectionSchemaInfo): string {
	return imageFields(collection)[0]?.slug ?? (collection.hasSeo ? "seo" : "none");
}

/**
 * Gather what the page shows. Bridge calls: the schema's collections and
 * the count of failed deliveries (2), on top of the caller's settings and KV.
 */
export async function loadCollectionsAndFailures(ctx: PluginContext): Promise<{ collections: CollectionSchemaInfo[]; failed: number }> {
	const collections = ctx.schema ? await ctx.schema.listCollections() : [];
	const failed = await ctx.storage.deliveries!.count({ status: "failed" });
	return { collections, failed };
}

/**
 * The snapshot rows the analytics view and the widget read, in one call.
 */
export async function loadSnapshots(ctx: PluginContext, zone: string): Promise<{ ledger: Ledger; aggregates: Aggregates; origins: Origins }> {
	const rows = await ctx.storage[REPORTS]!.getMany([LEDGER_ID, AGGREGATES_ID, ORIGINS_ID]);
	// Rows keyed in another zone (UTC, before 0.1.5) read as empty until the sync rebuilds them.
	return { ledger: parseLedger(rows.get(LEDGER_ID)), aggregates: parseAggregates(rows.get(AGGREGATES_ID), zone), origins: parseOrigins(rows.get(ORIGINS_ID), zone) };
}

export function renderSetup(input: PageInput): PageBlock[] {
	const { lang, settings, stored } = input;
	const blocks: PageBlock[] = [
		actions([button(ANALYTICS_ACTION, t(lang, "backToAnalytics"), { style: "secondary", value: input.range })], { blockId: "buffer:setup-controls" }),
		header(t(lang, "pageTitle")),
	];
	if (!settings.enabled) blocks.push(banner({ description: t(lang, "paused"), variant: "alert" }));

	blocks.push(...setupSection(input));

	if (stored.state.watchSince) {
		blocks.push(context(t(lang, "watchingSince", { date: when(stored.state.watchSince, lang, settings.timeZone) })));
	}
	return blocks;
}

function setupSection(input: PageInput): PageBlock[] {
	const { lang, settings, stored, canManage } = input;
	const blocks: PageBlock[] = [header(t(lang, "setupHeader"))];

	blocks.push(context(settings.accessToken ? t(lang, "tokenSet") : t(lang, "tokenMissing")));
	const setupActions: ActionElement[] = [link(t(lang, "openSettings"), { kind: "plugin-settings" }, { appearance: "secondary" })];
	if (settings.accessToken && canManage) setupActions.unshift(button(DISCOVER_ACTION, t(lang, "discover"), { style: "primary" }));
	blocks.push(actions(setupActions));

	const cache = stored.channels;
	if (cache?.error) {
		blocks.push(banner({ description: t(lang, "discoverFailed", { message: cache.error.message }), variant: "error" }));
	}

	blocks.push(header(t(lang, "channelsHeader")));
	if (cache?.fetchedAt) blocks.push(context(t(lang, "channelsFetched", { date: when(cache.fetchedAt, lang, settings.timeZone) })));
	if (cache?.truncated) blocks.push(context(t(lang, "channelsTruncated", { count: cache.organizations.length })));
	// Where each rule comes from, and when Buffer's configuration was read with the channels.
	if (cache?.fetchedAt) {
		const time = formatTime(cache.fetchedAt, lang, settings.timeZone);
		if (cache.hintsNote) blocks.push(context(t(lang, "hintsUnavailable", { message: cache.hintsNote, time })));
		else if (cache.hints && Object.keys(cache.hints).length > 0) blocks.push(context(t(lang, "hintsFromBuffer", { time })));
		else blocks.push(context(t(lang, "hintsNone", { time })));
	}
	const origins = originsLine(input);
	if (origins) blocks.push(context(origins));

	const channels = cache?.channels ?? [];
	blocks.push(
		table({
			blockId: "channels",
			pageActionId: CHANNELS_TABLE_ACTION,
			emptyText: t(lang, "channelsEmpty"),
			columns: [
				{ key: "channel", label: t(lang, "colChannel") },
				{ key: "service", label: t(lang, "colService"), format: "code" },
				{ key: "health", label: t(lang, "colHealth"), format: "badge" },
				{ key: "sharing", label: t(lang, "colSharing"), format: "badge" },
				{ key: "rules", label: t(lang, "colRules") },
			],
			rows: channels.map((c) => channelRow(input, c)),
		}),
	);

	if (canManage) {
		for (const channel of channels) blocks.push(...channelForm(input, channel));
		blocks.push(...collectionsSection(input));
		blocks.push(...utmSection(input));
	}

	blocks.push(header(t(lang, "deliveriesHeader")));
	if (input.failed > 0) {
		blocks.push(banner({ description: t(lang, "failedCount", { count: input.failed }), variant: "error" }));
		if (canManage) blocks.push(actions([button(RETRY_ACTION, t(lang, "retry"))]));
	}
	const until = headroomPausedUntil(settings, stored, input.now);
	if (until) blocks.push(banner({ description: t(lang, "headroomPaused", { time: formatTime(until, lang, settings.timeZone) }), variant: "alert" }));
	// The newest reading from a delivery, a discovery or a report run.
	const rate = latestRateLimit(stored);
	if (rate) {
		const windows = rate.windows.map((w) => `${w.remaining} of ${w.quota ?? "?"} (${w.name})`).join(", ");
		blocks.push(context(t(lang, "rateLimit", { windows })));
		blocks.push(context(t(lang, "headroomHelp")));
	}
	return blocks;
}

function channelRow(input: PageInput, c: BufferChannel): Record<string, unknown> {
	const { lang, stored } = input;
	const cfg = channelConfig(stored.config, c.id);
	const hints = hintsFor(stored.channels, c.id);
	const blocker = channelBlocker(c.service, c, { boardServiceId: cfg.boardServiceId }, hints);
	const health: string[] = [];
	if (c.isDisconnected) health.push(t(lang, "healthDisconnected"));
	if (c.isLocked) health.push(t(lang, "healthLocked"));
	if (c.isQueuePaused) health.push(t(lang, "healthPaused"));
	if (limitFor(stored.channels, c.id)?.isAtLimit) health.push(t(lang, "healthAtLimit"));
	return {
		id: c.id,
		channel: c.displayName || c.name,
		service: c.service,
		health: health.length > 0 ? health.join(", ") : t(lang, "healthOk"),
		sharing: cfg.enabled && !blocker ? t(lang, "sharingOn") : t(lang, "sharingOff"),
		rules: blocker ? reasonText(lang, blocker) : rulesText(lang, ruleFor(c.service, hints), textLimit(c.service, c.maxCharacters, hints)),
	};
}

/** The rules that apply to a channel, each marked when it came from Buffer's configuration. */
export function rulesText(lang: Lang, rule: ResolvedRule, limit: { max: number } | undefined): string {
	const mark = (text: string, from: "configuration" | "documented") =>
		`${text} (${t(lang, from === "configuration" ? "ruleFromBuffer" : "ruleDocumented")})`;
	const parts: string[] = [];
	const image = rule.image === "needed" ? "ruleImageNeeded" : rule.image === "allowed" ? "ruleImageAllowed" : "ruleImageNever";
	parts.push(mark(t(lang, image), rule.origin.image));
	if (rule.linkCard) parts.push(mark(t(lang, "ruleLinkCard"), rule.origin.linkCard));
	parts.push(limit ? mark(t(lang, "ruleLimit", { max: limit.max }), rule.origin.limit) : t(lang, "ruleNoLimit"));
	return parts.join(", ");
}

function channelForm(input: PageInput, channel: BufferChannel): PageBlock[] {
	const { lang, stored } = input;
	const hints = hintsFor(stored.channels, channel.id);
	const rule = ruleFor(channel.service, hints);
	const title = t(lang, "channelFormTitle", { name: channel.displayName || channel.name, service: channel.service });
	if (rule.postable !== true) {
		return [context(`${title}: ${reasonText(lang, rule.postable.reason)}`)];
	}
	const cfg = channelConfig(stored.config, channel.id);
	const attachOptions = [
		{ label: t(lang, "attachImage"), value: "image" },
		...(supportsLinkCard(channel.service, hints) ? [{ label: t(lang, "attachLink"), value: "link" }] : []),
		{ label: t(lang, "attachNone"), value: "none" },
	];
	const attach = attachOptions.some((o) => o.value === cfg.attach) ? cfg.attach : "image";
	const fields: FormField[] = [
		toggle("enabled", t(lang, "fieldEnabled"), { initialValue: cfg.enabled }),
		select(
			"mode",
			t(lang, "fieldMode"),
			[
				{ label: t(lang, "modeQueue"), value: "addToQueue" },
				{ label: t(lang, "modeNext"), value: "shareNext" },
				{ label: t(lang, "modeNow"), value: "shareNow" },
				{ label: t(lang, "modeDraft"), value: "draft" },
			],
			{ initialValue: cfg.mode },
		),
	];
	if (rule.image !== "never") fields.push(select("attach", t(lang, "fieldAttach"), attachOptions, { initialValue: attach }));
	if (rule.needsBoard) {
		const boards = channel.boards ?? [];
		if (boards.length > 0) {
			fields.push(
				select(
					"board",
					t(lang, "fieldBoard"),
					boards.map((b) => ({ label: b.name, value: b.serviceId })),
					cfg.boardServiceId ? { initialValue: cfg.boardServiceId } : undefined,
				),
			);
		}
	}
	fields.push(
		textInput("template", t(lang, "fieldTemplate"), {
			multiline: true,
			placeholder: input.settings.defaultTemplate,
			...(cfg.template && { initialValue: cfg.template }),
		}),
	);
	const out: PageBlock[] = [header(title), form(fields, { label: t(lang, "save"), actionId: `${CHANNEL_ACTION_PREFIX}${channel.id}` }, { blockId: `channel-${channel.id}` })];
	if (rule.needsBoard && (channel.boards ?? []).length === 0) out.push(context(t(lang, "noBoards")));
	out.push(context(t(lang, "templateHelp")));
	return out;
}

function collectionsSection(input: PageInput): PageBlock[] {
	const { lang, stored } = input;
	const routable = routableCollections(input.collections);
	const blocks: PageBlock[] = [header(t(lang, "collectionsHeader"))];
	if (routable.length === 0) return [...blocks, context(t(lang, "collectionsEmpty"))];
	const enabled = routable.filter((c) => stored.config.collections[c.slug]?.enabled).map((c) => c.slug);
	const fields: FormField[] = [
		checkbox(
			"collections",
			t(lang, "fieldCollections"),
			routable.map((c) => ({ label: c.label, value: c.slug })),
			{ initialValue: enabled },
		),
	];
	for (const c of routable) {
		const options = [
			...imageFields(c).map((f) => ({ label: f.label, value: f.slug })),
			...(c.hasSeo ? [{ label: t(lang, "imageSeo"), value: "seo" }] : []),
			{ label: t(lang, "imageNone"), value: "none" },
		];
		const current = stored.config.collections[c.slug]?.image;
		const initial = current && options.some((o) => o.value === current) ? current : defaultImageSource(c);
		fields.push(select(`image_${c.slug}`, t(lang, "imageSourceFor", { collection: c.label }), options, { initialValue: initial }));
	}
	blocks.push(form(fields, { label: t(lang, "save"), actionId: COLLECTIONS_ACTION }, { blockId: "collections" }));
	blocks.push(context(t(lang, "collectionsHelp")));
	return blocks;
}

function utmSection(input: PageInput): PageBlock[] {
	const { lang, stored } = input;
	const utm = stored.config.utm;
	return [
		header(t(lang, "utmHeader")),
		form(
			[
				toggle("utm", t(lang, "fieldUtm"), { initialValue: utm.enabled, description: t(lang, "utmHelp") }),
				textInput("source", t(lang, "fieldUtmSource"), { initialValue: utm.source }),
				textInput("medium", t(lang, "fieldUtmMedium"), { initialValue: utm.medium }),
			],
			{ label: t(lang, "save"), actionId: UTM_ACTION },
			{ blockId: "utm" },
		),
	];
}

/** Collection settings from the collections form, with the schema facts publishing needs. */
export function collectionsFromForm(
	values: Record<string, unknown>,
	all: CollectionSchemaInfo[],
): Record<string, CollectionConfig> {
	const chosen = new Set(Array.isArray(values.collections) ? values.collections.filter((v): v is string => typeof v === "string") : []);
	const out: Record<string, CollectionConfig> = {};
	for (const c of routableCollections(all)) {
		const allowed = new Set([...imageFields(c).map((f) => f.slug), ...(c.hasSeo ? ["seo"] : []), "none"]);
		const picked = values[`image_${c.slug}`];
		out[c.slug] = {
			enabled: chosen.has(c.slug),
			image: typeof picked === "string" && allowed.has(picked) ? picked : defaultImageSource(c),
			...(c.titleField && { titleField: c.titleField }),
			label: c.label,
		};
	}
	return out;
}

/** A moment as its day in the zone, `YYYY-MM-DD`. A value that is already a day is kept. */
/**
 * A stored day or moment as the rest of the admin writes it: a calendar day
 * as "9 Oct 2026", a moment as "9 Oct 2026, 6:55 am AEDT", both in the
 * "Time zone" setting. 0.1.5 showed the raw "2026-10-09" here.
 */
function when(value: string, lang: Lang, zone: string): string {
	return isDay(value) ? formatDay(value, lang, zone) : formatTime(value, lang, zone);
}

/**
 * How the Analytics page splits each shared channel's figures by origin,
 * with the posts Buffer listed in the last pass by PostVia: the first live
 * pass shows whether Buffer's post list includes posts made directly on the
 * network. Read from the report state, so it costs no bridge call.
 */
export function originsLine(input: Pick<PageInput, "lang" | "stored" | "settings">): string | null {
	const { lang, stored } = input;
	const shared = (stored.channels?.channels ?? []).filter((c) => stored.config.channels[c.id]?.enabled);
	if (shared.length === 0 || !input.settings.accessToken) return null;
	const summary = stored.report.origins;
	if (!summary) return t(lang, "originsNotRead");
	const list = shared.flatMap((c) => {
		const row = summary.channels[c.id];
		if (!row) return [];
		const name = c.displayName || c.name;
		return [t(lang, row.method === "listed" ? "originListed" : "originDerived", { name, ...row.counts })];
	});
	return list.length > 0 ? t(lang, "originsSince", { date: when(summary.since, input.lang, input.settings.timeZone), list: list.join("; ") }) : t(lang, "originsNotRead");
}
