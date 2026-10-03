/**
 * The recurring sync, the Refresh run and the catch-up runs.
 *
 * Every run reads settings and KV (2 bridge calls), then does as many
 * report phases as fit, keeps two calls for scheduling the next catch-up
 * run and writing the report state, and the recurring sync then spends
 * whatever is left on the delivery pass, which catches anything a lost
 * continuation left behind.
 *
 *   phase       due                                   calls
 *   channels    daily (src/sync/channels.ts)          5
 *   prune       daily                                 4
 *   status      hourly, and while a pass is under way 3
 *   scan        every 25 minutes, and while behind    3
 *   metrics     daily, and while a pass is under way  3
 *   aggregates  daily, and while backfilling          3 (4 in a chained run)
 *
 * A run takes the phases in that order and skips one that does not fit;
 * the next run, half an hour later or a minute later when catching up,
 * takes it. Pages and the widget never call Buffer: they read what these
 * phases stored, and their Refresh button schedules the `refresh` run.
 *
 * While work is waiting (a backfill, a pass over many posts, a Refresh),
 * runs chain: each schedules the next about 50 s later under alternating
 * names, because EmDash deletes a one-shot task once its run ends,
 * including a row that run rescheduled under its own name (emdash
 * src/plugins/cron.ts). The Umami plugin's catch-up runs work the same way.
 */

import type { PluginContext } from "emdash/plugin";

import { metered } from "../publish/budget.js";
import { runDeliveries } from "../publish/pipeline.js";
import { readSettings } from "../settings.js";
import { DELIVERIES } from "../store/deliveries.js";
import { readStored } from "../store/kv.js";
import { OVERRIDES } from "../store/overrides.js";
import { REPORT_KEY, type ReportState } from "../store/report.js";
import { aggregatesDue, AGGREGATES_COST, runAggregatesPhase } from "./aggregates.js";
import { refreshChannels } from "./channels.js";
import { bufferClient, isDue, paused, type PhaseContext } from "./common.js";
import { runScanPhase, SCAN_COST, SCAN_EVERY_MS } from "./ledger.js";
import { metricsDue, METRICS_COST, runMetricsPhase } from "./metrics.js";
import { runStatusPhase, STATUS_COST, STATUS_EVERY_MS } from "./status.js";

export const SYNC_TASK = "sync";
export const REFRESH_TASK = "refresh";
export const CATCH_UP_TASKS = ["catchup-a", "catchup-b"] as const;
export type SyncTask = typeof SYNC_TASK | typeof REFRESH_TASK | (typeof CATCH_UP_TASKS)[number];

/** A little under a minute: on Workers one-shots run with the every-minute Cron Trigger. */
export const CATCH_UP_DELAY_MS = 50_000;

/** A scheduled catch-up run that never happened stops blocking a new chain after this. */
const CATCH_UP_PENDING_MS = 5 * 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Records deleted per prune: one storage page. */
const PRUNE_BATCH = 100;

/** Calls every run keeps back: the next catch-up run and the report state. */
const RESERVE = 2;

/** What the delivery pass needs at the least: its query, a continuation, the state. */
const DELIVERY_PASS_MIN = 3;

const CHANNELS_COST = 5;
/** Deliveries, then the editor's overrides: a query and a delete each. */
const PRUNE_COST = 4;

export function isSyncTask(name: string): name is SyncTask {
	return name === SYNC_TASK || name === REFRESH_TASK || (CATCH_UP_TASKS as readonly string[]).includes(name);
}

interface Phase {
	name: string;
	cost: number;
	due: () => boolean;
	run: () => Promise<void>;
}

