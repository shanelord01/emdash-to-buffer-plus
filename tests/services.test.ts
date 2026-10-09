import type { PluginContext } from "emdash/plugin";
import { describe, expect, it } from "vitest";

import type { BufferChannel } from "../src/buffer/client.js";
import { ruleFor, SERVICE_RULES, SKIP_REASONS, textLimit, type ChannelHints } from "../src/buffer/services.js";
import { createInput } from "../src/publish/pipeline.js";
import { prepareDeliveries, type EntryRef } from "../src/publish/prepare.js";
import { parseSettings } from "../src/settings.js";
import type { Delivery } from "../src/store/deliveries.js";
import { emptyConfig, type ChannelCache, type ChannelConfig, type PluginConfig } from "../src/store/kv.js";

/**
 * The createPost input built for every service, and every skip reason,
 * through the same functions the hooks use. Rules come from
 * developers.buffer.com (reference.md, hosting-media.md, character-limits.md);
 * the expectations below restate Buffer's documented requirements, not this
 * plugin's table.
 */

const SITE = "https://www.example.com";
const NOW = new Date("2026-10-03T00:00:00.000Z");
const IMAGE_URL = `${SITE}/_emdash/api/media/file/k1.jpg`;

function fakeCtx(opts: { publicUrl?: string | null; image?: boolean } = {}): PluginContext {
	return {
		site: { url: SITE, name: "Site", locale: "en" },
		content: { getPublicUrl: async () => (opts.publicUrl === undefined ? `${SITE}/blog/hello` : opts.publicUrl) },
	} as unknown as PluginContext;
}

function entry(excerpt = "A short excerpt.", cover: Record<string, unknown> = {}): EntryRef {
	return {
		collection: "posts",
		id: "e1",
		status: "published",
		publishedAt: NOW.toISOString(),
		slug: "hello",
		data: { title: "Hello world", excerpt, cover: { id: "m1", provider: "local", alt: "A road", meta: { storageKey: "k1.jpg" }, ...cover } },
	};
}

function chan(service: string, extra: Partial<BufferChannel> = {}): BufferChannel {
	return {
		id: `ch-${service}`,
		organizationId: "o1",
		name: service,
		displayName: null,
		service,
		avatar: null,
		isDisconnected: false,
		isLocked: false,
		isQueuePaused: false,
		...extra,
	};
}

async function prepare(
	channel: BufferChannel,
	cfg: Partial<ChannelConfig> = {},
	opts: {
		excerpt?: string;
		publicUrl?: string | null;
		image?: boolean;
		hints?: ChannelHints;
		template?: string;
		overrides?: { skip?: string[]; text?: Record<string, string> };
		cover?: Record<string, unknown>;
	} = {},
): Promise<Delivery> {
	const config: PluginConfig = {
		...emptyConfig(),
		channels: { [channel.id]: { enabled: true, mode: "addToQueue", attach: "image", ...cfg } },
		collections: { posts: { enabled: true, image: opts.image === false ? "none" : "cover", titleField: "title" } },
	};
	const cache: ChannelCache = {
		fetchedAt: NOW.toISOString(),
		organizations: [],
		channels: [channel],
		limits: [],
		...(opts.hints && { hints: { [channel.id]: opts.hints } }),
	};
	const settings = parseSettings(new Map(opts.template ? [["defaultTemplate", opts.template]] : []));
	const rows = await prepareDeliveries(fakeCtx(opts), {
		entry: entry(opts.excerpt, opts.cover),
		settings,
		config,
		channels: cache,
		now: NOW,
		...(opts.overrides && { overrides: opts.overrides }),
	});
	expect(rows).toHaveLength(1);
	return rows[0]!.data;
}

const TEXT = `Hello world\n\nA short excerpt.\n\n${SITE}/blog/hello`;

