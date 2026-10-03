import { describe, expect, it } from "vitest";

import { backfillDecision, backgroundDecision, currentWindows, publishDecision, reserveFor } from "../src/buffer/headroom.js";
import type { RateLimitSnapshot } from "../src/buffer/ratelimit.js";
import { parseSettings } from "../src/settings.js";
import { newSyncOffset, syncSchedule } from "../src/sync/sync.js";

/**
 * The shared-bucket guard, from Buffer's api-limits.md: windows matched by
 * `w`, a reading good until `t` seconds after it was taken, and the
 * reserves the 0.1.1 brief sets (15 minutes: max(20, 20%); 24 hours and
 * 30 days: the "Leave for other tools" share).
 */

const NOW = new Date("2026-10-03T05:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

function snap(at: string, windows: Array<[w: number, q: number, r: number, t: number]>): RateLimitSnapshot {
	return { at, windows: windows.map(([window, quota, remaining, resetSeconds]) => ({ name: `${quota}-in-${window}`, window, quota, remaining, resetSeconds })) };
}

const FREE_FULL = snap(ago(10), [
	[900, 100, 96, 800],
	[86_400, 250, 246, 80_000],
	[2_592_000, 3000, 2996, 2_000_000],
]);

describe("reading the stored snapshots", () => {
	it("keeps a window only until its reset", () => {
		const windows = currentWindows([snap(ago(1000), [[900, 100, 0, 900], [86_400, 250, 10, 80_000]])], NOW);
		// 1000 s after the reading the 15-minute window has reset: unknown, not spent.
		expect(windows.has(900)).toBe(false);
		expect(windows.get(86_400)?.remaining).toBe(10);
	});

	it("takes the newest reading per window, so a 429 with one window does not hide the others", () => {
		const tripped = snap(ago(5), [[900, 100, 0, 600]]);
		const windows = currentWindows([FREE_FULL, tripped], NOW);
		expect(windows.get(900)?.remaining).toBe(0);
		expect(windows.get(86_400)?.remaining).toBe(246);
	});

	it("ignores a window without its policy (no w or q), whatever its name says", () => {
		const nameOnly: RateLimitSnapshot = { at: ago(1), windows: [{ name: "100-in-15min", remaining: 0, resetSeconds: 600 }] };
		expect(currentWindows([nameOnly], NOW).size).toBe(0);
		expect(publishDecision(currentWindows([nameOnly], NOW))).toEqual({ allowed: true });
	});
});

describe("background reads", () => {
	it("are allowed with nothing stored: the first request reads the headers", () => {
		expect(backgroundDecision(currentWindows([], NOW), 25)).toEqual({ allowed: true });
	});

	it("keep max(20, 20%) of the 15-minute window", () => {
		expect(reserveFor({ window: 900, quota: 100 }, 25)).toBe(20);
		expect(reserveFor({ window: 900, quota: 500 }, 25)).toBe(100);
		expect(backgroundDecision(currentWindows([snap(ago(1), [[900, 100, 21, 600]])], NOW), 25).allowed).toBe(true);
		const low = backgroundDecision(currentWindows([snap(ago(1), [[900, 100, 20, 600]])], NOW), 25);
		expect(low).toEqual({ allowed: false, window: 900, until: new Date(Date.parse(ago(1)) + 600_000).toISOString() });
	});

	it("keep the chosen share of the 24-hour and 30-day windows", () => {
		// Free plan, 25%: 63 of 250 a day and 750 of 3,000 a month stay for other tools.
		expect(backgroundDecision(currentWindows([snap(ago(1), [[86_400, 250, 64, 5000]])], NOW), 25).allowed).toBe(true);
		expect(backgroundDecision(currentWindows([snap(ago(1), [[86_400, 250, 63, 5000]])], NOW), 25).allowed).toBe(false);
		expect(backgroundDecision(currentWindows([snap(ago(1), [[2_592_000, 3000, 750, 99_000]])], NOW), 25)).toMatchObject({ allowed: false, window: 2_592_000 });
		// A larger share stops sooner.
		expect(backgroundDecision(currentWindows([snap(ago(1), [[86_400, 250, 120, 5000]])], NOW), 50).allowed).toBe(false);
		expect(backgroundDecision(currentWindows([FREE_FULL], NOW), 75).allowed).toBe(true);
	});

	it("wait for the last window that is short, not the first", () => {
		const both = snap(ago(1), [
			[900, 100, 5, 300],
			[86_400, 250, 30, 7200],
		]);
		expect(backgroundDecision(currentWindows([both], NOW), 25)).toMatchObject({ allowed: false, window: 86_400 });
	});
});

describe("the backfill", () => {
	it("runs only while the 24-hour window is at least half full", () => {
		expect(backfillDecision(currentWindows([snap(ago(1), [[86_400, 250, 125, 5000]])], NOW), 25).allowed).toBe(true);
		expect(backfillDecision(currentWindows([snap(ago(1), [[86_400, 250, 124, 5000]])], NOW), 25).allowed).toBe(false);
		// Still allowed for the rest of the background reads.
		expect(backgroundDecision(currentWindows([snap(ago(1), [[86_400, 250, 124, 5000]])], NOW), 25).allowed).toBe(true);
	});
});

describe("publishing", () => {
	it("goes ahead below the background reserve", () => {
		expect(publishDecision(currentWindows([snap(ago(1), [[900, 100, 1, 600], [86_400, 250, 2, 5000]])], NOW))).toEqual({ allowed: true });
	});

	it("waits for the reset of a spent window, like a 429", () => {
		const decision = publishDecision(currentWindows([snap(ago(60), [[86_400, 250, 0, 3600]])], NOW));
		expect(decision).toEqual({ allowed: false, window: 86_400, until: new Date(Date.parse(ago(60)) + 3_600_000).toISOString() });
	});
});

describe("the headroom setting", () => {
	it("defaults to 25 and stays within 10 to 75", () => {
		expect(parseSettings(new Map()).headroomPercent).toBe(25);
		expect(parseSettings(new Map([["headroomPercent", 5]])).headroomPercent).toBe(10);
		expect(parseSettings(new Map([["headroomPercent", 90]])).headroomPercent).toBe(75);
		expect(parseSettings(new Map([["headroomPercent", "40"]])).headroomPercent).toBe(40);
	});
});

describe("the staggered sync", () => {
	const minutes = (expression: string) => expression.split(" ")[0]!.split(",").map(Number);

	it("never fires on :00 or :30, whatever the offset", () => {
		for (let offset = 0; offset < 60; offset++) {
			for (const m of minutes(syncSchedule("*/30 * * * *", offset))) expect(m % 30).not.toBe(0);
			for (const m of minutes(syncSchedule("*/15 * * * *", offset))) expect(m % 15).not.toBe(0);
			expect(minutes(syncSchedule("0 * * * *", offset))[0]).not.toBe(0);
			expect(syncSchedule("0 */6 * * *", offset)).toMatch(/^\d+ \*\/6 \* \* \*$/);
		}
	});

	it("keeps the interval: four runs an hour, two, one", () => {
		expect(minutes(syncSchedule("*/15 * * * *", 7))).toEqual([8, 23, 38, 53]);
		expect(minutes(syncSchedule("*/30 * * * *", 7))).toEqual([8, 38]);
		expect(syncSchedule("0 * * * *", 7)).toBe("8 * * * *");
	});

	it("spreads installs across the window", () => {
		expect(new Set(Array.from({ length: 60 }, (_, o) => syncSchedule("*/30 * * * *", o))).size).toBe(29);
		expect(newSyncOffset(() => 0)).toBe(0);
		expect(newSyncOffset(() => 0.9999)).toBe(59);
	});
});
