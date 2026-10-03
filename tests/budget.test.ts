import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PAGE_REFRESH_ACTION, RANGE_ACTION, RETRY_ALL_ACTION, SETUP_ACTION } from "../src/ui/analytics.js";
import { CHANNEL_ACTION_PREFIX, COLLECTIONS_ACTION, DISCOVER_ACTION, PAGE_PATH, RETRY_ACTION, UTM_ACTION } from "../src/ui/page.js";
import { WIDGET_ID, WIDGET_REFRESH_ACTION } from "../src/ui/widget.js";
import { PANEL_AGAIN_ACTION, PANEL_AGAIN_CONFIRM_ACTION, PANEL_CANCEL_ACTION, PANEL_ID, PANEL_RETRY_ACTION, PANEL_SAVE_ACTION, PANEL_SHARE_ACTION, PANEL_SHARE_CONFIRM_ACTION } from "../src/ui/panel.js";
import { TOOL_ROUTES } from "../src/tools/load.js";
import { bridgeCalls } from "./bridge-calls.js";
import {
	allOn,
	channel,
	created,
	deliveries,
	HOUR,
	json,
	newHost,
	NOW,
	postsCollection,
	publishedPost,
	rateLimited,
	reading,
	respond,
	seedChannels,
	seedConfig,
	seedDelivery,
	seedState,
	tick,
	watching,
} from "./host.js";
import {
	aggregatesAnswer,
	baseline,
	dayAgo as dayAgoDay,
	entry,
	metric,
	metricsAnswer,
	nothingDue,
	postNode,
	seedAggregates,
	seedLedger,
	seedReport,
	statusAnswer,
	today,
} from "./report-fixtures.js";

/**
 * Every invocation, at its worst case, against EmDash's sandbox limit.
 *
 * A sandboxed invocation may make ten subrequests and each `ctx` call is
 * one; the eleventh aborts it on Cloudflare. The test host does not enforce
 * the limit, so each test counts the calls and also checks the invocation
 * did its full share of work, so a fixture too small to reach the worst
 * case fails instead of passing quietly.
 */

const LIMIT = 10;

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const FIVE = ["a", "b", "c", "d", "e"].map((id) => channel(id, "linkedin"));

/** A local image as EmDash stores it: the public address comes from the storage key, with no lookup. */
const COVER = { id: "01M3QY3W07VYPSCAA3J1EHX3V8", provider: "local", filename: "c.jpg", mimeType: "image/jpeg", alt: "x", meta: { storageKey: "01M3QY3VKJAWMFNS7TH6JHSA8W.jpg" } };
const ASSET = "https://www.example.com/_emdash/api/media/asset/01M3QY3W07VYPSCAA3J1EHX3V8/c.jpg";

/** Five channels sharing the cover image, so a publish needs the public URL and more sends than fit. */
async function publishSetup(runtime: PluginRuntimeTestHost) {
	await postsCollection(runtime);
	await seedChannels(runtime, FIVE);
	await seedConfig(runtime, { channels: allOn(FIVE), collections: { posts: { enabled: true, image: "cover" } } });
	await seedState(runtime, watching);
	return await publishedPost(runtime, { cover: COVER });
}

describe("lifecycle hooks", () => {
	for (const name of ["plugin:install", "plugin:activate"]) {
		it(name, async () => {
			host = await newHost();
			const calls = await bridgeCalls(() => host!.transport.invokeHook(name, {}));
			expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
			expect(await host.inspect.kv.get("state")).toMatchObject({ watchSince: expect.any(String) });
			expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("sync");
			// Staggered: the default half-hourly sync is never on :00 and :30.
			const state = await host.inspect.kv.get<{ syncOffset: number }>("state");
			expect(state?.syncOffset).toEqual(expect.any(Number));
			const sync = (await host.inspect.scheduledTasks()).find((t) => t.name === "sync");
			expect(sync?.schedule).toMatch(/^([1-9]|[12]\d),([3-5]\d) \* \* \* \*$/);
		});
	}
});