export async function runSync(rawCtx: PluginContext, task: SyncTask = SYNC_TASK, now = new Date()): Promise<void> {
	const { ctx, meter } = metered(rawCtx);
	const settings = await readSettings(ctx);
	const stored = await readStored(ctx);
	const report: ReportState = { ...stored.report, lastSyncAt: now.toISOString() };
	if (task === REFRESH_TASK) report.forcedAt = now.toISOString();
	const chained = task !== SYNC_TASK;

	const p: PhaseContext = { ctx, meter, settings, stored, client: bufferClient(ctx, settings), now, report };
	const buffer = () => Boolean(p.client) && !paused(p);
	const stamp = now.toISOString();

	const phases: Phase[] = [
		{
			name: "channels",
			cost: CHANNELS_COST,
			// Not forced by Refresh: Discover on the Setup screen reads channels now.
			due: () => {
				const last = report.channelsAt ?? stored.channels?.fetchedAt;
				return buffer() && (!last || now.getTime() - Date.parse(last) >= DAY_MS);
			},
			run: async () => {
				const outcome = await refreshChannels(ctx, settings, stored, now);
				stored.channels = outcome.cache;
				report.channelsAt = stamp;
			},
		},
		{
			name: "prune",
			cost: PRUNE_COST,
			due: () => !report.lastPruneAt || now.getTime() - Date.parse(report.lastPruneAt) >= DAY_MS,
			run: async () => {
				const pruned = await pruneDeliveries(ctx, settings.retentionDays, now);
				// A full batch means more are waiting: prune again on the next run.
				// The editor panel's overrides go once the deliveries are done.
				if (pruned >= PRUNE_BATCH) return;
				const overrides = await pruneOverrides(ctx, settings.retentionDays, now);
				if (overrides < PRUNE_BATCH) report.lastPruneAt = stamp;
			},
		},
		{
			name: "status",
			cost: STATUS_COST,
			due: () => buffer() && (Boolean(report.status?.pending) || isDue(p, report.status?.at, STATUS_EVERY_MS)),
			run: () => runStatusPhase(p),
		},
		{
			name: "scan",
			cost: SCAN_COST,
			due: () => Boolean(report.scan?.pending) || isDue(p, report.scan?.at, SCAN_EVERY_MS),
			run: () => runScanPhase(p),
		},
		{ name: "metrics", cost: METRICS_COST, due: () => buffer() && metricsDue(p), run: () => runMetricsPhase(p) },
		{
			name: "aggregates",
			cost: chained ? AGGREGATES_COST + 1 : AGGREGATES_COST,
			due: () => buffer() && aggregatesDue(p),
			run: () => runAggregatesPhase(p, chained ? 2 : 1),
		},
	];

	for (const phase of phases) {
		if (meter.left() - RESERVE < phase.cost || !phase.due()) continue;
		await phase.run();
	}

	// Work still waiting, other than the daily channel refresh and prune,
	// which the recurring sync takes on its own.
	const waiting = phases.filter((ph) => ph.name !== "channels" && ph.name !== "prune").some((ph) => ph.due());
	const pending = report.chain && now.getTime() < Date.parse(report.chain.at) + CATCH_UP_PENDING_MS;
	if (waiting && ctx.cron && (chained || !pending)) {
		const next = task === CATCH_UP_TASKS[0] ? CATCH_UP_TASKS[1] : CATCH_UP_TASKS[0];
		const at = new Date(now.getTime() + CATCH_UP_DELAY_MS).toISOString();
		await ctx.cron.schedule(next, { schedule: at });
		report.chain = { next, at };
	}
	await ctx.kv.set(REPORT_KEY, report);

	if (task === SYNC_TASK && meter.left() >= DELIVERY_PASS_MIN) {
		await runDeliveries(ctx, { now, meter, settings, stored });
	}
}

/**
 * Delete up to one page of records created before the retention cutoff.
 * Bridge calls: one query, one deleteMany when anything matched.
 */
export async function pruneDeliveries(ctx: PluginContext, retentionDays: number, now: Date): Promise<number> {
	const cutoff = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
	const page = await ctx.storage[DELIVERIES]!.query({ where: { createdAt: { lt: cutoff } }, limit: PRUNE_BATCH });
	if (page.items.length === 0) return 0;
	return await ctx.storage[DELIVERIES]!.deleteMany(page.items.map((i) => i.id));
}

/**
 * Delete up to one page of editor overrides last saved before the
 * retention cutoff. Bridge calls: one query, one deleteMany when anything
 * matched.
 */
export async function pruneOverrides(ctx: PluginContext, retentionDays: number, now: Date): Promise<number> {
	const cutoff = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
	const page = await ctx.storage[OVERRIDES]!.query({ where: { updatedAt: { lt: cutoff } }, limit: PRUNE_BATCH });
	if (page.items.length === 0) return 0;
	return await ctx.storage[OVERRIDES]!.deleteMany(page.items.map((i) => i.id));
}

/** Schedule the recurring sync at the interval the settings name. Upserts, so it is safe to repeat. */
export async function ensureScheduled(ctx: PluginContext, interval: string): Promise<void> {
	await ctx.cron?.schedule(SYNC_TASK, { schedule: interval });
}

/**
 * Ask for a report run now instead of reading Buffer inside an admin
 * request, which has the same ten calls and still has to render.
 * Returns false when the host runs no scheduler.
 */
export async function requestRefresh(ctx: PluginContext, now: Date): Promise<boolean> {
	if (!ctx.cron) return false;
	await ctx.cron.schedule(REFRESH_TASK, { schedule: now.toISOString() });
	return true;
}
