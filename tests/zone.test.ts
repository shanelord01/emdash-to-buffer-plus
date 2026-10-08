import { describe, expect, it } from "vitest";

import { sendsByDay } from "../src/report/figures.js";
import { parseSettings } from "../src/settings.js";
import { dayWindow } from "../src/sync/aggregates.js";
import { addOrigins, metricsWindow } from "../src/sync/metrics.js";
import type { OriginWork } from "../src/store/report.js";
import { addDays, dayEnd, dayOf, dayStart, daysBetween, DEFAULT_TIME_ZONE, resolveTimeZone } from "../src/time/zone.js";
import { formatDay, formatShortDay, formatTime } from "../src/ui/format.js";
import { entry } from "./report-fixtures.js";

/**
 * Days in the "Time zone" setting. The case that showed the bug, live on
 * fueloracle.com.au with 0.1.4 (9 October 2026): Buffer showed a Facebook
 * post published "Sep 27, 8:15 AM" Sydney time, 2026-09-26T22:15Z, and the
 * plugin's daily charts put it on 26 September.
 */

const SYD = "Australia/Sydney";
const POSTED = "2026-09-26T22:15:00Z";

describe("the day a moment falls on", () => {
	it("a post at 8:15 am Sydney time counts on that Sydney day, not the UTC one", () => {
		expect(dayOf(POSTED, SYD)).toBe("2026-09-27");
		expect(dayOf(POSTED, "UTC")).toBe("2026-09-26");
		expect(dayOf(new Date(POSTED), SYD)).toBe("2026-09-27");
	});

	it("the window Buffer is asked for on 27 September in Sydney holds that post, and the one for the 26th does not", () => {
		const day27 = dayWindow("o", "c", "2026-09-27", SYD);
		expect(day27).toMatchObject({ start: "2026-09-26T14:00:00Z", end: "2026-09-27T13:59:59Z", key: "2026-09-27" });
		expect(Date.parse(day27.start) <= Date.parse(POSTED) && Date.parse(POSTED) <= Date.parse(day27.end)).toBe(true);
		const day26 = dayWindow("o", "c", "2026-09-26", SYD);
		expect(Date.parse(POSTED)).toBeGreaterThan(Date.parse(day26.end));
	});

	it("the ledger's daily sends and the posts by origin put it on 27 September", () => {
		const ledger = { entries: { a: entry({ sentAt: POSTED, createdAt: POSTED }) } };
		const rows = sendsByDay(ledger, { start: "2026-09-25", end: "2026-09-28" }, "2026-09-01T00:00:00Z", SYD);
		expect(rows.filter((r) => r.sent > 0).map((r) => r.day)).toEqual(["2026-09-27"]);

		const work: OriginWork = { day: "2026-10-09", since: "2026-09-10", days: {}, counts: {} };
		const post = { id: "p", via: "network", channelId: "c1", sentAt: POSTED, dueAt: null, createdAt: POSTED, metrics: { reactions: 1, impressions: 114 }, metricsUpdatedAt: "2026-09-28T00:00:00Z" };
		addOrigins(work, [post] as never, new Set(["c1"]), "2026-09-10", "2026-10-09", SYD);
		expect(Object.keys(work.days.c1 ?? {})).toEqual(["2026-09-27"]);
		expect(work.days.c1?.["2026-09-27"]?.direct).toEqual({ posts: 1, engagement: 1, impressions: 114 });
	});

	it("the posts read asks Buffer from the first day's Sydney midnight", () => {
		const { since } = metricsWindow("2026-10-09", 31);
		expect(since).toBe("2026-09-09");
		expect(dayStart(since, SYD)).toBe("2026-09-08T14:00:00Z");
	});
});

