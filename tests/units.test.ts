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
	const field = { kind: "field", field: "cover" } as const;
	const KEY = "01M3QY3VKJAWMFNS7TH6JHSA8W.jpg";
	const cover = { id: "01M3QY3W07VYPSCAA3J1EHX3V8", provider: "local", filename: "gunbarrel-highway.jpg", mimeType: "image/jpeg", alt: "Alt", meta: { storageKey: KEY } };

	it("a local image field at the public file route, from its storage key, never its id", () => {
		expect(resolveImage(field, { data: { cover } }, SITE)).toEqual({ ok: true, url: `${SITE}/_emdash/api/media/file/${KEY}`, alt: "Alt" });
	});

	it("a local value's public src comes first, and a src that needs signing in is never used", () => {
		expect(resolveImage(field, { data: { cover: { ...cover, src: "/_emdash/api/media/file/other.jpg" } } }, SITE)).toMatchObject({ url: `${SITE}/_emdash/api/media/file/other.jpg` });
		expect(resolveImage(field, { data: { cover: { ...cover, src: `/_emdash/api/media/asset/${cover.id}/a.jpg` } } }, SITE)).toMatchObject({ url: `${SITE}/_emdash/api/media/file/${KEY}` });
	});

	it("a storage key is encoded segment by segment, and one that climbs out of the route is refused", () => {
		expect(resolveImage(field, { data: { cover: { ...cover, meta: { storageKey: "plugin-test/a b.jpg" } } } }, SITE)).toMatchObject({ url: `${SITE}/_emdash/api/media/file/plugin-test/a%20b.jpg` });
		expect(resolveImage(field, { data: { cover: { ...cover, meta: { storageKey: "../asset/x" } } } }, SITE)).toEqual({ ok: false, reason: "noPublicAddress" });
	});

	it("a local value without a storage key falls back to the SEO image, keeping the field's alt text, else names why", () => {
		const bare = { id: cover.id, provider: "local", alt: "Alt" };
		expect(resolveImage(field, { data: { cover: bare }, seo: { image: "/_emdash/api/media/file/seo.jpg" } }, SITE)).toEqual({ ok: true, url: `${SITE}/_emdash/api/media/file/seo.jpg`, alt: "Alt" });
		expect(resolveImage(field, { data: { cover: bare } }, SITE)).toEqual({ ok: false, reason: "noPublicAddress" });
	});

	it("a bare string in an image field is never looked up or sent elsewhere", () => {
		expect(resolveImage(field, { data: { cover: "https://evil.example.net/x.jpg" } }, SITE)).toEqual({ ok: false, reason: "noPublicAddress" });
	});

	it("a provider's absolute https src", () => {
		const result = resolveImage(field, { data: { cover: { id: "u1", provider: "unsplash", src: "https://images.unsplash.com/p.jpg", alt: "Hill" } } }, SITE);
		expect(result).toEqual({ ok: true, url: "https://images.unsplash.com/p.jpg", alt: "Hill" });
	});

	it("the SEO image resolved as EmDash resolves og:image: a site path, an absolute URL on the site, or a bare key", () => {
		const seo = (image: string) => resolveImage({ kind: "seo" }, { data: {}, seo: { image } }, SITE);
		expect(seo("/_emdash/api/media/file/k.jpg")).toMatchObject({ ok: true, url: `${SITE}/_emdash/api/media/file/k.jpg` });
		expect(seo(`${SITE}/_emdash/api/media/file/k.jpg`)).toMatchObject({ ok: true, url: `${SITE}/_emdash/api/media/file/k.jpg` });
		expect(seo(KEY)).toMatchObject({ ok: true, url: `${SITE}/_emdash/api/media/file/${KEY}` });
		expect(seo("https://elsewhere.example.net/k.jpg")).toEqual({ ok: false, reason: "notPublic" });
	});

	it("never an address under the signed-in media route, however it is written", () => {
		for (const path of ["/_emdash/api/media/asset/m1/a.jpg", "/_emdash/api/media/file/../asset/m1/a.jpg", "/_emdash/api/media/%61sset/m1/a.jpg", "/_EMDASH/api/media/asset/m1/a.jpg"]) {
			expect(publicImageUrl(`${SITE}${path}`, SITE), path).toBeNull();
			expect(resolveImage({ kind: "seo" }, { data: {}, seo: { image: path } }, SITE), path).toEqual({ ok: false, reason: "notPublic" });
		}
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
		const { current } = periodOf(7, now, "Australia/Sydney");
		expect(figuresByDay(agg, ["a", "b"], current)).toEqual([{ day: "2026-10-03", engagement: 3, impressions: 10 }]);
		expect(total(figuresByDay(agg, ["b"], current), "impressions")).toBeUndefined();
	});

	it("plans the last 30 days first, then the ranges, then older days, newest first", () => {
		const windows = plan({ days: {}, ranges: {}, progress: { c: { recentOn: "2026-10-03", backTo: "2026-09-04" } } }, [{ id: "c", organizationId: "o" }], "2026-10-03", "Australia/Sydney");
		expect(windows.slice(0, 4).map((w) => [w.kind, w.window.key])).toEqual([
			["range", "7"],
			["range", "30"],
			["range", "90"],
			["backfill", "2026-09-03"],
		]);
		expect(windows.at(-1)?.window.key).toBe("2026-04-07");
		// 3 October in Sydney (AEST, UTC+10), sent to Buffer as UTC instants.
		expect(plan({ days: {}, ranges: {}, progress: {} }, [{ id: "c", organizationId: "o" }], "2026-10-03", "Australia/Sydney")[0]).toMatchObject({ kind: "recent", window: { start: "2026-10-02T14:00:00Z", end: "2026-10-03T13:59:59Z" } });
	});
});
