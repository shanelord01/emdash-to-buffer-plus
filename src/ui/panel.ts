/**
 * The entry editor's Buffer panel.
 *
 * EmDash shows editor panels on saved entries only, opens them collapsed,
 * and calls the panel's private route when an editor opens one
 * (`panel_load`), presses a button (`block_action`) or saves a form
 * (`form_submit`). The host attests the entry in `routeCtx.ui.entry` and
 * checks, before this code runs, that the user may edit it (emdash
 * src/plugins/http-route-dispatch.ts `dispatchPluginEditorExtensionApiRequest`).
 *
 * What it shows:
 * - a collection the plugin does not share from: a short note and a link
 *   to the Buffer page;
 * - before the entry's first send: a toggle and a text field per channel
 *   that is on, saved to the `overrides` collection and used by the publish
 *   hook (`src/publish/pipeline.ts`);
 * - an entry published before the plugin started watching, with no
 *   records: a line saying it was not shared automatically, and for
 *   administrators the same choices plus Share now (behind a confirm
 *   dialog), which sends this one entry through the normal pipeline
 *   (`shareNow`) without moving the watch;
 * - after: each channel's latest delivery (waiting, queued with its time,
 *   posted with a link to the live post, failed with Buffer's reason and a
 *   Retry, skipped with its reason), and "Send again" behind a confirm
 *   dialog.
 *
 * The route needs `plugins:read` (editors and administrators). Retry and
 * Send again also need `plugins:manage`, checked here from the attested
 * user's role, as on the Buffer page.
 *
 * Bridge calls, worst cases (`tests/budget.test.ts` counts them):
 * - a collection that is not shared: KV (1);
 * - a load before the first send: KV, settings, the entry's deliveries,
 *   the entry itself (is it older than the watch?), its override (5); a
 *   save writes the override instead of reading it (5);
 * - Share now: KV, settings, the entry's deliveries, the entry, its
 *   override (5), the public URL and media lookup (7), then the claim and
 *   as many sends as fit with the results, or a continuation (10);
 * - a load after: KV, settings, the entry's deliveries (3);
 * - Retry: those three, the record, the continuation (5);
 * - Send again: those three, the claim, the post, the result, and a
 *   continuation or the rate-limit reading when Buffer answers so (7).
 */

import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";

import { channelBlocker, textLimit } from "../buffer/services.js";
import { langOf, reasonText, t, type Lang } from "../i18n.js";
import { metered } from "../publish/budget.js";
import { againRecord, retryOne, sendPrepared, shareNow } from "../publish/pipeline.js";
import type { EntryRef } from "../publish/prepare.js";
import { readSettings, type PluginSettings } from "../settings.js";
import { DELIVERIES, POST_NOT_FOUND, type Delivery } from "../store/deliveries.js";
import { channelConfig, hintsFor, readStored, type Stored } from "../store/kv.js";
import { MAX_OVERRIDE_TEXT, OVERRIDES, overrideId, parseOverride, type EntryOverride } from "../store/overrides.js";
import { capText, isRecord } from "../values.js";
import { actions, button, context, empty, form, link, section, shownWhen, textInput, toggle, type ActionElement, type FormField, type PageBlock } from "./blocks.js";
import { formatCount, formatTime } from "./format.js";
import { ROLE_ADMIN } from "./handlers.js";
import { PAGE_PATH } from "./page.js";

export const PANEL_ID = "buffer";
export const PANEL_ROUTE = "panel";
export const PANEL_SAVE_ACTION = "buffer:panel:save";
export const PANEL_RETRY_ACTION = "buffer:panel:retry";
export const PANEL_AGAIN_ACTION = "buffer:panel:again";
export const PANEL_SHARE_ACTION = "buffer:panel:share";

/** An entry as `ctx.content.get()` returns it. */
type ContentItem = NonNullable<Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>>;

/** Whether an entry was first published before the plugin started watching, so the publish hook left it alone. */
export function publishedBeforeWatch(item: Pick<ContentItem, "publishedAt"> | null, watchSince: string | undefined): boolean {
	if (!item?.publishedAt || !watchSince) return false;
	return Date.parse(item.publishedAt) < Date.parse(watchSince);
}

/** Delivery records read per entry: one storage page, far more than channels times sends. */
const ENTRY_RECORDS = 100;

type Row = { id: string; data: Delivery };
type Toast = { message: string; type: "success" | "error" };

