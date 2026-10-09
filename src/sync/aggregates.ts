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
 * - A day is a calendar day in the "Time zone" setting (src/time/zone.ts),
 *   so a post at 8:15 am in Sydney counts on that Sydney day. Its window
 *   runs from the zone's midnight to the last second before the next one,
 *   both sent as UTC instants (`2026-09-26T14:00:00Z` to
 *   `2026-09-27T13:59:59Z` for 27 September in Sydney), the form of the
 *   guide's example, and the reference describes the end as inclusive. A day
 *   on which the clocks change is 23 or 25 hours long, and the window is too.
 * - Figures are refreshed about daily (AggregatedPostMetrics
 *   .metricsUpdatedAt), so the last 30 days are read again once a day and
 *   older days keep what was read last.
 * - Buffer's plan may give figures for a limited number of days only (the
 *   Free plan: 31). Buffer does not document it; it refuses an older window
 *   with a message naming the limit, and the reference types the field
 *   non-null, so one refused alias fails the whole request. The limit is
 *   learnt from that message (`learnHistory`), every window then starts
 *   inside it: the backfill stops at today minus (limit - 1) and a range
 *   longer than the limit covers the limit, with the days it covered kept
 *   beside it. A request refused for the limit alone is asked again at once,
 *   cut to the limit, while the invocation has the calls for it, else on
 *   the next run. Once a week one day just beyond the limit is asked for on
 *   its own; when Buffer answers it, the plan now goes further and the
 *   limit is dropped.
 *
 * Bridge calls with a retry or the weekly check: one more Buffer request,
 * taken only while the invocation has a call for it and one for the row
 * write beyond the run's reserve.
 */

import { failureKind, type AggregateWindow } from "../buffer/client.js";
import { effectiveDays, historyRefusal } from "../buffer/history.js";
import { POST_COUNT } from "../buffer/metrics.js";
import {
	addDays,
	AGGREGATES_ID,
	daysBetween,
	parseAggregates,
	RANGES,
	REPORT_DAYS,
	REPORTS,
	type Aggregates,
	type Day,
} from "../store/report.js";
import { dayEnd, dayOf, dayStart } from "../time/zone.js";
import {
	backfillHeadroom,
	headroom,
	historyDays,
	learnHistory,
	noteFailure,
	noteOtherFailure,
	observe,
	refusalOf,
	RUN_RESERVE,
	type PhaseContext,
} from "./common.js";

/** Aliases per request (api-limits.md: at most 30). */
export const ALIASES_PER_REQUEST = 30;

/** Days read again every day, newest first. */
export const RECENT_DAYS = 30;

/** Channels read: ten keep the three range windows each inside one request. */
export const MAX_CHANNELS = 10;

/** After a failed request the phase waits this long before trying again. */
export const RETRY_AFTER_FAILURE_MS = 60 * 60_000;

export const AGGREGATES_COST = 3;

/** How often a day just beyond the history limit is asked for, to notice a plan that now goes further. */
export const HISTORY_CHECK_MS = 7 * 24 * 60 * 60_000;

interface Planned {
	window: AggregateWindow;
	kind: "recent" | "backfill" | "range" | "check";
	/** A range's real length in days: shorter than the range under a history limit. */
	days?: number;
}

/** The oldest day the plan's history limit lets a window start on, if it has one. */
export function historyFloor(today: Day, limit: number | undefined): Day | undefined {
	return limit === undefined ? undefined : addDays(today, -(limit - 1));
}

/** The later of two days, either of which may be absent. */
function later(a: Day, b: Day | undefined): Day {
	return b !== undefined && daysBetween(a, b) > 0 ? b : a;
}

/** The first day the daily re-read of recent days goes back to. */
function recentFloorOf(today: Day, limit: number | undefined): Day {
	return later(addDays(today, -(RECENT_DAYS - 1)), historyFloor(today, limit));
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
	return state?.done !== dayOf(p.now, p.settings.timeZone);
}

