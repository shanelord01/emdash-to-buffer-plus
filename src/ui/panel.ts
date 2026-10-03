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
 *   its override (4); a save writes the override instead of reading it (4);
 * - a load after: KV, settings, the entry's deliveries (3);
 * - Retry: those three, the record, the continuation (5);
 * - Send again: those three, the claim, the post, the result, and a
 *   continuation or the rate-limit reading when Buffer answers so (7).
 */

import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";

import { channelBlocker, textLimit } from "../buffer/services.js";
import { langOf, reasonText, t, type Lang } from "../i18n.js";
import { metered } from "../publish/budget.js";
import { againRecord, retryOne, sendPrepared } from "../publish/pipeline.js";
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

	if (isAction && (actionId === PANEL_RETRY_ACTION || actionId === PANEL_AGAIN_ACTION)) {
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
	} else {
		if (override === undefined) override = parseOverride(await ctx.storage[OVERRIDES]!.get(overrideId(entry.collection, entry.id)));
		blocks = renderBeforeSend({ lang, settings, stored, override });
	}
	return toast ? { blocks, toast } : { blocks };
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

export function renderBeforeSend(input: { lang: Lang; settings: PluginSettings; stored: Stored; override: EntryOverride | null }): PageBlock[] {
	const { lang, settings, stored, override } = input;
	if (!settings.accessToken) return [context(t(lang, "panelNoKey")), pageLink(lang)];
	const channels = panelChannels(stored);
	if (channels.length === 0) return [context(t(lang, "panelNoChannels")), pageLink(lang)];

	const out: PageBlock[] = [];
	if (!settings.enabled) out.push(context(t(lang, "panelPaused")));
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
	if (fields.length > 0) {
		out.push(form(fields, { label: t(lang, "save"), actionId: PANEL_SAVE_ACTION }, { blockId: "buffer:panel:choices" }));
		out.push(context(t(lang, "panelBeforeHelp")));
	}
	for (const line of blocked) out.push(context(line));
	if (stored.state.watchSince) out.push(context(t(lang, "panelWatchNote", { date: formatTime(stored.state.watchSince, lang) })));
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
		const notes = [...(detail ? [detail] : []), ...(count > 1 ? [t(lang, "panelSentCount", { count })] : [])];
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
