import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Delivery } from "../src/store/deliveries.js";
import { parseAggregates, parseOrigins, type Aggregates, type Ledger, type ReportState } from "../src/store/report.js";
import {
	allOn,
	channel,
	created,
	deliveries,
	HOUR,
	json,
	limits,
	newHost,
	NOW,
	rateLimited,
	reading,
	respond,
	seedChannels,
	seedConfig,
	seedDelivery,
	seedState,
	sentBodies,
	tick,
} from "./host.js";
import {
	aggregatesAnswer,
	baseline,
	dayAgo,
	metric,
	metricsAnswer,
	nothingDue,
	postNode,
	seedReport,
	statusAnswer,
	today,
	ZONE,
} from "./report-fixtures.js";
import { dayEnd, dayStart } from "../src/time/zone.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const LI = channel("c1", "linkedin");

async function setup(report: ReportState) {
	host = await newHost();
	await seedChannels(host, [LI]);
	await seedConfig(host, { channels: allOn([LI]) });
	await seedReport(host, report);
	return host;
}

const report = async (runtime: PluginRuntimeTestHost) => (await runtime.inspect.kv.get<ReportState>("report")) ?? {};
const row = async <T>(runtime: PluginRuntimeTestHost, id: string) =>
	(await runtime.inspect.storage.list<T>("reports")).find((r) => r.id === id)?.data;
const operation = (body: { query: string }) => body.query.match(/query (\w+)/)?.[1];

describe("the status phase", () => {
	it("follows a queued post to sent and copies it into the ledger", async () => {
		host = await setup({ ...nothingDue(), status: undefined, scan: undefined });
		await seedDelivery(host, "posts:e1:c1", { status: "sent", postId: "p1", postStatus: "scheduled", dueAt: NOW.toISOString() });
		const sentAt = new Date(NOW.getTime() - HOUR).toISOString();
		await respond(host, statusAnswer([postNode("other"), postNode("p1", { sentAt, externalLink: "https://www.linkedin.com/feed/update/1" })]));

		await tick(host, "sync")();

		const [body] = sentBodies(host);
		expect(operation(body!)).toBe("PostStatuses");
		const input = body!.variables.s0 as { organizationId: string; filter: { channelIds: string[]; createdAt: { start: string; end: string } } };
		expect(input.organizationId).toBe("org1");
		expect(input.filter.channelIds).toEqual(["c1"]);
		// The window brackets the moment the plugin created the post.
		const created = Date.parse((await deliveries(host))[0]!.createdAt);
		expect(Date.parse(input.filter.createdAt.start)).toBeLessThan(created);
		expect(Date.parse(input.filter.createdAt.end)).toBeGreaterThan(created);

		const [d] = await deliveries(host);
		expect(d).toMatchObject({ postStatus: "sent", sentAt, externalLink: "https://www.linkedin.com/feed/update/1" });
		const ledger = await row<Ledger>(host, "ledger");
		expect(ledger?.entries["posts:e1:c1"]).toMatchObject({ postStatus: "sent", sentAt, link: "https://www.linkedin.com/feed/update/1" });
	});

	it("keeps Buffer's publishing error", async () => {
		host = await setup({ ...nothingDue(), status: undefined });
		await seedDelivery(host, "posts:e1:c1", { status: "sent", postId: "p1", postStatus: "sending" });
		await respond(host, statusAnswer([postNode("p1", { status: "error", sentAt: null, error: { message: "The image is too large for Instagram." } })]));

		await tick(host, "sync")();

		expect((await deliveries(host))[0]).toMatchObject({ postStatus: "error", postError: "The image is too large for Instagram." });
	});

	it("marks a post Buffer no longer has after three misses, and stops looking it up", async () => {
		host = await setup({ ...nothingDue(), status: undefined });
		await seedDelivery(host, "posts:e1:c1", { status: "sent", postId: "p1", postStatus: "scheduled", statusMisses: 2 });
		await respond(host, statusAnswer([]));

		await tick(host, "sync")();
		expect((await deliveries(host))[0]).toMatchObject({ postStatus: "notFound", statusMisses: 3 });

		await seedReport(host, { ...nothingDue(), status: undefined });
		host.http.clear();
		await tick(host, "sync")();
		expect(host.http.requests()).toHaveLength(0);
	});

	it("leaves records alone when Buffer fails, and backs off", async () => {
		host = await setup({ ...nothingDue(), status: undefined });
		const before = await seedDelivery(host, "posts:e1:c1", { status: "sent", postId: "p1", postStatus: "scheduled" });
		await respond(host, json({ errors: [{ message: "boom" }] }, 503));

		await tick(host, "sync")();

		expect((await deliveries(host))[0]).toEqual(before);
		expect((await report(host)).problem).toMatchObject({ kind: "uncertain" });
		host.http.clear();
		await tick(host, "sync")();
		expect(host.http.requests()).toHaveLength(0);
	});
});