export async function handlePanel(routeCtx: SandboxedRouteContext, rawCtx: PluginContext, now = new Date()) {
	const { ctx, meter } = metered(rawCtx);
	const ui = routeCtx.ui;
	const lang = langOf(ui?.locale);
	if (ui?.surface !== "content-editor-panel") {
		return { blocks: [empty({ title: t(lang, "panelOutsideEditor") })] };
	}
	const entry = { collection: ui.entry.collection, id: ui.entry.id };
	const input = isRecord(routeCtx.input) ? routeCtx.input : {};
	const actionId = typeof input.action_id === "string" ? input.action_id : "";
	const isAction = input.type === "block_action";
	const isSubmit = input.type === "form_submit";
	const canManage = (routeCtx.user?.role ?? 0) >= ROLE_ADMIN;

	const stored = await readStored(ctx);
	if (!stored.config.collections[entry.collection]?.enabled) {
		return { blocks: [context(t(lang, "panelNotShared")), pageLink(lang)] };
	}

	const settings = await readSettings(ctx);
	const page = await ctx.storage[DELIVERIES]!.query({ where: { entryId: entry.id }, limit: ENTRY_RECORDS });
	const records: Row[] = page.items
		.map((i) => ({ id: i.id, data: i.data as Delivery }))
		.filter((r) => r.data.collection === entry.collection);

	let toast: Toast | undefined;
	let override: EntryOverride | null | undefined;
	// The entry itself, read once and only when there are no records yet.
	let item: ContentItem | null | undefined;
	const loadItem = async (): Promise<ContentItem | null> => {
		if (item === undefined) item = stored.state.watchSince && ctx.content ? await ctx.content.get(entry.collection, entry.id) : null;
		return item;
	};
	const loadOverride = async (): Promise<EntryOverride | null> => {
		if (override === undefined) override = parseOverride(await ctx.storage[OVERRIDES]!.get(overrideId(entry.collection, entry.id)));
		return override;
	};

	if (isAction && actionId === PANEL_SHARE_ACTION) {
		if (!canManage) toast = { message: t(lang, "forbidden"), type: "error" };
		// A second press, or a second administrator: the first one's records win.
		else if (records.length > 0) toast = { message: t(lang, "panelShareExists"), type: "error" };
		else {
			const shared = await shareFromPanel(ctx, meter, settings, stored, lang, now, entry.collection, await loadItem(), loadOverride);
			toast = shared.toast;
			records.push(...shared.rows);
		}
	} else if (isAction && (actionId === PANEL_RETRY_ACTION || actionId === PANEL_AGAIN_ACTION)) {
		const target = records.find((r) => r.id === input.value);
		if (!canManage) toast = { message: t(lang, "forbidden"), type: "error" };
		else if (actionId === PANEL_RETRY_ACTION) {
			const back = target ? await retryOne(ctx, stored, target, now) : null;
			if (back && target) target.data = back;
			toast = back ? { message: t(lang, "panelRetried"), type: "success" } : { message: t(lang, "panelNothingToRetry"), type: "error" };
		} else {
			toast = await sendAgain(ctx, meter, settings, stored, records, target, lang, now);
		}
	} else if (isSubmit && actionId === PANEL_SAVE_ACTION) {
		if (records.length > 0) {
			toast = { message: t(lang, "panelAlreadySent"), type: "error" };
		} else {
			override = overrideFromForm(isRecord(input.values) ? input.values : {}, entry, stored, now);
			await ctx.storage[OVERRIDES]!.put(overrideId(entry.collection, entry.id), override);
			toast = { message: t(lang, "panelSaved"), type: "success" };
		}
	}

	let blocks: PageBlock[];
	if (records.length > 0) {
		blocks = renderDeliveries({ lang, records, canManage });
	} else if (publishedBeforeWatch(await loadItem(), stored.state.watchSince)) {
		blocks = canManage
			? renderBeforeWatch({ lang, settings, stored, override: await loadOverride() })
			: [context(t(lang, "panelBeforeWatch")), pageLink(lang)];
	} else {
		blocks = renderBeforeSend({ lang, settings, stored, override: await loadOverride() });
	}
	return toast ? { blocks, toast } : { blocks };
}

/**
 * Share now, after the checks a press must pass: a key and the master
 * switch, the entry published now and first published before the watch,
 * and at least one channel left in. Returns the records written, for the
 * panel to show.
 */
