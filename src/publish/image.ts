/**
 * The entry's image, as a URL Buffer can fetch.
 *
 * Buffer has no upload: it fetches a public, direct HTTPS URL when the post
 * goes out, which can be days later (developers.buffer.com
 * /guides/hosting-media.md). So the URL must be https, and it must not point
 * anywhere private: no IP literals, no localhost, no internal names. Its host
 * must be the site's own host, except for an image from a non-local media
 * provider, whose absolute https `src` is allowed on the provider's host.
 *
 * Where the image comes from (emdash src/media/types.ts `MediaValue`,
 * src/seo/media-url.ts):
 * - an image field holds `{ provider?, id, src?, alt? }`. Local media is
 *   looked up with `ctx.media.get(id)`, whose `url` is a site-relative
 *   `/_emdash/api/media/asset/<id>/<filename>`; other providers carry an
 *   absolute `src`.
 * - the SEO image is a string: an absolute URL, a site path, or a bare media
 *   id. A bare id is looked up as media, never used as a URL.
 */

import type { PluginContext } from "emdash/plugin";

import { isRecord, str } from "../values.js";

export type ImageSource = { kind: "field"; field: string } | { kind: "seo" } | { kind: "none" };

export type ImageResult =
	| { ok: true; url: string; alt: string }
	| { ok: false; reason: "none" | "notPublic" | "notFound" | "lookupFailed" };

export async function resolveImage(
	ctx: Pick<PluginContext, "media">,
	source: ImageSource,
	content: { data: Record<string, unknown>; seo?: unknown },
	siteUrl: string,
): Promise<ImageResult> {
	if (source.kind === "none") return { ok: false, reason: "none" };

	if (source.kind === "seo") {
		const seo = isRecord(content.seo) ? content.seo : {};
		const ref = str(seo.image);
		if (!ref) return { ok: false, reason: "none" };
		if (/^https?:\/\//i.test(ref) || ref.startsWith("//")) return checked(ref.startsWith("//") ? `https:${ref}` : ref, siteUrl, "");
		if (ref.startsWith("/")) return checked(join(siteUrl, ref), siteUrl, "");
		return await fromMedia(ctx, ref, siteUrl, "");
	}

	const value = content.data[source.field];
	if (typeof value === "string") {
		// A bare string in an image field is a media id at most, never a URL.
		return value.trim() ? await fromMedia(ctx, value.trim(), siteUrl, "") : { ok: false, reason: "none" };
	}
	if (!isRecord(value)) return { ok: false, reason: "none" };
	const alt = str(value.alt);
	const provider = str(value.provider) || "local";
	const src = str(value.src);
	if (provider !== "local") {
		if (!src) return { ok: false, reason: "none" };
		return checked(src, siteUrl, alt, { providerSrc: true });
	}
	const id = str(value.id);
	if (id) return await fromMedia(ctx, id, siteUrl, alt);
	if (src.startsWith("/")) return checked(join(siteUrl, src), siteUrl, alt);
	return src ? checked(src, siteUrl, alt) : { ok: false, reason: "none" };
}

async function fromMedia(ctx: Pick<PluginContext, "media">, id: string, siteUrl: string, alt: string): Promise<ImageResult> {
	if (!ctx.media) return { ok: false, reason: "lookupFailed" };
	let item: Awaited<ReturnType<NonNullable<PluginContext["media"]>["get"]>>;
	try {
		item = await ctx.media.get(id);
	} catch {
		return { ok: false, reason: "lookupFailed" };
	}
	if (!item) return { ok: false, reason: "notFound" };
	if (!item.mimeType.startsWith("image/")) return { ok: false, reason: "notFound" };
	const url = item.url.startsWith("/") ? join(siteUrl, item.url) : item.url;
	return checked(url, siteUrl, alt || str(item.alt));
}

function join(siteUrl: string, path: string): string {
	return `${siteUrl.replace(/\/$/, "")}${path}`;
}

function checked(raw: string, siteUrl: string, alt: string, opts?: { providerSrc?: boolean }): ImageResult {
	const url = publicImageUrl(raw, siteUrl, opts);
	return url ? { ok: true, url, alt } : { ok: false, reason: "notPublic" };
}

/**
 * The URL when Buffer may be given it, else null. Exported for tests.
 */
export function publicImageUrl(raw: string, siteUrl: string, opts?: { providerSrc?: boolean }): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	if (url.username || url.password) return null;
	const host = url.hostname.toLowerCase();
	if (!isPublicHostname(host)) return null;
	if (!opts?.providerSrc) {
		let siteHost: string;
		try {
			siteHost = new URL(siteUrl).hostname.toLowerCase();
		} catch {
			return null;
		}
		if (host !== siteHost) return null;
	}
	return url.toString();
}

/**
 * A DNS name that can only be public. IP literals are refused outright,
 * which covers every private, loopback and link-local range without having
 * to list them; so are single-label names and the reserved suffixes for
 * local and internal use.
 */
export function isPublicHostname(host: string): boolean {
	if (!host || host.startsWith("[") || host.includes(":")) return false;
	if (/^[\d.]+$/.test(host)) return false;
	if (/^0x[0-9a-f]+$/i.test(host)) return false;
	if (!host.includes(".")) return false;
	const blocked = ["localhost", "local", "internal", "intranet", "lan", "home", "corp", "test", "invalid", "example", "onion", "home.arpa"];
	const labels = host.replace(/\.$/, "").split(".");
	const tld = labels[labels.length - 1]!;
	if (blocked.includes(tld)) return false;
	if (host.endsWith(".home.arpa") || host.endsWith(".in-addr.arpa") || host.endsWith(".ip6.arpa")) return false;
	return true;
}