describe("content hooks", () => {
	it("a publish to more channels than fit, with a public URL and an image", async () => {
		host = await newHost();
		const { event } = await publishSetup(host);
		for (const id of ["p1", "p2", "p3", "p4", "p5"]) await respond(host, created(id));

		const calls = await bridgeCalls(() => host!.transport.invokeHook("content:afterPublish", event));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("contentPublicUrl");
		// The image's address comes from the entry: no media lookup, and never the signed-in route.
		expect(calls).not.toContain("mediaGet");
		const rows = await deliveries(host);
		expect(rows.every((r) => r.imageUrl === "https://www.example.com/_emdash/api/media/file/01M3QY3VKJAWMFNS7TH6JHSA8W.jpg")).toBe(true);
		expect(rows.filter((r) => r.status === "sent").length).toBeGreaterThanOrEqual(1);
		expect(rows.filter((r) => r.status === "pending").length).toBeGreaterThanOrEqual(1);
		expect(calls).toContain("cronSchedule");
	});

	it("a publish whose first send is rate-limited", async () => {
		host = await newHost();
		const { event } = await publishSetup(host);
		await respond(host, rateLimited(120));

		const calls = await bridgeCalls(() => host!.transport.invokeHook("content:afterPublish", event));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect((await deliveries(host)).every((r) => r.status === "pending")).toBe(true);
	});

	it("a publish into two channels, sent in full", async () => {
		host = await newHost();
		await postsCollection(host);
		const two = FIVE.slice(0, 2);
		await seedChannels(host, two);
		await seedConfig(host, { channels: allOn(two), collections: { posts: { enabled: true, image: "cover" } } });
		await seedState(host, watching);
		const { event } = await publishedPost(host, { cover: COVER });
		await respond(host, created("p1"), created("p2"));

		const calls = await bridgeCalls(() => host!.transport.invokeHook("content:afterPublish", event));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect((await deliveries(host)).filter((r) => r.status === "sent")).toHaveLength(2);
	});

	it("a publish with the editor's choices for the entry", async () => {
		host = await newHost();
		const { event, id } = await publishSetup(host);
		await host.fixtures.plugin.storage("overrides", `posts:${id}`, {
			collection: "posts",
			entryId: id,
			skip: ["e"],
			text: { a: "Custom {url}" },
			updatedAt: NOW.toISOString(),
		});
		for (const p of ["p1", "p2", "p3", "p4"]) await respond(host, created(p));

		const calls = await bridgeCalls(() => host!.transport.invokeHook("content:afterPublish", event));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("storageGet");
		const rows = await deliveries(host);
		expect(rows.find((r) => r.channelId === "e")?.reason).toBe("editorSkipped");
		expect(rows.find((r) => r.channelId === "a")?.text).toBe("Custom https://www.example.com/blog/hello");
		expect(rows.filter((r) => r.status === "sent").length).toBeGreaterThanOrEqual(1);
	});

	it("a create-as-published save", async () => {
		host = await newHost();
		const { event } = await publishSetup(host);
		for (const id of ["p1", "p2", "p3", "p4", "p5"]) await respond(host, created(id));
		const calls = await bridgeCalls(() => host!.transport.invokeHook("content:afterSave", { ...event, isNew: true }));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect((await deliveries(host)).length).toBe(5);
	});

	it("the first publish the plugin sees, which starts the watch", async () => {
		host = await newHost();
		const { event } = await publishSetup(host);
		await seedState(host, {});
		const calls = await bridgeCalls(() => host!.transport.invokeHook("content:afterPublish", event));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("kvSet");
	});
});

/** Unknown records whose lookups find nothing, then pending ones: the most expensive mix. */
async function openRecords(runtime: PluginRuntimeTestHost, count: number) {
	for (let i = 0; i < count; i++) {
		await seedDelivery(runtime, `posts:e${i}:c1`, {
			entryId: `e${i}`,
			status: i < 2 ? "unknown" : "pending",
			lastAttemptAt: new Date(NOW.getTime() - HOUR).toISOString(),
		});
	}
}

