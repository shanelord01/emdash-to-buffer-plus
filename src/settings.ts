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
}

export const DEFAULT_TEMPLATE = "{title}\n\n{excerpt}\n\n{url}";
export const DEFAULT_RETENTION_DAYS = 180;
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 730;

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
	};
}

/**
 * Line breaks are kept. A literal `\n` typed into a single-line field also
 * becomes a line break, so a template can be written either way.
 */
export function normaliseTemplate(template: string): string {
	return template.replace(/\r\n?/g, "\n").replace(/\\n/g, "\n").trim();
}
