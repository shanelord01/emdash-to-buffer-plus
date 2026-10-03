import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelCache, PluginConfig } from "../src/store/kv.js";
import { SETUP_ACTION } from "../src/ui/analytics.js";
import { CHANNEL_ACTION_PREFIX, COLLECTIONS_ACTION, DISCOVER_ACTION, PAGE_PATH, RETRY_ACTION, UTM_ACTION } from "../src/ui/page.js";
import {
	allOn,
	channel,
	deliveries,
	expectValid,
	json,
	newHost,
	postsCollection,
	respond,
	seedChannels,
	seedConfig,
	seedDelivery,
	sentBodies,
} from "./host.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const text = (response: unknown) => JSON.stringify(response);

const discovery = {
	orgs: () => json({ data: { account: { organizations: [{ id: "org1", name: "Org" }] } } }),
	channels: () =>
		json({
			data: {
				o0: [
					{ id: "c1", organizationId: "org1", name: "li", displayName: "My LinkedIn", service: "linkedin", isDisconnected: false, isLocked: false, isQueuePaused: true },
					{ id: "c2", organizationId: "org1", name: "pin", service: "pinterest", isDisconnected: false, isLocked: false, isQueuePaused: false, metadata: { boards: [{ serviceId: "b1", name: "Trips" }] } },
				],
			},
		}),
	limits: () => json({ data: { l0: [{ channelId: "c1", isAtLimit: true, limit: 10, scheduled: 10, sent: 0 }] } }),
};

