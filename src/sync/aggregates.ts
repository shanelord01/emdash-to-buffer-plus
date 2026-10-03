/**
 * Aggregates phase: Buffer's `aggregatedPostMetrics` per channel and per
 * day for the charts, and per channel over the last 7, 30 and 90 days for
 * the channel table.
 *
 * Bridge calls: one read of the `aggregates` snapshot row, one Buffer
 * request per round, one write of the row when anything changed. A
 * recurring sync runs one round (3 calls), a catch-up run two (4).
 *
 * Why it is shaped like this, from Buffer's documentation:
 *
 * - `aggregatedPostMetrics` sums one window per request field
 *   (reference.md: AggregatedPostMetricsInput), so a day per channel is one
 *   alias, and one request carries at most 30 aliases (api-limits.md,
 *   Query Limits). 180 days for a few channels is therefore a backfill
 *   over several runs, newest days first, like the Umami plugin's history
 *   pass, and catch-up runs a minute apart finish it the same day.
 * - Each alias names one channel, because a filter over several networks
 *   keeps only the metric types all of them report (post-metrics.md,
 *   "Cross-channel intersection"), which would drop impressions and
 *   Buffer's own engagement rate.
 * - The window is UTC midnight to 23:59:59 of the day, the form the guide's
 *   example uses; the reference describes the end as inclusive of its day.
 * - Figures are refreshed about daily (AggregatedPostMetrics
 *   .metricsUpdatedAt), so the last 30 days are read again once a day and
 *   older days keep what was read last.
 */

import type { AggregateWindow } from "../buffer/client.js";
import { POST_COUNT } from "../buffer/metrics.js";
import {
	addDays,
	AGGREGATES_ID,
	daysBetween,
	parseAggregates,
	RANGES,
	REPORT_DAYS,
	REPORTS,
	utcDay,
	type Aggregates,
	type Day,
} from "../store/report.js";
import { noteFailure, type PhaseContext } from "./common.js";

/** Aliases per request (api-limits.md: at most 30). */
export const ALIASES_PER_REQUEST = 30;

/** Days read again every day, newest first. */
export const RECENT_DAYS = 30;

/** Channels read: ten keep the three range windows each inside one request. */
export const MAX_CHANNELS = 10;

/** After a failed request the phase waits this long before trying again. */
export const RETRY_AFTER_FAILURE_MS = 60 * 60_000;

export const AGGREGATES_COST = 3;

interface Planned {
	window: AggregateWindow;
	kind: "recent" | "backfill" | "range";
}

/** The channels whose figures are read: the ones this plugin shares to. */
export function aggregateTargets(p: PhaseContext): Array<{ id: string; organizationId: string }> {
	return (p.stored.channels?.channels ?? [])
		.filter((c) => p.stored.config.channels[c.id]?.enabled && c.organizationId)
		.slice(0, MAX_CHANNELS)
		.map((c) => ({ id: c.id, organizationId: c.organizationId }));
}

export function aggregatesDue(p: PhaseContext): boolean {
	const state = p.report.aggregates;
	if (state?.failedAt && p.now.getTime() - Date.parse(state.failedAt) < RETRY_AFTER_FAILURE_MS) return false;
	if (p.report.forcedAt && (!state?.at || state.at < p.report.forcedAt)) return true;
	return state?.done !== utcDay(p.now);
}

function dayWindow(organizationId: string, channelId: string, day: Day): AggregateWindow {
	return { organizationId, channelId, start: `${day}T00:00:00Z`, end: `${day}T23:59:59Z`, key: day };
}

/** The windows still to read today, in the order they are read. */
export function plan(agg: Aggregates, targets: Array<{ id: string; organizationId: string }>, today: Day): Planned[] {
	const floor = addDays(today, -(REPORT_DAYS - 1));
	const recentFloor = addDays(today, -(RECENT_DAYS - 1));
	const recent: Planned[] = [];
	const backfill: Planned[] = [];
	const ranges: Planned[] = [];
	for (const t of targets) {
		const prog = agg.progress[t.id] ?? {};
		if (prog.recentOn !== today) {
			for (let day = prog.recentNext ?? today; daysBetween(recentFloor, day) >= 0; day = addDays(day, -1)) {
				recent.push({ kind: "recent", window: dayWindow(t.organizationId, t.id, day) });
			}
		}
		if (prog.backTo) {
			for (let day = addDays(prog.backTo, -1); daysBetween(floor, day) >= 0; day = addDays(day, -1)) {
				backfill.push({ kind: "backfill", window: dayWindow(t.organizationId, t.id, day) });
			}
		}
		if (agg.rangesOn !== today) {
			for (const days of RANGES) {
				ranges.push({
					kind: "range",
					window: { organizationId: t.organizationId, channelId: t.id, start: `${addDays(today, -(days - 1))}T00:00:00Z`, end: `${today}T23:59:59Z`, key: String(days) },
				});
			}
		}
	}
	return [...recent, ...ranges, ...backfill];
}

