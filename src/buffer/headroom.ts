/**
 * The shared-bucket guard: whether the plugin may spend a Buffer request
 * now, worked out from the RateLimit readings it has stored. Pure.
 *
 * Buffer counts requests per account, not per tool: "MCP connections share
 * one rate-limit bucket with your personal API keys", every request counts
 * whether it succeeds or fails, and only a 429 is refunded
 * (developers.buffer.com /guides/api-limits.md and
 * /guides/efficient-api-usage.md). The guide asks clients to watch `r` and
 * slow down before a 429 rather than after one.
 *
 * So the plugin's background reads (channel refresh, status, metrics,
 * aggregates) leave a reserve in every window for the site owner's other
 * tools, and stop while a window is below it. Publishing is what the
 * plugin is for, so it only stops when a window is spent (`r` = 0), and
 * then waits for that window's reset, as it would after a 429.
 *
 * A window is matched by its length `w` (900, 86400, 2592000), never by
 * its name, which changes with the plan. A reading is good until `t`
 * seconds after it was taken; after that the window has reset and its
 * reading is unknown. Unknown windows allow the request: the first
 * request reads the headers again.
 */

import type { RateLimitSnapshot } from "./ratelimit.js";

export const WINDOW_15_MIN = 900;
export const WINDOW_DAY = 86_400;
export const WINDOW_30_DAYS = 2_592_000;

/** The 15-minute window keeps at least this many requests, or this share of its quota when that is more. */
export const SHORT_RESERVE_MIN = 20;
export const SHORT_RESERVE_SHARE = 0.2;

/** A backfill of old days runs only while the 24-hour window has at least this share left. */
export const BACKFILL_DAY_SHARE = 0.5;

export interface WindowReading {
	/** Window length in seconds. */
	window: number;
	quota: number;
	remaining: number;
	/** When the window resets (ms since the epoch); the reading is good until then. */
	resetAt: number;
	/** When the reading was taken (ms). */
	takenAt: number;
}

export type Decision = { allowed: true } | { allowed: false; until: string; window: number };

/**
 * The newest reading of each window still in force at `now`, from any
 * number of stored snapshots (the delivery state, the channel snapshot,
 * the report state). A 429's snapshot carries only the window that
 * tripped, so windows are merged one by one rather than taking the newest
 * snapshot whole.
 */
export function currentWindows(snapshots: Array<RateLimitSnapshot | undefined | null>, now: Date): Map<number, WindowReading> {
	const out = new Map<number, WindowReading>();
	for (const snap of snapshots) {
		if (!snap) continue;
		const takenAt = Date.parse(snap.at);
		if (Number.isNaN(takenAt)) continue;
		for (const w of snap.windows) {
			if (w.window === undefined || w.quota === undefined || w.resetSeconds === undefined) continue;
			const resetAt = takenAt + w.resetSeconds * 1000;
			if (resetAt <= now.getTime()) continue;
			const held = out.get(w.window);
			if (held && held.takenAt >= takenAt) continue;
			out.set(w.window, { window: w.window, quota: w.quota, remaining: w.remaining, resetAt, takenAt });
		}
	}
	return out;
}

/** Requests a window keeps back from background reads. */
export function reserveFor(reading: Pick<WindowReading, "window" | "quota">, headroomPercent: number): number {
	if (reading.window === WINDOW_15_MIN) return Math.max(SHORT_RESERVE_MIN, Math.ceil(reading.quota * SHORT_RESERVE_SHARE));
	return Math.ceil((reading.quota * headroomPercent) / 100);
}

function blocked(readings: WindowReading[]): Decision {
	if (readings.length === 0) return { allowed: true };
	// Wait for the last of them: a resumed run would only stop again.
	const last = readings.reduce((a, b) => (b.resetAt > a.resetAt ? b : a));
	return { allowed: false, until: new Date(last.resetAt).toISOString(), window: last.window };
}

/**
 * Whether a background read may go ahead: one request leaves every known
 * window at or above its reserve. The 15-minute window keeps
 * max(20, 20% of its quota); the 24-hour and 30-day windows keep
 * `headroomPercent` of theirs. Other window lengths are not judged.
 */
export function backgroundDecision(windows: Map<number, WindowReading>, headroomPercent: number): Decision {
	const short = [...windows.values()].filter(
		(r) => (r.window === WINDOW_15_MIN || r.window === WINDOW_DAY || r.window === WINDOW_30_DAYS) && r.remaining - 1 < reserveFor(r, headroomPercent),
	);
	return blocked(short);
}

/** Whether the backfill of older days may run: the background check, and half the 24-hour window left. */
export function backfillDecision(windows: Map<number, WindowReading>, headroomPercent: number): Decision {
	const background = backgroundDecision(windows, headroomPercent);
	if (!background.allowed) return background;
	const day = windows.get(WINDOW_DAY);
	if (day && day.remaining < day.quota * BACKFILL_DAY_SHARE) return blocked([day]);
	return { allowed: true };
}

/** Whether a post may be sent (or an uncertain one looked up): no window is spent. */
export function publishDecision(windows: Map<number, WindowReading>): Decision {
	return blocked([...windows.values()].filter((r) => r.remaining <= 0));
}

/** The newest of several stored snapshots, for showing "requests left". */
export function newestSnapshot(snapshots: Array<RateLimitSnapshot | undefined | null>): RateLimitSnapshot | undefined {
	let newest: RateLimitSnapshot | undefined;
	for (const snap of snapshots) {
		if (snap && (!newest || Date.parse(snap.at) > Date.parse(newest.at))) newest = snap;
	}
	return newest;
}