describe("the metrics phase", () => {
	it("stores Buffer's figures on our sent posts and leaves missing ones missing", async () => {
		host = await setup({ ...nothingDue(), metrics: undefined });
		await seedDelivery(host, "posts:e1:c1", { status: "sent", postId: "p1", postStatus: "sent" });
		await seedDelivery(host, "posts:e2:c1", { entryId: "e2", status: "sent", postId: "p2", postStatus: "sent" });
		await respond(
			host,
			metricsAnswer([
				postNode("p1", { metrics: [metric("reactions", 7), metric("comments", 2), metric("impressions", 300), metric("engagementRate", 3, "percentage")], metricsUpdatedAt: NOW.toISOString() }),
				// Sent, not read by Buffer yet: no figures, not zeros.
				postNode("p2", { metrics: [], metricsUpdatedAt: null }),
				postNode("not-ours", { metrics: [metric("reactions", 99)], metricsUpdatedAt: NOW.toISOString() }),
			]),
		);

		await tick(host, "sync")();

		const [body] = sentBodies(host);
		expect(operation(body!)).toBe("SentPostMetrics");
		const input = body!.variables.input as { organizationId: string; filter: { channelIds: string[]; status: string[]; createdAt: { start: string } } };
		expect(input).toMatchObject({ organizationId: "org1", filter: { channelIds: ["c1"], status: ["sent"] } });
		expect(NOW.getTime() - Date.parse(input.filter.createdAt.start)).toBeGreaterThanOrEqual(29 * 24 * HOUR);

		const byPost = Object.fromEntries((await deliveries(host)).map((d) => [d.postId, d]));
		expect(byPost.p1).toMatchObject({ metrics: { reactions: 7, comments: 2, impressions: 300, engagementRate: 3 }, metricsUpdatedAt: NOW.toISOString() });
		expect(byPost.p2?.metrics).toBeUndefined();
		expect((await report(host)).metrics).toMatchObject({ day: today });
	});

	it("continues a long list from Buffer's cursor on the next run", async () => {
		host = await setup({ ...nothingDue(), metrics: undefined });
		await respond(host, metricsAnswer([postNode("x")], { endCursor: "cursor-1", hasNextPage: true }));
		await tick(host, "sync")();
		expect((await report(host)).metrics).toMatchObject({ cursor: "cursor-1" });

		host.http.clear();
		await respond(host, metricsAnswer([]));
		await tick(host, "catchup-a")();
		expect(sentBodies(host)[0]!.variables.after).toBe("cursor-1");
		expect((await report(host)).metrics).toEqual({ day: today, at: expect.any(String) });
	});
});

