/**
 * The admin route: the Buffer page's two views and the dashboard widget.
 *
 * The route itself needs `plugins:read` (EDITOR and above), so editors can
 * see the page and the widget. Everything that changes something
 * (Discover, Retry, saving a form) also needs `plugins:manage`, which is
 * ADMIN (@emdash-cms/auth Permissions: "plugins:read" EDITOR 40,
 * "plugins:manage" ADMIN 50). The host attests the caller in
 * `routeCtx.user`, which is checked here because one Block Kit route
 * serves both. Refresh only schedules a read of Buffer, so editors may
 * press it.
 *
 * The widget's interactions carry `page: "widget:summary"` (emdash admin
 * SandboxedPluginWidget); the page's carry `/buffer`.
 *
 * Bridge calls, worst cases (`tests/budget.test.ts` counts them):
 * - Discover: settings, KV, starting the watch, four Buffer requests and
 *   the channel snapshot, the schema and the failed count (10).
 * - Retry all failed: settings, KV, the watch, the failed records, their
 *   write, the continuation, the snapshots, the failed count (8).
 * - An analytics load: settings, KV, the watch, scheduling the sync, the
 *   snapshots, the failed count (6); Refresh adds its one-shot task.
 * - The widget: settings, KV, the watch, scheduling the sync, the
 *   snapshots (5); Refresh adds its one-shot task.
 */

import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";

import { langOf, t, type Lang } from "../i18n.js";
import { metered } from "../publish/budget.js";
import { retryFailed } from "../publish/pipeline.js";
import { readSettings, type PluginSettings } from "../settings.js";
import { CHANNEL_MODES, CONFIG_KEY, readStored, STATE_KEY, ATTACH_MODES, type ChannelConfig, type ChannelMode, type Stored } from "../store/kv.js";
import type { RangeDays } from "../store/report.js";
import { refreshChannels } from "../sync/channels.js";
import { ensureScheduled, requestRefresh } from "../sync/sync.js";
import { isRecord, str } from "../values.js";
import type { AttachMode } from "../buffer/services.js";
import {
	ANALYTICS_ACTION,
	DEFAULT_RANGE,
	PAGE_REFRESH_ACTION,
	parseRange,
	RANGE_ACTION,
	renderAnalytics,
	RETRY_ALL_ACTION,
	SETUP_ACTION,
} from "./analytics.js";
import {
	CHANNEL_ACTION_PREFIX,
	COLLECTIONS_ACTION,
	collectionsFromForm,
	DISCOVER_ACTION,
	loadCollectionsAndFailures,
	loadSnapshots,
	renderSetup,
	RETRY_ACTION,
	UTM_ACTION,
} from "./page.js";
import { renderWidget, WIDGET_PAGE, WIDGET_REFRESH_ACTION } from "./widget.js";

/** `plugins:manage` is ADMIN (role 50) in @emdash-cms/auth. */
export const ROLE_ADMIN = 50;

/** Longest template accepted from the form. */
const MAX_TEMPLATE = 2000;

type Toast = { message: string; type: "success" | "error" };

export async function handleAdmin(routeCtx: SandboxedRouteContext, rawCtx: PluginContext, now = new Date()) {
	const { ctx } = metered(rawCtx);
	const lang = langOf(routeCtx.ui?.locale);
	const canManage = (routeCtx.user?.role ?? 0) >= ROLE_ADMIN;
	const input = isRecord(routeCtx.input) ? routeCtx.input : {};
	const actionId = typeof input.action_id === "string" ? input.action_id : "";
	const isAction = input.type === "block_action";
	const isSubmit = input.type === "form_submit";
	const values = isRecord(input.values) ? input.values : {};

	const settings = await readSettings(ctx);
	const stored = await readStored(ctx);
	if (!stored.state.watchSince) {
		// The page is one of the places the plugin starts watching for new
		// entries; plugin:install and plugin:activate are the others.
		stored.state = { ...stored.state, watchSince: now.toISOString() };
		await ctx.kv.set(STATE_KEY, stored.state);
	}

	if (input.page === WIDGET_PAGE) {
		let toast: Toast | undefined;
		if (isAction && actionId === WIDGET_REFRESH_ACTION) toast = await refresh(ctx, lang, now);
		else await ensureScheduled(ctx, settings.syncInterval);
		const { ledger, aggregates } = await loadSnapshots(ctx);
		const blocks = renderWidget({ lang, settings, stored, ledger, aggregates, now });
		return toast ? { blocks, toast } : { blocks };
	}

	const setupActions = [DISCOVER_ACTION, RETRY_ACTION, SETUP_ACTION];
	const setupView = (isAction && setupActions.includes(actionId)) || isSubmit;
	const range = parseRange(input.value);

	if (setupView) return await setupPage(ctx, { lang, settings, stored, canManage, actionId, isAction, isSubmit, values, range: isAction ? range : DEFAULT_RANGE, now });

	let toast: Toast | undefined;
	if (isAction && actionId === RETRY_ALL_ACTION) {
		toast = canManage ? await retry(ctx, stored, lang, now) : { message: t(lang, "forbidden"), type: "error" };
	} else if (isAction && actionId === PAGE_REFRESH_ACTION) {
		toast = await refresh(ctx, lang, now);
	} else if (!isAction || (actionId !== RANGE_ACTION && actionId !== ANALYTICS_ACTION)) {
		await ensureScheduled(ctx, settings.syncInterval);
	}

	const { ledger, aggregates } = await loadSnapshots(ctx);
	const failed = await ctx.storage.deliveries!.count({ status: "failed" });
	const blocks = renderAnalytics({ lang, settings, stored, ledger, aggregates, failed, range: isAction ? range : DEFAULT_RANGE, canManage, now });
	return toast ? { blocks, toast } : { blocks };
}

