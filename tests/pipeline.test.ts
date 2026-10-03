import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	allOn,
	channel,
	created,
	deliveries,
	HOUR,
	json,
	limits,
	mutationError,
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
	sentBodies,
	tick,
	watching,
} from "./host.js";
import { RETRY_ALL_ACTION } from "../src/ui/analytics.js";
import { PAGE_PATH } from "../src/ui/page.js";

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

	it("sends the local cover image at the site's public media address, with its alt text", async () => {
		host = await setup([channel("c1", "linkedin")]);
		await seedConfig(host, { channels: allOn([channel("c1", "linkedin")]), collections: { posts: { enabled: true, image: "cover" } } });
		// The value EmDash stores for a local image: the media id is not the storage key.
		const { event } = await publishedPost(host, {
			cover: { id: "01M3QY3W07VYPSCAA3J1EHX3V8", provider: "local", filename: "gunbarrel-highway.jpg", mimeType: "image/jpeg", alt: "A road", meta: { storageKey: "01M3QY3VKJAWMFNS7TH6JHSA8W.jpg" } },
		});
		await respond(host, created("p1"));

		await host.transport.invokeHook("content:afterPublish", event);

		const input = sentBodies(host)[0]!.variables.input as { assets: Array<{ image: { url: string; metadata?: { altText: string } } }> };
		expect(input.assets).toEqual([{ image: { url: "https://www.example.com/_emdash/api/media/file/01M3QY3VKJAWMFNS7TH6JHSA8W.jpg", metadata: { altText: "A road" } } }]);
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

describe("the shared bucket when publishing", () => {
	it("sends below the reports' reserve: posts keep going out", async () => {
		host = await setup([channel("c1", "linkedin")]);
		await seedState(host, { ...watching, rateLimit: reading(3, 5, 40) });
		const { event } = await publishedPost(host);
		await respond(host, created("p1"));
		await host.transport.invokeHook("content:afterPublish", event);
		expect((await deliveries(host))[0]).toMatchObject({ status: "sent" });
	});

	it("holds every post while a window is spent, until it resets, without a request", async () => {
		host = await setup();
		await seedState(host, { ...watching, rateLimit: reading(50, 0, 2000) });
		const { event } = await publishedPost(host);

		await host.transport.invokeHook("content:afterPublish", event);

		expect(host.http.requests()).toHaveLength(0);
		const rows = await deliveries(host);
		expect(rows.every((r) => r.status === "pending" && r.attempts === 0)).toBe(true);
		// The day window resets 80,000 s after the reading, taken a minute ago.
		const reset = NOW.getTime() - 60_000 + 80_000_000;
		expect(Date.parse(rows[0]!.nextAttemptAt)).toBe(reset);
		const task = (await host.inspect.scheduledTasks()).find((t) => t.name === "deliver-a");
		expect(Date.parse(String(task?.nextRunAt))).toBe(reset);
	});

	it("a spent reading that has expired no longer holds anything", async () => {
		host = await setup([channel("c1", "linkedin")]);
		await seedState(host, { ...watching, rateLimit: { at: new Date(NOW.getTime() - 900_000).toISOString(), windows: [{ name: "100-in-15min", window: 900, quota: 100, remaining: 0, resetSeconds: 800 }] } });
		const { event } = await publishedPost(host);
		await respond(host, created("p1"));
		await host.transport.invokeHook("content:afterPublish", event);
		expect((await deliveries(host))[0]).toMatchObject({ status: "sent" });
	});

	it("a send that spends a window stops the rest of the run", async () => {
		host = await newHost();
		await seedState(host, watching);
		await seedDelivery(host, "posts:e1:c1", { status: "pending" });
		await seedDelivery(host, "posts:e2:c1", { entryId: "e2", status: "pending" });
		await respond(host, json({ data: { createPost: { post: { id: "p1", status: "scheduled", dueAt: null, externalLink: null } } } }, 200, limits(0, 100, 2000)));

		await tick(host, "deliver-a")();

		expect(host.http.requests()).toHaveLength(1);
		const rows = await deliveries(host);
		expect(rows.filter((r) => r.status === "sent")).toHaveLength(1);
		expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
		const task = (await host.inspect.scheduledTasks()).find((t) => t.name === "deliver-b");
		expect(Date.parse(String(task?.nextRunAt)) - Date.now()).toBeGreaterThan(700_000);
	});

	it("a delivery run with a spent window looks nothing up and sends nothing", async () => {
		host = await newHost();
		await seedState(host, { ...watching, rateLimit: reading(0, 100, 2000) });
		await seedDelivery(host, "posts:e1:c1", { status: "unknown", lastAttemptAt: new Date(NOW.getTime() - HOUR).toISOString() });
		await tick(host, "deliver-a")();
		expect(host.http.requests()).toHaveLength(0);
		expect((await deliveries(host))[0]).toMatchObject({ status: "unknown" });
	});
});

describe("records from 0.1.3 with an image address that needs signing in", () => {
	const KEY = "01M3QY3VKJAWMFNS7TH6JHSA8W.jpg";
	const ASSET = "https://www.example.com/_emdash/api/media/asset/01M3QY3W07VYPSCAA3J1EHX3V8/gunbarrel-highway.jpg";
	const cover = { id: "01M3QY3W07VYPSCAA3J1EHX3V8", provider: "local", filename: "gunbarrel-highway.jpg", mimeType: "image/jpeg", alt: "The Gunbarrel", meta: { storageKey: KEY } };
	const three = [channel("fb", "facebook"), channel("ig", "instagram"), channel("th", "threads")];

	/** The three deliveries Buffer refused on fueloracle.com.au: "Invalid post: Image could not be read from its URL." */
	async function refused(runtime: PluginRuntimeTestHost, entryId: string) {
		for (const c of three) {
			await seedDelivery(runtime, `posts:${entryId}:${c.id}`, {
				entryId,
				channelId: c.id,
				service: c.service,
				attach: "image",
				status: "failed",
				attempts: 1,
				error: "Invalid post: Image could not be read from its URL.",
				errorKind: "refused",
				imageUrl: ASSET,
				imageAlt: "The Gunbarrel",
			});
		}
	}

	async function retryAndRun(runtime: PluginRuntimeTestHost) {
		await runtime.admin.act(PAGE_PATH, RETRY_ALL_ACTION);
		// One read and one send fit a run beside its reserve; each run sends one.
		for (const task of ["deliver-a", "deliver-b", "deliver-a"]) await tick(runtime, task)();
	}

	const imagesSent = (runtime: PluginRuntimeTestHost) =>
		sentBodies(runtime).map((b) => (b.variables.input as { assets?: Array<{ image: { url: string } }> }).assets?.[0]?.image.url ?? null);

	it("Retry works the image out again from the entry and sends the public address", async () => {
		host = await setup(three);
		await seedConfig(host, { channels: allOn(three), collections: { posts: { enabled: true, image: "cover" } } });
		const { id } = await publishedPost(host, { cover });
		await refused(host, id);
		await respond(host, created("p1"), created("p2"), created("p3"));

		await retryAndRun(host);

		expect(imagesSent(host)).toEqual(Array(3).fill(`https://www.example.com/_emdash/api/media/file/${KEY}`));
		const rows = await deliveries(host);
		expect(rows.map((r) => r.status)).toEqual(["sent", "sent", "sent"]);
		expect(rows.every((r) => !r.imageUrl?.includes("/media/asset/"))).toBe(true);
	});

	it("with no public address, a network that needs an image is skipped and the others go without it, saying why", async () => {
		host = await setup(three);
		await seedConfig(host, { channels: allOn(three), collections: { posts: { enabled: true, image: "cover" } } });
		const { id } = await publishedPost(host, { cover: { id: cover.id, provider: "local", alt: "x" } });
		await refused(host, id);
		await respond(host, created("p1"), created("p2"));

		await retryAndRun(host);

		expect(imagesSent(host)).toEqual([null, null]);
		const byChannel = Object.fromEntries((await deliveries(host)).map((r) => [r.channelId, r]));
		expect(byChannel.ig).toMatchObject({ status: "skipped", reason: "needsImage", imageIssue: "noPublicAddress" });
		expect(byChannel.fb).toMatchObject({ status: "sent", imageIssue: "noPublicAddress" });
		expect(byChannel.th).toMatchObject({ status: "sent", imageIssue: "noPublicAddress" });
		expect(byChannel.fb!.imageUrl).toBeUndefined();
	});

	it("an entry that cannot be read sends without the image and records that", async () => {
		host = await setup([three[0]!]);
		await seedDelivery(host, "posts:gone:fb", { entryId: "gone", channelId: "fb", service: "facebook", attach: "image", imageUrl: ASSET });
		await respond(host, created("p1"));

		await tick(host, "deliver-a")();

		expect(imagesSent(host)).toEqual([null]);
		expect((await deliveries(host))[0]).toMatchObject({ status: "sent", imageIssue: "entryUnreadable" });
	});
});