describe("the aggregates phase", () => {
	it("reads the last 30 days one channel per alias, newest first, and files each day", async () => {
		host = await setup({ ...nothingDue(), aggregates: undefined });
		await respond(host, aggregatesAnswer(30, [...baseline(2, 10, 3), metric("impressions", 500), metric("engagementRate", 4.2, "percentage")]));

		await tick(host, "sync")();

		const [body] = sentBodies(host);
		expect(operation(body!)).toBe("Aggregates");
		expect(Object.keys(body!.variables)).toHaveLength(30);
		expect(body!.variables.a0).toEqual({ organizationId: "org1", startDateTime: dayStart(today, ZONE), endDateTime: dayEnd(today, ZONE), channelIds: ["c1"] });
		expect(body!.variables.a29).toMatchObject({ startDateTime: dayStart(dayAgo(29), ZONE) });

		const agg = await row<Aggregates>(host, "aggregates");
		expect(agg?.days.c1?.[today]).toEqual({ posts: 2, metrics: { reactions: 10, comments: 3, impressions: 500, engagementRate: 4.2 }, metricsUpdatedAt: NOW.toISOString() });
		expect(agg?.progress.c1).toMatchObject({ recentOn: today, backTo: dayAgo(29) });
		// The ranges and the older days are still to read: a catch-up run follows.
		expect((await report(host)).aggregates).toMatchObject({ pending: true });
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("catchup-a");
	});

	it("a catch-up run reads the ranges and backfills older days, then hands on to the other name", async () => {
		host = await setup({ ...nothingDue(), aggregates: undefined });
		const recentOnly: Aggregates = { days: {}, ranges: {}, progress: { c1: { recentOn: today, backTo: dayAgo(29) } } };
		await host.fixtures.plugin.storage("reports", "aggregates", { zone: ZONE, ...recentOnly });
		await respond(host, aggregatesAnswer(30, baseline(1, 4, 1)), aggregatesAnswer(30, baseline(0, 0, 0), null));

		await tick(host, "catchup-a")();

		const bodies = sentBodies(host);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]!.variables.a0).toMatchObject({ startDateTime: dayStart(dayAgo(6), ZONE), endDateTime: dayEnd(today, ZONE) });
		expect(bodies[0]!.variables.a3).toMatchObject({ startDateTime: dayStart(dayAgo(30), ZONE), endDateTime: dayEnd(dayAgo(30), ZONE) });
		const agg = await row<Aggregates>(host, "aggregates");
		expect(agg?.rangesOn).toBe(today);
		expect(agg?.ranges.c1?.["90"]).toMatchObject({ metrics: { reactions: 4, comments: 1 } });
		// Round one: three ranges and 27 days back from day 30; round two: 30 more.
		expect(agg?.progress.c1?.backTo).toBe(dayAgo(86));
		// A day with no posts matched: Buffer says null, and it is kept as not read.
		expect(agg?.days.c1?.[dayAgo(60)]?.metricsUpdatedAt).toBeNull();
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("catchup-b");
	});

	it("a 429 pauses every report read until Retry-After has passed", async () => {
		host = await setup({ ...nothingDue(), aggregates: undefined });
		await respond(host, rateLimited(600));

		await tick(host, "sync")();

		const state = await report(host);
		expect(Date.parse(state.pausedUntil!) - Date.now()).toBeGreaterThan(500_000);
		await seedReport(host, { ...state, status: undefined, metrics: undefined });
		host.http.clear();
		await tick(host, "sync")();
		expect(host.http.requests()).toHaveLength(0);
	});
});

describe("updating from 0.1.4, whose days were UTC", () => {
	const utcRow = {
		days: { c1: { [dayAgo(1)]: { posts: 1, metrics: { reactions: 1, impressions: 114 }, metricsUpdatedAt: NOW.toISOString() }, [dayAgo(60)]: { posts: 1, metrics: { reactions: 9 }, metricsUpdatedAt: NOW.toISOString() } } },
		ranges: { c1: { "7": { metrics: { impressions: 114 }, metricsUpdatedAt: NOW.toISOString() } } },
		progress: { c1: { recentOn: today, backTo: dayAgo(60) } },
		rangesOn: today,
	};

	it("pages read the UTC-keyed rows as empty until the sync has rebuilt them", () => {
		expect(parseAggregates(utcRow, ZONE)).toEqual({ zone: ZONE, days: {}, ranges: {}, progress: {} });
		expect(parseAggregates({ ...utcRow, zone: ZONE }, ZONE).days.c1?.[dayAgo(1)]).toBeDefined();
		expect(parseOrigins({ days: { c1: { [dayAgo(1)]: { unread: 1 } } }, coveredFrom: { c1: dayAgo(29) } }, ZONE)).toEqual({ zone: ZONE, days: {}, coveredFrom: {} });
		// A changed setting rebuilds the same way.
		expect(parseAggregates({ ...utcRow, zone: "Australia/Perth" }, ZONE).days).toEqual({});
	});

	it("the first sync drops the UTC days and reads the posts and the recent days again in the zone, inside the plan's history", async () => {
		// 0.1.4's state: today's passes done (by UTC day) and no zone recorded.
		const { dayZone: _zone, ...old } = nothingDue();
		host = await setup({ ...old, insightsHistory: { days: 31, learntAt: NOW.toISOString() } });
		await host.fixtures.plugin.storage("reports", "aggregates", utcRow);
		await respond(host, metricsAnswer([]), aggregatesAnswer(30, baseline(1, 2, 0)));

		await tick(host, "sync")();

		expect(sentBodies(host).map(operation)).toEqual(["SentPostMetrics", "Aggregates"]);
		const [metricsBody, aggregatesBody] = sentBodies(host);
		const input = metricsBody!.variables.input as { filter: { createdAt: { start: string } } };
		expect(input.filter.createdAt.start).toBe(dayStart(dayAgo(30), ZONE));
		expect(aggregatesBody!.variables.a0).toMatchObject({ startDateTime: dayStart(today, ZONE), endDateTime: dayEnd(today, ZONE) });

		const state = await report(host);
		expect(state.dayZone).toBe(ZONE);
		expect(state.insightsHistory?.days).toBe(31);
		const agg = await row<Aggregates>(host, "aggregates");
		expect(agg?.zone).toBe(ZONE);
		// The day beyond the Free plan's 31 days cannot be read again, so it goes.
		expect(agg?.days.c1?.[dayAgo(60)]).toBeUndefined();
		expect(agg?.days.c1?.[dayAgo(1)]).toMatchObject({ posts: 1, metrics: { reactions: 2 } });
		expect(agg?.progress.c1).toEqual({ recentOn: today, backTo: dayAgo(29) });
		expect(agg?.ranges).toEqual({});

		// The next sync carries on (ranges, then the origins pass) and does not drop anything again.
		host.http.clear();
		await respond(host, aggregatesAnswer(3, baseline(1, 2, 0)));
		await tick(host, "sync")();
		expect((await row<Aggregates>(host, "aggregates"))?.days.c1?.[dayAgo(1)]).toBeDefined();
		expect((await report(host)).dayZone).toBe(ZONE);
	});
});

