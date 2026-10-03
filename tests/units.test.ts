import type { PluginContext } from "emdash/plugin";
import { describe, expect, it } from "vitest";

import { engagementOf, engagementRateOf, impressionsOf, metricMap } from "../src/buffer/metrics.js";
import { figuresByDay, periodOf, total } from "../src/report/figures.js";
import { plan } from "../src/sync/aggregates.js";
import { isPublicHostname, publicImageUrl, resolveImage } from "../src/publish/image.js";
import { matchesPost } from "../src/publish/pipeline.js";
import { fitText, measure, renderTemplate } from "../src/publish/text.js";
import { canonicalUrl, withUtm } from "../src/publish/url.js";
import { normaliseTemplate, parseSettings } from "../src/settings.js";
import type { Delivery } from "../src/store/deliveries.js";

const SITE = "https://www.example.com";

describe("templates", () => {
	it("fills the tags and keeps line breaks", () => {
		expect(renderTemplate("{title}\n\n{excerpt}\n\n{url}", { title: "T", excerpt: "E", url: "U" })).toBe("T\n\nE\n\nU");
	});

	it("closes up the gap an empty excerpt leaves, and only that", () => {
		expect(renderTemplate("{title}\n\n{excerpt}\n\n{url}", { title: "T", excerpt: "", url: "U" })).toBe("T\n\nU");
		expect(renderTemplate("{title}\n{url}", { title: "T", excerpt: "", url: "U" })).toBe("T\nU");
	});

	it("a literal \\n in a single-line setting becomes a line break", () => {
		expect(normaliseTemplate("{title}\\n{url}")).toBe("{title}\n{url}");
		expect(parseSettings(new Map()).defaultTemplate).toBe("{title}\n\n{excerpt}\n\n{url}");
	});
});

describe("counting like Buffer (character-limits.md)", () => {
	const url = "https://www.example.com/blog/a-very-long-slug-indeed";
	it("UTF-16 units: an emoji is two", () => expect(measure("🚀", "utf16")).toBe(2));
	it("LinkedIn: every URL is 24", () => expect(measure(`a ${url}`, "linkedin")).toBe(2 + 24));
	it("Mastodon: every URL is 23", () => expect(measure(`a ${url}`, "mastodon")).toBe(2 + 23));
	it("Instagram: a line break is 2", () => expect(measure("a\nb", "instagram")).toBe(4));
	it("X: URLs 23, emoji 2", () => expect(measure(`🚀 ${url}`, "twitter")).toBe(2 + 1 + 23));
	it("Bluesky: graphemes, URL is host plus up to 16", () => {
		expect(measure("👨‍👩‍👧", "bluesky")).toBe(1);
		expect(measure(url, "bluesky")).toBe("www.example.com".length + 16);
	});
});

describe("fitting", () => {
	it("leaves text that fits alone", () => {
		expect(fitText("{title} {url}", { title: "T", excerpt: "", url: "U" }, { max: 10, count: "utf16" })).toEqual({ ok: true, text: "T U", shortened: false });
	});

	it("never cuts the title or the URL", () => {
		const result = fitText("{title} {excerpt} {url}", { title: "A long title", excerpt: "x", url: "https://e.com/a" }, { max: 5, count: "utf16" });
		expect(result.ok).toBe(false);
	});

	it("drops the excerpt entirely before giving up", () => {
		const result = fitText("{title}\n\n{excerpt}\n\n{url}", { title: "Title", excerpt: "lorem ipsum ".repeat(20), url: "U" }, { max: 9, count: "utf16" });
		expect(result).toEqual({ ok: true, text: "Title\n\nU", shortened: true });
	});
});