describe("the createPost input for each service", () => {
	it("bluesky: no required metadata; a link card carries the image as its thumbnail and no asset", async () => {
		const row = await prepare(chan("bluesky"), { attach: "link" });
		expect(createInput(row)).toEqual({
			channelId: "ch-bluesky",
			text: TEXT,
			schedulingType: "automatic",
			mode: "addToQueue",
			assets: [],
			metadata: {
				bluesky: {
					linkAttachment: { url: `${SITE}/blog/hello`, title: "Hello world", description: "A short excerpt.", thumbnail: { url: IMAGE_URL } },
				},
			},
		});
	});

	it("facebook: type post is always sent; an image is an asset with alt text", async () => {
		const input = createInput(await prepare(chan("facebook")));
		expect(input.metadata).toEqual({ facebook: { type: "post" } });
		expect(input.assets).toEqual([{ image: { url: IMAGE_URL, metadata: { altText: "A road" } } }]);
	});

	it("facebook with a link card keeps type post beside the card", async () => {
		const input = createInput(await prepare(chan("facebook"), { attach: "link" }));
		expect(input.metadata).toMatchObject({ facebook: { type: "post", linkAttachment: { url: `${SITE}/blog/hello` } } });
		expect(input.assets).toEqual([]);
	});

	it("googlebusiness: what's new, with a learn more button to the entry, under the google key", async () => {
		const input = createInput(await prepare(chan("googlebusiness")));
		expect(input.metadata).toEqual({ google: { type: "whats_new", detailsWhatsNew: { button: "learn_more", link: `${SITE}/blog/hello` } } });
	});

	it("instagram: type post and shouldShareToFeed, with the image", async () => {
		const input = createInput(await prepare(chan("instagram")));
		expect(input.metadata).toEqual({ instagram: { type: "post", shouldShareToFeed: true } });
		expect(input.assets).toHaveLength(1);
	});

	it("instagram asked for a link card sends the image instead: no link card is documented there", async () => {
		const input = createInput(await prepare(chan("instagram"), { attach: "link" }));
		expect(JSON.stringify(input.metadata)).not.toContain("linkAttachment");
		expect(input.assets).toHaveLength(1);
	});

	it("linkedin: no metadata with an image; a link card when chosen", async () => {
		expect(createInput(await prepare(chan("linkedin"))).metadata).toBeUndefined();
		expect(createInput(await prepare(chan("linkedin"), { attach: "link" })).metadata).toHaveProperty("linkedin.linkAttachment");
	});

	it("mastodon: no metadata, the server's own limit applies", async () => {
		expect(createInput(await prepare(chan("mastodon"))).metadata).toBeUndefined();
		expect(textLimit("mastodon", 11000)).toEqual({ max: 11000, count: "mastodon" });
		expect(textLimit("mastodon")).toEqual({ max: 500, count: "mastodon" });
		expect(textLimit("mastodon", 50000)?.max).toBe(20000);
	});

	it("pinterest: the chosen board, the entry's link and title on the Pin", async () => {
		const input = createInput(await prepare(chan("pinterest"), { boardServiceId: "board-9" }));
		expect(input.metadata).toEqual({ pinterest: { boardServiceId: "board-9", url: `${SITE}/blog/hello`, title: "Hello world" } });
		expect(input.assets).toHaveLength(1);
	});

	it("substack: link card under the substack key", async () => {
		expect(createInput(await prepare(chan("substack"), { attach: "link" })).metadata).toHaveProperty("substack.linkAttachment.url");
	});

	it("threads: no required metadata; link card supported", async () => {
		expect(createInput(await prepare(chan("threads"))).metadata).toBeUndefined();
		expect(createInput(await prepare(chan("threads"), { attach: "link" })).metadata).toHaveProperty("threads.linkAttachment");
	});

	it("tiktok: image sent, no metadata", async () => {
		const input = createInput(await prepare(chan("tiktok")));
		expect(input.metadata).toBeUndefined();
		expect(input.assets).toHaveLength(1);
	});

	it("twitter: no metadata, no link card even when asked", async () => {
		const input = createInput(await prepare(chan("twitter"), { attach: "link" }));
		expect(input.metadata).toBeUndefined();
		expect(input.assets).toHaveLength(1);
	});

	it("a service Buffer adds later: text with the link in it, no metadata, no image", async () => {
		const row = await prepare(chan("newnetwork"), { attach: "link" });
		const input = createInput(row);
		expect(input.text).toContain(`${SITE}/blog/hello`);
		expect(input.metadata).toBeUndefined();
		expect(input.assets).toEqual([]);
	});

	it("draft mode saves a draft in Buffer", async () => {
		expect(createInput(await prepare(chan("linkedin"), { mode: "draft" }))).toMatchObject({ mode: "addToQueue", saveToDraft: true });
	});

	it("attach none sends no image where one is optional", async () => {
		expect(createInput(await prepare(chan("linkedin"), { attach: "none" })).assets).toEqual([]);
	});

	it("every Service enum value has a rule", () => {
		const enumValues = ["bluesky", "facebook", "googlebusiness", "instagram", "linkedin", "mastodon", "pinterest", "startPage", "substack", "threads", "tiktok", "twitter", "whatsapp", "youtube"];
		expect(Object.keys(SERVICE_RULES).sort()).toEqual([...enumValues].sort());
	});
});

