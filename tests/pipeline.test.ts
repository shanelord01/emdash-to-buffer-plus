import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	allOn,
	channel,
	created,
	deliveries,
	HOUR,
	json,
	mutationError,
	newHost,
	NOW,
	postsCollection,
	publishedPost,
	rateLimited,
	respond,
	seedChannels,
	seedConfig,
	seedDelivery,
	seedState,
	sentBodies,
	tick,
	watching,
} from "./host.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const posts = { posts: { enabled: true, image: "none", titleField: "title" } };

async function setup(channels = [channel("c1", "linkedin"), channel("c2", "facebook")]) {
	host = await newHost();
	await postsCollection(host);
	await seedChannels(host, channels);
	await seedConfig(host, { channels: allOn(channels, { attach: "none" }), collections: posts });
	await seedState(host, watching);
	return host;
}

describe("publishing an entry", () => {
	it("sends to every channel that is on, with the entry's link and line breaks kept", async () => {
		host = await setup();
		const { event, id } = await publishedPost(host);
		await respond(host, created("p1"), created("p2"));

		await host.transport.invokeHook("content:afterPublish", event);

		const bodies = sentBodies(host);
		expect(bodies).toHaveLength(2);
		const input = bodies[0]!.variables.input as Record<string, unknown>;
		expect(input).toMatchObject({ channelId: "c1", mode: "addToQueue", schedulingType: "automatic", assets: [] });
		expect(input.text).toBe("Hello world\n\nA short excerpt.\n\nhttps://www.example.com/blog/hello");
		expect((bodies[1]!.variables.input as Record<string, unknown>).metadata).toEqual({ facebook: { type: "post" } });

		const rows = await deliveries(host);
		expect(rows.map((r) => [r.channelId, r.status, r.postId])).toEqual(
			expect.arrayContaining([
				["c1", "sent", "p1"],
				["c2", "sent", "p2"],
			]),
		);
		expect(rows.every((r) => r.entryId === id)).toBe(true);
		expect(await host.inspect.kv.get("state")).toMatchObject({ rateLimit: { windows: [{ name: "100-in-15min", remaining: 97, window: 900 }, expect.anything()] } });
	});

	it("never sends again on a republish", async () => {
		host = await setup();
		const { event } = await publishedPost(host);
		await respond(host, created("p1"), created("p2"));
		await host.transport.invokeHook("content:afterPublish", event);
		host.http.clear();

		await host.transport.invokeHook("content:afterPublish", event);

		expect(host.http.requests()).toHaveLength(0);
	});

	it("leaves entries first published before the watch started alone", async () => {
		host = await setup();
		const { event } = await publishedPost(host, { publishedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString() });

		await host.transport.invokeHook("content:afterPublish", event);

		expect(host.http.requests()).toHaveLength(0);
		expect(await deliveries(host)).toEqual([]);
	});

	it("starts watching on first sight and shares nothing then", async () => {
		host = await setup();
		await seedState(host, {});
		const { event } = await publishedPost(host);

		await host.transport.invokeHook("content:afterPublish", event);

		expect(host.http.requests()).toHaveLength(0);
		expect(await host.inspect.kv.get("state")).toMatchObject({ watchSince: expect.any(String) });
	});

	it("shares an entry created as published, through content:afterSave", async () => {
		host = await setup([channel("c1", "linkedin")]);
		const { event } = await publishedPost(host);
		await respond(host, created("p1"));

		await host.transport.invokeHook("content:afterSave", { ...event, isNew: true });

		expect((await deliveries(host))[0]).toMatchObject({ status: "sent", postId: "p1" });
	});

	it("ignores a save of an existing entry", async () => {
		host = await setup([channel("c1", "linkedin")]);
		const { event } = await publishedPost(host);

		await host.transport.invokeHook("content:afterSave", { ...event, isNew: false });

		expect(await deliveries(host)).toEqual([]);
	});

	it("sends nothing from a collection that is off", async () => {
		host = await setup();
		await seedConfig(host, { channels: allOn([channel("c1", "linkedin")]), collections: { posts: { enabled: false, image: "none" } } });
		const { event } = await publishedPost(host);

		await host.transport.invokeHook("content:afterPublish", event);

		expect(await deliveries(host)).toEqual([]);
	});

	it("uses the SEO canonical when set", async () => {
		host = await setup([channel("c1", "linkedin")]);
		const { event } = await publishedPost(host);
		await respond(host, created("p1"));

		await host.transport.invokeHook("content:afterPublish", {
			...event,
			content: { ...event.content, seo: { canonical: "https://elsewhere.example.org/original", title: null, description: null, image: null, noIndex: false } },
		});

		expect((sentBodies(host)[0]!.variables.input as { text: string }).text).toContain("https://elsewhere.example.org/original");
	});

	it("adds UTM tags when they are on, keeping a tag the link already has", async () => {
		host = await setup([channel("c1", "linkedin")]);
		await seedConfig(host, {
			channels: allOn([channel("c1", "linkedin")], { attach: "none" }),
			collections: posts,
			utm: { enabled: true, source: "buffer", medium: "social" },
		});
		const { event } = await publishedPost(host);
		await respond(host, created("p1"));

		await host.transport.invokeHook("content:afterPublish", {
			...event,
			content: { ...event.content, seo: { canonical: "https://www.example.com/blog/hello?utm_source=newsletter", title: null, description: null, image: null, noIndex: false } },
		});

		const text = (sentBodies(host)[0]!.variables.input as { text: string }).text;
		expect(text).toContain("https://www.example.com/blog/hello?utm_source=newsletter&utm_medium=social&utm_campaign=linkedin");
	});

	it("sends the local cover image through the media library, with its alt text", async () => {
		host = await setup([channel("c1", "linkedin")]);
		await seedConfig(host, { channels: allOn([channel("c1", "linkedin")]), collections: { posts: { enabled: true, image: "cover" } } });
		const media = await host.fixtures.media({ filename: "cover.jpg", mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]), alt: "A road" });
		const { event } = await publishedPost(host, { cover: { id: media.id, provider: "local" } });
		await respond(host, created("p1"));

		await host.transport.invokeHook("content:afterPublish", event);

		const input = sentBodies(host)[0]!.variables.input as { assets: Array<{ image: { url: string; metadata?: { altText: string } } }> };
		expect(input.assets).toEqual([
			{ image: { url: `https://www.example.com/_emdash/api/media/asset/${media.id}/cover.jpg`, metadata: { altText: "A road" } } },
		]);
	});

	it("records channels it cannot use as skipped, with a reason", async () => {
		const chans = [channel("c1", "youtube"), channel("c2", "linkedin", { isDisconnected: true }), channel("c3", "instagram")];
		host = await setup(chans);
		const { event } = await publishedPost(host);

		await host.transport.invokeHook("content:afterPublish", event);

		expect(host.http.requests()).toHaveLength(0);
		const reasons = Object.fromEntries((await deliveries(host)).map((r) => [r.channelId, [r.status, r.reason]]));
		expect(reasons).toEqual({
			c1: ["skipped", "videoOnly"],
			c2: ["skipped", "channelDisconnected"],
			c3: ["skipped", "needsImage"],
		});
	});

	it("hands channels past the budget to a continuation", async () => {
		const chans = ["a", "b", "c", "d", "e"].map((id) => channel(id, "linkedin"));
		host = await setup(chans);
		const { event } = await publishedPost(host);
		for (const id of ["p1", "p2", "p3", "p4", "p5"]) await respond(host, created(id));

		await host.transport.invokeHook("content:afterPublish", event);

		const rows = await deliveries(host);
		const sent = rows.filter((r) => r.status === "sent").length;
		expect(sent).toBeGreaterThan(0);
		expect(rows.filter((r) => r.status === "pending")).toHaveLength(5 - sent);
		const tasks = await host.inspect.scheduledTasks();
		expect(tasks.map((t) => t.name)).toContain("deliver-a");
	});
});

