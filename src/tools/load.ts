/**
 * The MCP tools' routes: read-only answers from what the plugin stored.
 *
 * None of them calls Buffer. Each call is one sandboxed route invocation
 * with ten bridge calls, and the answers come from the same records the
 * Buffer page and the editor panel show: delivery records, the channel
 * snapshot in KV, and the `ledger` and `aggregates` report rows. Every
 * answer says when the plugin last synced with Buffer.
 *
 * The input schemas in `./declare.ts` are build metadata: the build strips
 * them from the runtime, and EmDash's MCP server validates a call against
 * them before the route runs. The same route is reachable over HTTP without
 * that validation, so each handler reads its input by hand and falls back
 * to the default.
 *
 * Bridge calls: entry_status and recent_deliveries read KV and one page of
 * deliveries (2); channel_health reads KV and counts failed deliveries (2);
 * engagement_summary reads KV and the two report rows (2).
 */

import type { PluginContext } from "emdash/plugin";

import { engagementOf, engagementRateOf, impressionsOf } from "../buffer/metrics.js";
import { channelBlocker, ruleFor, textLimit, type SkipReason } from "../buffer/services.js";
import { reasonText } from "../i18n.js";
import {
	aggregatesReach,
	aggregatesSince,
	channelTotals,
	failedIn,
	figuresByDay,
	ledgerReaches,
	periodOf,
	queued,
	sentIn,
	topEntries,
	total,
} from "../report/figures.js";
import { DELIVERIES, type Delivery, type DeliveryStatus } from "../store/deliveries.js";
import { channelConfig, hintsFor, limitFor, readStored, type Stored } from "../store/kv.js";
import { AGGREGATES_ID, LEDGER_ID, parseAggregates, parseLedger, REPORTS, type Day } from "../store/report.js";
import { isRecord } from "../values.js";

export const TOOL_ROUTES = {
	entryStatus: "mcp/entry_status",
	recentDeliveries: "mcp/recent_deliveries",
	channelHealth: "mcp/channel_health",
	engagementSummary: "mcp/engagement_summary",
} as const;

export const DELIVERY_STATUSES: readonly DeliveryStatus[] = ["pending", "sending", "sent", "unknown", "failed", "skipped"];
export const SUMMARY_DAYS = [7, 30, 90] as const;
export const DEFAULT_SUMMARY_DAYS = 30;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const MAX_ENTRY_ID = 128;
export const MAX_COLLECTION = 63;
export const COLLECTION_PATTERN = /^[a-z][a-z0-9_]*$/;
export const TOP_ENTRIES = 10;

/** Records read for one entry: one storage page, far more than channels times sends. */
const ENTRY_RECORDS = 100;

export interface DeliveryView {
	entryId: string;
	collection: string;
	entryTitle: string;
	channelId: string;
	channelName: string;
	service: string;
	status: DeliveryStatus;
	bufferStatus: string | null;
	reason: string | null;
	error: string | null;
	postUrl: string | null;
	dueAt: string | null;
	sentAt: string | null;
	createdAt: string;
	attempts: number;
	shortened: boolean;
	engagement: number | null;
	impressions: number | null;
	engagementRate: number | null;
	metricsUpdatedAt: string | null;
}

export interface EntryStatusResult {
	found: boolean;
	entryId: string | null;
	collection: string | null;
	title: string | null;
	deliveries: DeliveryView[];
	lastSync: string | null;
}

export interface RecentDeliveriesResult {
	status: DeliveryStatus | null;
	items: DeliveryView[];
	lastSync: string | null;
}

export interface ChannelHealthResult {
	fetchedAt: string | null;
	discoveryError: { at: string; message: string } | null;
	channels: Array<{
		channelId: string;
		name: string;
		service: string;
		organizationId: string;
		sharing: boolean;
		blocked: { reason: SkipReason; message: string } | null;
		disconnected: boolean;
		locked: boolean;
		queuePaused: boolean;
		dailyLimit: { atLimit: boolean; limit: number | null; scheduled: number; sent: number } | null;
		rules: { image: "needed" | "allowed" | "never"; linkCard: boolean; textLimit: number | null; fromConfiguration: boolean };
	}>;
	failedDeliveries: number;
	rateLimit: { at: string; windows: Array<{ name: string; remaining: number; quota: number | null; windowSeconds: number | null; resetSeconds: number | null }> } | null;
	lastProblem: { at: string; message: string } | null;
	pausedUntil: string | null;
	lastSync: string | null;
}