describe("the Refresh run", () => {
	it("reads status and figures again even when they were read minutes ago, chaining what does not fit", async () => {
		host = await setup(nothingDue());
		await seedDelivery(host, "posts:e1:c1", { status: "sent", postId: "p1", postStatus: "scheduled" });
		await respond(host, statusAnswer([postNode("p1")]));

		await tick(host, "refresh")();

		expect(sentBodies(host).map(operation)).toEqual(["PostStatuses"]);
		expect((await deliveries(host))[0]).toMatchObject({ postStatus: "sent" });
		expect((await report(host)).forcedAt).toBeDefined();
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("catchup-a");

		await respond(host, metricsAnswer([]), aggregatesAnswer(30, baseline(1, 1, 0)), aggregatesAnswer(30, baseline(1, 1, 0)));
		await tick(host, "catchup-a")();
		// The metrics page was empty, which left room for two aggregate rounds.
		expect(sentBodies(host).map(operation)).toEqual(["PostStatuses", "SentPostMetrics", "Aggregates", "Aggregates"]);
	});
});

describe("the scan phase", () => {
	it("copies changed deliveries into the ledger, ties included, without copying twice", async () => {
		host = await newHost({ token: false });
		await seedReport(host, { ...nothingDue(), scan: undefined });
		const stamp = new Date(NOW.getTime() - HOUR).toISOString();
		for (const id of ["a", "b", "c"]) await seedDelivery(host, `posts:${id}:c1`, { entryId: id, entryTitle: `Entry ${id}`, updatedAt: stamp, status: "failed", error: "nope" });

		await tick(host, "sync")();

		const ledger = await row<Ledger>(host, "ledger");
		expect(Object.keys(ledger?.entries ?? {}).sort()).toEqual(["posts:a:c1", "posts:b:c1", "posts:c:c1"]);
		expect(ledger?.entries["posts:a:c1"]).toMatchObject({ title: "Entry a", status: "failed" });
		expect((await report(host)).scan).toMatchObject({ after: stamp, seen: expect.arrayContaining(["posts:a:c1", "posts:b:c1", "posts:c:c1"]) });

		// A later change to one record is picked up on the next scan.
		const later = new Date(NOW.getTime() - 60_000).toISOString();
		await seedDelivery(host, "posts:b:c1", { entryId: "b", entryTitle: "Entry b", updatedAt: later, status: "sent", postId: "p", postStatus: "sent", sentAt: later });
		await seedReport(host, { ...(await report(host)), scan: { ...(await report(host)).scan, at: undefined } });
		await tick(host, "sync")();
		expect((await row<Ledger>(host, "ledger"))?.entries["posts:b:c1"]).toMatchObject({ status: "sent", postStatus: "sent" });
	});

	it("keeps a post's figures off the ledger until Buffer has read them", async () => {
		host = await newHost({ token: false });
		await seedReport(host, { ...nothingDue(), scan: undefined });
		await seedDelivery(host, "posts:e1:c1", { status: "sent", postStatus: "sent", metrics: { reactions: 0 } as Delivery["metrics"] });
		await seedDelivery(host, "posts:e2:c1", {
			entryId: "e2",
			status: "sent",
			postStatus: "sent",
			metrics: { reactions: 3, comments: 1, likes: 3, clicks: 9 },
			metricsUpdatedAt: NOW.toISOString(),
		});

		await tick(host, "sync")();

		const ledger = await row<Ledger>(host, "ledger");
		expect(ledger?.entries["posts:e1:c1"]?.engagement).toBeUndefined();
		// likes (inside reactions) and clicks are not engagement; impressions were not reported.
		expect(ledger?.entries["posts:e2:c1"]).toMatchObject({ engagement: 4 });
		expect(ledger?.entries["posts:e2:c1"]?.impressions).toBeUndefined();
	});
});