describe("fitting the text", () => {
	it("shortens only the excerpt, with an ellipsis, to the network's limit", async () => {
		const long = "word ".repeat(200).trim();
		const row = await prepare(chan("bluesky"), {}, { excerpt: long });
		expect(row.status).toBe("pending");
		expect(row.shortened).toBe(true);
		expect(row.text.startsWith("Hello world\n\nword")).toBe(true);
		expect(row.text).toContain("…\n\nhttps://www.example.com/blog/hello");
		const graphemes = [...new Intl.Segmenter().segment(row.text.replace(/https:\S+/, ""))].length + "www.example.com".length + 11;
		expect(graphemes).toBeLessThanOrEqual(300);
	});

	it("keeps the line breaks of a custom template", async () => {
		const row = await prepare(chan("linkedin"), { template: "New: {title}\n{url}\n\n\n\n{excerpt}" });
		expect(row.text).toBe(`New: Hello world\n${SITE}/blog/hello\n\nA short excerpt.`);
	});
});

describe("every skip reason", () => {
	const cases: Array<[string, () => Promise<Delivery>]> = [
		["serviceUnsupported", () => prepare(chan("whatsapp"))],
		["videoOnly", () => prepare(chan("youtube"))],
		["needsBoard", () => prepare(chan("pinterest"))],
		["needsImage", () => prepare(chan("instagram"), {}, { image: false })],
		["channelDisconnected", () => prepare(chan("linkedin", { isDisconnected: true }))],
		["channelLocked", () => prepare(chan("linkedin", { isLocked: true }))],
		["textTooLong", () => prepare(chan("twitter"), {}, { template: `${"T".repeat(300)} {url}` })],
		["noUrl", () => prepare(chan("linkedin"), {}, { publicUrl: null })],
		["editorSkipped", () => prepare(chan("linkedin"), {}, { overrides: { skip: ["ch-linkedin"] } })],
		["imageAspect", () => prepare(chan("instagram"), {}, { cover: { width: 3000, height: 1000 } })],
	];

	it("covers the whole list", () => {
		expect(cases.map(([reason]) => reason).sort()).toEqual([...SKIP_REASONS].sort());
	});

	for (const [reason, run] of cases) {
		it(reason, async () => {
			const row = await run();
			expect(row).toMatchObject({ status: "skipped", reason });
			// A shape skip keeps the prepared post, for Send again once the image is changed.
			if (reason === "imageAspect") expect(row.text).toBe(TEXT);
			else expect(row.text).toBe("");
		});
	}

	it("the editor's choice wins over a channel problem, and needs no link lookup", async () => {
		let lookups = 0;
		const ctx = {
			site: { url: SITE },
			content: { getPublicUrl: async () => (lookups++, `${SITE}/blog/hello`) },
		} as unknown as PluginContext;
		const channel = chan("instagram", { isLocked: true });
		const config: PluginConfig = { ...emptyConfig(), channels: { [channel.id]: { enabled: true, mode: "addToQueue", attach: "image" } }, collections: {} };
		const rows = await prepareDeliveries(ctx, {
			entry: entry(),
			settings: parseSettings(new Map()),
			config,
			channels: { fetchedAt: "", organizations: [], channels: [channel], limits: [] },
			now: NOW,
			overrides: { skip: [channel.id] },
		});
		expect(rows[0]!.data).toMatchObject({ status: "skipped", reason: "editorSkipped" });
		expect(lookups).toBe(0);
	});

	it("custom text from the editor replaces the template, placeholders and fitting included", async () => {
		const row = await prepare(chan("bluesky"), { template: "Channel text {url}" }, { excerpt: "word ".repeat(100).trim(), overrides: { text: { "ch-bluesky": "{title}: {excerpt} {url}" } } });
		expect(row.status).toBe("pending");
		expect(row.text.startsWith("Hello world: word")).toBe(true);
		expect(row.shortened).toBe(true);
	});

	it("startPage is unsupported too", async () => {
		expect(await prepare(chan("startPage"))).toMatchObject({ status: "skipped", reason: "serviceUnsupported" });
	});
});