describe("the setup section", () => {
	it("without a key, says where to put one and offers no Discover", async () => {
		host = await newHost({ token: false });
		const response = await host.admin.act(PAGE_PATH, SETUP_ACTION);
		expectValid(response);
		expect(text(response)).toContain("Buffer API key: not set");
		expect(text(response)).toContain("plugin-settings");
		expect(text(response)).not.toContain(DISCOVER_ACTION);
	});

	it("opens with channels, collections and forms, and the analytics load schedules the sync", async () => {
		host = await newHost();
		await postsCollection(host);
		await seedChannels(host, [channel("c1", "linkedin"), channel("c2", "youtube")]);
		expectValid(await host.admin.loadPage(PAGE_PATH));
		const response = await host.admin.act(PAGE_PATH, SETUP_ACTION, { value: 7 });
		expectValid(response);
		const body = text(response);
		expect(body).toContain("Buffer API key: set.");
		expect(body).toContain(`${CHANNEL_ACTION_PREFIX}c1`);
		expect(body).not.toContain(`${CHANNEL_ACTION_PREFIX}c2`);
		expect(body).toContain("This service takes video only.");
		expect(body).toContain(COLLECTIONS_ACTION);
		expect(body).toContain('"initial_value":"cover"');
		// The way back keeps the range the editor came from.
		expect(body).toContain('"action_id":"buffer:analytics","label":"Back to analytics","style":"secondary","value":7');
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("sync");
	});

	it("Discover stores channels, limits and Buffer's configuration hints, and the page shows where each rule came from", async () => {
		host = await newHost();
		await respond(
			host,
			discovery.orgs(),
			discovery.channels(),
			discovery.limits(),
			json({
				data: {
					c0: {
						channels: [
							{
								channelId: "c1",
								content: [{ configurationContentTypes: ["post"], supportedProperties: ["text", "image", "linkAttachment"], rules: [{ __typename: "LengthRule", property: "text", maxLength: 2999 }] }],
							},
						],
					},
				},
			}),
		);

		const response = await host.admin.act(PAGE_PATH, DISCOVER_ACTION);

		expectValid(response);
		expect(response.toast).toMatchObject({ type: "success", message: "Found 2 channels." });
		const cache = await host.inspect.kv.get<ChannelCache>("channels");
		expect(cache?.channels.map((c) => c.id)).toEqual(["c1", "c2"]);
		expect(cache?.hints?.c1).toMatchObject({ textMaxLength: 2999, linkAttachment: true });
		const body = text(response);
		expect(body).toContain("2999 characters (from Buffer)");
		expect(body).toContain("Queue paused, At daily limit");
		expect(body).toContain("Choose a Pinterest board for this channel.");
		expect(body).toContain('"action_id":"board"');
		expect(sentBodies(host).map((b) => b.query.match(/query (\w+)/)?.[1])).toEqual(["Organizations", "Channels", "DailyLimits", "Configuration"]);
	});

	it("a failing configuration query leaves the documented rules in place", async () => {
		host = await newHost();
		await respond(host, discovery.orgs(), discovery.channels(), discovery.limits(), json({ errors: [{ message: "Cannot query field configuration", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }));

		const response = await host.admin.act(PAGE_PATH, DISCOVER_ACTION);

		expectValid(response);
		expect(response.toast).toMatchObject({ type: "success" });
		const cache = await host.inspect.kv.get<ChannelCache>("channels");
		expect(cache?.hints).toBeUndefined();
		expect(text(response)).toContain("did not answer when the channels were read");
		expect(text(response)).toContain("every rule is Buffer's documented default");
		expect(text(response)).toContain("3000 characters (documented)");
		expect(text(response)).not.toContain("from Buffer)");
	});

	it("a refused key keeps the last channels and says what happened", async () => {
		host = await newHost();
		await seedChannels(host, [channel("c1", "linkedin")]);
		await respond(host, json({ errors: [{ message: "Not authorized", extensions: { code: "UNAUTHORIZED" } }] }));

		const response = await host.admin.act(PAGE_PATH, DISCOVER_ACTION);

		expectValid(response);
		expect(response.toast).toMatchObject({ type: "error" });
		expect(text(response)).toContain("Not authorized");
		expect((await host.inspect.kv.get<ChannelCache>("channels"))?.channels).toHaveLength(1);
	});
});

describe("saving", () => {
	it("a channel's settings, keeping only a board Buffer listed", async () => {
		host = await newHost();
		await seedChannels(host, [channel("c2", "pinterest", { boards: [{ serviceId: "b1", name: "Trips" }] })]);

		const response = await host.admin.submit(PAGE_PATH, `${CHANNEL_ACTION_PREFIX}c2`, {
			enabled: true,
			mode: "shareNext",
			attach: "image",
			board: "b1",
			template: "{title}\r\n{url}",
		});

		expectValid(response);
		expect(response.toast).toMatchObject({ type: "success" });
		const config = await host.inspect.kv.get<PluginConfig>("config");
		expect(config?.channels.c2).toEqual({ enabled: true, mode: "shareNext", attach: "image", boardServiceId: "b1", template: "{title}\n{url}" });

		await host.admin.submit(PAGE_PATH, `${CHANNEL_ACTION_PREFIX}c2`, { enabled: true, mode: "bogus", board: "not-listed" });
		expect((await host.inspect.kv.get<PluginConfig>("config"))?.channels.c2).toMatchObject({ mode: "shareNext", boardServiceId: "b1" });
	});

	it("the collections, with each one's image source and title field", async () => {
		host = await newHost();
		await postsCollection(host);
		const response = await host.admin.submit(PAGE_PATH, COLLECTIONS_ACTION, { collections: ["posts", "nope"], image_posts: "seo" });
		expectValid(response);
		expect((await host.inspect.kv.get<PluginConfig>("config"))?.collections).toEqual({
			posts: { enabled: true, image: "seo", label: "Posts", ...(await titleField(host)) },
		});
	});

	it("the UTM tags", async () => {
		host = await newHost();
		const response = await host.admin.submit(PAGE_PATH, UTM_ACTION, { utm: true, source: "  bluesky-feed ", medium: "" });
		expectValid(response);
		expect((await host.inspect.kv.get<PluginConfig>("config"))?.utm).toEqual({ enabled: true, source: "bluesky-feed", medium: "social" });
	});

	it("Retry puts failed deliveries back and schedules a run", async () => {
		host = await newHost();
		await seedDelivery(host, "f1", { status: "failed", error: "nope", errorKind: "rejected" });
		await seedDelivery(host, "f2", { status: "failed", error: "?", errorKind: "unconfirmed" });

		const before = await host.admin.loadPage(PAGE_PATH);
		expect(text(before)).toContain("2 deliveries failed.");
		const response = await host.admin.act(PAGE_PATH, RETRY_ACTION);

		expectValid(response);
		const byId = Object.fromEntries((await deliveries(host)).map((d) => [d.error, d.status]));
		expect(byId).toEqual({ nope: "pending", "?": "unknown" });
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("deliver-a");
	});
});

describe("permissions", () => {
	it("an editor sees the page but cannot change anything", async () => {
		host = await newHost();
		await seedChannels(host, [channel("c1", "linkedin")]);
		await seedConfig(host, { channels: allOn([channel("c1", "linkedin")]) });
		const editor = await host.fixtures.user({ email: "ed@example.com", role: "editor" });

		expectValid(await host.admin.loadPage(PAGE_PATH, { user: editor }));
		const page = await host.admin.act(PAGE_PATH, SETUP_ACTION, { user: editor });
		expectValid(page);
		expect(text(page)).toContain("Buffer API key: set.");
		expect(text(page)).not.toContain(CHANNEL_ACTION_PREFIX);
		expect(text(page)).not.toContain(DISCOVER_ACTION);

		const response = await host.admin.submit(PAGE_PATH, `${CHANNEL_ACTION_PREFIX}c1`, { enabled: false }, { user: editor });
		expectValid(response);
		expect(response.toast).toMatchObject({ type: "error", message: "Only administrators can change this." });
		expect((await host.inspect.kv.get<PluginConfig>("config"))?.channels.c1?.enabled).toBe(true);
	});
});

/** The posts fixture's title field as the schema reports it, which the save copies. */
async function titleField(runtime: PluginRuntimeTestHost) {
	const schema = await runtime.inspect.schema();
	const posts = (schema as Array<{ slug: string; titleField?: string | null }>).find((c) => c.slug === "posts");
	return posts?.titleField ? { titleField: posts.titleField } : {};
}