describe("the shared-bucket guard", () => {
	it("pauses the report reads while the day is below the reserve, without a failure, and still runs the delivery pass", async () => {
		host = await setup({ ...nothingDue(), status: undefined, metrics: undefined, aggregates: undefined });
		// 60 of 250 left today: under the 25% (63) kept for other tools.
		await seedState(host, { watchSince: NOW.toISOString(), rateLimit: reading(90, 60, 2500) });
		await seedDelivery(host, "posts:e1:c1", { status: "sent", postId: "p1", postStatus: "scheduled" });
		await seedDelivery(host, "posts:e2:c1", { entryId: "e2", status: "pending" });
		await respond(host, created("p2"));

		await tick(host, "sync")();

		// Only the post went out: no status, metrics or aggregates read.
		expect(sentBodies(host)).toHaveLength(1);
		expect(sentBodies(host)[0]!.query).toContain("createPost");
		const state = await report(host);
		expect(state.headroom).toMatchObject({ window: 86_400 });
		expect(Date.parse(state.headroom!.until)).toBeGreaterThan(Date.now());
		expect(state.problem).toBeUndefined();
		// Paused work is not chased by catch-up runs.
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).not.toContain("catchup-a");
	});

	it("stops between requests when an answer brings the reading below the reserve, and keeps that reading", async () => {
		host = await setup({ ...nothingDue(), metrics: undefined, aggregates: undefined });
		await seedDelivery(host, "posts:e1:c1", { status: "sent", postId: "p1", postStatus: "sent" });
		await respond(host, json({ data: { posts: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } } } }, 200, limits(19, 200, 2000)));

		await tick(host, "sync")();

		expect(sentBodies(host).map(operation)).toEqual(["SentPostMetrics"]);
		const state = await report(host);
		expect(state.rateLimit?.windows.find((w) => w.window === 900)?.remaining).toBe(19);
		expect(state.headroom).toMatchObject({ window: 900 });
	});

	it("clears the pause once the window that ran low has reset", async () => {
		host = await setup(nothingDue());
		const old = new Date(NOW.getTime() - 900_000);
		await seedReport(host, { ...nothingDue(), rateLimit: reading(5, 200, 2000, old), headroom: { at: old.toISOString(), until: NOW.toISOString(), window: 900 } });
		await tick(host, "sync")();
		expect((await report(host)).headroom).toBeUndefined();
	});

	it("leaves the backfill for later while less than half the day is left, and reads the recent days", async () => {
		host = await setup({ ...nothingDue(), aggregates: undefined });
		await seedState(host, { watchSince: NOW.toISOString(), rateLimit: reading(90, 120, 2500) });
		const recentDone: Aggregates = { days: {}, ranges: {}, progress: { c1: { recentOn: today, backTo: dayAgo(29) } }, rangesOn: today };
		await host.fixtures.plugin.storage("reports", "aggregates", { zone: ZONE, ...recentDone });

		await tick(host, "catchup-a")();

		// Only older days were left, and they wait: no request, and the phase is done for today.
		expect(host.http.requests()).toHaveLength(0);
		expect((await report(host)).aggregates).toMatchObject({ done: today });
		expect((await report(host)).headroom).toBeUndefined();
	});

	it("stops a channel refresh part way and keeps the last snapshot", async () => {
		host = await setup({ ...nothingDue(), channelsAt: undefined });
		await seedChannels(host, [LI], { fetchedAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() });
		await respond(host, json({ data: { account: { organizations: [{ id: "org1", name: "Org" }] } } }, 200, limits(90, 40, 2000)));

		await tick(host, "sync")();

		expect(host.http.requests()).toHaveLength(1);
		const state = await report(host);
		expect(state.channelsAt).toBeUndefined();
		expect(state.headroom).toMatchObject({ window: 86_400 });
		expect(state.rateLimit?.windows.find((w) => w.window === 86_400)?.remaining).toBe(40);
		expect((await host.inspect.kv.get<{ fetchedAt: string }>("channels"))?.fetchedAt).toBe(new Date(NOW.getTime() - 25 * HOUR).toISOString());
	});
});