export interface EngagementSummaryResult {
	window: { days: number; since: Day; until: Day };
	sent: number;
	failed: number;
	queued: number;
	impressions: number | null;
	engagement: number | null;
	previous: { sent: number | null; failed: number | null; impressions: number | null; engagement: number | null };
	figuresSince: Day | null;
	channels: Array<{ channelId: string; name: string; service: string; sent: number; failed: number; impressions: number | null; engagementRate: number | null }>;
	topEntries: Array<{ title: string; collection: string; channelName: string; service: string; engagement: number; impressions: number | null; postUrl: string | null; sentAt: string | null }>;
	lastSync: string | null;
}

export function deliveryView(d: Delivery): DeliveryView {
	const fresh = Boolean(d.metricsUpdatedAt) && d.metrics ? d.metrics : undefined;
	return {
		entryId: d.entryId,
		collection: d.collection,
		entryTitle: d.entryTitle,
		channelId: d.channelId,
		channelName: d.channelName,
		service: d.service,
		status: d.status,
		bufferStatus: d.postStatus ?? null,
		reason: d.status === "skipped" ? (d.reason ?? null) : null,
		error: d.status === "failed" || d.status === "unknown" || d.status === "pending" ? (d.error ?? null) : d.postError ?? null,
		postUrl: d.externalLink ?? null,
		dueAt: d.dueAt ?? null,
		sentAt: d.sentAt ?? null,
		createdAt: d.createdAt,
		attempts: d.attempts,
		shortened: d.shortened === true,
		engagement: engagementOf(fresh) ?? null,
		impressions: impressionsOf(fresh) ?? null,
		engagementRate: engagementRateOf(fresh) ?? null,
		metricsUpdatedAt: d.metricsUpdatedAt ?? null,
	};
}

function lastSync(stored: Stored): string | null {
	return stored.report.lastSyncAt ?? null;
}

/** One entry's deliveries, newest first, by entry id (with or without its collection). */
export async function entryStatus(ctx: PluginContext, input: unknown): Promise<EntryStatusResult> {
	const record = asRecord(input);
	const entryId = boundedString(record.entryId, MAX_ENTRY_ID) ?? boundedString(record.id, MAX_ENTRY_ID);
	const collection = slugOf(record.collection);
	const stored = await readStored(ctx);
	const missing: EntryStatusResult = { found: false, entryId: entryId ?? null, collection, title: null, deliveries: [], lastSync: lastSync(stored) };
	if (!entryId) return missing;

	const page = await ctx.storage[DELIVERIES]!.query({ where: { entryId }, limit: ENTRY_RECORDS });
	const rows = page.items
		.map((i) => i.data as Delivery)
		.filter((d) => !collection || d.collection === collection)
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.channelName.localeCompare(b.channelName)));
	if (rows.length === 0) return missing;
	return {
		found: true,
		entryId,
		collection: rows[0]!.collection,
		title: rows[0]!.entryTitle,
		deliveries: rows.map(deliveryView),
		lastSync: lastSync(stored),
	};
}

/** The newest deliveries across every entry, optionally of one status. */
export async function recentDeliveries(ctx: PluginContext, input: unknown): Promise<RecentDeliveriesResult> {
	const record = asRecord(input);
	const limit = limitOf(record.limit);
	const status = DELIVERY_STATUSES.includes(record.status as DeliveryStatus) ? (record.status as DeliveryStatus) : null;
	const stored = await readStored(ctx);
	const page = await ctx.storage[DELIVERIES]!.query({
		...(status && { where: { status } }),
		orderBy: { createdAt: "desc" },
		limit,
	});
	return { status, items: page.items.map((i) => deliveryView(i.data as Delivery)), lastSync: lastSync(stored) };
}

/** Every discovered channel with its health, the rules that apply and whether the plugin shares to it. */
export async function channelHealth(ctx: PluginContext): Promise<ChannelHealthResult> {
	const stored = await readStored(ctx);
	const failedDeliveries = await ctx.storage[DELIVERIES]!.count({ status: "failed" });
	const cache = stored.channels;
	const rate = stored.state.rateLimit ?? cache?.rateLimit;
	return {
		fetchedAt: cache?.fetchedAt || null,
		discoveryError: cache?.error ? { at: cache.error.at, message: cache.error.message } : null,
		channels: (cache?.channels ?? []).map((c) => {
			const cfg = channelConfig(stored.config, c.id);
			const hints = hintsFor(cache, c.id);
			const rule = ruleFor(c.service, hints);
			const limit = textLimit(c.service, c.maxCharacters, hints);
			const blocker = channelBlocker(c.service, c, { boardServiceId: cfg.boardServiceId }, hints);
			const daily = limitFor(cache, c.id);
			return {
				channelId: c.id,
				name: c.displayName || c.name,
				service: c.service,
				organizationId: c.organizationId,
				sharing: cfg.enabled && !blocker,
				blocked: blocker ? { reason: blocker, message: reasonText("en", blocker) } : null,
				disconnected: c.isDisconnected,
				locked: c.isLocked,
				queuePaused: c.isQueuePaused,
				dailyLimit: daily ? { atLimit: daily.isAtLimit, limit: daily.limit, scheduled: daily.scheduled, sent: daily.sent } : null,
				rules: {
					image: rule.image,
					linkCard: rule.linkCard,
					textLimit: limit?.max ?? null,
					fromConfiguration: Object.values(rule.origin).includes("configuration"),
				},
			};
		}),
		failedDeliveries,
		rateLimit: rate
			? {
					at: rate.at,
					windows: rate.windows.map((w) => ({
						name: w.name,
						remaining: w.remaining,
						quota: w.quota ?? null,
						windowSeconds: w.window ?? null,
						resetSeconds: w.resetSeconds ?? null,
					})),
				}
			: null,
		lastProblem: stored.report.problem ? { at: stored.report.problem.at, message: stored.report.problem.message } : null,
		pausedUntil: stored.report.pausedUntil ?? null,
		lastSync: lastSync(stored),
	};
}

