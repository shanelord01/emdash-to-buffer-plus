import { describe, expect, it } from "vitest";

import changelog from "../docs/registry/changelog.md?raw";
import description from "../docs/registry/description.md?raw";
import faq from "../docs/registry/faq.md?raw";
import installation from "../docs/registry/installation.md?raw";
import security from "../docs/registry/security.md?raw";
import manifestText from "../emdash-plugin.jsonc?raw";
import readme from "../README.md?raw";
import { SERVICE_RULES } from "../src/buffer/services.js";
import { reasonText } from "../src/i18n.js";

/**
 * The documents a site owner reads: the registry page's tabs and the
 * README's table of networks. Files come in as Vite `?raw` imports, since
 * the suite runs inside workerd.
 */

const FILES: Record<string, string> = {
	"docs/registry/changelog.md": changelog,
	"docs/registry/description.md": description,
	"docs/registry/faq.md": faq,
	"docs/registry/installation.md": installation,
	"docs/registry/security.md": security,
};

/** JSON with comments and trailing commas, as `emdash-plugin.jsonc` is written. */
function parseJsonc(text: string): unknown {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (c === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2) + 1;
		} else out += c;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function manifest(): Record<string, unknown> {
	return parseJsonc(manifestText) as Record<string, unknown>;
}

function graphemes(text: string): number {
	let n = 0;
	for (const _ of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)) n++;
	return n;
}

describe("the registry page's sections", () => {
	const sections = manifest().sections as Record<string, { file: string }>;

	it("declares all five, each as a file inside the repository", () => {
		expect(Object.keys(sections).sort()).toEqual(["changelog", "description", "faq", "installation", "security"]);
		for (const [key, value] of Object.entries(sections)) {
			expect(value.file, key).toMatch(/^docs\/registry\/[a-z]+\.md$/);
		}
	});

	for (const key of ["description", "installation", "faq", "changelog", "security"]) {
		it(`keeps ${key} inside the registry's caps of 20000 bytes and 2000 graphemes`, () => {
			const text = FILES[sections[key]!.file];
			expect(text, sections[key]!.file).toBeDefined();
			expect(text!.trim().length).toBeGreaterThan(200);
			expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(20_000);
			expect(graphemes(text!)).toBeLessThanOrEqual(2_000);
		});
	}
});

const NAMES: Record<string, string> = {
	bluesky: "Bluesky",
	facebook: "Facebook",
	googlebusiness: "Google Business Profile",
	instagram: "Instagram",
	linkedin: "LinkedIn",
	mastodon: "Mastodon",
	pinterest: "Pinterest",
	startPage: "Start Page",
	substack: "Substack",
	threads: "Threads",
	tiktok: "TikTok",
	twitter: "X",
	whatsapp: "WhatsApp",
	youtube: "YouTube",
};

/** The README's row for each service, worked out from the rule table the plugin uses. */
function networkRows(): string[] {
	return Object.entries(SERVICE_RULES).map(([service, rule]) => {
		const postable = rule.postable === true;
		const image = !postable ? "No" : rule.image === "needed" ? "Needed" : rule.image === "allowed" ? "Optional" : "No";
		const limit = !postable ? "" : rule.limit ? (service === "mastodon" ? "Server's own, 500 by default" : rule.limit.max.toLocaleString("en-AU")) : "Not documented";
		const skipped = !postable
			? reasonText("en", rule.postable === true ? "" : rule.postable.reason)
			: [
					...(rule.needsBoard ? ["Until you choose a board."] : []),
					...(rule.image === "needed" ? ["When the entry has no image Buffer can fetch."] : []),
				].join(" ");
		return `| ${NAMES[service] ?? service} | ${postable ? "Yes" : "No"} | ${postable && rule.linkCard ? "Yes" : "No"} | ${image} | ${limit} | ${skipped} |`.replace(/ {2,}\|/g, " |");
	});
}

describe("the README's table of networks", () => {
	it("matches the plugin's rule table, row for row", () => {
		const missing = networkRows().filter((row) => !readme.includes(row));
		expect(missing, `rows to put in README.md:\n${missing.join("\n")}`).toEqual([]);
	});
});
