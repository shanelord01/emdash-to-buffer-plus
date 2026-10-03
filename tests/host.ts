import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { expect, vi } from "vitest";

import type { BufferChannel } from "../src/buffer/client.js";
import type { Delivery } from "../src/store/deliveries.js";
import type { ChannelCache, PluginConfig, PluginState } from "../src/store/kv.js";

/**
 * Fixtures for tests that run the plugin inside the runtime test host.
 * Each test file creates and disposes its own host.
 */

export const SITE = "https://www.example.com";

/**
 * The test host answers a URL only when it matches to the character, and
 * `new Request("https://api.buffer.com")` normalises to a trailing slash.
 * Every Buffer request goes to this one URL; answers are served in order.
 */
export const BUFFER = "https://api.buffer.com/";

export const NOW = new Date();
export const HOUR = 60 * 60 * 1000;

export async function newHost(opts: { token?: boolean } = {}) {
	vi.stubEnv("EMDASH_ENCRYPTION_KEY", "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
	const host = await createPluginRuntimeTestHost({ site: { url: SITE, locale: "en", trailingSlash: "never" } });
	if (opts.token !== false) {
		const saved = await host.actions.plugin.updateSettings({ accessToken: "buffer_test_key" });
		expect(saved).toMatchObject({ success: true });
	}
	return host;
}

export function channel(id: string, service: string, extra: Partial<BufferChannel> = {}): BufferChannel {
	return {
		id,
		organizationId: "org1",
		name: `${service}-${id}`,
		displayName: `${service} ${id}`,
		service,
		avatar: null,
		isDisconnected: false,
		isLocked: false,
		isQueuePaused: false,
		...extra,
	};
}

export async function seedChannels(host: PluginRuntimeTestHost, channels: BufferChannel[], extra: Partial<ChannelCache> = {}) {
	const cache: ChannelCache = {
		fetchedAt: NOW.toISOString(),
		organizations: [{ id: "org1", name: "Org" }],
		channels,
		limits: [],
		...extra,
	};
	await host.fixtures.plugin.kv("channels", cache);
}

export async function seedConfig(host: PluginRuntimeTestHost, config: Partial<PluginConfig>) {
	await host.fixtures.plugin.kv("config", {
		channels: {},
		collections: {},
		utm: { enabled: false, source: "buffer", medium: "social" },
		...config,
	});
}

export async function seedState(host: PluginRuntimeTestHost, state: PluginState) {
	await host.fixtures.plugin.kv("state", state);
}

/** A watch that started an hour ago, so entries published now are shared. */
export const watching: PluginState = { watchSince: new Date(NOW.getTime() - HOUR).toISOString() };

/** Every channel on, in queue mode, sharing the entry's image. */
export function allOn(channels: BufferChannel[], extra: Partial<PluginConfig["channels"][string]> = {}) {
	return Object.fromEntries(channels.map((c) => [c.id, { enabled: true, mode: "addToQueue" as const, attach: "image" as const, ...extra }]));
}

export async function postsCollection(host: PluginRuntimeTestHost) {
	await host.fixtures.collection({
		slug: "posts",
		label: "Posts",
		urlPattern: "/blog/{slug}",
		routable: true,
		hasSeo: true,
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "excerpt", label: "Excerpt", type: "text" },
			{ slug: "cover", label: "Cover", type: "image" },
		],
	});
}

/** A published post, its hook event and its id. */
export async function publishedPost(
	host: PluginRuntimeTestHost,
	opts: { slug?: string; title?: string; excerpt?: string; publishedAt?: string; cover?: unknown } = {},
) {
	const item = await host.fixtures.content("posts", {
		slug: opts.slug ?? "hello",
		data: {
			title: opts.title ?? "Hello world",
			excerpt: opts.excerpt ?? "A short excerpt.",
			...(opts.cover !== undefined && { cover: opts.cover }),
		},
		status: "published",
		publishedAt: opts.publishedAt ?? NOW.toISOString(),
	});
	const event = {
		collection: "posts",
		content: {
			id: item.id,
			slug: item.slug,
			status: "published",
			publishedAt: opts.publishedAt ?? NOW.toISOString(),
			data: item.data,
		},
	};
	return { id: item.id, event };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function created(id: string, extra: Record<string, unknown> = {}): Response {
	return json(
		{ data: { createPost: { post: { id, status: "scheduled", dueAt: "2026-10-04T00:00:00.000Z", externalLink: null, ...extra } } } },
		200,
		{ ratelimit: '"100-in-15min"; r=97; t=800, "250-in-1day"; r=240; t=80000', "ratelimit-policy": '"100-in-15min"; q=100; w=900, "250-in-1day"; q=250; w=86400' },
	);
}

export function mutationError(message: string): Response {
	return json({ data: { createPost: { message } } });
}

export function rateLimited(seconds: number): Response {
	return json(
		{ errors: [{ message: "Too many requests from this client. Please try again later.", extensions: { code: "RATE_LIMIT_EXCEEDED", window: "15m" } }] },
		429,
		{ "retry-after": String(seconds) },
	);
}

export async function respond(host: PluginRuntimeTestHost, ...responses: Response[]) {
	for (const response of responses) await host.http.respond(BUFFER, response);
}

/** The GraphQL bodies the plugin sent, in order. */
export function sentBodies(host: PluginRuntimeTestHost): Array<{ query: string; variables: Record<string, unknown> }> {
	return host.http.requests().map((r) => JSON.parse(new TextDecoder().decode(r.body)));
}

export async function deliveries(host: PluginRuntimeTestHost): Promise<Delivery[]> {
	return (await host.inspect.storage.list<Delivery>("deliveries")).map((r) => r.data);
}

export async function seedDelivery(host: PluginRuntimeTestHost, id: string, data: Partial<Delivery>) {
	const stamp = new Date(NOW.getTime() - 2 * HOUR).toISOString();
	const row: Delivery = {
		collection: "posts",
		entryId: "e1",
		entryTitle: "Hello world",
		channelId: "c1",
		organizationId: "org1",
		service: "linkedin",
		channelName: "LinkedIn",
		status: "pending",
		text: "Hello world\n\nA short excerpt.\n\nhttps://www.example.com/blog/hello",
		url: "https://www.example.com/blog/hello",
		mode: "addToQueue",
		attach: "none",
		attempts: 0,
		createdAt: stamp,
		updatedAt: stamp,
		nextAttemptAt: "",
		...data,
	};
	await host.fixtures.plugin.storage("deliveries", id, row);
	return row;
}

export const tick = (host: PluginRuntimeTestHost, name: string) => () =>
	host.transport.invokeHook("cron", { name, scheduledAt: NOW.toISOString() });

/** Validate a route response the way the host does before rendering it. */
export function expectValid(response: unknown) {
	const result = validateBlockResponse(response, {});
	expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
	expect(result.valid).toBe(true);
}
