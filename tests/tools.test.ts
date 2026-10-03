import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { TOOL_ROUTES } from "../src/tools/load.js";
import { allOn, channel, HOUR, newHost, NOW, seedChannels, seedConfig, seedDelivery, seedState } from "./host.js";
import { dayAgo, entry, seedAggregates, seedLedger, seedReport, today } from "./report-fixtures.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

interface ManifestTool {
	name: string;
	route: string;
	permission: string;
	destructive: boolean;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
}

function toolsOf(runtime: PluginRuntimeTestHost): ManifestTool[] {
	return (runtime.manifest as unknown as { mcp?: { tools: ManifestTool[] } }).mcp?.tools ?? [];
}

/**
 * Call a tool's route and hold the answer against the output schema the
 * build wrote. The MCP server rejects an answer that does not match, so a
 * loader that drifts from its declaration breaks the tool, not just a type.
 */
async function call(runtime: PluginRuntimeTestHost, route: string, input: Record<string, unknown> = {}) {
	const tool = toolsOf(runtime).find((t) => t.route === route);
	if (!tool?.outputSchema) throw new Error(`no tool with an output schema calls ${route}`);
	const result = await runtime.transport.invokeRoute(route, input);
	const parsed = z.fromJSONSchema({ ...tool.outputSchema }).safeParse(result);
	expect(parsed.error?.issues ?? []).toEqual([]);
	return result as Record<string, any>;
}

describe("the manifest's MCP tools", () => {
	it("are the four read-only tools, each on a private route with the permission it declares", async () => {
		// EmDash skips a tool whose route is missing, public or has another
		// permission, without an error anywhere.
		host = await newHost();
		const manifest = host.manifest as unknown as { routes?: Array<string | { name: string; permission?: string; public?: boolean }> };
		const routes = new Map((manifest.routes ?? []).map((r) => (typeof r === "string" ? [r, { name: r }] : [r.name, r])));
		const tools = toolsOf(host);

		expect(tools.map((t) => t.name).sort()).toEqual(["channel_health", "engagement_summary", "entry_status", "recent_deliveries"]);
		for (const tool of tools) {
			const route = routes.get(tool.route) as { permission?: string; public?: boolean } | undefined;
			expect(route, tool.name).toBeDefined();
			expect(route!.public, tool.name).not.toBe(true);
			expect(route!.permission, tool.name).toBe("plugins:read");
			expect(tool.permission, tool.name).toBe("plugins:read");
			expect(tool.destructive, tool.name).toBe(false);
			expect(tool.outputSchema, tool.name).toBeDefined();
		}
	});

	it("never call Buffer", async () => {
		host = await newHost();
		await seedDelivery(host, "posts:e1:c1", { status: "sent", postId: "p1", postStatus: "scheduled" });
		for (const route of Object.values(TOOL_ROUTES)) await call(host, route, { entryId: "e1" });
		expect(host.http.requests()).toHaveLength(0);
	});
});