describe("days across a change of the clocks", () => {
	it("4 October 2026, when Sydney's daylight saving starts at 2 am, is 23 hours long", () => {
		expect(dayStart("2026-10-03", SYD)).toBe("2026-10-02T14:00:00Z");
		expect(dayEnd("2026-10-03", SYD)).toBe("2026-10-03T13:59:59Z");
		expect(dayStart("2026-10-04", SYD)).toBe("2026-10-03T14:00:00Z");
		expect(dayEnd("2026-10-04", SYD)).toBe("2026-10-04T12:59:59Z");
		expect(dayStart("2026-10-05", SYD)).toBe("2026-10-04T13:00:00Z");
		expect(dayEnd("2026-10-05", SYD)).toBe("2026-10-05T12:59:59Z");
		// 1:59:59 am AEST is 4 October, and 3 am AEDT follows a second later.
		expect(dayOf("2026-10-03T15:59:59Z", SYD)).toBe("2026-10-04");
		expect(dayOf("2026-10-03T16:00:00Z", SYD)).toBe("2026-10-04");
		expect(dayOf("2026-10-04T12:59:59Z", SYD)).toBe("2026-10-04");
		expect(dayOf("2026-10-04T13:00:00Z", SYD)).toBe("2026-10-05");
	});

	it("5 April 2026, when it ends, is 25 hours long", () => {
		expect(dayStart("2026-04-05", SYD)).toBe("2026-04-04T13:00:00Z");
		expect(dayEnd("2026-04-05", SYD)).toBe("2026-04-05T13:59:59Z");
	});

	it("adding days steps one calendar day at a time over the change, and windows meet without a gap or overlap", () => {
		expect(addDays("2026-10-03", 1)).toBe("2026-10-04");
		expect(addDays("2026-10-04", 1)).toBe("2026-10-05");
		expect(addDays("2026-10-05", -2)).toBe("2026-10-03");
		expect(daysBetween("2026-09-30", "2026-10-10")).toBe(10);
		for (let day = "2026-09-28"; daysBetween(day, "2026-10-08") >= 0; day = addDays(day, 1)) {
			const next = addDays(day, 1);
			expect(Date.parse(dayStart(next, SYD)) - Date.parse(dayEnd(day, SYD))).toBe(1000);
			expect(dayOf(dayStart(day, SYD), SYD)).toBe(day);
			expect(dayOf(dayEnd(day, SYD), SYD)).toBe(day);
		}
	});

	it("a zone whose clocks skip midnight starts the day when its clock does", () => {
		// Chile: 6 September 2026 starts at 1 am, 2026-09-06T04:00Z.
		expect(dayStart("2026-09-06", "America/Santiago")).toBe("2026-09-06T04:00:00Z");
		expect(dayEnd("2026-09-05", "America/Santiago")).toBe("2026-09-06T03:59:59Z");
	});
});

describe("the Time zone setting", () => {
	it("defaults to Australia/Sydney, keeps a zone the runtime knows and falls back from one it does not", () => {
		expect(DEFAULT_TIME_ZONE).toBe("Australia/Sydney");
		expect(parseSettings(new Map()).timeZone).toBe("Australia/Sydney");
		expect(parseSettings(new Map([["timeZone", "Australia/Perth"]])).timeZone).toBe("Australia/Perth");
		expect(parseSettings(new Map([["timeZone", "Mars/Olympus_Mons"]])).timeZone).toBe("Australia/Sydney");
		expect(parseSettings(new Map([["timeZone", 42]])).timeZone).toBe("Australia/Sydney");
		expect(resolveTimeZone("  ")).toBe("Australia/Sydney");
		expect(resolveTimeZone("europe/london")).toBe("Europe/London");
		expect(resolveTimeZone("Not a zone", "UTC")).toBe("UTC");
	});
});

describe("labels in the zone", () => {
	it("a moment shows its Sydney day and time; a day key shows the date it names", () => {
		expect(formatTime(POSTED, "en", SYD)).toBe("27 Sept 2026, 8:15 am AEST");
		expect(formatDay(POSTED, "en", SYD)).toBe("27 Sept 2026");
		expect(formatDay("2026-09-27", "en", SYD)).toBe("27 Sept 2026");
		expect(formatShortDay("2026-09-27", "en")).toBe("27 Sept");
		expect(formatTime("2026-10-04T00:00:00Z", "en", SYD)).toBe("4 Oct 2026, 11:00 am AEDT");
	});
});