/** One channel's day in the zone, from its first second to its last, as UTC instants. */
export function dayWindow(organizationId: string, channelId: string, day: Day, zone: string): AggregateWindow {
	return { organizationId, channelId, start: dayStart(day, zone), end: dayEnd(day, zone), key: day };
}

/**
 * The windows still to read today, in the order they are read. Without
 * `withBackfill`, days older than the last 30 are left for a later run: the
 * backfill runs only while Buffer's 24-hour window is at least half full.
 */
export function plan(agg: Aggregates, targets: Array<{ id: string; organizationId: string }>, today: Day, zone: string, withBackfill = true, limit?: number): Planned[] {
	const floor = later(addDays(today, -(REPORT_DAYS - 1)), historyFloor(today, limit));
	const recentFloor = recentFloorOf(today, limit);
	settleRecent(agg, today, recentFloor);
	const recent: Planned[] = [];
	const backfill: Planned[] = [];
	const ranges: Planned[] = [];
	for (const t of targets) {
		const prog = agg.progress[t.id] ?? {};
		if (prog.recentOn !== today) {
			for (let day = prog.recentNext ?? today; daysBetween(recentFloor, day) >= 0; day = addDays(day, -1)) {
				recent.push({ kind: "recent", window: dayWindow(t.organizationId, t.id, day, zone) });
			}
		}
		if (withBackfill && prog.backTo) {
			for (let day = addDays(prog.backTo, -1); daysBetween(floor, day) >= 0; day = addDays(day, -1)) {
				backfill.push({ kind: "backfill", window: dayWindow(t.organizationId, t.id, day, zone) });
			}
		}
		if (agg.rangesOn !== today) {
			for (const range of RANGES) {
				const days = effectiveDays(range, limit);
				ranges.push({
					kind: "range",
					days,
					window: { organizationId: t.organizationId, channelId: t.id, start: dayStart(addDays(today, -(days - 1)), zone), end: dayEnd(today, zone), key: String(range) },
				});
			}
		}
	}
	return [...recent, ...ranges, ...backfill];
}

/**
 * A pass over the recent days that stopped on a day the history limit now
 * puts out of reach is complete: nothing older can be read.
 */
function settleRecent(agg: Aggregates, today: Day, recentFloor: Day): void {
	for (const prog of Object.values(agg.progress)) {
		if (prog.recentOn === today || !prog.recentNext || daysBetween(recentFloor, prog.recentNext) >= 0) continue;
		prog.recentOn = today;
		delete prog.recentNext;
		if (!prog.backTo || daysBetween(prog.backTo, recentFloor) < 0) prog.backTo = recentFloor;
	}
}

/** Whether this run should ask for a day just beyond the history limit. */
export function historyCheckDue(p: PhaseContext): boolean {
	const known = p.report.insightsHistory;
	if (!known || known.days >= REPORT_DAYS) return false;
	const last = known.checkedAt ?? known.learntAt;
	return p.now.getTime() - Date.parse(last) >= HISTORY_CHECK_MS;
}

