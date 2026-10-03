import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Aggregates, AggregateDay } from "../src/store/report.js";
import { PAGE_REFRESH_ACTION, RANGE_ACTION, RETRY_ALL_ACTION } from "../src/ui/analytics.js";
import { PAGE_PATH } from "../src/ui/page.js";
import { SETUP_ACTION } from "../src/ui/analytics.js";
import { WIDGET_ID, WIDGET_REFRESH_ACTION } from "../src/ui/widget.js";
import { allOn, channel, deliveries, expectValid, HOUR, newHost, NOW, reading, seedChannels, seedConfig, seedDelivery, seedState } from "./host.js";
import { DAY, dayAgo, entry, seedAggregates, seedLedger, today } from "./report-fixtures.js";

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
		expect(charts).toContain('"style":"bar"');
		expect(charts).toContain('"height":300');
		expect(charts).toContain('"y_axis_name":"Times shown"');

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
		expect(String(banner?.description)).toMatch(/^Reports paused to leave Buffer requests for your other tools until .+ UTC\. Posts still go out\.$/);

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
