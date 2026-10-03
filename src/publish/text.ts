/**
 * Post text: the template, filled in, measured the way Buffer measures it,
 * and shortened to fit.
 *
 * Line breaks are kept exactly as the template has them. Only runs of three
 * or more line breaks left by an empty `{excerpt}` are closed up to one blank
 * line, and spaces at the ends of lines are trimmed.
 */

import type { CountRule } from "../buffer/services.js";

export interface TemplateValues {
	title: string;
	excerpt: string;
	url: string;
}

const TAG = /\{(title|excerpt|url)\}/gi;
const ELLIPSIS = "…";

export function renderTemplate(template: string, values: TemplateValues): string {
	const filled = template.replace(TAG, (_match, tag: string) => values[tag.toLowerCase() as keyof TemplateValues] ?? "");
	return tidy(filled);
}

function tidy(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const URL_RE = /https?:\/\/[^\s]+/g;

/**
 * Text length as Buffer counts it for one network (character-limits.md).
 *
 * X's weighted count is X's own algorithm, which the guide summarises as
 * "URLs are 23 and emoji are 2". This counts URLs as 23 and every character
 * outside the Latin, Greek, Cyrillic and other scripts below U+1100 as 2,
 * which can only overcount, never undercount, so a post that passes here
 * passes at X.
 */
export function measure(text: string, rule: CountRule): number {
	switch (rule) {
		case "utf16":
			return text.length;
		case "linkedin":
			return replaceUrls(text, 24);
		case "mastodon":
			return replaceUrls(text, 23);
		case "instagram":
			return text.length + (text.match(/\n/g)?.length ?? 0);
		case "twitter": {
			let total = 0;
			const rest = text.replace(URL_RE, () => {
				total += 23;
				return "";
			});
			for (const char of rest) total += (char.codePointAt(0) ?? 0) <= 0x10ff ? 1 : 2;
			return total;
		}
		case "bluesky": {
			let total = 0;
			const rest = text.replace(URL_RE, (url) => {
				total += blueskyUrlLength(url);
				return "";
			});
			return total + graphemes(rest);
		}
	}
}

function replaceUrls(text: string, each: number): number {
	let total = 0;
	const rest = text.replace(URL_RE, () => {
		total += each;
		return "";
	});
	return total + rest.length;
}

/** "URLs count as the host plus up to 16 more characters" (character-limits.md, Bluesky). */
function blueskyUrlLength(url: string): number {
	try {
		const parsed = new URL(url);
		const rest = url.length - (parsed.protocol.length + 2 + parsed.host.length);
		return graphemes(parsed.host) + Math.min(16, Math.max(0, rest));
	} catch {
		return graphemes(url);
	}
}

function graphemes(text: string): number {
	if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
		let n = 0;
		for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) n++;
		return n;
	}
	return [...text].length;
}

export type FitResult = { ok: true; text: string; shortened: boolean } | { ok: false; length: number };

/**
 * Render the template and fit it under `max` by shortening the excerpt, with
 * an ellipsis, down to nothing if need be. The title and the URL are never
 * cut. When the text still does not fit without any excerpt, the result says
 * so and the channel is skipped with a reason.
 */
export function fitText(template: string, values: TemplateValues, limit?: { max: number; count: CountRule }): FitResult {
	const full = renderTemplate(template, values);
	if (!limit || measure(full, limit.count) <= limit.max) return { ok: true, text: full, shortened: false };

	const fits = (excerpt: string) => {
		const text = renderTemplate(template, { ...values, excerpt });
		return measure(text, limit.count) <= limit.max ? text : null;
	};

	const excerpt = cutter(values.excerpt);
	const shortened = longestFitting(excerpt.count + 1, (n) => fits(excerpt.at(n)));
	if (shortened !== null) return { ok: true, text: shortened, shortened: true };

	return { ok: false, length: measure(full, limit.count) };
}

/**
 * Shortened versions of a value, longest first (index 0) and "" last. Built
 * on demand so a search over a long excerpt costs a dozen cuts, not one per
 * character: a sandboxed invocation gets 50 ms of CPU. Cuts fall on a word
 * boundary where one is close, and never inside a surrogate pair.
 */
function cutter(value: string): { count: number; at(index: number): string } {
	const chars = [...value];
	return {
		count: chars.length,
		at(index: number): string {
			const n = chars.length - 1 - index;
			if (n <= 0) return "";
			let cut = chars.slice(0, n).join("");
			const space = cut.lastIndexOf(" ");
			if (space > cut.length * 0.6) cut = cut.slice(0, space);
			cut = cut.replace(/[\s.,;:!?-]+$/u, "");
			return cut ? `${cut}${ELLIPSIS}` : "";
		},
	};
}

/** Binary search for the first (longest) candidate that fits. Candidates shrink monotonically. */
function longestFitting(count: number, attempt: (index: number) => string | null): string | null {
	let lo = 0;
	let hi = count - 1;
	let found: string | null = null;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const text = attempt(mid);
		if (text !== null) {
			found = text;
			hi = mid - 1;
		} else {
			lo = mid + 1;
		}
	}
	return found;
}
