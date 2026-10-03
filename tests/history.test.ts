import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BufferClient, type Fetcher } from "../src/buffer/client.js";
import { historyLimitDays, historyRefusal } from "../src/buffer/history.js";
import { fitText, renderTemplate } from "../src/publish/text.js";
import { plan } from "../src/sync/aggregates.js";
import { addOrigins, metricsWindow } from "../src/sync/metrics.js";
import type { Aggregates, OriginWork, ReportState } from "../src/store/report.js";
import { allOn, channel, HOUR, json, newHost, NOW, respond, seedChannels, seedConfig, sentBodies, tick } from "./host.js";
import { aggregatesAnswer, baseline, dayAgo, metric, metricsAnswer, nothingDue, postNode, seedReport, today } from "./report-fixtures.js";

/**
 * Buffer's per-plan history limit, learnt from its refusal ("Free-plan
 * Insights are limited to the last 31 days of history.", seen live on the
 * Free plan, not documented by Buffer), partial GraphQL answers, and the
 * {description} tag.
 */

const LIVE = "Free-plan Insights are limited to the last 31 days of history.";
const refusedWhole = (message = LIVE, path: string[] = ["a3"]) => json({ data: null, errors: [{ message, path, extensions: { code: "FORBIDDEN" } }] });

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

describe("reading the limit from Buffer's message", () => {
	it("takes the number from the live message and from looser wordings", () => {
		expect(historyLimitDays(LIVE)).toBe(31);
		expect(historyLimitDays("Insights are LIMITED TO THE PAST 7 DAYS on this plan")).toBe(7);
		expect(historyLimitDays("Your plan includes 90 days of history")).toBe(90);
		expect(historyLimitDays("limited to last 1 day")).toBe(1);
	});

	it("does not invent a limit", () => {
		expect(historyLimitDays("Not authorized")).toBeNull();
		expect(historyLimitDays("limited to the last 0 days")).toBeNull();
		expect(historyLimitDays("limited to the last 99999 days")).toBeNull();
		expect(historyLimitDays(undefined)).toBeNull();
	});

	it("tells a refusal for the limit alone from one with another error", () => {
		expect(historyRefusal([{ message: LIVE }, { message: "limited to the last 40 days" }])).toEqual({ days: 31, only: true });
		expect(historyRefusal([{ message: LIVE }, { message: "boom", code: "UNEXPECTED" }])).toEqual({ days: 31, only: false, other: { message: "boom", code: "UNEXPECTED" } });
		expect(historyRefusal([{ message: "boom" }])).toBeNull();
	});
});

