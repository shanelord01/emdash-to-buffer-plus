import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OVERRIDES } from "../src/store/overrides.js";
import { PANEL_AGAIN_ACTION, PANEL_ID, PANEL_RETRY_ACTION, PANEL_SAVE_ACTION } from "../src/ui/panel.js";
import {
	allOn,
	channel,
	created,
	deliveries,
	expectValid,
	HOUR,
	mutationError,
	newHost,
	NOW,
	postsCollection,
	publishedPost,
	respond,
	seedChannels,
	seedConfig,
	seedDelivery,
	seedState,
	sentBodies,
	watching,
} from "./host.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const text = (response: unknown) => JSON.stringify(response);

type AnyBlock = Record<string, unknown> & { type: string };

function find(blocks: unknown, type: string): AnyBlock[] {
	const out: AnyBlock[] = [];
	const walk = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === "object") {
			const record = value as AnyBlock;
			if (record.type === type) out.push(record);
			Object.values(record).forEach(walk);
		}
	};
	walk(blocks);
	return out;
}

const LI = channel("c1", "linkedin");
const FB = channel("c2", "facebook");
const YT = channel("c3", "youtube");

/** A shared posts collection, three channels on (one of them video only), a saved entry. */
async function setup(opts: { collectionOn?: boolean } = {}) {
	const runtime = await newHost();
	await postsCollection(runtime);
	await seedChannels(runtime, [LI, FB, YT]);
	await seedConfig(runtime, {
		channels: allOn([LI, FB, YT], { attach: "none" }),
		collections: { posts: { enabled: opts.collectionOn !== false, image: "none", titleField: "title" } },
	});
	await seedState(runtime, watching);
	const post = await publishedPost(runtime);
	return { runtime, ...post };
}

async function editor(runtime: PluginRuntimeTestHost) {
	return await runtime.fixtures.user({ email: "editor@example.test", role: "editor" });
}

describe("a collection the plugin does not share from", () => {
	it("says so and links to the Buffer page", async () => {
		const { runtime, id } = await setup({ collectionOn: false });
		host = runtime;
		const response = await host.admin.loadEditorPanel(PANEL_ID, "posts", id);
		expectValid(response);
		expect(text(response)).toContain("not shared to Buffer");
		expect(text(response)).toContain('"kind":"plugin-page","path":"/buffer"');
		expect(find(response.blocks, "form")).toHaveLength(0);
	});
});

describe("before the entry's first send", () => {
	it("offers a toggle and a text field per channel that can take it, and names the one that cannot", async () => {
		const { runtime, id } = await setup();
		host = runtime;
		const response = await host.admin.loadEditorPanel(PANEL_ID, "posts", id);
		expectValid(response);
		const fields = (find(response.blocks, "form")[0]!.fields as Array<Record<string, unknown>>).map((f) => f.action_id);
		expect(fields).toEqual(["send_c1", "text_c1", "send_c2", "text_c2"]);
		expect(text(response)).toContain("This service takes video only");
		// The text field shows the network's limit.
		expect(text(response)).toContain("up to 3,000 characters");
	});

	it("saves the editor's choices, and the publish hook sends with them", async () => {
		const { runtime, id, event } = await setup();
		host = runtime;
		const saved = await host.admin.submitEditorPanel(PANEL_ID, "posts", id, PANEL_SAVE_ACTION, {
			send_c1: true,
			text_c1: "Custom for LinkedIn: {title}\n{url}",
			send_c2: false,
			text_c2: "never used",
		});
		expectValid(saved);
		expect(saved.toast).toMatchObject({ type: "success" });
		// The form comes back with what was saved.
		expect(text(saved)).toContain("Custom for LinkedIn");

		await respond(host, created("p1"));
		await host.transport.invokeHook("content:afterPublish", event);

		const bodies = sentBodies(host);
		expect(bodies).toHaveLength(1);
		expect((bodies[0]!.variables.input as Record<string, unknown>).text).toBe("Custom for LinkedIn: Hello world\nhttps://www.example.com/blog/hello");
		const rows = await deliveries(host);
		expect(rows.find((r) => r.channelId === "c2")).toMatchObject({ status: "skipped", reason: "editorSkipped" });
	});

	it("refuses to save once the entry has gone to Buffer", async () => {
		const { runtime, id } = await setup();
		host = runtime;
		await seedDelivery(host, `posts:${id}:c1`, { entryId: id, status: "sent", postId: "p1" });
		const response = await host.admin.submitEditorPanel(PANEL_ID, "posts", id, PANEL_SAVE_ACTION, { send_c1: false });
		expect(response.toast).toMatchObject({ type: "error" });
		expect(await host.inspect.storage.list(OVERRIDES)).toHaveLength(0);
	});

	it("says when no key is set", async () => {
		host = await newHost({ token: false });
		await postsCollection(host);
		await seedConfig(host, { collections: { posts: { enabled: true, image: "none" } } });
		const { id } = await publishedPost(host);
		const response = await host.admin.loadEditorPanel(PANEL_ID, "posts", id);
		expectValid(response);
		expect(text(response)).toContain("No Buffer API key is set");
	});
});