async function shareFromPanel(
	ctx: PluginContext,
	meter: ReturnType<typeof metered>["meter"],
	settings: PluginSettings,
	stored: Stored,
	lang: Lang,
	now: Date,
	collection: string,
	item: ContentItem | null,
	loadOverride: () => Promise<EntryOverride | null>,
): Promise<{ toast: Toast; rows: Row[] }> {
	const refuse = (message: string) => ({ toast: { message, type: "error" as const }, rows: [] });
	if (!settings.accessToken) return refuse(t(lang, "panelNoKey"));
	if (!settings.enabled) return refuse(t(lang, "panelShareOff"));
	if (!item || item.status !== "published") return refuse(t(lang, "panelShareNotPublished"));
	if (!publishedBeforeWatch(item, stored.state.watchSince)) return refuse(t(lang, "panelShareNotOld"));
	const override = await loadOverride();
	if (shareableChannels(stored, override).length === 0) return refuse(t(lang, "panelShareNoChannel"));

	const ref: EntryRef = {
		collection,
		id: item.id,
		status: item.status,
		publishedAt: item.publishedAt,
		slug: item.slug,
		data: item.data,
		...(item.seo !== undefined && { seo: item.seo }),
	};
	const { outcome, rows } = await shareNow(ctx, meter, settings, stored, ref, override ? { skip: override.skip, text: override.text } : null, now);
	if (outcome.kind === "ignored") return refuse(t(lang, "panelNoChannels"));
	const toast: Toast =
		outcome.deferred === 0 && outcome.sent > 0
			? { message: t(lang, "panelShareDone", { count: outcome.sent }), type: "success" }
			: { message: t(lang, "panelShareQueued"), type: "success" };
	return { toast, rows };
}

/** The channels Share now would post to: on, able to take the entry, and not left out in the saved choices. */
function shareableChannels(stored: Stored, override: EntryOverride | null) {
	return panelChannels(stored).filter((channel) => {
		if (override?.skip.includes(channel.id)) return false;
		const cfg = channelConfig(stored.config, channel.id);
		return !channelBlocker(channel.service, channel, { boardServiceId: cfg.boardServiceId }, hintsFor(stored.channels, channel.id));
	});
}

async function sendAgain(
	ctx: PluginContext,
	meter: ReturnType<typeof metered>["meter"],
	settings: PluginSettings,
	stored: Stored,
	records: Row[],
	target: Row | undefined,
	lang: Lang,
	now: Date,
): Promise<Toast> {
	if (!target || target.data.status !== "sent") return { message: t(lang, "panelAgainNothing"), type: "error" };
	// A double press, or a second editor at the same moment, must not post twice.
	const latest = latestByChannel(records).get(target.data.channelId);
	if (latest && ["pending", "sending", "unknown"].includes(latest.row.data.status)) {
		return { message: t(lang, "panelAgainBusy"), type: "error" };
	}
	const row = againRecord(target, now);
	records.push(row);
	await sendPrepared(ctx, meter, settings, stored, [row], now);
	const result = row.data;
	if (result.status === "sent") return { message: t(lang, "panelAgainSent"), type: "success" };
	if (result.status === "failed") return { message: t(lang, "panelAgainFailed", { message: result.error ?? "" }), type: "error" };
	return { message: t(lang, "panelAgainQueued"), type: "success" };
}

/** The override a save asks for. Only channels that are on are kept, and text is capped. */
export function overrideFromForm(
	values: Record<string, unknown>,
	entry: { collection: string; id: string },
	stored: Stored,
	now: Date,
): EntryOverride {
	const skip: string[] = [];
	const text: Record<string, string> = {};
	for (const channel of panelChannels(stored)) {
		if (values[`send_${channel.id}`] === false) skip.push(channel.id);
		const raw = values[`text_${channel.id}`];
		if (typeof raw === "string") {
			const value = capText(raw.replace(/\r\n?/g, "\n").trim(), MAX_OVERRIDE_TEXT);
			if (value) text[channel.id] = value;
		}
	}
	return { collection: entry.collection, entryId: entry.id, skip, text, updatedAt: now.toISOString() };
}

/** The channels a new entry would go to: discovered and turned on. */
function panelChannels(stored: Stored) {
	return (stored.channels?.channels ?? []).filter((c) => channelConfig(stored.config, c.id).enabled);
}