describe("Buffer's answers", () => {
	it("a MutationError fails the delivery with Buffer's message, capped", async () => {
		host = await setup([channel("c1", "linkedin")]);
		const { event } = await publishedPost(host);
		await respond(host, mutationError(`LinkedIn posts cannot exceed 3000 characters. ${"x".repeat(900)}`));

		await host.transport.invokeHook("content:afterPublish", event);

		const [row] = await deliveries(host);
		expect(row).toMatchObject({ status: "failed", errorKind: "rejected" });
		expect(row!.error!.startsWith("LinkedIn posts cannot exceed 3000 characters.")).toBe(true);
		expect(row!.error!.length).toBe(500);
	});

	it("a 429 waits for Retry-After in a one-shot run and sends nothing more", async () => {
		host = await setup();
		const { event } = await publishedPost(host);
		await respond(host, rateLimited(600));

		await host.transport.invokeHook("content:afterPublish", event);

		expect(host.http.requests()).toHaveLength(1);
		const rows = await deliveries(host);
		expect(rows.every((r) => r.status === "pending")).toBe(true);
		const wait = Date.parse(rows[0]!.nextAttemptAt) - Date.now();
		expect(wait).toBeGreaterThan(590_000);
		const task = (await host.inspect.scheduledTasks()).find((t) => t.name === "deliver-a");
		expect(Date.parse(String(task?.nextRunAt)) - Date.now()).toBeGreaterThan(590_000);
	});

	it("a 5xx leaves the delivery unknown, never failed or resent", async () => {
		host = await setup([channel("c1", "linkedin")]);
		const { event } = await publishedPost(host);
		await respond(host, json({ errors: [{ message: "boom" }] }, 502));

		await host.transport.invokeHook("content:afterPublish", event);

		expect((await deliveries(host))[0]).toMatchObject({ status: "unknown", errorKind: "uncertain" });
	});
});

