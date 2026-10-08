/**
 * What every report phase shares: the metered context, the Buffer client,
 * the stored state, one way to record a failed read, and the shared-bucket
 * guard every Buffer read checks first (`src/buffer/headroom.ts`).
 */

import type { PluginContext } from "emdash/plugin";

import { BufferClient, failureKind, type BufferResult } from "../buffer/client.js";
import { historyRefusal, type HistoryRefusal } from "../buffer/history.js";
import { backfillDecision, backgroundDecision, type Decision, type WindowReading } from "../buffer/headroom.js";
import type { RateLimitSnapshot } from "../buffer/ratelimit.js";
import type { Meter } from "../publish/budget.js";
import type { PluginSettings } from "../settings.js";
import { storedReadings, type Stored } from "../store/kv.js";
import type { ReportState } from "../store/report.js";

export interface PhaseContext {
	ctx: PluginContext;
	meter: Meter;
	settings: PluginSettings;
	stored: Stored;
	/** Null without an API key or network access: Buffer phases do not run. */
	client: BufferClient | null;
	now: Date;
	/** The report state, updated in place by each phase and written once at the end. */
	report: ReportState;
}

export function bufferClient(ctx: PluginContext, settings: PluginSettings): BufferClient | null {
	if (!settings.accessToken || !ctx.http) return null;
	const http = ctx.http;
	return new BufferClient({ fetch: (url, init) => http.fetch(url, init), token: settings.accessToken });
}

/**
 * Record a failed Buffer read on the report state. A 429 pauses every
 * report read until Buffer's Retry-After has passed (api-limits.md: "This
 * is the number to sleep on"); anything else is shown on the page and the
 * phase tries again when it is next due.
 */
export function noteFailure(p: PhaseContext, result: Extract<BufferResult<unknown>, { ok: false }>): void {
	const at = p.now.toISOString();
	if (result.kind === "rate_limited") {
		p.report.pausedUntil = new Date(p.now.getTime() + (result.retryAfterSeconds ?? 60) * 1000).toISOString();
	}
	p.report.problem = { at, kind: result.kind, message: result.message };
}

/** Calls every report run keeps back for its end: the next catch-up run and the report state. */
export const RUN_RESERVE = 2;

/** The plan's history limit in days, when Buffer has named one. */
export function historyDays(p: PhaseContext): number | undefined {
	return p.report.insightsHistory?.days;
}

/** What a failed or part-refused Buffer read says about the plan's history limit. */
export function refusalOf(result: Extract<BufferResult<unknown>, { ok: false }>): HistoryRefusal | null {
	return historyRefusal(result.errors?.length ? result.errors : [{ message: result.message, ...(result.code && { code: result.code }) }]);
}

/**
 * Keep the history limit Buffer named. It is not a failure: nothing goes
 * on `report.problem`, and the reads ask only for what the plan allows
 * from here on.
 *
 * A refusal of a request already cut to the known limit means Buffer
 * counts the days a little differently from this plugin (its day may start
 * in the organisation's time zone, not the plugin's "Time zone" setting),
 * so the limit is taken one day
 * shorter rather than asked for again and refused again.
 */
export function learnHistory(p: PhaseContext, days: number): void {
	const known = p.report.insightsHistory;
	const stamp = p.now.toISOString();
	const next = known && days >= known.days ? Math.max(1, known.days - 1) : days;
	p.report.insightsHistory = { days: next, learntAt: stamp, checkedAt: stamp };
}

/**
 * Record a failed read that was not refused for the history limit alone:
 * Buffer's first other message goes on the page.
 */
export function noteOtherFailure(p: PhaseContext, result: Extract<BufferResult<unknown>, { ok: false }>, refusal: HistoryRefusal | null): void {
	if (!refusal?.other) return noteFailure(p, result);
	const code = refusal.other.code;
	noteFailure(p, { ...result, kind: code ? failureKind(code) : result.kind, message: refusal.other.message, ...(code && { code }) });
}

/** Whether a phase last done at `at` is due again after `everyMs`, or after a Refresh. */
export function isDue(p: PhaseContext, at: string | undefined, everyMs: number): boolean {
	if (!at) return true;
	if (p.report.forcedAt && at < p.report.forcedAt) return true;
	return p.now.getTime() - Date.parse(at) >= everyMs;
}

/** After a failed read, Buffer is left alone this long, so a chain of runs never retries a failing request every minute. */
export const BACKOFF_MS = 15 * 60_000;

export function paused(p: PhaseContext): boolean {
	if (p.report.pausedUntil && Date.parse(p.report.pausedUntil) > p.now.getTime()) return true;
	return Boolean(p.report.problem && p.now.getTime() - Date.parse(p.report.problem.at) < BACKOFF_MS);
}

/**
 * Keep a response's RateLimit reading. It travels in the report state,
 * which every report run writes once at its end anyway, so keeping it
 * costs no bridge call.
 */
export function observe(p: PhaseContext, rateLimit: RateLimitSnapshot | undefined): void {
	if (rateLimit) p.report.rateLimit = rateLimit;
}

function readings(p: PhaseContext): Map<number, WindowReading> {
	return storedReadings({ state: p.stored.state, channels: p.stored.channels, report: p.report }, p.now);
}

function record(p: PhaseContext, decision: Decision): boolean {
	if (decision.allowed) return true;
	p.report.headroom = { at: p.now.toISOString(), until: decision.until, window: decision.window };
	return false;
}

/**
 * Whether a background read may spend a Buffer request now. When it may
 * not, the reason is recorded on the report state ("paused for headroom
 * until ..."): not a failure, so `report.problem` is left alone and the
 * phase simply stops.
 */
export function headroom(p: PhaseContext): boolean {
	return record(p, backgroundDecision(readings(p), p.settings.headroomPercent));
}

/** Whether the backfill of older days may run: the same check, and half the 24-hour window left. Not recorded as a pause. */
export function backfillHeadroom(p: PhaseContext): boolean {
	return backfillDecision(readings(p), p.settings.headroomPercent).allowed;
}

/** At the end of a run: record the pause while the guard holds, clear it once it lifts. */
export function settleHeadroom(p: PhaseContext): void {
	if (headroom(p)) delete p.report.headroom;
}
