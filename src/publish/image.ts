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
 * The address is EmDash's public file route,
 * `/_emdash/api/media/file/<storageKey>` (emdash 1.1
 * src/astro/routes/api/media/file/[...key].ts, which serves without
 * signing in). Never `/_emdash/api/media/asset/<id>/<filename>`, the `url`
 * that `ctx.media.get()` gives: that route asks for `media:read` and answers
 * 401 to Buffer.
 *
 * Where the image comes from (emdash src/media/types.ts `MediaValue`,
 * src/media/local-runtime.ts `getEmbed`, src/seo/media-url.ts):
 * - an image field holds `{ id, src, alt, provider, meta: { storageKey } }`
 *   (docs.emdashcms.com/reference/field-types/#image), `src` being
 *   `/_emdash/api/media/file/<key>` for local media. A local value with
 *   neither a public `src` nor a storage key has no address the plugin can
 *   be sure of, so the SEO image stands in for it, else there is no image.
 *   Other providers carry an absolute https `src`.
 * - the SEO image is a string, resolved as EmDash resolves `og:image`
 *   (`buildSeoImageUrl`): an absolute URL as it is, a site path joined to
 *   the site's URL, and a bare reference under the public file route.
 *
 * No bridge call: everything is in the entry.
 */

import { isRecord, str } from "../values.js";

export type ImageSource = { kind: "field"; field: string } | { kind: "seo" } | { kind: "none" };

export type ImageResult =
	| { ok: true; url: string; alt: string }
	/** `noPublicAddress`: a local image whose storage key the entry does not carry, and no SEO image to stand in. */
	| { ok: false; reason: "none" | "notPublic" | "noPublicAddress" };

/** EmDash's public media route, and the signed-in one Buffer cannot read. */
export const MEDIA_FILE_PATH = "/_emdash/api/media/file/";
export const MEDIA_ASSET_PATH = "/_emdash/api/media/asset/";

export function resolveImage(source: ImageSource, content: { data: Record<string, unknown>; seo?: unknown }, siteUrl: string): ImageResult {
	if (source.kind === "none") return { ok: false, reason: "none" };
	if (source.kind === "seo") return seoImage(content.seo, siteUrl);

	const value = content.data[source.field];
	if (typeof value === "string") {
		// A bare string in an image field: an address at most, never looked up.
		const ref = value.trim();
		if (!ref) return { ok: false, reason: "none" };
		if (/^https:\/\//i.test(ref) || ref.startsWith(MEDIA_FILE_PATH)) {
			const result = checked(ref.startsWith("/") ? join(siteUrl, ref) : ref, siteUrl, "");
			if (result.ok) return result;
		}
		return standIn(content.seo, siteUrl, "");
	}
	if (!isRecord(value)) return { ok: false, reason: "none" };
	const alt = str(value.alt);
	const provider = str(value.provider) || "local";
	const src = str(value.src);
	if (provider !== "local") {
		if (!src) return { ok: false, reason: "none" };
		return checked(src, siteUrl, alt, { providerSrc: true });
	}
	// The order EmDash itself follows. A local `src` under the public file
	// route is canonical (emdash src/loader.ts normalizeLocalMediaValue,
	// LOCAL_MEDIA_FILE_PREFIX), as is an absolute https one on the site's
	// host. Else the route plus `meta.storageKey` (src/components/EmDashMedia.astro,
	// src/media/local-runtime.ts getEmbed). Never the id as a key: a media
	// id is not its storage key, and that path would not exist.
	if (src.startsWith(MEDIA_FILE_PATH) || /^https:\/\//i.test(src)) {
		const fromSrc = checked(src.startsWith("/") ? join(siteUrl, src) : src, siteUrl, alt);
		if (fromSrc.ok) return fromSrc;
	}
	const meta = isRecord(value.meta) ? value.meta : {};
	const key = str(meta.storageKey) || str(value.storageKey);
	if (key) {
		const path = filePath(key);
		if (path) return checked(join(siteUrl, path), siteUrl, alt);
	}
	return standIn(content.seo, siteUrl, alt);
}

/** The SEO image in place of a local image with no address, keeping the field's alt text. */
function standIn(seo: unknown, siteUrl: string, alt: string): ImageResult {
	const result = seoImage(seo, siteUrl);
	if (result.ok) return { ...result, alt: alt || result.alt };
	return { ok: false, reason: "noPublicAddress" };
}

function seoImage(seo: unknown, siteUrl: string): ImageResult {
	const ref = str(isRecord(seo) ? seo.image : undefined);
	if (!ref) return { ok: false, reason: "none" };
	if (/^https?:\/\//i.test(ref)) return checked(ref, siteUrl, "");
	if (ref.startsWith("//")) return checked(`https:${ref}`, siteUrl, "");
	if (ref.startsWith("/")) return checked(join(siteUrl, ref), siteUrl, "");
	const path = filePath(ref);
	return path ? checked(join(siteUrl, path), siteUrl, "") : { ok: false, reason: "notPublic" };
}

/**
 * The public route for a storage key, each segment percent-encoded, or null
 * for a key that could climb out of it ("..", empty segments).
 */
export function filePath(key: string): string | null {
	const segments = key.split("/");
	if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
	return MEDIA_FILE_PATH + segments.map(encodeURIComponent).join("/");
}

/** Whether a URL points at EmDash's signed-in media route, which Buffer cannot read. */
export function isSignedInMediaUrl(raw: string): boolean {
	try {
		return decodeURIComponent(new URL(raw, "https://site.invalid").pathname).toLowerCase().startsWith(MEDIA_ASSET_PATH);
	} catch {
		return true;
	}
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
	// EmDash's signed-in media route answers 401 to Buffer, on any host.
	if (isSignedInMediaUrl(url.toString())) return null;
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