export async function runAggregatesPhase(p: PhaseContext, rounds: number): Promise<void> {
	const client = p.client;
	if (!client) return;
	const zone = p.settings.timeZone;
	const today = dayOf(p.now, zone);
	const stamp = p.now.toISOString();
	const targets = aggregateTargets(p);
	if (targets.length === 0) {
		p.report.aggregates = { at: stamp, done: today };
		return;
	}

	const row = await p.ctx.storage[REPORTS]!.get(AGGREGATES_ID);
	const before = JSON.stringify(row ?? null);
	// A row keyed in another zone (UTC, before 0.1.5) reads as empty and is rebuilt.
	const agg = parseAggregates(row, zone);
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
	// A retry after a history refusal is one round more, while the calls allow it.
	const spare = () => p.meter.left() >= RUN_RESERVE + 2;
	let limitRounds = rounds;
	for (let round = 0; round < limitRounds; round++) {
		const limit = historyDays(p);
		const check = round === 0 && historyCheckDue(p) && backfillHeadroom(p);
		const batch = check ? [checkItem(targets[0]!, today, limit!, zone)] : plan(agg, targets, today, zone, backfillHeadroom(p), limit).slice(0, ALIASES_PER_REQUEST);
		if (batch.length === 0) break;
		// Shared bucket: checked before every request, with the reading the last one brought back.
		if (!headroom(p)) break;
		const result = await client.aggregates(batch.map((b) => b.window));
		observe(p, result.rateLimit);
		if (check) {
			// Asked alone, so a refusal here spoils nothing else.
			const refusal = result.ok ? null : refusalOf(result);
			if (result.ok && result.data.refused.length === 0) {
				delete p.report.insightsHistory;
				delete agg.rangesOn;
				delete p.report.problem;
			} else if (refusal?.only) {
				p.report.insightsHistory = { ...p.report.insightsHistory!, checkedAt: stamp };
			} else if (!result.ok) {
				noteFailure(p, result);
				failed = true;
				break;
			}
			if (round + 1 >= limitRounds && spare()) limitRounds++;
			continue;
		}
		if (!result.ok) {
			const refusal = refusalOf(result);
			if (refusal) learnHistory(p, refusal.days);
			if (refusal?.only) {
				if (round + 1 >= limitRounds && spare()) limitRounds++;
				continue;
			}
			noteOtherFailure(p, result, refusal);
			failed = true;
			break;
		}
		for (const key of apply(agg, batch, result.data.results, today, historyDays(p))) ranges.add(key);
		if (targets.every((t) => RANGES.every((d) => ranges.has(`${t.id}:${d}`)))) agg.rangesOn = today;
		const refusal = historyRefusal(result.data.refused);
		if (result.data.refused.length === 0) {
			delete p.report.problem;
			continue;
		}
		// Some aliases answered and some were refused: the answers are kept.
		if (refusal) learnHistory(p, refusal.days);
		if (refusal?.only) {
			delete p.report.problem;
			if (round + 1 >= limitRounds && spare()) limitRounds++;
			continue;
		}
		const other = refusal?.other ?? result.data.refused[0]!;
		noteFailure(p, { ok: false, kind: failureKind(other.code), message: other.message, ...(other.code && { code: other.code }) });
		failed = true;
		break;
	}

	prune(agg, new Set((p.stored.channels?.channels ?? []).map((c) => c.id)), today);
	if (JSON.stringify(agg) !== before) await p.ctx.storage[REPORTS]!.put(AGGREGATES_ID, agg);

	const remaining = plan(agg, targets, today, zone, backfillHeadroom(p), historyDays(p)).length;
	p.report.aggregates = failed
		? { ...p.report.aggregates, failedAt: stamp }
		: { at: stamp, ...(remaining === 0 ? { done: today } : { pending: true }) };
}

/** The weekly check: one channel's day just beyond the history limit, asked for alone. */
function checkItem(target: { id: string; organizationId: string }, today: Day, limit: number, zone: string): Planned {
	return { kind: "check", window: dayWindow(target.organizationId, target.id, addDays(today, -limit), zone) };
}

/**
 * File each answer and move each channel's progress past the days answered,
 * in order. Returns the range windows answered, as `channelId:days`.
 */
export function apply(
	agg: Aggregates,
	batch: Planned[],
	results: Array<{ window: AggregateWindow; metrics: Record<string, number>; metricsUpdatedAt: string | null }>,
	today: Day,
	limit?: number,
): Set<string> {
	const recentFloor = recentFloorOf(today, limit);
	const answered = new Map(results.map((r) => [r.window, r]));
	const stopped = new Set<string>();
	const fresh = new Set<string>();
	for (const item of batch) {
		const c = item.window.channelId;
		const answer = answered.get(item.window);
		if (item.kind === "range") {
			if (!answer) continue;
			fresh.add(`${c}:${item.window.key}`);
			const days = item.days !== undefined && String(item.days) !== item.window.key ? { days: item.days } : {};
			agg.ranges[c] = { ...agg.ranges[c], [item.window.key]: { metrics: answer.metrics, metricsUpdatedAt: answer.metricsUpdatedAt, ...days } };
			continue;
		}
		if (item.kind === "check") continue;
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
