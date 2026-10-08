import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Aggregates, AggregateDay, Origins, ReportState } from "../src/store/report.js";
import { PAGE_REFRESH_ACTION, RANGE_ACTION, rangeAction, RETRY_ALL_ACTION } from "../src/ui/analytics.js";
import { CHART_COLOURS, dailyChart } from "../src/ui/blocks.js";
import { formatRate, formatShortDay } from "../src/ui/format.js";
import { PAGE_PATH } from "../src/ui/page.js";
import { SETUP_ACTION } from "../src/ui/analytics.js";
import { WIDGET_ID, WIDGET_REFRESH_ACTION } from "../src/ui/widget.js";
import { allOn, channel, deliveries, expectValid, HOUR, newHost, NOW, reading, seedChannels, seedConfig, seedDelivery, seedState } from "./host.js";
import { DAY, dayAgo, entry, nothingDue, seedAggregates, seedLedger, seedReport, today, ZONE } from "./report-fixtures.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const text = (response: unknown) => JSON.stringify(response);
const blocksOf = (response: { blocks: unknown }) => response.blocks as unknown as Array<Record<string, unknown>>;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const LI = channel("c1", "linkedin", { displayName: "Shane on LinkedIn" });
const FB = channel("c2", "facebook", { displayName: "FuelOracle page", isDisconnected: true });
const YT = channel("c3", "youtube", { displayName: "Videos" });

function days(count: number, metrics: Record<string, number>): Record<string, AggregateDay> {
	return Object.fromEntries(Array.from({ length: count }, (_, i) => [dayAgo(i), { posts: 1, metrics, metricsUpdatedAt: NOW.toISOString() }]));
}

async function seedAll(runtime: PluginRuntimeTestHost, opts: { aggregates?: boolean } = {}) {
	await seedChannels(runtime, [LI, FB, YT], { limits: [{ channelId: "c1", isAtLimit: true, limit: 5, scheduled: 5, sent: 0 }] });
	await seedConfig(runtime, { channels: allOn([LI, FB]) });
	await seedState(runtime, { watchSince: ago(100) });
	await seedLedger(runtime, {
		e1: entry({ title: "Road trip costs", engagement: 12, impressions: 300, link: "https://www.linkedin.com/feed/update/1" }),
		e2: entry({ title: "", channelId: "c2", channelName: "FuelOracle page", service: "facebook", sentAt: ago(2), createdAt: ago(2), engagement: 5 }),
		e3: entry({ title: "Refused", status: "failed", postStatus: undefined, sentAt: undefined, createdAt: ago(1) }),
		e4: entry({ title: "Next one", postStatus: "scheduled", sentAt: undefined, dueAt: new Date(NOW.getTime() + 20 * HOUR).toISOString() }),
		e5: entry({ title: "Bad image", postStatus: "error", sentAt: undefined, postError: "The image is too large." }),
	});
	if (opts.aggregates !== false) {
		const agg: Aggregates = {
			days: { c1: days(30, { reactions: 3, comments: 1, impressions: 100 }), c2: days(30, { reactions: 2, comments: 0 }) },
			ranges: { c1: { "30": { metrics: { impressions: 3000, engagementRate: 4.2 }, metricsUpdatedAt: NOW.toISOString() } } },
			progress: { c1: { recentOn: today, backTo: dayAgo(29) }, c2: { recentOn: today, backTo: dayAgo(29) } },
		};
		await seedAggregates(runtime, agg);
	}
	await seedDelivery(runtime, "posts:e3:c1", { entryId: "e3", status: "failed", error: "Refused" });
}