describe("entry_status", () => {
	it("lists the entry's deliveries per channel, newest first, with Buffer's state and figures", async () => {
		host = await newHost();
		await seedReport(host, { lastSyncAt: NOW.toISOString() });
		await seedDelivery(host, "posts:e1:c1", {
			status: "sent",
			postId: "p1",
			postStatus: "sent",
			externalLink: "https://www.linkedin.com/feed/update/p1",
			metrics: { reactions: 4, comments: 1, impressions: 90 },
			metricsUpdatedAt: NOW.toISOString(),
		});
		await seedDelivery(host, "posts:e1:c2", {
			channelId: "c2",
			channelName: "Bluesky",
			service: "bluesky",
			status: "failed",
			error: "Invalid image",
			createdAt: new Date(NOW.getTime() - HOUR).toISOString(),
		});
		await seedDelivery(host, "pages:e1:c1", { collection: "pages", status: "skipped", reason: "noUrl", text: "" });
		await seedDelivery(host, "posts:e2:c1", { entryId: "e2" });

		const result = await call(host, TOOL_ROUTES.entryStatus, { entryId: "e1", collection: "posts" });

		expect(result).toMatchObject({ found: true, entryId: "e1", collection: "posts", title: "Hello world", lastSync: NOW.toISOString() });
		expect(result.deliveries.map((d: { channelId: string; status: string }) => [d.channelId, d.status])).toEqual([
			["c2", "failed"],
			["c1", "sent"],
		]);
		expect(result.deliveries[0]).toMatchObject({ error: "Invalid image", engagement: null, impressions: null });
		expect(result.deliveries[1]).toMatchObject({ bufferStatus: "sent", postUrl: "https://www.linkedin.com/feed/update/p1", engagement: 5, impressions: 90, engagementRate: null });

		// id with collection works the same; without a collection every collection counts.
		expect((await call(host, TOOL_ROUTES.entryStatus, { id: "e1", collection: "posts" })).deliveries).toHaveLength(2);
		expect((await call(host, TOOL_ROUTES.entryStatus, { entryId: "e1" })).deliveries).toHaveLength(3);
	});

	it("keeps figures Buffer has not read yet missing, not zero", async () => {
		host = await newHost();
		await seedDelivery(host, "posts:e1:c1", { status: "sent", postId: "p1", postStatus: "sent", metrics: { reactions: 0 } });
		const result = await call(host, TOOL_ROUTES.entryStatus, { entryId: "e1" });
		expect(result.deliveries[0]).toMatchObject({ engagement: null, metricsUpdatedAt: null });
	});

	it("answers not found as data", async () => {
		host = await newHost();
		for (const input of [{ entryId: "missing" }, {}, { entryId: 42 }, { entryId: "e1", collection: "Not A Slug!" }]) {
			const result = await call(host, TOOL_ROUTES.entryStatus, input);
			expect(result, JSON.stringify(input)).toMatchObject({ found: false, deliveries: [], title: null, lastSync: null });
		}
	});
});

describe("recent_deliveries", () => {
	async function seeded() {
		const runtime = await newHost();
		for (let i = 0; i < 5; i++) {
			await seedDelivery(runtime, `posts:e${i}:c1`, {
				entryId: `e${i}`,
				entryTitle: `Entry ${i}`,
				status: i % 2 === 0 ? "sent" : "failed",
				createdAt: new Date(NOW.getTime() - i * HOUR).toISOString(),
			});
		}
		return runtime;
	}

	it("lists the newest first, up to the limit", async () => {
		host = await seeded();
		const result = await call(host, TOOL_ROUTES.recentDeliveries, { limit: 3 });
		expect(result.items.map((d: { entryId: string }) => d.entryId)).toEqual(["e0", "e1", "e2"]);
		expect(result.status).toBeNull();
	});

	it("filters by status", async () => {
		host = await seeded();
		const result = await call(host, TOOL_ROUTES.recentDeliveries, { status: "failed" });
		expect(result.items.map((d: { entryId: string }) => d.entryId)).toEqual(["e1", "e3"]);
		expect(result.status).toBe("failed");
	});

	it("falls back to the defaults for input nothing validated", async () => {
		// Over HTTP the route gets whatever the caller sent.
		host = await seeded();
		const result = await call(host, TOOL_ROUTES.recentDeliveries, { limit: 500, status: "lost" });
		expect(result.items).toHaveLength(5);
		expect(result.status).toBeNull();
	});
});