describe("configuration hints", () => {
	it("an image CountRule with min 1 makes the image required", async () => {
		expect(ruleFor("linkedin", { imageRequired: true })).toMatchObject({ image: "needed", origin: { image: "configuration" } });
		expect(await prepare(chan("linkedin"), {}, { image: false, hints: { imageRequired: true } })).toMatchObject({ status: "skipped", reason: "needsImage" });
	});

	it("a LengthRule replaces the documented limit", async () => {
		expect(textLimit("twitter", undefined, { textMaxLength: 25000 })).toEqual({ max: 25000, count: "twitter" });
		const row = await prepare(chan("twitter"), {}, { template: `${"T".repeat(300)} {url}`, hints: { textMaxLength: 25000 } });
		expect(row.status).toBe("pending");
	});

	it("supportedProperties without linkAttachment turns the link card off", async () => {
		const input = createInput(await prepare(chan("linkedin"), { attach: "link" }, { hints: { linkAttachment: false, image: true } }));
		expect(input.metadata).toBeUndefined();
		expect(input.assets).toHaveLength(1);
	});

	it("an unknown service may send an image when its configuration lists image", async () => {
		expect(createInput(await prepare(chan("newnetwork"), {}, { hints: { image: true, text: true } })).assets).toHaveLength(1);
	});

	it("a service whose post takes no text is skipped", async () => {
		expect(await prepare(chan("linkedin"), {}, { hints: { text: false } })).toMatchObject({ status: "skipped", reason: "serviceUnsupported" });
	});

	it("hints never make a documented exclusion postable", () => {
		expect(ruleFor("youtube", { text: true, image: true }).postable).toEqual({ reason: "videoOnly" });
	});

	it("no hints means the documented rule, marked as such", () => {
		expect(ruleFor("bluesky").origin).toEqual({ image: "documented", linkCard: "documented", limit: "documented", text: "documented" });
	});
});

describe("Instagram's image shape", () => {
	it("skips Instagram up front for a known shape outside 4:5 to 1.91:1, keeping the post and the image's size", async () => {
		const row = await prepare(chan("instagram"), {}, { cover: { width: 3000, height: 600 } });
		expect(row).toMatchObject({ status: "skipped", reason: "imageAspect", imageWidth: 3000, imageHeight: 600, imageUrl: IMAGE_URL, url: `${SITE}/blog/hello` });
	});

	it("reads the size from meta as well", async () => {
		const row = await prepare(chan("instagram"), {}, { cover: { meta: { storageKey: "k1.jpg", width: 600, height: 2000 } } });
		expect(row).toMatchObject({ status: "skipped", reason: "imageAspect", imageWidth: 600, imageHeight: 2000 });
	});

	it("1024x536 is 1.9104:1 and skipped; 1023x536 and the exact edges are sent", async () => {
		expect(await prepare(chan("instagram"), {}, { cover: { width: 1024, height: 536 } })).toMatchObject({ status: "skipped", reason: "imageAspect" });
		for (const [width, height] of [[1023, 536], [382, 200], [800, 1000], [1080, 1350], [1024, 768]] as const) {
			const row = await prepare(chan("instagram"), {}, { cover: { width, height } });
			expect(row.status, `${width}x${height}`).toBe("pending");
			expect(createInput(row).assets).toEqual([{ image: { url: IMAGE_URL, metadata: { altText: "A road" } } }]);
		}
	});

	it("sends as before when the size is unknown, or not whole numbers", async () => {
		expect((await prepare(chan("instagram"))).status).toBe("pending");
		expect((await prepare(chan("instagram"), {}, { cover: { width: 3000 } })).status).toBe("pending");
		expect((await prepare(chan("instagram"), {}, { cover: { width: "3000", height: "600" } })).status).toBe("pending");
		expect((await prepare(chan("instagram"), {}, { cover: { width: 3000.5, height: 600 } })).status).toBe("pending");
	});

	it("leaves every other network alone", async () => {
		for (const service of ["facebook", "threads", "bluesky", "linkedin", "tiktok"]) {
			const row = await prepare(chan(service), {}, { cover: { width: 3000, height: 600 } });
			expect(row.reason, service).not.toBe("imageAspect");
			expect(row.imageUrl, service).toBe(IMAGE_URL);
		}
	});

	it("leaves an Instagram channel alone when Buffer's configuration says it takes no image", async () => {
		const row = await prepare(chan("instagram"), {}, { cover: { width: 3000, height: 600 }, hints: { image: false } });
		expect(row.reason).not.toBe("imageAspect");
	});
});