describe("cron tasks", () => {
	it("a continuation over unknown and pending records", async () => {
		host = await newHost();
		await openRecords(host, 6);
		for (let i = 0; i < 6; i++) await respond(host, json({ data: { posts: { edges: [] } } }), created(`p${i}`));

		const calls = await bridgeCalls(tick(host, "deliver-a"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("storageUpdateIf");
		expect((await deliveries(host)).some((r) => r.status === "sent")).toBe(true);
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("deliver-b");
	});

	it("a continuation over records from 0.1.3 with an image address that needs signing in: one entry read, then the send", async () => {
		host = await newHost();
		await postsCollection(host);
		await seedConfig(host, { collections: { posts: { enabled: true, image: "cover" } } });
		const { id } = await publishedPost(host, { cover: COVER });
		for (const c of ["a", "b", "c"]) {
			await seedDelivery(host, `posts:${id}:${c}`, { entryId: id, channelId: c, service: "facebook", attach: "image", imageUrl: ASSET });
		}
		await respond(host, created("p1"), created("p2"), created("p3"));

		const calls = await bridgeCalls(tick(host, "deliver-a"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "contentGet")).toHaveLength(1);
		expect(calls).toContain("storageUpdateIf");
		const rows = await deliveries(host);
		expect(rows.filter((r) => r.status === "sent")).toHaveLength(1);
		expect(rows.find((r) => r.status === "sent")?.imageUrl).toBe("https://www.example.com/_emdash/api/media/file/01M3QY3VKJAWMFNS7TH6JHSA8W.jpg");
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("deliver-b");
	});

	it("a continuation whose lookups fail", async () => {
		host = await newHost();
		await openRecords(host, 6);
		for (let i = 0; i < 8; i++) await respond(host, json({ errors: [{ message: "boom" }] }, 503));

		const calls = await bridgeCalls(tick(host, "deliver-b"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect((await deliveries(host)).filter((r) => r.status === "unknown").length).toBeGreaterThanOrEqual(2);
	});

	it("a sync with a full prune batch and records due", async () => {
		host = await newHost();
		await seedReport(host, { ...nothingDue(), lastPruneAt: undefined });
		for (let i = 0; i < 105; i++) {
			await seedDelivery(host, `old${i}`, { status: "sent", createdAt: new Date(NOW.getTime() - 400 * 24 * HOUR).toISOString() });
		}
		await openRecords(host, 3);
		for (let i = 0; i < 3; i++) await respond(host, json({ data: { posts: { edges: [] } } }), created(`p${i}`));

		const calls = await bridgeCalls(tick(host, "sync"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("storageDeleteMany");
		// The delivery pass still ran, with what the prune left it.
		expect(calls.filter((c) => c === "storageQuery")).toHaveLength(2);
		expect((await host.inspect.storage.list("deliveries")).length).toBe(8);
	});

	it("a sync with nothing else due spends the rest on the delivery pass", async () => {
		host = await newHost();
		await seedReport(host, nothingDue());
		await openRecords(host, 6);
		for (let i = 0; i < 6; i++) await respond(host, json({ data: { posts: { edges: [] } } }), created(`p${i}`));

		const calls = await bridgeCalls(tick(host, "sync"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect((await deliveries(host)).some((r) => r.status === "sent")).toBe(true);
	});
});

describe("report runs", () => {
	const LI = [channel("c1", "linkedin")];

	async function reportSetup(runtime: PluginRuntimeTestHost, report: ReturnType<typeof nothingDue>) {
		await seedChannels(runtime, LI);
		await seedConfig(runtime, { channels: allOn(LI) });
		await seedReport(runtime, report);
	}

	/** Twenty-five posts that can still change, each with an answer that changes it, and an outdated ledger. */
	async function statusWork(runtime: PluginRuntimeTestHost) {
		for (let i = 0; i < 26; i++) {
			await seedDelivery(runtime, `posts:e${String(i).padStart(2, "0")}:c1`, {
				entryId: `e${i}`,
				status: "sent",
				postId: `p${i}`,
				postStatus: "scheduled",
				createdAt: new Date(NOW.getTime() - (30 - i) * 60_000).toISOString(),
			});
		}
		await respond(runtime, statusAnswer(...Array.from({ length: 25 }, (_, i) => [postNode(`p${i}`)])));
	}

	it("a sync that runs the status pass and the scan", async () => {
		host = await newHost();
		await reportSetup(host, { ...nothingDue(), status: undefined, scan: undefined });
		await statusWork(host);

		const calls = await bridgeCalls(tick(host, "sync"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "storagePutMany")).toHaveLength(1);
		expect(calls).toContain("storagePut");
		expect(calls).toContain("httpFetch");
		// A 26th record is left: the pass continues on a catch-up run.
		expect(calls).toContain("cronSchedule");
	});

	it("a sync that refreshes the channels", async () => {
		host = await newHost();
		await reportSetup(host, { ...nothingDue(), channelsAt: undefined, status: undefined });
		await seedChannels(host, LI, { fetchedAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() });
		await respond(
			host,
			json({ data: { account: { organizations: [{ id: "org1", name: "Org" }] } } }),
			json({ data: { o0: [{ id: "c1", organizationId: "org1", name: "n", service: "linkedin", isDisconnected: false, isLocked: false, isQueuePaused: false }] } }),
			json({ data: { l0: [] } }),
			json({ data: { c0: { channels: [] } } }),
		);
		await openRecords(host, 2);

		const calls = await bridgeCalls(tick(host, "sync"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "httpFetch")).toHaveLength(4);
	});

	it("a sync that reads the metrics and a round of aggregates", async () => {
		host = await newHost();
		await reportSetup(host, { ...nothingDue(), metrics: undefined, aggregates: undefined });
		for (let i = 0; i < 3; i++) await seedDelivery(host, `posts:e${i}:c1`, { entryId: `e${i}`, status: "sent", postId: `p${i}`, postStatus: "sent" });
		await respond(
			host,
			metricsAnswer([0, 1, 2].map((i) => postNode(`p${i}`, { metrics: [metric("reactions", i + 1)], metricsUpdatedAt: NOW.toISOString() })), { endCursor: "c", hasNextPage: true }),
			aggregatesAnswer(30, baseline(1, 2, 3)),
		);

		const calls = await bridgeCalls(tick(host, "sync"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "httpFetch")).toHaveLength(2);
		expect(calls).toContain("storagePutMany");
		expect(calls).toContain("storagePut");
	});

	for (const name of ["catchup-a", "catchup-b"]) {
		it(`a ${name} run that backfills two rounds of aggregates`, async () => {
			host = await newHost();
			await reportSetup(host, { ...nothingDue(), aggregates: undefined });
			await respond(host, aggregatesAnswer(30, baseline(1, 2, 3)), aggregatesAnswer(30, baseline(1, 2, 3)));

			const calls = await bridgeCalls(tick(host, name));

			expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
			expect(calls.filter((c) => c === "httpFetch")).toHaveLength(2);
			expect(calls).toContain("cronSchedule");
		});
	}

	const LIVE = "Free-plan Insights are limited to the last 31 days of history.";
	const refused = () => json({ data: null, errors: [{ message: LIVE, path: ["a2"] }] });
	const recentDone = { days: {}, ranges: {}, progress: { c1: { recentOn: today, backTo: dayAgoDay(29) } } };

	it("a sync whose aggregates are refused for the history limit and asked again cut to it", async () => {
		host = await newHost();
		await reportSetup(host, { ...nothingDue(), aggregates: undefined });
		await seedAggregates(host, recentDone);
		await openRecords(host, 3);
		await respond(host, refused(), aggregatesAnswer(4, baseline(1, 2, 3)), created("p1"), created("p2"), created("p3"));

		const calls = await bridgeCalls(tick(host, "sync"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "httpFetch").length).toBeGreaterThanOrEqual(2);
		expect((await host.inspect.kv.get<{ insightsHistory?: { days: number } }>("report"))?.insightsHistory?.days).toBe(31);
	});

	it("a sync that reads the metrics, then aggregates refused for the limit, leaves the retry for the next run", async () => {
		host = await newHost();
		await reportSetup(host, { ...nothingDue(), metrics: undefined, aggregates: undefined });
		await seedAggregates(host, recentDone);
		for (let i = 0; i < 3; i++) await seedDelivery(host, `posts:e${i}:c1`, { entryId: `e${i}`, status: "sent", postId: `p${i}`, postStatus: "sent" });
		await respond(
			host,
			metricsAnswer([0, 1, 2].map((i) => postNode(`p${i}`, { metrics: [metric("reactions", i + 1)], metricsUpdatedAt: NOW.toISOString() })), { endCursor: "c", hasNextPage: true }),
			refused(),
		);

		const calls = await bridgeCalls(tick(host, "sync"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "httpFetch")).toHaveLength(2);
		const state = await host.inspect.kv.get<{ problem?: unknown; aggregates?: { failedAt?: string } }>("report");
		expect(state?.problem).toBeUndefined();
		expect(state?.aggregates?.failedAt).toBeUndefined();
		// Still due, so a catch-up run asks again cut to the limit.
		expect(calls).toContain("cronSchedule");
	});

	for (const name of ["catchup-a", "catchup-b"]) {
		it(`a ${name} run whose first round is refused for the history limit and asked again cut to it`, async () => {
			host = await newHost();
			await reportSetup(host, { ...nothingDue(), aggregates: undefined });
			await seedAggregates(host, recentDone);
			await respond(host, refused(), aggregatesAnswer(4, baseline(1, 2, 3)));

			const calls = await bridgeCalls(tick(host, name));

			expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
			expect(calls.filter((c) => c === "httpFetch")).toHaveLength(2);
			expect(calls).toContain("storagePut");
		});
	}

	it("a sync whose metrics page is refused for the limit and asked again, with figures to store and the pass to file", async () => {
		host = await newHost();
		await reportSetup(host, { ...nothingDue(), metrics: undefined });
		for (let i = 0; i < 3; i++) await seedDelivery(host, `posts:e${i}:c1`, { entryId: `e${i}`, status: "sent", postId: `p${i}`, postStatus: "sent" });
		await seedDelivery(host, "posts:w1:c1", { entryId: "w1", status: "pending" });
		await seedDelivery(host, "posts:w2:c1", { entryId: "w2", status: "pending" });
		await respond(
			host,
			json({ data: null, errors: [{ message: LIVE, path: ["posts"] }] }),
			metricsAnswer([0, 1, 2].map((i) => postNode(`p${i}`, { via: "api", channelId: "c1", metrics: [metric("reactions", i + 1)], metricsUpdatedAt: NOW.toISOString() }))),
			created("x1"),
			created("x2"),
		);

		const calls = await bridgeCalls(tick(host, "sync"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "httpFetch").length).toBeGreaterThanOrEqual(2);
		expect(calls).toContain("storagePutMany");
	});

	it("a catch-up run that files a finished pass by origin and reads aggregates", async () => {
		host = await newHost();
		await reportSetup(host, {
			...nothingDue(),
			aggregates: undefined,
			metrics: { day: today, at: NOW.toISOString() },
			originsWork: { day: today, since: dayAgoDay(29), ready: true, channels: ["c1"], days: { c1: { [today]: { buffer: { posts: 1, engagement: 2 } } } }, counts: { c1: { network: 0, buffer: 0, api: 1 } } },
		});
		await respond(host, aggregatesAnswer(30, baseline(1, 2, 3)), aggregatesAnswer(30, baseline(1, 2, 3)));

		const calls = await bridgeCalls(tick(host, "catchup-a"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("storageGet");
		expect((await host.inspect.kv.get<{ origins?: unknown; originsWork?: unknown }>("report"))?.originsWork).toBeUndefined();
	});

	it("a sync with the weekly check beyond the history limit, then a round", async () => {
		host = await newHost();
		const learnt = new Date(NOW.getTime() - 8 * 24 * HOUR).toISOString();
		await reportSetup(host, { ...nothingDue(), aggregates: undefined, insightsHistory: { days: 31, learntAt: learnt } });
		await seedAggregates(host, recentDone);
		await openRecords(host, 3);
		await respond(host, json({ data: null, errors: [{ message: LIVE, path: ["a0"] }] }), aggregatesAnswer(4, baseline(1, 2, 3)), created("p1"), created("p2"), created("p3"));

		const calls = await bridgeCalls(tick(host, "sync"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "httpFetch").length).toBeGreaterThanOrEqual(2);
	});

	it("a catch-up run that does the status pass and the scan", async () => {
		host = await newHost();
		await reportSetup(host, { ...nothingDue(), status: { pending: true, after: "", seen: [] }, scan: { pending: true } });
		await statusWork(host);

		const calls = await bridgeCalls(tick(host, "catchup-b"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("storagePutMany");
		expect(calls).toContain("storagePut");
	});

	it("a Refresh run", async () => {
		host = await newHost();
		await reportSetup(host, nothingDue());
		await statusWork(host);

		const calls = await bridgeCalls(tick(host, "refresh"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("httpFetch");
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("catchup-a");
	});
});

describe("the Analytics view and the widget", () => {
	async function analyticsSetup(runtime: PluginRuntimeTestHost) {
		await seedChannels(runtime, FIVE);
		await seedConfig(runtime, { channels: allOn(FIVE) });
		await seedLedger(runtime, { a: entry({ engagement: 3, impressions: 9, link: "https://example.org/p" }), b: entry({ postStatus: "scheduled", dueAt: NOW.toISOString() }) });
		await seedAggregates(runtime, {
			days: { a: { [today]: { posts: 1, metrics: { reactions: 1, impressions: 4 }, metricsUpdatedAt: NOW.toISOString() } } },
			ranges: {},
			progress: { a: { recentOn: today, backTo: today } },
		});
		await seedDelivery(runtime, "f1", { status: "failed", error: "nope" });
	}

	it("a first load, which also starts the watch and schedules the sync", async () => {
		host = await newHost();
		await analyticsSetup(host);
		const calls = await bridgeCalls(() => host!.admin.loadPage(PAGE_PATH));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toEqual(expect.arrayContaining(["kvSet", "cronSchedule", "storageGetMany", "storageCount"]));
	});

	for (const days of [7, 30, 90]) {
		it(`the ${days}-day range`, async () => {
			host = await newHost();
			await analyticsSetup(host);
			const calls = await bridgeCalls(() => host!.admin.act(PAGE_PATH, RANGE_ACTION, { value: days }));
			expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		});
	}

	it("Refresh", async () => {
		host = await newHost();
		await analyticsSetup(host);
		const calls = await bridgeCalls(() => host!.admin.act(PAGE_PATH, PAGE_REFRESH_ACTION, { value: 90 }));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("cronSchedule");
	});

	it("Retry all failed", async () => {
		host = await newHost();
		await analyticsSetup(host);
		const calls = await bridgeCalls(() => host!.admin.act(PAGE_PATH, RETRY_ALL_ACTION));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect((await deliveries(host)).find((d) => d.error === "nope")?.status).toBe("pending");
	});

	it("the Setup view", async () => {
		host = await newHost();
		await analyticsSetup(host);
		const calls = await bridgeCalls(() => host!.admin.act(PAGE_PATH, SETUP_ACTION));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
	});

	it("a widget load", async () => {
		host = await newHost();
		await analyticsSetup(host);
		const calls = await bridgeCalls(() => host!.admin.loadWidget(WIDGET_ID));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("storageGetMany");
	});

	it("the widget's Refresh", async () => {
		host = await newHost();
		await analyticsSetup(host);
		const calls = await bridgeCalls(() => host!.admin.act(`widget:${WIDGET_ID}`, WIDGET_REFRESH_ACTION));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("cronSchedule");
	});
});

describe("the Buffer page", () => {
	async function pageSetup(runtime: PluginRuntimeTestHost) {
		await postsCollection(runtime);
		await seedChannels(runtime, FIVE);
		await seedConfig(runtime, { channels: allOn(FIVE), collections: { posts: { enabled: true, image: "cover" } } });
		await seedDelivery(runtime, "f1", { status: "failed", error: "nope" });
	}

	it("a page load before the watch started", async () => {
		host = await newHost();
		await pageSetup(host);
		const calls = await bridgeCalls(() => host!.admin.loadPage(PAGE_PATH));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("cronSchedule");
	});

	it("Discover, answered in full", async () => {
		host = await newHost();
		await pageSetup(host);
		await respond(
			host,
			json({ data: { account: { organizations: [{ id: "org1", name: "Org" }] } } }),
			json({ data: { o0: [{ id: "c1", organizationId: "org1", name: "n", service: "linkedin", isDisconnected: false, isLocked: false, isQueuePaused: false }] } }),
			json({ data: { l0: [{ channelId: "c1", isAtLimit: false, limit: 10, scheduled: 0, sent: 0 }] } }),
			json({ data: { c0: { channels: [] } } }),
		);
		const calls = await bridgeCalls(() => host!.admin.act(PAGE_PATH, DISCOVER_ACTION));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(host.http.requests()).toHaveLength(4);
	});

	it("saving a channel", async () => {
		host = await newHost();
		await pageSetup(host);
		const calls = await bridgeCalls(() =>
			host!.admin.submit(PAGE_PATH, `${CHANNEL_ACTION_PREFIX}a`, { enabled: true, mode: "shareNext", attach: "link", template: "" }),
		);
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
	});

	it("saving the collections", async () => {
		host = await newHost();
		await pageSetup(host);
		const calls = await bridgeCalls(() => host!.admin.submit(PAGE_PATH, COLLECTIONS_ACTION, { collections: ["posts"], image_posts: "seo" }));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
	});

	it("saving the UTM tags", async () => {
		host = await newHost();
		await pageSetup(host);
		const calls = await bridgeCalls(() => host!.admin.submit(PAGE_PATH, UTM_ACTION, { utm: true, source: "buffer", medium: "social" }));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
	});

	it("Retry with failed deliveries", async () => {
		host = await newHost();
		await pageSetup(host);
		const calls = await bridgeCalls(() => host!.admin.act(PAGE_PATH, RETRY_ACTION));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect((await deliveries(host)).find((d) => d.error === "nope")?.status).toBe("pending");
	});
});

describe("the editor panel", () => {
	const TWO = FIVE.slice(0, 2);

	async function panelSetup(runtime: PluginRuntimeTestHost, opts: { sent?: boolean } = {}) {
		await postsCollection(runtime);
		await seedChannels(runtime, TWO);
		await seedConfig(runtime, { channels: allOn(TWO), collections: { posts: { enabled: true, image: "cover" } } });
		await seedState(runtime, watching);
		const { id } = await publishedPost(runtime);
		if (opts.sent) {
			await seedDelivery(runtime, `posts:${id}:a`, { entryId: id, channelId: "a", status: "sent", postId: "p1", postStatus: "sent" });
			await seedDelivery(runtime, `posts:${id}:b`, { entryId: id, channelId: "b", status: "failed", error: "nope" });
		}
		return id;
	}

	it("a collection that is not shared", async () => {
		host = await newHost();
		await postsCollection(host);
		const { id } = await publishedPost(host);
		const calls = await bridgeCalls(() => host!.admin.loadEditorPanel(PANEL_ID, "posts", id));
		expect(calls, calls.join(", ")).toEqual(["kvList"]);
	});

	it("a load before the first send", async () => {
		host = await newHost();
		const id = await panelSetup(host);
		const calls = await bridgeCalls(() => host!.admin.loadEditorPanel(PANEL_ID, "posts", id));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("storageGet");
	});

	it("saving the choices", async () => {
		host = await newHost();
		const id = await panelSetup(host);
		const calls = await bridgeCalls(() => host!.admin.submitEditorPanel(PANEL_ID, "posts", id, PANEL_SAVE_ACTION, { send_a: false, text_b: "x" }));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("storagePut");
	});

	it("a load after the send", async () => {
		host = await newHost();
		const id = await panelSetup(host, { sent: true });
		const calls = await bridgeCalls(() => host!.admin.loadEditorPanel(PANEL_ID, "posts", id));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
	});

	it("Retry", async () => {
		host = await newHost();
		const id = await panelSetup(host, { sent: true });
		const calls = await bridgeCalls(() => host!.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_RETRY_ACTION, { value: `posts:${id}:b` }));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("cronSchedule");
	});

	it("Send again, first press, which asks and reads no more than a load", async () => {
		host = await newHost();
		const id = await panelSetup(host, { sent: true });
		const calls = await bridgeCalls(() => host!.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_AGAIN_ACTION, { value: `posts:${id}:a` }));
		// KV, settings, the entry's deliveries: the same three as a load after the send.
		expect(calls, calls.join(", ")).toHaveLength(3);
	});

	it("Cancel", async () => {
		host = await newHost();
		const id = await panelSetup(host, { sent: true });
		const calls = await bridgeCalls(() => host!.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_CANCEL_ACTION));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).not.toContain("httpFetch");
	});

	it("Send again, rate-limited, which schedules a continuation and stores the reading", async () => {
		host = await newHost();
		const id = await panelSetup(host, { sent: true });
		await respond(host, rateLimited(90));
		const calls = await bridgeCalls(() => host!.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_AGAIN_CONFIRM_ACTION, { value: `posts:${id}:a` }));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("httpFetch");
		expect(calls).toContain("cronSchedule");
	});

	it("Send again of a record from 0.1.3 with an image address that needs signing in, which reads the entry first", async () => {
		host = await newHost();
		await postsCollection(host);
		await seedChannels(host, TWO);
		await seedConfig(host, { channels: allOn(TWO), collections: { posts: { enabled: true, image: "cover" } } });
		await seedState(host, watching);
		const { id } = await publishedPost(host, { cover: COVER });
		await seedDelivery(host, `posts:${id}:a`, { entryId: id, channelId: "a", status: "sent", postId: "p1", postStatus: "sent", attach: "image", imageUrl: ASSET });
		await respond(host, created("p2"));
		const calls = await bridgeCalls(() => host!.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_AGAIN_CONFIRM_ACTION, { value: `posts:${id}:a` }));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("contentGet");
		expect((await deliveries(host)).find((d) => d.postId === "p2")?.imageUrl).toBe("https://www.example.com/_emdash/api/media/file/01M3QY3VKJAWMFNS7TH6JHSA8W.jpg");
	});

	it("Send again, answered", async () => {
		host = await newHost();
		const id = await panelSetup(host, { sent: true });
		await respond(host, created("p2"));
		const calls = await bridgeCalls(() => host!.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_AGAIN_CONFIRM_ACTION, { value: `posts:${id}:a` }));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect((await deliveries(host)).filter((d) => d.postId === "p2")).toHaveLength(1);
	});
});

describe("Share now on an entry from before the watch", () => {
	async function oldEntry(runtime: PluginRuntimeTestHost, channels: typeof FIVE) {
		await postsCollection(runtime);
		await seedChannels(runtime, channels);
		await seedConfig(runtime, { channels: allOn(channels), collections: { posts: { enabled: true, image: "cover" } } });
		await seedState(runtime, { watchSince: NOW.toISOString() });
		const item = await runtime.fixtures.content("posts", {
			slug: "old",
			data: { title: "Old post", excerpt: "A short excerpt.", cover: COVER },
			status: "published",
			publishedAt: new Date(NOW.getTime() - 6 * HOUR).toISOString(),
		});
		return item.id;
	}

	it("the panel load, which reads the entry", async () => {
		host = await newHost();
		const id = await oldEntry(host, FIVE);
		const calls = await bridgeCalls(() => host!.admin.loadEditorPanel(PANEL_ID, "posts", id));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("contentGet");
	});

	it("the first press of Share now, which asks", async () => {
		host = await newHost();
		const id = await oldEntry(host, FIVE);
		const calls = await bridgeCalls(() => host!.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_SHARE_ACTION));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(5);
		expect(calls).toEqual(expect.arrayContaining(["contentGet", "storageGet"]));
		expect(calls).not.toContain("httpFetch");
		expect(await deliveries(host)).toHaveLength(0);
	});

	it("Cancel on Share now's question", async () => {
		host = await newHost();
		const id = await oldEntry(host, FIVE);
		const calls = await bridgeCalls(() => host!.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_CANCEL_ACTION));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(5);
	});

	it("five channels with an image: the claim, then a continuation for those that do not fit", async () => {
		host = await newHost();
		const id = await oldEntry(host, FIVE);
		for (const p of ["p1", "p2", "p3", "p4", "p5"]) await respond(host, created(p));
		const calls = await bridgeCalls(() => host!.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_SHARE_CONFIRM_ACTION));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toEqual(expect.arrayContaining(["contentGet", "contentPublicUrl", "storagePutMany", "cronSchedule"]));
		expect(calls).not.toContain("mediaGet");
		const rows = await deliveries(host);
		expect(rows).toHaveLength(5);
		expect(rows.every((r) => r.origin === "manual")).toBe(true);
		expect(rows.filter((r) => r.status === "pending").length).toBeGreaterThanOrEqual(1);
	});

	it("one channel with an image, sent in the press", async () => {
		host = await newHost();
		const id = await oldEntry(host, FIVE.slice(0, 1));
		await respond(host, created("p1"));
		const calls = await bridgeCalls(() => host!.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_SHARE_CONFIRM_ACTION));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect((await deliveries(host))[0]).toMatchObject({ status: "sent", postId: "p1" });
	});
});

describe("the shared-bucket guard and the stagger", () => {
	it("a sync paused for headroom, with deliveries due", async () => {
		host = await newHost();
		await seedChannels(host, [channel("c1", "linkedin")]);
		await seedConfig(host, { channels: allOn([channel("c1", "linkedin")]) });
		await seedReport(host, { ...nothingDue(), status: undefined, metrics: undefined, aggregates: undefined, channelsAt: undefined });
		await seedState(host, { ...watching, rateLimit: reading(10, 200, 2000) });
		await openRecords(host, 3);
		for (let i = 0; i < 3; i++) await respond(host, json({ data: { posts: { edges: [] } } }), created(`p${i}`));
		const calls = await bridgeCalls(tick(host, "sync"));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("httpFetch");
		expect(await host.inspect.kv.get("report")).toMatchObject({ headroom: { window: 900 } });
	});

	it("a page load on an install from before the stagger, which picks its offset and moves the sync", async () => {
		host = await newHost();
		await seedChannels(host, FIVE);
		await seedConfig(host, { channels: allOn(FIVE) });
		await seedState(host, watching);
		await host.transport.invokeHook("plugin:activate", {});
		await seedState(host, watching);
		const calls = await bridgeCalls(() => host!.admin.loadPage(PAGE_PATH));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toEqual(expect.arrayContaining(["kvSet", "cronSchedule"]));
		const sync = (await host.inspect.scheduledTasks()).find((t) => t.name === "sync");
		expect(sync?.schedule).not.toBe("*/30 * * * *");
	});
});

describe("the MCP tools", () => {
	for (const [name, route] of Object.entries(TOOL_ROUTES)) {
		it(name, async () => {
			host = await newHost();
			await seedChannels(host, FIVE);
			await seedConfig(host, { channels: allOn(FIVE) });
			await seedLedger(host, { a: entry({ engagement: 3 }) });
			for (let i = 0; i < 3; i++) await seedDelivery(host, `posts:e1:c${i}`, { channelId: `c${i}`, status: "failed" });
			const calls = await bridgeCalls(() => host!.transport.invokeRoute(route, { entryId: "e1", days: 90, limit: 50 }));
			expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
			expect(calls.length).toBeGreaterThanOrEqual(2);
		});
	}
});
