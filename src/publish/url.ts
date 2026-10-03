/**
 * The entry's public link, and the UTM tags added to it.
 *
 * The link is the SEO canonical when the editor set one, resolved the way
 * EmDash resolves it for `<link rel="canonical">` (emdash src/seo/media-url.ts
 * `resolveSeoCanonicalUrl`: absolute as-is, a path joined to the site URL).
 * Otherwise it is `ctx.content.getPublicUrl()` (emdash
 * src/plugins/content-access.ts), which is the site URL plus the
 * collection's URL pattern and returns null when there is no site URL, the
 * entry is not published, has no slug, or the collection is not routable.
 * There is no fallback to a guessed path: an entry without a link is skipped
 * with a reason.
 */

import { slugify } from "../values.js";

export function canonicalUrl(canonical: unknown, siteUrl: string): string | null {
	if (typeof canonical !== "string" || !canonical.trim()) return null;
	const value = canonical.trim();
	let resolved: string;
	if (/^https?:\/\//i.test(value)) resolved = value;
	else if (value.startsWith("//")) resolved = `https:${value}`;
	else {
		if (!siteUrl) return null;
		resolved = `${siteUrl.replace(/\/$/, "")}${value.startsWith("/") ? value : `/${value}`}`;
	}
	return httpUrl(resolved);
}

/** An absolute http(s) URL, or null. */
export function httpUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
	} catch {
		return null;
	}
}

export interface UtmConfig {
	enabled: boolean;
	source: string;
	medium: string;
}

export const DEFAULT_UTM: UtmConfig = { enabled: false, source: "buffer", medium: "social" };

/**
 * Add `utm_source`, `utm_medium` and `utm_campaign` to a link. Any UTM
 * parameter the link already carries is kept as it is and not added a
 * second time; other query parameters and the fragment are kept.
 * The campaign is the channel's service, or its name as a slug when the
 * service is unknown.
 */
export function withUtm(link: string, utm: UtmConfig, channel: { service: string; name: string }): string {
	if (!utm.enabled) return link;
	let url: URL;
	try {
		url = new URL(link);
	} catch {
		return link;
	}
	const campaign = slugify(channel.service && channel.service !== "unknown" ? channel.service : channel.name) || "buffer";
	const values: Array<[string, string]> = [
		["utm_source", slugify(utm.source) || DEFAULT_UTM.source],
		["utm_medium", slugify(utm.medium) || DEFAULT_UTM.medium],
		["utm_campaign", campaign],
	];
	for (const [key, value] of values) {
		if (!url.searchParams.has(key)) url.searchParams.append(key, value);
	}
	return url.toString();
}