describe("the Analytics view", () => {
	it("shows sent, queued, failed, impressions and engagement from the snapshots, in the Umami layout", async () => {
		host = await newHost();
		await seedAll(host);

		const response = await host.admin.loadPage(PAGE_PATH);

		expectValid(response);
		const blocks = blocksOf(response);
		expect(blocks[0]).toMatchObject({ type: "actions", block_id: "buffer:controls" });
		const stats = blocks.find((b) => b.type === "stats") as { items: Array<{ label: string; value: string; description?: string; trend?: string }> };
		const byLabel = Object.fromEntries(stats.items.map((i) => [i.label, i]));
		expect(byLabel["Sent, last 30 days"]).toMatchObject({ value: "2" });
		expect(byLabel["Queued now"]?.value).toBe("1");
		// Refused by Buffer, and accepted then not published.
		expect(byLabel["Failed, last 30 days"]).toMatchObject({ value: "2" });
		expect(byLabel["Failed, last 30 days"]?.trend).toBeUndefined();
		// Impressions only where the network reports them (LinkedIn here, not Facebook).
		expect(byLabel["Impressions, last 30 days"]).toMatchObject({ value: "3,000", description: "no earlier period to compare yet" });
		expect(byLabel["Engagement, last 30 days"]).toMatchObject({ value: "180" });

		const charts = JSON.stringify(blocks.filter((b) => b.type === "chart" || b.type === "columns"));
		expect(charts).toContain('"type":"bar"');
		expect(charts).toContain('"height":300');
		expect(charts).toContain('"name":"Times shown"');

		const body = text(response);
		expect(body).toContain('"type":"link","label":"View post","target":{"kind":"external","url":"https://www.linkedin.com/feed/update/1"}');
		expect(body).toContain('"entry":"Untitled"');
		expect(body).toMatch(/"entry":"Untitled","channel":"FuelOracle page","service":"facebook","engagement":5,"impressions":"No figures yet"/);
		expect(body).toMatch(/"channel":"Shane on LinkedIn","service":"linkedin","sent":1,"failed":2,"impressions":3000,"rate":"4.2%"/);
		expect(body).toMatch(/"channel":"FuelOracle page","service":"facebook","sent":1,"failed":0,"impressions":"No figures yet","rate":"No figures yet"/);
		expect(body).toContain("1 delivery failed.");
		expect(body).toContain(RETRY_ALL_ACTION);
		expect(body).toContain("The image is too large.");
		expect(body).toContain("Disconnected in Buffer: FuelOracle page.");
		expect(body).toContain("At today's posting limit in Buffer: Shane on LinkedIn.");
		expect(body).toContain("Not shared to: FuelOracle page (The channel is disconnected in Buffer); Videos (This service takes video only).");
		expect(body).not.toMatch(/[\u2013\u2014]/);
	});

	it("compares with the previous period once the stored days reach it", async () => {
		host = await newHost();
		await seedAll(host);

		const response = await host.admin.act(PAGE_PATH, RANGE_ACTION, { value: 7 });

		expectValid(response);
		const stats = blocksOf(response).find((b) => b.type === "stats") as { items: Array<{ label: string; value: string; description: string; trend?: string }> };
		const impressions = stats.items.find((i) => i.label === "Impressions, last 7 days");
		expect(impressions).toMatchObject({ value: "700", description: "0% on the previous period", trend: "neutral" });
		expect(text(response)).toContain('"label":"7 days","style":"primary","value":7');
	});

	it("gives each range button its own action id, reads the range from it, and still takes the id 0.1.5 sent", async () => {
		host = await newHost();
		await seedAll(host);
		const page = await host.admin.loadPage(PAGE_PATH);
		expectValid(page);
		const ids = (JSON.stringify(page).match(/"action_id":"buffer:range[^"]*"/g) ?? []).map((m) => m.slice(13, -1));
		expect(ids).toEqual(["buffer:range:7", "buffer:range:30", "buffer:range:90"]);
		// Every button in one actions block has its own id: the admin keys them by it.
		for (const block of JSON.parse(JSON.stringify(page)).blocks as Array<{ type: string; elements?: Array<{ action_id?: string }> }>) {
			if (block.type !== "actions") continue;
			const own = (block.elements ?? []).map((e) => e.action_id).filter(Boolean);
			expect(new Set(own).size, own.join(", ")).toBe(own.length);
		}

		const week = await host.admin.act(PAGE_PATH, rangeAction(7));
		expectValid(week);
		expect(JSON.stringify(week)).toContain("Sent, last 7 days");
		expect(JSON.stringify(week)).toContain('"action_id":"buffer:range:7","label":"7 days","style":"primary"');
		// A page drawn by 0.1.5 sends the shared id with the days in the value.
		const old = await host.admin.act(PAGE_PATH, RANGE_ACTION, { value: 90 });
		expect(JSON.stringify(old)).toContain("Sent, last 90 days");
	});

	it("shows engagement rates with one decimal place, so a column lines up", () => {
		expect(formatRate(3, "en")).toBe("3.0%");
		expect(formatRate(4.2, "en")).toBe("4.2%");
		expect(formatRate(4.25, "en")).toBe("4.3%");
		expect(formatRate(0, "en")).toBe("0.0%");
	});

	it("shows missing figures as missing, never as zero", async () => {
		host = await newHost();
		await seedAll(host, { aggregates: false });

		const response = await host.admin.loadPage(PAGE_PATH);

		expectValid(response);
		const stats = blocksOf(response).find((b) => b.type === "stats") as { items: Array<{ label: string; value: string }> };
		// A short value the card can hold; the description says why.
		expect(stats.items.find((i) => i.label.startsWith("Impressions"))?.value).toBe("None yet");
		expect(stats.items.find((i) => i.label.startsWith("Engagement"))?.value).toBe("None yet");
		expect(stats.items.some((i) => i.value === "0")).toBe(false);
		expect(text(response)).not.toContain("buffer:chart:engagement");
		expect(text(response)).not.toMatch(/"impressions":0\b/);
	});

	it("before setup, says what to do and offers Setup", async () => {
		host = await newHost({ token: false });
		const response = await host.admin.loadPage(PAGE_PATH);
		expectValid(response);
		expect(response.blocks[0]).toMatchObject({ type: "empty", title: "Nothing to show yet" });
		expect(text(response)).toContain("buffer:setup");
	});

	it("Refresh schedules a report run instead of calling Buffer", async () => {
		host = await newHost();
		await seedAll(host);
		const response = await host.admin.act(PAGE_PATH, PAGE_REFRESH_ACTION, { value: 90 });
		expectValid(response);
		expect(response.toast).toMatchObject({ type: "success" });
		expect(host.http.requests()).toHaveLength(0);
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("refresh");
		expect(text(response)).toContain('"label":"90 days","style":"primary"');
	});

	it("Retry all failed puts failed deliveries back, for administrators only", async () => {
		host = await newHost();
		await seedAll(host);
		const editor = await host.fixtures.user({ email: "ed@example.com", role: "editor" });

		const refused = await host.admin.act(PAGE_PATH, RETRY_ALL_ACTION, { user: editor });
		expectValid(refused);
		expect(refused.toast).toMatchObject({ type: "error" });
		expect(text(refused)).not.toContain(RETRY_ALL_ACTION);
		expect((await deliveries(host))[0]?.status).toBe("failed");

		const response = await host.admin.act(PAGE_PATH, RETRY_ALL_ACTION);
		expectValid(response);
		expect(response.toast).toMatchObject({ type: "success" });
		expect((await deliveries(host))[0]?.status).toBe("pending");
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("deliver-a");
	});
});

describe("the dashboard widget", () => {
	it("before setup, says what to do and links to the page", async () => {
		host = await newHost({ token: false });
		const response = await host.admin.loadWidget(WIDGET_ID);
		expectValid(response);
		expect(response.blocks[0]).toMatchObject({ type: "empty" });
		expect(text(response)).toContain('"kind":"plugin-page","path":"/buffer"');
	});

	it("shows the week's sent, failed, engagement and the next queued post", async () => {
		host = await newHost();
		await seedAll(host);
		const response = await host.admin.loadWidget(WIDGET_ID);
		expectValid(response);
		const stats = blocksOf(response).find((b) => b.type === "stats") as { items: Array<{ label: string; value: string }> };
		expect(Object.fromEntries(stats.items.map((i) => [i.label, i.value]))).toEqual({
			Sent: "2",
			Failed: "2",
			Queued: "1",
		});
		// Engagement is a line of text, not a fourth card.
		expect(text(response)).toContain("Engagement, last 7 days: 42.");
		expect(text(response)).toContain("Next: Next one");
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("sync");
	});

	it("Refresh schedules a report run", async () => {
		host = await newHost();
		await seedAll(host);
		const response = await host.admin.act(`widget:${WIDGET_ID}`, WIDGET_REFRESH_ACTION);
		expectValid(response);
		expect(response.toast).toMatchObject({ type: "success" });
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("refresh");
	});
});

describe("reports paused for the account's other tools", () => {
	it("the Analytics view says so with the time they resume; the Setup view says so beside the requests left", async () => {
		host = await newHost();
		await seedAll(host);
		await seedState(host, { watchSince: ago(100), rateLimit: reading(90, 50, 2500) });

		const analytics = await host.admin.loadPage(PAGE_PATH);
		expectValid(analytics);
		const banner = blocksOf(analytics).find((b) => b.block_id === "buffer:headroom");
		expect(banner).toMatchObject({ type: "banner", variant: "alert" });
		expect(String(banner?.description)).toMatch(/^Reports paused to leave Buffer requests for your other tools until .+ AE[DS]T\. Posts still go out\.$/);

		const setup = await host.admin.act(PAGE_PATH, SETUP_ACTION);
		expectValid(setup);
		expect(text(setup)).toContain("Reports paused to leave Buffer requests for your other tools");
		expect(text(setup)).toContain("Buffer requests left: 90 of 100 (100-in-15min), 50 of 250 (250-in-1day)");
	});

	it("no notice while every window keeps its reserve", async () => {
		host = await newHost();
		await seedAll(host);
		await seedState(host, { watchSince: ago(100), rateLimit: reading(96, 246, 2996) });
		const analytics = await host.admin.loadPage(PAGE_PATH);
		expect(text(analytics)).not.toContain("Reports paused");
	});
});

describe("empty and missing figures", () => {
	it("an empty block instead of a chart when nothing was sent or failed in the range", async () => {
		host = await newHost();
		await seedChannels(host, [LI]);
		await seedConfig(host, { channels: allOn([LI]) });
		await seedState(host, { watchSince: ago(100) });
		const response = await host.admin.loadPage(PAGE_PATH);
		expectValid(response);
		expect(blocksOf(response).find((b) => b.block_id === "buffer:chart:sent")).toMatchObject({ type: "empty", title: "Nothing sent in this range" });
		expect(blocksOf(response).some((b) => b.type === "timeseries")).toBe(false);
	});

	it("the widget puts missing engagement in a line of text, not a card", async () => {
		host = await newHost();
		await seedAll(host, { aggregates: false });
		const response = await host.admin.loadWidget(WIDGET_ID);
		expectValid(response);
		const stats = blocksOf(response).find((b) => b.type === "stats") as { items: Array<{ value: string }> };
		expect(stats.items).toHaveLength(3);
		expect(stats.items.every((i) => /^\d+$/.test(i.value))).toBe(true);
		expect(text(response)).toContain("Buffer has no engagement figures for the last 7 days yet.");
	});
});

describe("Buffer's history limit on the page", () => {
	const LIVE = "Free-plan Insights are limited to the last 31 days of history.";
	const limited = (extra: Partial<ReportState> = {}): ReportState => ({ ...nothingDue(), insightsHistory: { days: 31, learntAt: NOW.toISOString() }, ...extra });

	async function seedLimited(runtime: PluginRuntimeTestHost, report: ReportState) {
		await seedAll(runtime);
		await seedAggregates(runtime, {
			days: { c1: days(31, { reactions: 3, comments: 1, impressions: 100 }), c2: days(31, { reactions: 2, comments: 0 }) },
			ranges: { c1: { "90": { metrics: { impressions: 3100, engagementRate: 5 }, metricsUpdatedAt: NOW.toISOString(), days: 31 } } },
			progress: { c1: { recentOn: today, backTo: dayAgo(30) }, c2: { recentOn: today, backTo: dayAgo(30) } },
		});
		await seedReport(runtime, report);
	}

	it("a line of context by the range buttons, honest 90-day labels, and no problem banner", async () => {
		host = await newHost();
		await seedLimited(host, limited({ problem: { at: NOW.toISOString(), kind: "forbidden", message: LIVE } }));

		const response = await host.admin.act(PAGE_PATH, RANGE_ACTION, { value: 90 });

		expectValid(response);
		const blocks = blocksOf(response);
		expect(blocks[0]).toMatchObject({ block_id: "buffer:controls" });
		expect(blocks[1]).toMatchObject({ type: "context", block_id: "buffer:history", text: "Your Buffer plan gives figures for the last 31 days." });
		const body = text(response);
		expect(body).not.toContain("did not answer the last check");
		const stats = blocks.find((b) => b.type === "stats") as { items: Array<{ label: string; value: string }> };
		const labels = stats.items.map((i) => i.label);
		// Sent and failed come from the plugin's own records and cover the 90 days.
		expect(labels).toEqual(["Sent, last 90 days", "Queued now", "Failed, last 90 days", "Impressions, last 31 days", "Engagement, last 31 days"]);
		expect(stats.items[3]?.value).toBe("3,100");
		expect(body).toContain("Impressions by day, last 31 days");
		expect(body).toContain('"label":"Impressions, last 31 days","format":"number"');
		expect(body).toMatch(/"channel":"Shane on LinkedIn","service":"linkedin","sent":\d+,"failed":\d+,"impressions":3100,"rate":"5.0%"/);
		expect(body).toContain("over the last 31 days, the most your Buffer plan gives");
		// The 90-day button stays.
		expect(body).toContain('"label":"90 days","style":"primary"');
		expect(body).not.toContain("earlier days are still being read");
	});

	it("no line and the usual labels while no limit is known", async () => {
		host = await newHost();
		await seedAll(host);
		const response = await host.admin.act(PAGE_PATH, RANGE_ACTION, { value: 90 });
		expect(text(response)).not.toContain("buffer:history");
		expect(text(response)).toContain("Impressions, last 90 days");
	});

	it("an ordinary problem is still shown", async () => {
		host = await newHost();
		await seedLimited(host, limited({ problem: { at: NOW.toISOString(), kind: "uncertain", message: "Buffer answered with HTTP 503." } }));
		const response = await host.admin.loadPage(PAGE_PATH);
		expect(text(response)).toContain("Buffer did not answer the last check: Buffer answered with HTTP 503.");
	});
});

describe("figures by origin", () => {
	const FB2 = channel("c4", "facebook", { displayName: "Caravan club" });
	type Series = Array<{ name: string; data: Array<number | null> }>;
	type Chart = { labels: string[]; series: Series };
	const chartOf = (response: unknown, blockId: string): Chart => {
		let found: Chart = { labels: [], series: [] };
		const walk = (node: unknown): void => {
			if (Array.isArray(node)) return node.forEach(walk);
			if (!node || typeof node !== "object") return;
			const block = node as Record<string, unknown>;
			if (block.type === "chart" && block.block_id === blockId) {
				const options = (block.config as { options: { xAxis: { data: string[] }; series: Series } }).options;
				found = { labels: options.xAxis.data, series: options.series.map((s) => ({ name: s.name, data: s.data })) };
			}
			Object.values(block).forEach(walk);
		};
		walk(response);
		return found;
	};
	const series = (response: unknown, blockId: string): Series => chartOf(response, blockId).series;

	async function seedOrigins(runtime: PluginRuntimeTestHost, origins: Origins, methods: Record<string, "listed" | "derived">) {
		await seedChannels(runtime, [LI, { ...FB, isDisconnected: false }, FB2]);
		await seedConfig(runtime, { channels: allOn([LI, FB, FB2]) });
		await seedState(runtime, { watchSince: ago(100) });
		await seedLedger(runtime, { e1: entry() });
		await seedAggregates(runtime, {
			days: {
				c1: { [today]: { posts: 3, metrics: { reactions: 10, impressions: 1000 }, metricsUpdatedAt: NOW.toISOString() }, [dayAgo(1)]: { posts: 1, metrics: { reactions: 4, impressions: 400 }, metricsUpdatedAt: NOW.toISOString() } },
				c2: { [today]: { posts: 2, metrics: { reactions: 9 }, metricsUpdatedAt: NOW.toISOString() } },
				c4: { [today]: { posts: 1, metrics: { reactions: 1 }, metricsUpdatedAt: null } },
			},
			ranges: {},
			progress: {},
		});
		await host!.fixtures.plugin.storage("reports", "origins", { zone: ZONE, ...origins });
		await seedReport(runtime, {
			...nothingDue(),
			origins: { at: NOW.toISOString(), since: dayAgo(0), channels: Object.fromEntries(Object.entries(methods).map(([id, method]) => [id, { method, counts: { network: method === "listed" ? 2 : 0, buffer: 1, api: 1 } }])) },
		});
	}

	it("one line per channel and origin, network names with the channel's name for a second channel on the same network", async () => {
		host = await newHost();
		await seedOrigins(
			host,
			{
				days: {
					c1: { [today]: { direct: { posts: 2, engagement: 7, impressions: 700 }, buffer: { posts: 1, engagement: 3, impressions: 300 } } },
					c2: { [today]: { buffer: { posts: 1, engagement: 4 } } },
				},
				coveredFrom: { c1: today, c2: today },
			},
			{ c1: "listed", c2: "derived" },
		);

		const response = await host.admin.loadPage(PAGE_PATH);

		expectValid(response);
		const engagement = series(response, "buffer:chart:engagement");
		expect(engagement.map((s) => s.name)).toEqual([
			"LinkedIn (Direct)",
			"LinkedIn (Buffer)",
			// Yesterday is before the post list covered LinkedIn: the channel's total, not split.
			"LinkedIn (Not split)",
			// Facebook's direct figure is the channel's 9 less the 4 Buffer listed.
			"Facebook FuelOracle page (Direct)",
			"Facebook FuelOracle page (Buffer)",
		]);
		// Every day of the range is on the axis; the days before the post list covered Facebook have no value.
		const fbDirect = engagement.find((s) => s.name === "Facebook FuelOracle page (Direct)")!.data;
		expect(fbDirect).toHaveLength(30);
		expect(fbDirect.at(-1)).toBe(5);
		expect(fbDirect.slice(0, -1).every((v) => v === null)).toBe(true);
		// Caravan club has no figures read yet: no line at all, not a line of zeros.
		expect(JSON.stringify(engagement)).not.toContain("Caravan club");
		const impressions = series(response, "buffer:chart:impressions");
		// Facebook reports no impressions: no Facebook line rather than zeros.
		expect(impressions.map((s) => s.name)).toEqual(["LinkedIn (Direct)", "LinkedIn (Buffer)", "LinkedIn (Not split)"]);
		const body = text(response);
		expect(body).toContain("Direct figures are Buffer's channel total minus the posts it listed.");
		expect(body).toContain("Not split: days Buffer's post list does not cover yet");
		expect(body).toContain("split into posts made directly on the network (Direct) and posts made through Buffer, this plugin included (Buffer)");
	});

	it("the stat cards stay channel-wide and split the total when every figure is split", async () => {
		host = await newHost();
		await seedOrigins(
			host,
			{
				days: { c1: { [today]: { direct: { posts: 2, engagement: 7, impressions: 700 }, buffer: { posts: 1, engagement: 3, impressions: 300 } }, [dayAgo(1)]: { direct: { posts: 1, engagement: 4, impressions: 400 } } } },
				coveredFrom: { c1: dayAgo(29) },
			},
			{ c1: "listed" },
		);
		await seedConfig(host, { channels: allOn([LI]) });

		const response = await host.admin.act(PAGE_PATH, RANGE_ACTION, { value: 7 });

		const stats = blocksOf(response).find((b) => b.type === "stats") as { items: Array<{ label: string; value: string; description: string }> };
		const impressions = stats.items.find((i) => i.label === "Impressions, last 7 days");
		expect(impressions?.value).toBe("1,400");
		expect(impressions?.description).toMatch(/^1,100 direct, 300 via Buffer · /);
	});

	it("the Setup view says how each channel is split and how many posts Buffer listed by origin", async () => {
		host = await newHost();
		await seedOrigins(host, { days: {}, coveredFrom: {} }, { c1: "listed", c2: "derived" });
		const response = await host.admin.act(PAGE_PATH, SETUP_ACTION);
		expectValid(response);
		const body = text(response);
		expect(body).toContain("Shane on LinkedIn from Buffer's post list (2 made directly, 1 in Buffer, 1 through the API, this plugin included)");
		expect(body).toContain("FuelOracle page derived from channel totals, as Buffer listed no post made directly (1 in Buffer, 1 through the API, this plugin included)");
	});
});

describe("charts over the whole range", () => {
	const chartOf = (response: unknown, blockId: string) => {
		let found:
			| { labels: string[]; series: Array<{ name: string; data: Array<number | null>; itemStyle?: { color: string }; lineStyle?: { color: string }; areaStyle?: any }>; tooltip?: unknown; xType?: string }
			| undefined;
		const walk = (node: unknown): void => {
			if (Array.isArray(node)) return node.forEach(walk);
			if (!node || typeof node !== "object") return;
			const block = node as Record<string, unknown>;
			if (block.type === "chart" && block.block_id === blockId) {
				const config = block.config as { chart_type: string; options: Record<string, any> };
				expect(config.chart_type).toBe("custom");
				found = { labels: config.options.xAxis.data, series: config.options.series, tooltip: config.options.tooltip, xType: config.options.xAxis.type };
			}
			Object.values(block).forEach(walk);
		};
		walk(response);
		return found!;
	};
	const line = (chart: ReturnType<typeof chartOf>, name: string) => chart.series.find((s) => s.name === name)?.data;
	const FBX = channel("c2", "facebook", { displayName: "FuelOracle" });

	/** LinkedIn split from Buffer's post list over the last `covered` days, by a pass that ran `passAgo` days ago. */
	async function seedSplit(runtime: PluginRuntimeTestHost, origins: Origins, opts: { passAgo?: number; channels?: typeof LI[]; methods?: Record<string, "listed" | "derived">; aggregates?: Aggregates["days"] } = {}) {
		const channels = opts.channels ?? [LI];
		await seedChannels(runtime, channels);
		await seedConfig(runtime, { channels: allOn(channels) });
		await seedState(runtime, { watchSince: ago(3) });
		await seedLedger(runtime, { e1: entry({ sentAt: ago(1), createdAt: ago(1) }) });
		await seedAggregates(runtime, { days: opts.aggregates ?? {}, ranges: {}, progress: {} });
		await runtime.fixtures.plugin.storage("reports", "origins", { zone: ZONE, ...origins });
		const methods = opts.methods ?? { c1: "listed" };
		await seedReport(runtime, {
			...nothingDue(),
			origins: {
				at: ago(opts.passAgo ?? 0),
				since: dayAgo(6),
				channels: Object.fromEntries(Object.entries(methods).map(([id, method]) => [id, { method, counts: { network: 1, buffer: 1, api: 0 } }])),
			},
		});
	}

	it("spans the selected range with date labels, and a day the post list covers with no posts is 0", async () => {
		host = await newHost();
		await seedSplit(host, {
			days: { c1: { [dayAgo(3)]: { direct: { posts: 1, engagement: 5, impressions: 50 } }, [today]: { buffer: { posts: 2, engagement: 4, impressions: 40 } } } },
			coveredFrom: { c1: dayAgo(6) },
		});

		const response = await host.admin.act(PAGE_PATH, RANGE_ACTION, { value: 7 });

		expectValid(response);
		const engagement = chartOf(response, "buffer:chart:engagement");
		expect(engagement.xType).toBe("category");
		expect(engagement.labels).toEqual([6, 5, 4, 3, 2, 1, 0].map((n) => formatShortDay(dayAgo(n), "en")));
		expect(engagement.labels[0]).toMatch(/^\d{1,2} [A-Z][a-z]+$/);
		// One post on one day is 5 on that day and 0 on the days around it, not a line held at 5.
		expect(line(engagement, "LinkedIn (Direct)")).toEqual([0, 0, 0, 5, 0, 0, 0]);
		expect(line(engagement, "LinkedIn (Buffer)")).toEqual([0, 0, 0, 0, 0, 0, 4]);
		expect(line(chartOf(response, "buffer:chart:impressions"), "LinkedIn (Direct)")).toEqual([0, 0, 0, 50, 0, 0, 0]);
		// The tooltip is ECharts' own over a category axis: the day label, no time of day.
		expect(engagement.tooltip).toEqual({ trigger: "axis" });
		expect(JSON.stringify(response)).not.toContain("formatter");
		expect(JSON.stringify(response)).not.toContain("timeseries");
	});

	it("days the plugin has not read, and days beyond Buffer's history limit, stay missing", async () => {
		host = await newHost();
		await seedSplit(
			host,
			{ days: { c1: { [dayAgo(2)]: { direct: { posts: 1, engagement: 3 } }, [dayAgo(1)]: { buffer: { posts: 1, engagement: 2 } } } }, coveredFrom: { c1: dayAgo(3) } },
			// The last pass ran yesterday, so today is not covered yet.
			{ passAgo: 1 },
		);
		await seedReport(host, {
			...nothingDue(),
			insightsHistory: { days: 5, learntAt: NOW.toISOString() },
			origins: { at: ago(1), since: dayAgo(3), channels: { c1: { method: "listed", counts: { network: 1, buffer: 1, api: 0 } } } },
		});

		const response = await host.admin.act(PAGE_PATH, RANGE_ACTION, { value: 7 });

		expectValid(response);
		const engagement = chartOf(response, "buffer:chart:engagement");
		// The plan gives five days: the axis covers those five, not the seven of the range.
		expect(engagement.labels).toEqual([4, 3, 2, 1, 0].map((n) => formatShortDay(dayAgo(n), "en")));
		// Four days ago is before the post list covered the channel; today is after its last pass.
		expect(line(engagement, "LinkedIn (Direct)")).toEqual([null, 0, 3, 0, null]);
		expect(line(engagement, "LinkedIn (Buffer)")).toEqual([null, 0, 0, 2, null]);
		// The sent chart covers the whole range: no bar before the plugin started watching three days ago.
		const sent = chartOf(response, "buffer:chart:sent");
		expect(sent.labels).toHaveLength(7);
		expect(line(sent, "Sent")).toEqual([null, null, null, 0, 0, 1, 0]);
	});

	it("a day with posts whose network reported no figure for the metric stays missing, and so does a day with unread posts", async () => {
		host = await newHost();
		await seedSplit(host, {
			days: {
				c1: {
					// Engagement reported, impressions not.
					[dayAgo(4)]: { direct: { posts: 1, engagement: 6 } },
					[dayAgo(3)]: { direct: { posts: 1, engagement: 2, impressions: 20 } },
					// A post Buffer has not read: it could be either origin.
					[dayAgo(1)]: { unread: 1 },
				},
			},
			coveredFrom: { c1: dayAgo(6) },
		});

		const response = await host.admin.act(PAGE_PATH, RANGE_ACTION, { value: 7 });

		expectValid(response);
		expect(line(chartOf(response, "buffer:chart:engagement"), "LinkedIn (Direct)")).toEqual([0, 0, 6, 2, 0, null, 0]);
		expect(line(chartOf(response, "buffer:chart:impressions"), "LinkedIn (Direct)")).toEqual([0, 0, null, 20, 0, null, 0]);
		// LinkedIn made no post through Buffer in the range: no line of zeros.
		expect(line(chartOf(response, "buffer:chart:engagement"), "LinkedIn (Buffer)")).toBeUndefined();
	});

	it("a channel with no posts in the range draws no line, and a derived channel is 0 on a day Buffer counted no direct post", async () => {
		host = await newHost();
		await seedSplit(
			host,
			{
				days: { c2: { [dayAgo(2)]: { buffer: { posts: 1, engagement: 4 } } } },
				coveredFrom: { c1: dayAgo(6), c2: dayAgo(6) },
			},
			{
				channels: [LI, FBX],
				methods: { c1: "listed", c2: "derived" },
				aggregates: {
					c2: {
						[dayAgo(3)]: { posts: 0, metrics: {}, metricsUpdatedAt: null },
						[dayAgo(2)]: { posts: 2, metrics: { reactions: 9 }, metricsUpdatedAt: NOW.toISOString() },
						[dayAgo(1)]: { posts: 1, metrics: { reactions: 4 }, metricsUpdatedAt: NOW.toISOString() },
					},
				},
			},
		);

		const response = await host.admin.act(PAGE_PATH, RANGE_ACTION, { value: 7 });

		expectValid(response);
		const engagement = chartOf(response, "buffer:chart:engagement");
		expect(engagement.series.map((s) => s.name)).toEqual(["Facebook (Direct)", "Facebook (Buffer)"]);
		// Days the aggregates have not read stay missing; a day Buffer counted one post, the listed one, is 0.
		expect(line(engagement, "Facebook (Direct)")).toEqual([null, null, null, 0, 5, 4, null]);
		expect(line(engagement, "Facebook (Buffer)")).toEqual([0, 0, 0, 0, 4, 0, 0]);
	});

	it("leaves out a series with no value on any day, so it takes no colour and no tooltip row", () => {
		const chart = dailyChart({
			labels: ["1 Oct", "2 Oct", "3 Oct"],
			series: [
				{ name: "Threads (Not split)", data: [null, null, null] },
				{ name: "Facebook (Direct)", data: [0, 2, null] },
			],
			style: "line",
			height: 220,
			gradient: true,
		});
		const series = (chart.config as unknown as { options: { series: Array<{ name: string; areaStyle?: unknown }> } }).options.series;
		expect(series.map((s) => s.name)).toEqual(["Facebook (Direct)"]);
		// The one line left is the only line, so it keeps the gradient under it.
		expect(series[0]!.areaStyle).toBeDefined();
	});

	it("a channel and origin keep one colour on both charts and every range, whatever other lines are left out", async () => {
		const TH = channel("c5", "threads", { displayName: "FuelOracle Threads" });
		host = await newHost();
		await seedSplit(
			host,
			{ days: { c2: { [dayAgo(1)]: { direct: { posts: 1, engagement: 3, impressions: 30 } } } }, coveredFrom: { c2: dayAgo(6) } },
			{
				channels: [TH, FBX],
				methods: { c2: "listed" },
				// Threads is not split and reports no impressions; its one figure is 13 days old.
				aggregates: { c5: { [dayAgo(13)]: { posts: 1, metrics: { reactions: 1 }, metricsUpdatedAt: NOW.toISOString() } } },
			},
		);

		const month = await host.admin.act(PAGE_PATH, RANGE_ACTION, { value: 30 });
		const week = await host.admin.act(PAGE_PATH, RANGE_ACTION, { value: 7 });

		expectValid(month);
		expectValid(week);
		const colour = (chart: ReturnType<typeof chartOf>, name: string) => {
			const s = chart.series.find((x) => x.name === name)!;
			expect(s.lineStyle?.color).toBe(s.itemStyle?.color);
			return s.itemStyle!.color;
		};
		const engagement = chartOf(month, "buffer:chart:engagement");
		const impressions = chartOf(month, "buffer:chart:impressions");
		expect(engagement.series.map((s) => s.name)).toEqual(["Threads (Not split)", "Facebook (Direct)"]);
		// Threads reports no impressions: no line there, and Facebook keeps its colour rather than taking the first.
		expect(impressions.series.map((s) => s.name)).toEqual(["Facebook (Direct)"]);
		const facebook = colour(engagement, "Facebook (Direct)");
		expect(CHART_COLOURS).toContain(facebook);
		expect(colour(impressions, "Facebook (Direct)")).toBe(facebook);
		expect(colour(engagement, "Threads (Not split)")).not.toBe(facebook);
		// The gradient under the single line is in that line's colour.
		const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(facebook.slice(i, i + 2), 16));
		expect(impressions.series[0]!.areaStyle.color.colorStops[0].color).toBe(`rgba(${r}, ${g}, ${b}, 0.4)`);
		// Over seven days Threads has no figure and no line; Facebook's colour stays.
		const weekEngagement = chartOf(week, "buffer:chart:engagement");
		expect(weekEngagement.series.map((s) => s.name)).toEqual(["Facebook (Direct)"]);
		expect(colour(weekEngagement, "Facebook (Direct)")).toBe(facebook);
		expect(colour(chartOf(week, "buffer:chart:impressions"), "Facebook (Direct)")).toBe(facebook);
	});

	it("names each line and its colour under the chart, since the host registers no legend", async () => {
		const TH = channel("c5", "threads", { displayName: "FuelOracle Threads" });
		host = await newHost();
		await seedSplit(
			host,
			{ days: { c2: { [dayAgo(1)]: { direct: { posts: 1, engagement: 3, impressions: 30 } } } }, coveredFrom: { c2: dayAgo(6) } },
			{ channels: [TH, FBX], methods: { c2: "listed" }, aggregates: { c5: { [dayAgo(3)]: { posts: 1, metrics: { reactions: 1 }, metricsUpdatedAt: NOW.toISOString() } } } },
		);
		const response = await host.admin.act(PAGE_PATH, rangeAction(30));
		expectValid(response);
		const NAMES = ["blue", "yellow", "pink", "purple", "teal", "orange"];
		const contextText = (blockId: string) => {
			const match = JSON.stringify(response).match(new RegExp(`"type":"context","text":"([^"]*)","block_id":"${blockId}"`));
			return match?.[1];
		};
		for (const id of ["buffer:chart:engagement", "buffer:chart:impressions"]) {
			const chart = chartOf(response, id);
			expect(chart.series.length).toBeGreaterThan(0);
			const expected = `Lines: ${chart.series.map((s) => `${s.name} in ${NAMES[CHART_COLOURS.indexOf(s.itemStyle!.color as (typeof CHART_COLOURS)[number])]}`).join(", ")}.`;
			expect(contextText(`${id}:lines`), id).toBe(expected);
		}
		expect(contextText("buffer:chart:engagement:lines")).toContain("Threads (Not split) in");
		// A legend option would draw nothing in EmDash's admin, so none is sent.
		expect(JSON.stringify(response)).not.toContain('"legend"');
	});

	it("ten channels split two ways over 90 days stay inside Block Kit's node limit, keeping each chart's busiest lines", async () => {
		host = await newHost();
		const many = Array.from({ length: 10 }, (_, i) => channel(`m${i}`, "linkedin", { displayName: `Page ${i}` }));
		const originDays = Object.fromEntries(
			many.map((c, i) => [c.id, Object.fromEntries(Array.from({ length: 90 }, (_, d) => [dayAgo(d), { direct: { posts: 1, engagement: i + 1, impressions: 10 * (i + 1) }, buffer: { posts: 1, engagement: 1, impressions: 5 } }]))]),
		);
		await seedChannels(host, many);
		await seedConfig(host, { channels: allOn(many) });
		await seedState(host, { watchSince: ago(100) });
		await seedLedger(host, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`e${i}`, entry({ channelId: `m${i % 10}`, sentAt: ago(i), createdAt: ago(i), engagement: i })])));
		await seedAggregates(host, { days: {}, ranges: {}, progress: {} });
		await host.fixtures.plugin.storage("reports", "origins", { zone: ZONE, days: originDays, coveredFrom: Object.fromEntries(many.map((c) => [c.id, dayAgo(89)])) });
		await seedReport(host, {
			...nothingDue(),
			origins: { at: NOW.toISOString(), since: dayAgo(89), channels: Object.fromEntries(many.map((c) => [c.id, { method: "listed" as const, counts: { network: 90, buffer: 90, api: 0 } }])) },
		});

		const response = await host.admin.act(PAGE_PATH, RANGE_ACTION, { value: 90 });

		expectValid(response);
		const engagement = chartOf(response, "buffer:chart:engagement");
		expect(engagement.labels).toHaveLength(90);
		// The busiest lines are kept, in their usual order.
		expect(engagement.series.map((s) => s.name)).toEqual(["LinkedIn Page 6 (Direct)", "LinkedIn Page 7 (Direct)", "LinkedIn Page 8 (Direct)", "LinkedIn Page 9 (Direct)"]);
		expect(JSON.stringify(response)).toMatch(/Each chart shows its \d+ busiest lines of 20\./);
	});
});