/**
 * Sent, failed and queued posts, impressions and engagement over 7, 30 or
 * 90 days, with the period before, per channel and the top entries. The
 * same figures as the Analytics view (`src/report/figures.ts`).
 */
export async function engagementSummary(ctx: PluginContext, input: unknown, now: Date): Promise<EngagementSummaryResult> {
	const days = pickDays(asRecord(input).days);
	const stored = await readStored(ctx);
	const rows = await ctx.storage[REPORTS]!.getMany([LEDGER_ID, AGGREGATES_ID]);
	const ledger = parseLedger(rows.get(LEDGER_ID));
	const aggregates = parseAggregates(rows.get(AGGREGATES_ID));

	const shared = (stored.channels?.channels ?? []).filter((c) => stored.config.channels[c.id]?.enabled);
	const ids = shared.map((c) => c.id);
	const { current, previous } = periodOf(days, now);
	const reaches = ledgerReaches(stored.state.watchSince, previous);
	const figures = figuresByDay(aggregates, ids, current);
	const before = aggregatesReach(aggregates, ids, previous) ? figuresByDay(aggregates, ids, previous) : null;
	const nameOf = (id: string) => {
		const c = stored.channels?.channels.find((ch) => ch.id === id);
		return c ? { name: c.displayName || c.name, service: c.service } : undefined;
	};

	return {
		window: { days, since: current.start, until: current.end },
		sent: sentIn(ledger, current),
		failed: failedIn(ledger, current),
		queued: queued(ledger).length,
		impressions: total(figures, "impressions") ?? null,
		engagement: total(figures, "engagement") ?? null,
		previous: {
			sent: reaches ? sentIn(ledger, previous) : null,
			failed: reaches ? failedIn(ledger, previous) : null,
			impressions: before ? (total(before, "impressions") ?? null) : null,
			engagement: before ? (total(before, "engagement") ?? null) : null,
		},
		figuresSince: aggregatesSince(aggregates, ids) ?? null,
		channels: channelTotals(ledger, aggregates, ids, current, days).map((row) => ({
			channelId: row.channelId,
			name: nameOf(row.channelId)?.name ?? row.channelName ?? row.channelId,
			service: nameOf(row.channelId)?.service ?? row.service ?? "",
			sent: row.sent,
			failed: row.failed,
			impressions: row.impressions ?? null,
			engagementRate: row.engagementRate ?? null,
		})),
		topEntries: topEntries(ledger, current, TOP_ENTRIES).map((e) => ({
			title: e.title,
			collection: e.collection,
			channelName: nameOf(e.channelId)?.name ?? e.channelName,
			service: e.service,
			engagement: e.engagement!,
			impressions: e.impressions ?? null,
			postUrl: e.link ?? null,
			sentAt: e.sentAt ?? null,
		})),
		lastSync: lastSync(stored),
	};
}

function asRecord(input: unknown): Record<string, unknown> {
	return isRecord(input) ? input : {};
}

/** Numbers arrive as strings from a query string, so both are accepted. */
function pickDays(value: unknown): (typeof SUMMARY_DAYS)[number] {
	const n = typeof value === "string" ? Number(value) : value;
	return (SUMMARY_DAYS as readonly unknown[]).includes(n) ? (n as (typeof SUMMARY_DAYS)[number]) : DEFAULT_SUMMARY_DAYS;
}

function limitOf(value: unknown): number {
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
	return Math.min(n, MAX_LIMIT);
}

function slugOf(value: unknown): string | null {
	return typeof value === "string" && value.length <= MAX_COLLECTION && COLLECTION_PATTERN.test(value) ? value : null;
}

function boundedString(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}