describe("partial GraphQL answers", () => {
	const window = (key: string) => ({ organizationId: "o", channelId: "c1", start: `${key}T00:00:00Z`, end: `${key}T23:59:59Z`, key });
	const client = (body: unknown) => new BufferClient({ fetch: (async () => json(body)) as Fetcher, token: "t" });
	const answer = { metrics: [metric("postCount", 1), metric("reactions", 2)], metricsUpdatedAt: NOW.toISOString() };

	it("a whole-request error fails the request and carries every message, the history limit included", async () => {
		const result = await client({ data: null, errors: [{ message: LIVE, path: ["a1"] }, { message: "second", path: ["a0"] }] }).aggregates([window("2026-01-01"), window("2026-01-02")]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toBe(LIVE);
		expect(result.errors).toEqual([
			{ alias: "a1", message: LIVE },
			{ alias: "a0", message: "second" },
		]);
	});

	it("keeps the aliases that answered and puts each error against its alias", async () => {
		const result = await client({ data: { a0: answer, a1: null, a2: answer }, errors: [{ message: LIVE, path: ["a1"] }] }).aggregates([
			window("2026-01-01"),
			window("2026-01-02"),
			window("2026-01-03"),
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.results.map((r) => r.window.key)).toEqual(["2026-01-01", "2026-01-03"]);
		expect(result.data.refused).toEqual([{ window: window("2026-01-02"), message: LIVE }]);
	});

	it("an error naming no alias, or a rate limit, still fails the whole request", async () => {
		const noPath = await client({ data: { a0: answer }, errors: [{ message: "boom" }] }).aggregates([window("2026-01-01"), window("2026-01-02")]);
		expect(noPath.ok).toBe(false);
		const limited = await client({ data: { a0: answer }, errors: [{ message: "slow", path: ["a1"], extensions: { code: "RATE_LIMIT_EXCEEDED" } }] }).aggregates([
			window("2026-01-01"),
			window("2026-01-02"),
		]);
		expect(limited.ok ? "ok" : limited.kind).toBe("rate_limited");
	});
});

describe("windows under a known limit", () => {
	const targets = [{ id: "c1", organizationId: "org1" }];

	it("the backfill stops at today minus (limit - 1) and the 90-day range covers the limit", () => {
		const agg: Aggregates = { days: {}, ranges: {}, progress: { c1: { recentOn: today, backTo: dayAgo(29) } } };
		const planned = plan(agg, targets, today, true, 31);
		const backfill = planned.filter((p) => p.kind === "backfill").map((p) => p.window.key);
		expect(backfill).toEqual([dayAgo(30)]);
		const range90 = planned.find((p) => p.kind === "range" && p.window.key === "90");
		expect(range90).toMatchObject({ days: 31, window: { start: `${dayAgo(30)}T00:00:00Z` } });
		expect(planned.find((p) => p.window.key === "30")?.days).toBe(30);
	});

	it("without a limit nothing changes", () => {
		const agg: Aggregates = { days: {}, ranges: {}, progress: { c1: { recentOn: today, backTo: dayAgo(29) } } };
		expect(plan(agg, targets, today, true).find((p) => p.window.key === "90")?.window.start).toBe(`${dayAgo(89)}T00:00:00Z`);
	});

	it("the posts window stays inside the limit, slack included", () => {
		expect(metricsWindow(today, undefined)).toEqual({ from: dayAgo(29), since: dayAgo(36) });
		expect(metricsWindow(today, 31)).toEqual({ from: dayAgo(29), since: dayAgo(30) });
		expect(metricsWindow(today, 7)).toEqual({ from: dayAgo(6), since: dayAgo(6) });
	});
});

describe("the {description} tag", () => {
	const values = { title: "T", excerpt: "The entry's description", url: "https://x.example/a" };

	it("fills with the same text as {excerpt}", () => {
		expect(renderTemplate("{title}\n{description}\n{url}", values)).toBe("T\nThe entry's description\nhttps://x.example/a");
		expect(renderTemplate("{Description}|{excerpt}", values)).toBe("The entry's description|The entry's description");
	});

	it("leaves unknown tags as they are", () => {
		expect(renderTemplate("{title} {summary} {desc}", values)).toBe("T {summary} {desc}");
	});

	it("both tags shorten identically and only the description text is cut", () => {
		const long = { ...values, excerpt: "word ".repeat(40).trim() };
		const fitted = fitText("{title} {description} / {excerpt} {url}", long, { max: 80, count: "utf16" });
		expect(fitted.ok).toBe(true);
		if (!fitted.ok) return;
		expect(fitted.text.length).toBeLessThanOrEqual(80);
		const match = /^T (.+) \/ (.+) https:\/\/x\.example\/a$/.exec(fitted.text);
		expect(match?.[1]).toBe(match?.[2]);
		expect(match?.[1]).toMatch(/…$/);
	});
});

describe("posts by origin", () => {
	it("sums per channel, day and origin, counts every PostVia, and leaves unread posts without figures", () => {
		const work: OriginWork = { day: today, since: dayAgo(29), days: {}, counts: {} };
		const sent = NOW.toISOString();
		addOrigins(
			work,
			[
				{ ...postNode("n1"), via: "network", channelId: "c1", createdAt: sent, metrics: { reactions: 5, impressions: 100 }, metricsUpdatedAt: sent },
				{ ...postNode("n2"), via: "network", channelId: "c1", createdAt: sent, metrics: null, metricsUpdatedAt: null },
				{ ...postNode("b1"), via: "buffer", channelId: "c1", createdAt: sent, metrics: { comments: 2 }, metricsUpdatedAt: sent },
				{ ...postNode("a1"), via: "api", channelId: "c1", createdAt: sent, metrics: { reactions: 1, impressions: 10 }, metricsUpdatedAt: sent },
				{ ...postNode("x"), via: "network", channelId: "other", createdAt: sent, metrics: { reactions: 9 }, metricsUpdatedAt: sent },
				{ ...postNode("old"), sentAt: `${dayAgo(40)}T10:00:00Z`, via: "network", channelId: "c1", createdAt: sent, metrics: { reactions: 9 }, metricsUpdatedAt: sent },
			] as never,
			new Set(["c1"]),
			dayAgo(29),
			today,
		);
		expect(work.counts.c1).toEqual({ network: 2, buffer: 1, api: 1 });
		const day = work.days.c1?.[today];
		expect(day?.direct).toEqual({ posts: 1, engagement: 5, impressions: 100 });
		// Buffer and the API are one origin; impressions only where reported.
		expect(day?.buffer).toEqual({ posts: 2, engagement: 3, impressions: 10 });
		expect(day?.unread).toBe(1);
		expect(work.days.other).toBeUndefined();
	});
});

describe("learning the limit in the sync", () => {
	const LI = channel("c1", "linkedin");
	const report = async (runtime: PluginRuntimeTestHost) => (await runtime.inspect.kv.get<ReportState>("report")) ?? {};
	const aggRow = async (runtime: PluginRuntimeTestHost) => (await runtime.inspect.storage.list<Aggregates>("reports")).find((r) => r.id === "aggregates")?.data;

	async function setup(state: ReportState, agg?: Aggregates) {
		host = await newHost();
		await seedChannels(host, [LI]);
		await seedConfig(host, { channels: allOn([LI]) });
		await seedReport(host, state);
		if (agg) await host.fixtures.plugin.storage("reports", "aggregates", agg);
		return host;
	}
	const recentDone = (): Aggregates => ({ days: {}, ranges: {}, progress: { c1: { recentOn: today, backTo: dayAgo(29) } } });

	it("a range batch refused for the limit is asked again at once, cut to it, and no problem is shown", async () => {
		host = await setup({ ...nothingDue(), aggregates: undefined }, recentDone());
		await respond(host, refusedWhole(), aggregatesAnswer(4, [...baseline(1, 2, 3), metric("impressions", 50)]));

		await tick(host, "sync")();

		const bodies = sentBodies(host);
		expect(bodies).toHaveLength(2);
		// The first ask went 90 days back; the retry starts inside the 31 days.
		expect(bodies[0]!.variables.a2).toMatchObject({ startDateTime: `${dayAgo(89)}T00:00:00Z` });
		expect(bodies[1]!.variables.a2).toMatchObject({ startDateTime: `${dayAgo(30)}T00:00:00Z` });
		expect(bodies[1]!.variables.a3).toMatchObject({ startDateTime: `${dayAgo(30)}T00:00:00Z`, endDateTime: `${dayAgo(30)}T23:59:59Z` });
		const state = await report(host);
		expect(state.insightsHistory).toMatchObject({ days: 31 });
		expect(state.problem).toBeUndefined();
		expect(state.aggregates?.failedAt).toBeUndefined();
		const agg = await aggRow(host);
		expect(agg?.ranges.c1?.["90"]).toMatchObject({ days: 31, metrics: { impressions: 50 } });
		expect(agg?.ranges.c1?.["30"]?.days).toBeUndefined();
		expect(agg?.progress.c1?.backTo).toBe(dayAgo(30));
	});

	it("a partial answer keeps the aliases that answered and learns from the refused one", async () => {
		host = await setup({ ...nothingDue(), aggregates: undefined }, recentDone());
		const filled = { metrics: [...baseline(1, 2, 3), metric("impressions", 70)], metricsUpdatedAt: NOW.toISOString() };
		await respond(
			host,
			json({ data: { a0: filled, a1: filled, a2: null, a3: filled }, errors: [{ message: LIVE, path: ["a2"] }] }),
			aggregatesAnswer(3, [...baseline(1, 2, 3), metric("impressions", 40)]),
		);

		await tick(host, "sync")();

		const agg = await aggRow(host);
		// The backfill day answered in the partial request is kept.
		expect(agg?.days.c1?.[dayAgo(30)]).toMatchObject({ posts: 1 });
		expect(agg?.progress.c1?.backTo).toBe(dayAgo(30));
		const state = await report(host);
		expect(state.insightsHistory?.days).toBe(31);
		expect(state.problem).toBeUndefined();
		// The ranges are asked again, the 90-day one cut to the limit; the backfill is done.
		const retry = sentBodies(host)[1]!.variables;
		expect(Object.keys(retry)).toHaveLength(3);
		expect(retry.a2).toMatchObject({ startDateTime: `${dayAgo(30)}T00:00:00Z` });
		expect(agg?.ranges.c1?.["90"]).toMatchObject({ days: 31, metrics: { impressions: 40 } });
	});

	it("a partial answer with another error keeps the answers and shows that error", async () => {
		host = await setup({ ...nothingDue(), aggregates: undefined }, recentDone());
		const filled = { metrics: baseline(1, 2, 3), metricsUpdatedAt: NOW.toISOString() };
		await respond(host, json({ data: { a0: filled, a1: null, a2: filled, a3: filled }, errors: [{ message: "Something broke", path: ["a1"], extensions: { code: "UNEXPECTED" } }] }));

		await tick(host, "sync")();

		expect(sentBodies(host)).toHaveLength(1);
		const agg = await aggRow(host);
		expect(agg?.ranges.c1?.["7"]).toBeDefined();
		expect(agg?.ranges.c1?.["30"]).toBeUndefined();
		const state = await report(host);
		expect(state.problem).toMatchObject({ kind: "uncertain", message: "Something broke" });
		expect(state.insightsHistory).toBeUndefined();
	});

	it("another error beside the history refusal is a failure, with that error shown", async () => {
		host = await setup({ ...nothingDue(), aggregates: undefined }, recentDone());
		await respond(host, json({ data: null, errors: [{ message: LIVE, path: ["a2"] }, { message: "Server trouble", path: ["a0"], extensions: { code: "UNEXPECTED" } }] }));

		await tick(host, "sync")();

		expect(sentBodies(host)).toHaveLength(1);
		const state = await report(host);
		expect(state.insightsHistory?.days).toBe(31);
		expect(state.problem).toMatchObject({ message: "Server trouble" });
		expect(state.aggregates?.failedAt).toBeDefined();
	});

	it("a refusal under the limit already applied takes it one day shorter instead of asking again", async () => {
		const learnt = new Date(NOW.getTime() - HOUR).toISOString();
		host = await setup({ ...nothingDue(), aggregates: undefined, insightsHistory: { days: 31, learntAt: learnt, checkedAt: learnt } }, recentDone());
		await respond(host, refusedWhole(), aggregatesAnswer(4, baseline(1, 2, 3)));

		await tick(host, "sync")();

		expect((await report(host)).insightsHistory?.days).toBe(30);
		expect(sentBodies(host)[1]!.variables.a2).toMatchObject({ startDateTime: `${dayAgo(29)}T00:00:00Z` });
	});

	it("once a week asks for one day beyond the limit, alone, and drops the limit when Buffer answers", async () => {
		const learnt = new Date(NOW.getTime() - 8 * 24 * HOUR).toISOString();
		host = await setup({ ...nothingDue(), aggregates: undefined, insightsHistory: { days: 31, learntAt: learnt } }, { ...recentDone(), rangesOn: today });
		await respond(host, aggregatesAnswer(1, baseline(0, 0, 0), null), aggregatesAnswer(30, baseline(0, 0, 0), null));

		await tick(host, "sync")();

		const [check] = sentBodies(host);
		expect(Object.keys(check!.variables)).toEqual(["a0"]);
		expect(check!.variables.a0).toMatchObject({ startDateTime: `${dayAgo(31)}T00:00:00Z`, endDateTime: `${dayAgo(31)}T23:59:59Z` });
		const state = await report(host);
		expect(state.insightsHistory).toBeUndefined();
		// The ranges are read again over their full length.
		expect(sentBodies(host)[1]!.variables.a0).toMatchObject({ startDateTime: `${dayAgo(6)}T00:00:00Z` });
	});

	it("the weekly check refused again keeps the limit and notes when it was checked", async () => {
		const learnt = new Date(NOW.getTime() - 8 * 24 * HOUR).toISOString();
		host = await setup({ ...nothingDue(), aggregates: undefined, insightsHistory: { days: 31, learntAt: learnt } }, { ...recentDone(), rangesOn: today });
		await respond(host, refusedWhole(LIVE, ["a0"]), aggregatesAnswer(1, baseline(0, 0, 0)));

		await tick(host, "sync")();

		const state = await report(host);
		expect(state.insightsHistory).toMatchObject({ days: 31, learntAt: learnt });
		expect(Date.parse(state.insightsHistory!.checkedAt!)).toBeGreaterThan(Date.parse(learnt));
		expect(state.problem).toBeUndefined();
	});

	it("a metrics read refused for the limit starts again inside it at once", async () => {
		host = await setup({ ...nothingDue(), metrics: undefined });
		await respond(host, json({ data: null, errors: [{ message: "Free-plan Insights are limited to the last 14 days of history.", path: ["posts"] }] }), metricsAnswer([]));

		await tick(host, "sync")();

		const bodies = sentBodies(host);
		expect(bodies).toHaveLength(2);
		const start = (i: number) => (bodies[i]!.variables.input as { filter: { createdAt: { start: string } } }).filter.createdAt.start;
		expect(start(0)).toBe(`${dayAgo(36)}T00:00:00Z`);
		expect(start(1)).toBe(`${dayAgo(13)}T00:00:00Z`);
		const state = await report(host);
		expect(state.insightsHistory?.days).toBe(14);
		expect(state.problem).toBeUndefined();
		expect(state.metrics).toMatchObject({ day: today });
	});

	it("drops a history refusal 0.1.1 stored as the last problem", async () => {
		host = await setup({ ...nothingDue(), problem: { at: NOW.toISOString(), kind: "forbidden", message: LIVE } });
		await tick(host, "sync")();
		expect((await report(host)).problem).toBeUndefined();
	});

	it("files a finished pass by origin and records the method per channel", async () => {
		host = await setup({ ...nothingDue(), metrics: undefined });
		const sent = NOW.toISOString();
		await respond(
			host,
			metricsAnswer([
				postNode("n1", { via: "network", channelId: "c1", createdAt: sent, metrics: [metric("reactions", 6), metric("impressions", 600)], metricsUpdatedAt: sent }),
				postNode("b1", { via: "api", channelId: "c1", createdAt: sent, metrics: [metric("reactions", 1), metric("impressions", 100)], metricsUpdatedAt: sent }),
			]),
		);

		await tick(host, "sync")();

		const origins = (await host.inspect.storage.list<{ days: Record<string, Record<string, unknown>>; coveredFrom: Record<string, string> }>("reports")).find((r) => r.id === "origins")?.data;
		expect(origins?.days.c1?.[today]).toEqual({ direct: { posts: 1, engagement: 6, impressions: 600 }, buffer: { posts: 1, engagement: 1, impressions: 100 } });
		expect(origins?.coveredFrom.c1).toBe(dayAgo(29));
		const state = await report(host);
		expect(state.origins?.channels.c1).toEqual({ method: "listed", counts: { network: 1, buffer: 0, api: 1 } });
		expect(state.originsWork).toBeUndefined();
		const body = sentBodies(host)[0]!;
		expect(body.query).toMatch(/\bvia\b/);
		expect(body.query).toMatch(/\bchannelId\b/);
	});
});