describe("links", () => {
	it("an absolute canonical as is, a path joined to the site", () => {
		expect(canonicalUrl("https://other.example.org/x", SITE)).toBe("https://other.example.org/x");
		expect(canonicalUrl("/blog/x", SITE)).toBe(`${SITE}/blog/x`);
		expect(canonicalUrl("blog/x", SITE)).toBe(`${SITE}/blog/x`);
		expect(canonicalUrl("javascript:alert(1)", SITE)).toBe(`${SITE}/javascript:alert(1)`);
		expect(canonicalUrl("", SITE)).toBeNull();
	});

	it("UTM tags respect the query and are not added twice", () => {
		const utm = { enabled: true, source: "buffer", medium: "social" };
		expect(withUtm(`${SITE}/a?x=1#top`, utm, { service: "linkedin", name: "L" })).toBe(`${SITE}/a?x=1&utm_source=buffer&utm_medium=social&utm_campaign=linkedin#top`);
		const once = withUtm(`${SITE}/a`, utm, { service: "bluesky", name: "B" });
		expect(withUtm(once, utm, { service: "bluesky", name: "B" })).toBe(once);
		expect(withUtm(`${SITE}/a`, { ...utm, enabled: false }, { service: "x", name: "y" })).toBe(`${SITE}/a`);
		expect(withUtm(`${SITE}/a`, utm, { service: "unknown", name: "My Page!" })).toContain("utm_campaign=my-page");
	});
});

describe("image URLs Buffer may be given", () => {
	it("https on the site's own host", () => expect(publicImageUrl(`${SITE}/img.jpg`, SITE)).toBe(`${SITE}/img.jpg`));
	it("not http", () => expect(publicImageUrl("http://www.example.com/img.jpg", SITE)).toBeNull());
	it("not another host, unless it is a media provider's src", () => {
		expect(publicImageUrl("https://cdn.example.net/i.jpg", SITE)).toBeNull();
		expect(publicImageUrl("https://cdn.example.net/i.jpg", SITE, { providerSrc: true })).toBe("https://cdn.example.net/i.jpg");
	});
	it("never private", () => {
		for (const host of ["127.0.0.1", "10.0.0.5", "[::1]", "localhost", "nas.local", "intranet", "printer.internal", "0x7f000001", "192.168.1.1"]) {
			expect(publicImageUrl(`https://${host}/i.jpg`, `https://${host}`, { providerSrc: true }), host).toBeNull();
		}
		expect(isPublicHostname("www.example.com")).toBe(true);
	});
	it("no credentials in the URL", () => expect(publicImageUrl("https://u:p@www.example.com/i.jpg", SITE)).toBeNull());
});

describe("resolving the entry's image", () => {
	const media = (item: unknown) => ({ media: { get: async () => item } }) as unknown as Pick<PluginContext, "media">;
	const local = { id: "m1", filename: "a.jpg", mimeType: "image/jpeg", size: 1, url: "/_emdash/api/media/asset/m1/a.jpg", createdAt: "", alt: "Alt" };

	it("a local image field through the media library", async () => {
		expect(await resolveImage(media(local), { kind: "field", field: "cover" }, { data: { cover: { id: "m1" } } }, SITE)).toEqual({
			ok: true,
			url: `${SITE}/_emdash/api/media/asset/m1/a.jpg`,
			alt: "Alt",
		});
	});

	it("a bare string in an image field is looked up as an id, never used as a URL", async () => {
		const missing = await resolveImage(media(null), { kind: "field", field: "cover" }, { data: { cover: "https://evil.example.net/x.jpg" } }, SITE);
		expect(missing).toEqual({ ok: false, reason: "notFound" });
	});

	it("a provider's absolute https src", async () => {
		const result = await resolveImage(media(null), { kind: "field", field: "cover" }, { data: { cover: { id: "u1", provider: "unsplash", src: "https://images.unsplash.com/p.jpg", alt: "Hill" } } }, SITE);
		expect(result).toEqual({ ok: true, url: "https://images.unsplash.com/p.jpg", alt: "Hill" });
	});

	it("the SEO image as a path, an absolute URL on the site, or a media id", async () => {
		expect(await resolveImage(media(null), { kind: "seo" }, { data: {}, seo: { image: "/_emdash/api/media/file/k.jpg" } }, SITE)).toMatchObject({ ok: true, url: `${SITE}/_emdash/api/media/file/k.jpg` });
		expect(await resolveImage(media(null), { kind: "seo" }, { data: {}, seo: { image: "https://elsewhere.example.net/k.jpg" } }, SITE)).toEqual({ ok: false, reason: "notPublic" });
		expect(await resolveImage(media(local), { kind: "seo" }, { data: {}, seo: { image: "m1" } }, SITE)).toMatchObject({ ok: true });
	});

	it("a media item that is not an image is not sent", async () => {
		expect(await resolveImage(media({ ...local, mimeType: "application/pdf" }), { kind: "field", field: "cover" }, { data: { cover: { id: "m1" } } }, SITE)).toEqual({ ok: false, reason: "notFound" });
	});
});

