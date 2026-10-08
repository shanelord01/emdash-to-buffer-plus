/**
 * The generated settings form: credentials and plain values only.
 *
 * Everything comes out of `ctx.settings.list()` in one call rather than one
 * `get()` per key, because a sandboxed invocation gets ten bridge calls and
 * every settings read counts. `ctx.settings.get()` returns null for an unset
 * key (defaults in `settingsSchema` are applied by the admin form when it
 * saves, not when a value is read), so every default is applied again here.
 *
 * Dynamic configuration (which channels, which collections, the image source,
 * UTM tags) lives on the Buffer admin page and in plugin KV, because the
 * generated form only offers fixed fields.
 */

import type { PluginContext } from "emdash/plugin";

import { DEFAULT_TIME_ZONE, resolveTimeZone } from "./time/zone.js";
import { clampNumber, str } from "./values.js";

export interface PluginSettings {
	/** The Buffer personal API key. Empty when not set. Never logged or rendered. */
	accessToken: string;
	/** The master switch: off stops new deliveries, keeps everything else. */
	enabled: boolean;
	/** The post text template, line breaks kept. */
	defaultTemplate: string;
	/** Days to keep delivery records. */
	retentionDays: number;
	/** The recurring sync's cron expression, one of `SYNC_INTERVALS`. */
	syncInterval: string;
	/**
	 * "Leave for other tools": the share (percent) of Buffer's 24-hour and
	 * 30-day quotas the background reports leave untouched, because every
	 * API key and MCP connection on the account draws on one bucket.
	 */
	headroomPercent: number;
	/**
	 * The IANA time zone the reports' days are in: which day a post counts
	 * on, where "today" and each range start, and the times the admin shows.
	 * EmDash 1.1 and 1.2 give a sandboxed plugin no site time zone
	 * (`ctx.site` holds name, URL, locale and trailingSlash only), so it is
	 * a setting. An unknown zone falls back to the default.
	 */
	timeZone: string;
}

export const DEFAULT_TEMPLATE = "{title}\n\n{excerpt}\n\n{url}";
export const DEFAULT_RETENTION_DAYS = 180;
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 730;
export const DEFAULT_HEADROOM_PERCENT = 25;
export const MIN_HEADROOM_PERCENT = 10;
export const MAX_HEADROOM_PERCENT = 75;
export { DEFAULT_TIME_ZONE };

/**
 * The sync's choices, the same as the `syncInterval` select in
 * `emdash-plugin.jsonc`. Anything else falls back to the default, so a
 * hand-edited value can never schedule something unexpected.
 */
export const SYNC_INTERVALS = ["*/15 * * * *", "*/30 * * * *", "0 * * * *", "0 */6 * * *"] as const;
export const DEFAULT_SYNC_INTERVAL = "*/30 * * * *";

export async function readSettings(ctx: PluginContext): Promise<PluginSettings> {
	const raw = new Map<string, unknown>();
	for (const entry of await ctx.settings.list()) raw.set(entry.key, entry.value);
	return parseSettings(raw);
}

export function parseSettings(raw: Map<string, unknown>): PluginSettings {
	const template = typeof raw.get("defaultTemplate") === "string" ? (raw.get("defaultTemplate") as string) : "";
	return {
		accessToken: str(raw.get("accessToken")),
		// On unless switched off: nothing is sent before a channel and a
		// collection are both turned on, which is the real gate.
		enabled: raw.get("enabled") !== false,
		defaultTemplate: normaliseTemplate(template) || DEFAULT_TEMPLATE,
		retentionDays: clampNumber(raw.get("retentionDays"), MIN_RETENTION_DAYS, MAX_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
		syncInterval: (SYNC_INTERVALS as readonly string[]).includes(str(raw.get("syncInterval")))
			? str(raw.get("syncInterval"))
			: DEFAULT_SYNC_INTERVAL,
		headroomPercent: clampNumber(raw.get("headroomPercent"), MIN_HEADROOM_PERCENT, MAX_HEADROOM_PERCENT, DEFAULT_HEADROOM_PERCENT),
		timeZone: resolveTimeZone(raw.get("timeZone")),
	};
}

/**
 * Line breaks are kept. A literal `\n` typed into a single-line field also
 * becomes a line break, so a template can be written either way.
 */
export function normaliseTemplate(template: string): string {
	return template.replace(/\r\n?/g, "\n").replace(/\\n/g, "\n").trim();
}