function pageLink(lang: Lang): PageBlock {
	return actions([link(t(lang, "openPage"), { kind: "plugin-page", path: PAGE_PATH }, { appearance: "secondary" })]);
}

/** The per-channel choices: a share toggle and optional text with the channel's limit, and a line for each channel that cannot take the entry. */
function choiceFields(lang: Lang, settings: PluginSettings, stored: Stored, override: EntryOverride | null): { fields: FormField[]; blocked: string[] } {
	const channels = panelChannels(stored);
	const fields: FormField[] = [];
	const blocked: string[] = [];
	for (const channel of channels) {
		const name = channel.displayName || channel.name;
		const cfg = channelConfig(stored.config, channel.id);
		const hints = hintsFor(stored.channels, channel.id);
		const blocker = channelBlocker(channel.service, channel, { boardServiceId: cfg.boardServiceId }, hints);
		if (blocker) {
			blocked.push(t(lang, "panelChannelLine", { name, service: channel.service, state: reasonText(lang, blocker).replace(/\.$/, "") }));
			continue;
		}
		const sendKey = `send_${channel.id}`;
		const limit = textLimit(channel.service, channel.maxCharacters, hints);
		fields.push(toggle(sendKey, t(lang, "panelShareTo", { name, service: channel.service }), { initialValue: !override?.skip.includes(channel.id) }));
		fields.push(
			shownWhen(
				textInput(`text_${channel.id}`, limit ? t(lang, "panelTextFor", { name, max: formatCount(limit.max, lang) }) : t(lang, "panelTextForNoLimit", { name }), {
					multiline: true,
					placeholder: cfg.template ?? settings.defaultTemplate,
					...(override?.text[channel.id] && { initialValue: override.text[channel.id] }),
				}),
				{ field: sendKey, eq: true },
			),
		);
	}
	return { fields, blocked };
}

export function renderBeforeSend(input: { lang: Lang; settings: PluginSettings; stored: Stored; override: EntryOverride | null }): PageBlock[] {
	const { lang, settings, stored, override } = input;
	if (!settings.accessToken) return [context(t(lang, "panelNoKey")), pageLink(lang)];
	if (panelChannels(stored).length === 0) return [context(t(lang, "panelNoChannels")), pageLink(lang)];

	const out: PageBlock[] = [];
	if (!settings.enabled) out.push(context(t(lang, "panelPaused")));
	const { fields, blocked } = choiceFields(lang, settings, stored, override);
	if (fields.length > 0) {
		out.push(form(fields, { label: t(lang, "save"), actionId: PANEL_SAVE_ACTION }, { blockId: "buffer:panel:choices" }));
		out.push(context(t(lang, "panelBeforeHelp")));
	}
	for (const line of blocked) out.push(context(line));
	if (stored.state.watchSince) out.push(context(t(lang, "panelWatchNote", { date: formatTime(stored.state.watchSince, lang) })));
	out.push(pageLink(lang));
	return out;
}

/**
 * An entry first published before the watch, for an administrator: the
 * line, the same choices, and Share now behind a confirm dialog. A Block
 * Kit form's submit takes no confirm, so the choices are saved first and
 * the button shares with what was saved.
 */
export function renderBeforeWatch(input: { lang: Lang; settings: PluginSettings; stored: Stored; override: EntryOverride | null }): PageBlock[] {
	const { lang, settings, stored, override } = input;
	const out: PageBlock[] = [context(t(lang, "panelBeforeWatch"))];
	if (!settings.accessToken) return [...out, context(t(lang, "panelNoKey")), pageLink(lang)];
	if (panelChannels(stored).length === 0) return [...out, context(t(lang, "panelNoChannels")), pageLink(lang)];
	if (!settings.enabled) out.push(context(t(lang, "panelShareOff")));

	const { fields, blocked } = choiceFields(lang, settings, stored, override);
	if (fields.length > 0) {
		out.push(form(fields, { label: t(lang, "save"), actionId: PANEL_SAVE_ACTION }, { blockId: "buffer:panel:choices" }));
		out.push(context(t(lang, "panelShareHelp")));
	}
	for (const line of blocked) out.push(context(line));
	const count = shareableChannels(stored, override).length;
	if (count === 0) out.push(context(t(lang, "panelShareNoChannel")));
	else if (settings.enabled) {
		out.push(
			actions([
				button(PANEL_SHARE_ACTION, t(lang, "panelShareNow"), {
					style: "primary",
					confirm: {
						title: t(lang, "panelShareTitle", { count }),
						text: t(lang, "panelShareText"),
						confirm: t(lang, "panelShareConfirm"),
						deny: t(lang, "panelShareDeny"),
					},
				}),
			]),
		);
	}
	out.push(pageLink(lang));
	return out;
}

