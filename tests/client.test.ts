import { describe, expect, it } from "vitest";

import { BufferClient, MAX_ERROR_LENGTH, retryAfter, type Fetcher } from "../src/buffer/client.js";
import { parseRateLimit } from "../src/buffer/ratelimit.js";

const NOW = new Date("2026-10-03T00:00:00.000Z");

function fake(...responses: Array<Response | Error | "hang">): { fetch: Fetcher; calls: Array<{ url: string; init?: RequestInit }> } {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	return {
		calls,
		fetch: async (url, init) => {
			calls.push({ url, init });
			const next = responses.shift();
			if (next === "hang") return await new Promise<Response>(() => {});
			if (next instanceof Error) throw next;
			if (!next) throw new Error("no response");
			return next;
		},
	};
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const client = (f: Fetcher, timeoutMs?: number) => new BufferClient({ fetch: f, token: "secret-key", now: () => NOW, ...(timeoutMs && { timeoutMs }) });

const input = { channelId: "c1", text: "hi", mode: "addToQueue" as const, schedulingType: "automatic" as const, assets: [] };

describe("requests", () => {
	it("posts GraphQL to api.buffer.com with the key as a bearer token", async () => {
		const f = fake(json({ data: { account: { organizations: [{ id: "o1", name: "Mine" }] } } }));
		const result = await client(f.fetch).organizations();
		expect(result).toMatchObject({ ok: true, data: [{ id: "o1", name: "Mine" }] });
		expect(f.calls[0]!.url).toBe("https://api.buffer.com");
		expect((f.calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
	});

	it("reads every organization's channels in one aliased request", async () => {
		const f = fake(
			json({
				data: {
					o0: [{ id: "c1", organizationId: "o1", name: "a", service: "mastodon", isDisconnected: false, isLocked: true, isQueuePaused: false, metadata: { maxCharacters: 1000 } }],
					o1: [{ id: "c2", organizationId: "o2", name: "b", service: "pinterest", metadata: { boards: [{ serviceId: "b1", name: "Trips" }] } }],
				},
			}),
		);
		const result = await client(f.fetch).channels(["o1", "o2"]);
		expect(f.calls).toHaveLength(1);
		const body = JSON.parse(String(f.calls[0]!.init!.body));
		expect(body.variables).toEqual({ o0: { organizationId: "o1" }, o1: { organizationId: "o2" } });
		expect(result).toMatchObject({
			ok: true,
			data: [
				{ id: "c1", service: "mastodon", isLocked: true, maxCharacters: 1000 },
				{ id: "c2", service: "pinterest", boards: [{ serviceId: "b1", name: "Trips" }] },
			],
		});
	});
});

describe("createPost outcomes", () => {
	it("a created post", async () => {
		const f = fake(json({ data: { createPost: { post: { id: "p1", status: "scheduled", dueAt: "2026-10-04T00:00:00Z" } } } }));
		expect(await client(f.fetch).createPost(input)).toMatchObject({ ok: true, data: { id: "p1", status: "scheduled" } });
	});

	it("a MutationError is a definite refusal with Buffer's message, capped", async () => {
		const f = fake(json({ data: { createPost: { message: "y".repeat(2000) } } }));
		const result = await client(f.fetch).createPost(input);
		expect(result).toMatchObject({ ok: false, kind: "rejected", code: "MUTATION_ERROR" });
		if (!result.ok) expect(result.message).toHaveLength(MAX_ERROR_LENGTH);
	});

	it("a 429 is rate_limited with Retry-After and the RateLimit reading", async () => {
		const f = fake(
			json({ errors: [{ message: "Too many", extensions: { code: "RATE_LIMIT_EXCEEDED" } }] }, 429, {
				"retry-after": "753",
				ratelimit: '"100-in-15min"; r=0; t=753',
				"ratelimit-policy": '"100-in-15min"; q=100; w=900',
			}),
		);
		const result = await client(f.fetch).createPost(input);
		expect(result).toMatchObject({
			ok: false,
			kind: "rate_limited",
			retryAfterSeconds: 753,
			rateLimit: { windows: [{ name: "100-in-15min", remaining: 0, resetSeconds: 753, window: 900, quota: 100 }] },
		});
	});

	it("RATE_LIMIT_EXCEEDED inside a 200 is rate_limited too", async () => {
		const f = fake(json({ errors: [{ message: "slow down", extensions: { code: "RATE_LIMIT_EXCEEDED" } }] }));
		expect(await client(f.fetch).createPost(input)).toMatchObject({ ok: false, kind: "rate_limited", retryAfterSeconds: 60 });
	});

	it("a 5xx, a lost connection, a timeout, UNEXPECTED and unreadable JSON are all uncertain", async () => {
		const results = [
			await client(fake(json({}, 503)).fetch).createPost(input),
			await client(fake(new Error("socket hang up")).fetch).createPost(input),
			await client(fake("hang").fetch, 20).createPost(input),
			await client(fake(json({ errors: [{ message: "x", extensions: { code: "UNEXPECTED" } }] })).fetch).createPost(input),
			await client(fake(new Response("<html>", { status: 200 })).fetch).createPost(input),
		];
		expect(results.map((r) => (r.ok ? "ok" : r.kind))).toEqual(["uncertain", "uncertain", "uncertain", "uncertain", "uncertain"]);
	});

	it("UNAUTHORIZED, FORBIDDEN and a 401 are definite and never mention the key", async () => {
		const results = [
			await client(fake(json({ errors: [{ message: "Not authorized", extensions: { code: "UNAUTHORIZED" } }] })).fetch).createPost(input),
			await client(fake(json({ errors: [{ message: "No", extensions: { code: "FORBIDDEN" } }] })).fetch).createPost(input),
			await client(fake(json({}, 401)).fetch).createPost(input),
		];
		expect(results.map((r) => (r.ok ? "ok" : r.kind))).toEqual(["unauthorized", "forbidden", "unauthorized"]);
		expect(JSON.stringify(results)).not.toContain("secret-key");
	});
});

describe("recent posts", () => {
	it("asks for one channel's posts created since a moment, newest first", async () => {
		const f = fake(json({ data: { posts: { edges: [{ node: { id: "p1", text: "t", status: "sent", channelId: "c1" } }] } } }));
		const result = await client(f.fetch).recentPosts("o1", "c1", "2026-10-02T00:00:00.000Z");
		expect(JSON.parse(String(f.calls[0]!.init!.body)).variables.input).toEqual({
			organizationId: "o1",
			filter: { channelIds: ["c1"], createdAt: { start: "2026-10-02T00:00:00.000Z" } },
			sort: [{ field: "createdAt", direction: "desc" }],
		});
		expect(result).toMatchObject({ ok: true, data: [{ id: "p1", text: "t" }] });
	});
});

describe("configuration hints", () => {
	it("reads the post entry's properties and rules", async () => {
		const f = fake(
			json({
				data: {
					c0: {
						channels: [
							{
								channelId: "c1",
								content: [
									{ configurationContentTypes: ["story"], supportedProperties: ["video"], rules: [] },
									{
										configurationContentTypes: ["post", "reel"],
										supportedProperties: ["text", "image", "linkAttachment"],
										rules: [
											{ __typename: "CountRule", property: "image", min: 1, max: 10 },
											{ __typename: "LengthRule", property: "text", maxLength: 1234 },
											{ __typename: "SomeFutureRule", property: "text" },
										],
									},
								],
							},
						],
					},
				},
			}),
		);
		const result = await client(f.fetch).configurationHints(["o1"]);
		expect(result).toMatchObject({
			ok: true,
			data: { c1: { text: true, image: true, linkAttachment: true, imageRequired: true, textMaxLength: 1234 } },
		});
	});

	it("an unexpected shape gives no hints rather than wrong ones", async () => {
		const f = fake(json({ data: { c0: { channels: [{ channelId: "c1", content: "nope" }, { nothing: true }] } } }));
		expect(await client(f.fetch).configurationHints(["o1"])).toMatchObject({ ok: true, data: {} });
	});

	it("a refused query is a failure the caller can ignore", async () => {
		const f = fake(json({ errors: [{ message: "Cannot query field", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }));
		expect(await client(f.fetch).configurationHints(["o1"])).toMatchObject({ ok: false, kind: "rejected" });
	});
});

describe("headers", () => {
	it("Retry-After as seconds or a date", () => {
		expect(retryAfter(new Headers({ "retry-after": "30" }), NOW)).toBe(30);
		expect(retryAfter(new Headers({ "retry-after": new Date(NOW.getTime() + 90_000).toUTCString() }), NOW)).toBe(90);
		expect(retryAfter(new Headers(), NOW)).toBe(60);
	});

	it("RateLimit windows joined to their policies by name", () => {
		const headers = new Headers();
		headers.append("ratelimit", '"100-in-15min"; r=98; t=897');
		headers.append("ratelimit", '"250-in-1day"; r=248; t=86397');
		headers.append("ratelimit-policy", '"100-in-15min"; q=100; w=900; pk=:abc:');
		headers.append("ratelimit-policy", '"250-in-1day"; q=250; w=86400; pk=:abc:');
		expect(parseRateLimit(headers, NOW)?.windows).toEqual([
			{ name: "100-in-15min", remaining: 98, resetSeconds: 897, window: 900, quota: 100 },
			{ name: "250-in-1day", remaining: 248, resetSeconds: 86397, window: 86400, quota: 250 },
		]);
	});
});