describe("channel_health", () => {
	it("reports each channel's health, rules and whether the plugin shares to it", async () => {
		host = await newHost();
		const li = channel("c1", "linkedin", { isQueuePaused: true });
		const yt = channel("c2", "youtube");
		const pin = channel("c3", "pinterest");
		await seedChannels(host, [li, yt, pin], {
			limits: [{ channelId: "c1", isAtLimit: true, limit: 10, scheduled: 10, sent: 0 }],
			hints: { c1: { textMaxLength: 2000 } },
			rateLimit: { at: NOW.toISOString(), windows: [{ name: "100-in-15min", window: 900, quota: 100, remaining: 97 }] },
		});
		await seedConfig(host, { channels: allOn([li, yt, pin]) });
		await seedDelivery(host, "f1", { status: "failed" });

		const result = await call(host, TOOL_ROUTES.channelHealth);

		const [c1, c2, c3] = result.channels;
		expect(c1).toMatchObject({
			sharing: true,
			blocked: null,
			queuePaused: true,
			dailyLimit: { atLimit: true, limit: 10 },
			rules: { image: "allowed", linkCard: true, textLimit: 2000, fromConfiguration: true },
		});
		expect(c2).toMatchObject({ sharing: false, blocked: { reason: "videoOnly", message: "This service takes video only." } });
		expect(c3).toMatchObject({ sharing: false, blocked: { reason: "needsBoard" }, rules: { image: "needed" } });
		expect(result.failedDeliveries).toBe(1);
		expect(result.rateLimit.windows[0]).toEqual({ name: "100-in-15min", remaining: 97, quota: 100, windowSeconds: 900, resetSeconds: null });
	});

	it("answers before any discovery", async () => {
		host = await newHost();
		const result = await call(host, TOOL_ROUTES.channelHealth);
		expect(result).toMatchObject({ fetchedAt: null, channels: [], rateLimit: null, failedDeliveries: 0 });
	});
});

describe("engagement_summary", () => {
	it("sums the window from the stored report, per channel and with the top entries", async () => {
		host = await newHost();
		const li = channel("a", "linkedin");
		await seedChannels(host, [li]);
		await seedConfig(host, { channels: allOn([li]) });
		await seedState(host, { watchSince: new Date(NOW.getTime() - 200 * 24 * HOUR).toISOString() });
		await seedLedger(host, {
			x: entry({ channelId: "a", engagement: 7, impressions: 30, link: "https://example.org/x" }),
			y: entry({ channelId: "a", status: "failed", postStatus: undefined }),
			z: entry({ channelId: "a", postStatus: "scheduled", dueAt: NOW.toISOString() }),
		});
		await seedAggregates(host, {
			days: { a: { [today]: { posts: 1, metrics: { reactions: 3, impressions: 40 }, metricsUpdatedAt: NOW.toISOString() } } },
			ranges: { a: { "7": { metrics: { impressions: 40, engagementRate: 2.5 }, metricsUpdatedAt: NOW.toISOString() } } },
			progress: { a: { backTo: dayAgo(6), recentOn: today } },
		});

		const result = await call(host, TOOL_ROUTES.engagementSummary, { days: 7 });

		expect(result).toMatchObject({ window: { days: 7, until: today, since: dayAgo(6) }, sent: 1, failed: 1, queued: 1, impressions: 40, engagement: 3, figuresSince: dayAgo(6) });
		// The ledger reaches the period before; Buffer's figures do not.
		expect(result.previous).toEqual({ sent: 0, failed: 0, impressions: null, engagement: null });
		expect(result.channels).toEqual([{ channelId: "a", name: "linkedin a", service: "linkedin", sent: 1, failed: 1, impressions: 40, engagementRate: 2.5 }]);
		expect(result.topEntries).toEqual([
			expect.objectContaining({ engagement: 7, impressions: 30, postUrl: "https://example.org/x", channelName: "linkedin a" }),
		]);
	});

	it("leaves figures Buffer has not sent as null, and falls back to 30 days", async () => {
		host = await newHost();
		const result = await call(host, TOOL_ROUTES.engagementSummary, { days: 12 });
		expect(result).toMatchObject({ window: { days: 30 }, sent: 0, impressions: null, engagement: null, previous: { sent: null, impressions: null }, figuresSince: null, lastSync: null });
	});
});