describe("continuation runs", () => {
	it("an unknown delivery that Buffer has is marked sent without sending again", async () => {
		host = await newHost();
		await seedState(host, watching);
		const row = await seedDelivery(host, "posts:e1:c1", { status: "unknown", lastAttemptAt: new Date(NOW.getTime() - HOUR).toISOString() });
		await respond(
			host,
			json({ data: { posts: { edges: [{ node: { id: "found", text: row.text, status: "scheduled", channelId: "c1", createdAt: NOW.toISOString() } }] } } }),
		);

		await tick(host, "deliver-a")();

		expect(sentBodies(host).map((b) => b.query.match(/(query|mutation) (\w+)/)?.[2])).toEqual(["RecentPosts"]);
		expect((await deliveries(host))[0]).toMatchObject({ status: "sent", postId: "found" });
	});

	it("an unknown delivery that Buffer does not have is sent", async () => {
		host = await newHost();
		await seedState(host, watching);
		await seedDelivery(host, "posts:e1:c1", { status: "unknown", lastAttemptAt: new Date(NOW.getTime() - HOUR).toISOString() });
		await respond(host, json({ data: { posts: { edges: [] } } }), created("p9"));

		await tick(host, "deliver-a")();

		expect(sentBodies(host).map((b) => b.query.match(/(query|mutation) (\w+)/)?.[2])).toEqual(["RecentPosts", "CreatePost"]);
		expect((await deliveries(host))[0]).toMatchObject({ status: "sent", postId: "p9", attempts: 1 });
	});

	it("a delivery waiting out a 429 is not sent early", async () => {
		host = await newHost();
		await seedDelivery(host, "posts:e1:c1", { status: "pending", nextAttemptAt: new Date(NOW.getTime() + HOUR).toISOString() });

		await tick(host, "deliver-b")();

		expect(host.http.requests()).toHaveLength(0);
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("deliver-a");
	});

	it("a failed delivery is not retried until someone asks", async () => {
		host = await newHost();
		await seedDelivery(host, "posts:e1:c1", { status: "failed", error: "nope" });

		await tick(host, "deliver-a")();

		expect(host.http.requests()).toHaveLength(0);
	});

	it("the sync prunes records past the retention", async () => {
		// No key: pruning needs no Buffer, and the sync's Buffer phases stay quiet.
		host = await newHost({ token: false });
		await seedDelivery(host, "old", { status: "sent", createdAt: new Date(NOW.getTime() - 200 * 24 * HOUR).toISOString() });
		await seedDelivery(host, "new", { status: "sent", createdAt: NOW.toISOString() });

		await tick(host, "sync")();

		expect((await host.inspect.storage.list("deliveries")).map((r) => r.id)).toEqual(["new"]);
	});
});