export async function runAggregatesPhase(p: PhaseContext, rounds: number): Promise<void> {
	const client = p.client;
	if (!client) return;
	const today = utcDay(p.now);
	const stamp = p.now.toISOString();
	const targets = aggregateTargets(p);
	if (targets.length === 0) {
		p.report.aggregates = { at: stamp, done: today };
		return;
	}

	const row = await p.ctx.storage[REPORTS]!.get(AGGREGATES_ID);
	const before = JSON.stringify(row ?? null);
	const agg = parseAggregates(row);
	if (p.report.forcedAt && (!p.report.aggregates?.at || p.report.aggregates.at < p.report.forcedAt)) {
		// A Refresh reads the recent days and the ranges again.
		for (const prog of Object.values(agg.progress)) {
			delete prog.recentOn;
			delete prog.recentNext;
		}
		delete agg.rangesOn;
	}

	let failed = false;
	const ranges = new Set<string>();
	for (let round = 0; round < rounds; round++) {
		const batch = plan(agg, targets, today).slice(0, ALIASES_PER_REQUEST);
		if (batch.length === 0) break;
		const result = await client.aggregates(batch.map((b) => b.window));
		if (!result.ok) {
			noteFailure(p, result);
			failed = true;
			break;
		}
		delete p.report.problem;
		for (const key of apply(agg, batch, result.data, today)) ranges.add(key);
		if (targets.every((t) => RANGES.every((d) => ranges.has(`${t.id}:${d}`)))) agg.rangesOn = today;
	}

	prune(agg, new Set((p.stored.channels?.channels ?? []).map((c) => c.id)), today);
	if (JSON.stringify(agg) !== before) await p.ctx.storage[REPORTS]!.put(AGGREGATES_ID, agg);

	const remaining = plan(agg, targets, today).length;
	p.report.aggregates = failed
		? { ...p.report.aggregates, failedAt: stamp }
		: { at: stamp, ...(remaining === 0 ? { done: today } : { pending: true }) };
}

/** File each answer and move each channel's progress past the days answered, in order. */
/** Returns the range windows answered, as `channelId:days`. */
export function apply(
	agg: Aggregates,
	batch: Planned[],
	results: Array<{ window: AggregateWindow; metrics: Record<string, number>; metricsUpdatedAt: string | null }>,
	today: Day,
): Set<string> {
	const recentFloor = addDays(today, -(RECENT_DAYS - 1));
	const answered = new Map(results.map((r) => [r.window, r]));
	const stopped = new Set<string>();
	const fresh = new Set<string>();
	for (const item of batch) {
		const c = item.window.channelId;
		const answer = answered.get(item.window);
		if (item.kind === "range") {
			if (!answer) continue;
			fresh.add(`${c}:${item.window.key}`);
			agg.ranges[c] = { ...agg.ranges[c], [item.window.key]: { metrics: answer.metrics, metricsUpdatedAt: answer.metricsUpdatedAt } };
			continue;
		}
		if (stopped.has(`${item.kind}:${c}`)) continue;
		if (!answer) {
			// Progress never jumps a day Buffer did not answer.
			stopped.add(`${item.kind}:${c}`);
			continue;
		}
		const day = item.window.key;
		const { [POST_COUNT]: posts, ...metrics } = answer.metrics;
		agg.days[c] = { ...agg.days[c], [day]: { posts: posts ?? 0, metrics, metricsUpdatedAt: answer.metricsUpdatedAt } };
		const prog = (agg.progress[c] ??= {});
		if (item.kind === "recent") {
			const next = addDays(day, -1);
			if (daysBetween(recentFloor, next) < 0) {
				prog.recentOn = today;
				delete prog.recentNext;
				if (!prog.backTo || daysBetween(prog.backTo, recentFloor) < 0) prog.backTo = recentFloor;
			} else {
				prog.recentNext = next;
			}
		} else if (!prog.backTo || daysBetween(day, prog.backTo) > 0) {
			prog.backTo = day;
		}
	}
	return fresh;
}

/** Days past the report window and channels Buffer no longer lists are dropped. */
function prune(agg: Aggregates, known: Set<string>, today: Day): void {
	const floor = addDays(today, -(REPORT_DAYS - 1));
	for (const c of Object.keys(agg.days)) {
		if (!known.has(c)) {
			delete agg.days[c];
			continue;
		}
		for (const day of Object.keys(agg.days[c]!)) if (daysBetween(floor, day) < 0) delete agg.days[c]![day];
	}
	for (const c of Object.keys(agg.ranges)) if (!known.has(c)) delete agg.ranges[c];
	for (const c of Object.keys(agg.progress)) if (!known.has(c)) delete agg.progress[c];
}