async function refresh(ctx: PluginContext, lang: Lang, now: Date): Promise<Toast> {
	return (await requestRefresh(ctx, now))
		? { message: t(lang, "refreshScheduled"), type: "success" }
		: { message: t(lang, "refreshUnavailable"), type: "error" };
}

async function retry(ctx: PluginContext, stored: Stored, lang: Lang, now: Date): Promise<Toast> {
	const count = await retryFailed(ctx, stored, now);
	return count > 0 ? { message: t(lang, "retried", { count }), type: "success" } : { message: t(lang, "nothingToRetry"), type: "success" };
}

async function setupPage(
	ctx: PluginContext,
	opts: {
		lang: Lang;
		settings: PluginSettings;
		stored: Stored;
		canManage: boolean;
		actionId: string;
		isAction: boolean;
		isSubmit: boolean;
		values: Record<string, unknown>;
		range: RangeDays;
		now: Date;
	},
) {
	const { lang, settings, stored, canManage, actionId, isAction, isSubmit, values, now } = opts;
	let toast: Toast | undefined;
	const mutating = (isAction && (actionId === DISCOVER_ACTION || actionId === RETRY_ACTION)) || isSubmit;
	if (mutating && !canManage) {
		toast = { message: t(lang, "forbidden"), type: "error" };
	} else if (isAction && actionId === DISCOVER_ACTION) {
		const outcome = await refreshChannels(ctx, settings, stored, now);
		stored.channels = outcome.cache;
		toast = outcome.ok
			? { message: t(lang, "discovered", { count: outcome.cache.channels.length }), type: "success" }
			: { message: t(lang, "discoverFailed", { message: outcome.message }), type: "error" };
	} else if (isAction && actionId === RETRY_ACTION) {
		toast = await retry(ctx, stored, lang, now);
	} else if (isSubmit && actionId.startsWith(CHANNEL_ACTION_PREFIX)) {
		const id = actionId.slice(CHANNEL_ACTION_PREFIX.length);
		const channel = stored.channels?.channels.find((c) => c.id === id);
		if (channel) {
			stored.config.channels[id] = channelFromForm(values, stored.config.channels[id], channel.boards?.map((b) => b.serviceId) ?? []);
			await ctx.kv.set(CONFIG_KEY, stored.config);
			toast = { message: t(lang, "saved"), type: "success" };
		}
	} else if (isSubmit && actionId === UTM_ACTION) {
		stored.config.utm = {
			enabled: values.utm === true,
			source: str(values.source).slice(0, 60) || "buffer",
			medium: str(values.medium).slice(0, 60) || "social",
		};
		await ctx.kv.set(CONFIG_KEY, stored.config);
		toast = { message: t(lang, "saved"), type: "success" };
	}

	const { collections, failed } = await loadCollectionsAndFailures(ctx);
	if (isSubmit && actionId === COLLECTIONS_ACTION && canManage) {
		stored.config.collections = collectionsFromForm(values, collections);
		await ctx.kv.set(CONFIG_KEY, stored.config);
		toast = { message: t(lang, "saved"), type: "success" };
	}

	const blocks = renderSetup({ lang, settings, stored, collections, failed, canManage, range: opts.range });
	return toast ? { blocks, toast } : { blocks };
}

/** A channel's settings from its form. Unknown values keep the current setting. */
export function channelFromForm(values: Record<string, unknown>, current: ChannelConfig | undefined, boards: string[]): ChannelConfig {
	const mode = CHANNEL_MODES.includes(values.mode as ChannelMode) ? (values.mode as ChannelMode) : (current?.mode ?? "addToQueue");
	const attach = ATTACH_MODES.includes(values.attach as AttachMode) ? (values.attach as AttachMode) : (current?.attach ?? "image");
	const template = typeof values.template === "string" ? values.template.replace(/\r\n?/g, "\n").trim().slice(0, MAX_TEMPLATE) : "";
	const board = typeof values.board === "string" && boards.includes(values.board) ? values.board : current?.boardServiceId;
	return {
		enabled: values.enabled === true,
		mode,
		attach,
		...(template && { template }),
		...(board && { boardServiceId: board }),
	};
}