describe("matching an uncertain create to Buffer's posts", () => {
	const row = { text: "Hello world\n\nA long enough excerpt here.\n\nhttps://www.example.com/blog/hello" } as Delivery;
	it("the same text, whitespace aside", () => expect(matchesPost(row, { text: row.text.replace(/\n/g, " ") } as never)).toBe(true));
	it("the same text with a shortened link", () =>
		expect(matchesPost(row, { text: "Hello world\n\nA long enough excerpt here.\n\nhttps://buff.ly/abc" } as never)).toBe(true));
	it("another post", () => expect(matchesPost(row, { text: "Something else entirely, https://www.example.com/blog/hello" } as never)).toBe(false));
});

describe("Buffer metrics", () => {
	it("keeps a missing metric missing and a reported zero as zero", () => {
		const map = metricMap([
			{ type: "reactions", value: 0, unit: "count" },
			{ type: "impressions", value: "12" },
			{ value: 3 },
		]);
		expect(map).toEqual({ reactions: 0 });
		expect(engagementOf(map)).toBe(0);
		expect(impressionsOf(map)).toBeUndefined();
		expect(engagementOf({ impressions: 40, clicks: 3, likes: 2 })).toBeUndefined();
		expect(engagementOf(null)).toBeUndefined();
		expect(metricMap(null)).toBeNull();
	});

	it("adds the engagement types and never counts Facebook likes twice", () => {
		expect(engagementOf({ reactions: 5, likes: 4, comments: 2, shares: 1, reposts: 1, saves: 1, quotes: 1, clicks: 50 })).toBe(11);
		expect(engagementRateOf({ engagementRate: 4.2 })).toBe(4.2);
	});
});

describe("report figures", () => {
	const now = new Date("2026-10-03T12:00:00.000Z");

	it("leaves out days Buffer has not read and sums impressions only where reported", () => {
		const agg = {
			days: {
				a: {
					"2026-10-03": { posts: 1, metrics: { reactions: 2, impressions: 10 }, metricsUpdatedAt: "2026-10-03T01:00:00Z" },
					"2026-10-02": { posts: 1, metrics: { reactions: 0, comments: 0 }, metricsUpdatedAt: null },
				},
				b: { "2026-10-03": { posts: 2, metrics: { reactions: 1 }, metricsUpdatedAt: "2026-10-03T01:00:00Z" } },
			},
			ranges: {},
			progress: {},
		};
		const { current } = periodOf(7, now);
		expect(figuresByDay(agg, ["a", "b"], current)).toEqual([{ day: "2026-10-03", engagement: 3, impressions: 10 }]);
		expect(total(figuresByDay(agg, ["b"], current), "impressions")).toBeUndefined();
	});

	it("plans the last 30 days first, then the ranges, then older days, newest first", () => {
		const windows = plan({ days: {}, ranges: {}, progress: { c: { recentOn: "2026-10-03", backTo: "2026-09-04" } } }, [{ id: "c", organizationId: "o" }], "2026-10-03");
		expect(windows.slice(0, 4).map((w) => [w.kind, w.window.key])).toEqual([
			["range", "7"],
			["range", "30"],
			["range", "90"],
			["backfill", "2026-09-03"],
		]);
		expect(windows.at(-1)?.window.key).toBe("2026-04-07");
		expect(plan({ days: {}, ranges: {}, progress: {} }, [{ id: "c", organizationId: "o" }], "2026-10-03")[0]).toMatchObject({ kind: "recent", window: { start: "2026-10-03T00:00:00Z", end: "2026-10-03T23:59:59Z" } });
	});
});