describe("after the entry went to Buffer", () => {
	async function sent() {
		const { runtime, id } = await setup();
		await seedDelivery(runtime, `posts:${id}:c1`, {
			entryId: id,
			channelName: "My LinkedIn",
			status: "sent",
			postId: "p1",
			postStatus: "sent",
			sentAt: "2026-10-03T01:30:00.000Z",
			externalLink: "https://www.linkedin.com/feed/update/p1",
		});
		await seedDelivery(runtime, `posts:${id}:c2`, {
			entryId: id,
			channelId: "c2",
			channelName: "My Facebook",
			service: "facebook",
			status: "failed",
			error: "The channel needs to be reconnected.",
		});
		await seedDelivery(runtime, `posts:${id}:c3`, { entryId: id, channelId: "c3", channelName: "My YouTube", service: "youtube", status: "skipped", reason: "videoOnly", text: "" });
		return { runtime, id };
	}

	it("shows each channel's state, the live post, Buffer's reason, Retry and Send again", async () => {
		const { runtime, id } = await sent();
		host = runtime;
		const response = await host.admin.loadEditorPanel(PANEL_ID, "posts", id);
		expectValid(response);
		const body = text(response);
		expect(body).toContain("My LinkedIn (linkedin): posted 3 Oct 2026, 1:30 am UTC");
		expect(body).toContain("https://www.linkedin.com/feed/update/p1");
		expect(body).toContain("My Facebook (facebook): failed");
		expect(body).toContain("Buffer said: The channel needs to be reconnected.");
		expect(body).toContain("My YouTube (youtube): not sent");
		expect(body).toContain("This service takes video only.");
		const buttons = find(response.blocks, "button");
		expect(buttons.map((b) => [b.action_id, b.value])).toEqual([
			[PANEL_RETRY_ACTION, `posts:${id}:c2`],
			[PANEL_AGAIN_ACTION, `posts:${id}:c1`],
		]);
		// Send again asks first.
		expect(buttons[1]!.confirm).toMatchObject({ title: "Send this post again?", style: "danger" });
	});

	it("shows a queued post with its time", async () => {
		const { runtime, id } = await setup();
		host = runtime;
		await seedDelivery(host, `posts:${id}:c1`, { entryId: id, status: "sent", postId: "p1", postStatus: "scheduled", dueAt: "2026-10-04T00:00:00.000Z" });
		const response = await host.admin.loadEditorPanel(PANEL_ID, "posts", id);
		expect(text(response)).toContain("queued in Buffer for 4 Oct 2026, 12:00 am UTC");
	});

	it("gives editors the states without Retry or Send again, and refuses the actions", async () => {
		const { runtime, id } = await sent();
		host = runtime;
		const user = await editor(host);
		const response = await host.admin.loadEditorPanel(PANEL_ID, "posts", id, { user });
		expectValid(response);
		expect(find(response.blocks, "button")).toHaveLength(0);

		const again = await host.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_AGAIN_ACTION, { user, value: `posts:${id}:c1` });
		expect(again.toast).toMatchObject({ type: "error", message: "Only administrators can change this." });
		expect(host.http.requests()).toHaveLength(0);
	});

	it("Retry puts the failed post back and schedules a run", async () => {
		const { runtime, id } = await sent();
		host = runtime;
		const response = await host.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_RETRY_ACTION, { value: `posts:${id}:c2` });
		expectValid(response);
		expect(response.toast).toMatchObject({ type: "success" });
		expect((await deliveries(host)).find((d) => d.channelId === "c2")?.status).toBe("pending");
		expect((await host.inspect.scheduledTasks()).map((t) => t.name)).toContain("deliver-a");
		expect(text(response)).toContain("My Facebook (facebook): waiting to be sent");
	});

	it("Send again posts the same text as a new delivery and keeps the first", async () => {
		const { runtime, id } = await sent();
		host = runtime;
		await respond(host, created("p2"));
		const response = await host.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_AGAIN_ACTION, { value: `posts:${id}:c1` });
		expectValid(response);
		expect(response.toast).toMatchObject({ type: "success", message: "Sent to Buffer again." });
		const input = sentBodies(host)[0]!.variables.input as Record<string, unknown>;
		expect(input).toMatchObject({ channelId: "c1", text: "Hello world\n\nA short excerpt.\n\nhttps://www.example.com/blog/hello" });
		const linkedin = (await deliveries(host)).filter((d) => d.channelId === "c1");
		expect(linkedin.map((d) => d.postId).sort()).toEqual(["p1", "p2"]);
		expect(text(response)).toContain("Sent 2 times to this channel.");
	});

	it("Send again reports Buffer's refusal", async () => {
		const { runtime, id } = await sent();
		host = runtime;
		await respond(host, mutationError("Text is too long"));
		const response = await host.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_AGAIN_ACTION, { value: `posts:${id}:c1` });
		expect(response.toast).toMatchObject({ type: "error", message: "Buffer did not take the post: Text is too long" });
	});

	it("Send again refuses while a send to the channel is under way, so a double press posts once", async () => {
		const { runtime, id } = await sent();
		host = runtime;
		await seedDelivery(host, `posts:${id}:c1:later`, {
			entryId: id,
			status: "pending",
			createdAt: new Date(NOW.getTime() - HOUR).toISOString(),
		});
		const response = await host.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_AGAIN_ACTION, { value: `posts:${id}:c1` });
		expect(response.toast).toMatchObject({ type: "error" });
		expect(host.http.requests()).toHaveLength(0);
	});

	it("Send again is not offered for a delivery Buffer never took", async () => {
		const { runtime, id } = await sent();
		host = runtime;
		const response = await host.admin.actEditorPanel(PANEL_ID, "posts", id, PANEL_AGAIN_ACTION, { value: `posts:${id}:c3` });
		expect(response.toast).toMatchObject({ type: "error" });
		expect(host.http.requests()).toHaveLength(0);
	});
});