/** Each channel's newest record, and how many records the channel has for the entry. */
function latestByChannel(records: Row[]): Map<string, { row: Row; count: number }> {
	const out = new Map<string, { row: Row; count: number }>();
	for (const row of records) {
		const seen = out.get(row.data.channelId);
		if (!seen) out.set(row.data.channelId, { row, count: 1 });
		else out.set(row.data.channelId, { row: row.data.createdAt > seen.row.data.createdAt ? row : seen.row, count: seen.count + 1 });
	}
	return out;
}

export function renderDeliveries(input: { lang: Lang; records: Row[]; canManage: boolean }): PageBlock[] {
	const { lang, records, canManage } = input;
	const out: PageBlock[] = [];
	const latest = [...latestByChannel(records).values()].sort((a, b) => a.row.data.channelName.localeCompare(b.row.data.channelName));
	for (const { row, count } of latest) {
		const d = row.data;
		out.push(section(t(lang, "panelChannelLine", { name: d.channelName, service: d.service, state: stateText(d, lang) }), { blockId: `buffer:panel:${d.channelId}` }));
		const detail = detailText(d, lang);
		const notes = [...(d.origin === "manual" ? [t(lang, "panelSharedByHand")] : []), ...(detail ? [detail] : []), ...(count > 1 ? [t(lang, "panelSentCount", { count })] : [])];
		if (notes.length > 0) out.push(context(notes.join(" ")));
		const elements: ActionElement[] = [];
		if (d.externalLink) elements.push(link(t(lang, "viewPost"), { kind: "external", url: d.externalLink }, { appearance: "secondary" }));
		if (canManage && d.status === "failed") elements.push(button(PANEL_RETRY_ACTION, t(lang, "panelRetry"), { style: "primary", value: row.id }));
		if (canManage && d.status === "sent") {
			elements.push(
				button(PANEL_AGAIN_ACTION, t(lang, "panelAgain"), {
					style: "secondary",
					value: row.id,
					confirm: {
						title: t(lang, "panelAgainTitle"),
						text: t(lang, "panelAgainText", { name: d.channelName }),
						confirm: t(lang, "panelAgainConfirm"),
						deny: t(lang, "panelAgainDeny"),
						style: "danger",
					},
				}),
			);
		}
		if (elements.length > 0) out.push(actions(elements));
	}
	out.push(pageLink(lang));
	return out;
}

/** What happened to a delivery, in a few words. */
export function stateText(d: Delivery, lang: Lang): string {
	switch (d.status) {
		case "pending":
			return d.nextAttemptAt ? t(lang, "panelStatePendingAt", { time: formatTime(d.nextAttemptAt, lang) }) : t(lang, "panelStatePending");
		case "sending":
			return t(lang, "panelStateSending");
		case "unknown":
			return t(lang, "panelStateUnknown");
		case "failed":
			return t(lang, "panelStateFailed");
		case "skipped":
			return t(lang, "panelStateSkipped");
		case "sent":
			break;
	}
	switch (d.postStatus) {
		case "sent":
			return d.sentAt ? t(lang, "panelStatePosted", { time: formatTime(d.sentAt, lang) }) : t(lang, "panelStatePostedNoTime");
		case "draft":
			return t(lang, "panelStateDraft");
		case "needs_approval":
			return t(lang, "panelStateApproval");
		case "sending":
			return t(lang, "panelStatePublishing");
		case "error":
			return t(lang, "panelStatePostError");
		case POST_NOT_FOUND:
			return t(lang, "panelStateGone");
		default:
			return d.dueAt ? t(lang, "panelStateQueued", { time: formatTime(d.dueAt, lang) }) : t(lang, "panelStateAccepted");
	}
}

/** Buffer's reason or the skip reason, when there is one to show. */
function detailText(d: Delivery, lang: Lang): string | null {
	if (d.status === "skipped" && d.reason) return reasonText(lang, d.reason);
	if (d.status === "failed" && d.error) return t(lang, "panelBufferSaid", { message: d.error });
	if (d.status === "sent" && d.postStatus === "error" && d.postError) return t(lang, "panelBufferSaid", { message: d.postError });
	return null;
}
