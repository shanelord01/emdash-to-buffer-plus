/**
 * Plugin KV: configuration from the Buffer page, the channel cache, the
 * plugin's own state and the report sync's progress, read together with one
 * `ctx.kv.list()` call.
 *
 * One call instead of three matters: a sandboxed invocation gets ten bridge
 * calls, and every invocation needs all three.
 */

import type { PluginContext } from "emdash/plugin";

import type { BufferChannel, BufferOrganization, DailyLimit } from "../buffer/client.js";
import { currentWindows, newestSnapshot, type WindowReading } from "../buffer/headroom.js";
import type { RateLimitSnapshot } from "../buffer/ratelimit.js";
import type { AttachMode, ChannelHints, SkipReason } from "../buffer/services.js";
import { DEFAULT_UTM, type UtmConfig } from "../publish/url.js";
import { isRecord } from "../values.js";
import { parseReportState, REPORT_KEY, type ReportState } from "./report.js";

export const CONFIG_KEY = "config";
export const CHANNELS_KEY = "channels";
export const STATE_KEY = "state";

/** How a channel shares: Buffer's ShareMode, or a draft (CreatePostInput.saveToDraft). */
export type ChannelMode = "addToQueue" | "shareNext" | "shareNow" | "draft";

export const CHANNEL_MODES: readonly ChannelMode[] = ["addToQueue", "shareNext", "shareNow", "draft"];
export const ATTACH_MODES: readonly AttachMode[] = ["image", "link", "none"];

export interface ChannelConfig {
	enabled: boolean;
	mode: ChannelMode;
	attach: AttachMode;
	/** Overrides the default template when set. */
	template?: string;
	/** Pinterest: the board Pins go to (PinterestPostMetadataInput.boardServiceId). */
	boardServiceId?: string;
}

export interface CollectionConfig {
	enabled: boolean;
	/** An image field's slug, "seo" for the SEO image, or "none". */
	image: string;
	/** The collection's title field, copied from the schema when saved, so publishing needs no schema read. */
	titleField?: string;
	label?: string;
}

export interface PluginConfig {
	channels: Record<string, ChannelConfig>;
	collections: Record<string, CollectionConfig>;
	utm: UtmConfig;
}

export interface ChannelCache {
	fetchedAt: string;
	organizations: BufferOrganization[];
	channels: BufferChannel[];
	limits: DailyLimit[];
	/** True when more organizations exist than one discovery reads. */
	truncated?: boolean;
	/** Per-channel hints from Buffer's Experimental configuration query; absent when it did not answer. */
	hints?: Record<string, ChannelHints>;
	/** Why the configuration query gave no hints, when it failed. Informational only. */
	hintsNote?: string;
	/** The newest RateLimit reading from a discovery. */
	rateLimit?: RateLimitSnapshot;
	/** The last discovery that failed. The channels above are from the last one that worked. */
	error?: { at: string; kind: string; message: string };
}

export interface PluginState {
	/** Only entries first published at or after this moment are shared. */
	watchSince?: string;
	rateLimit?: RateLimitSnapshot;
	/** Which continuation task ran last, so the next one takes the other name. */
	lastContinuation?: string;
	lastRunAt?: string;
	lastPruneAt?: string;
	/**
	 * This install's minute offset (0 to 59) for the recurring sync, picked
	 * at random once so installs do not all ask Buffer on the hour.
	 */
	syncOffset?: number;
}

export interface Stored {
	config: PluginConfig;
	channels: ChannelCache | null;
	state: PluginState;
	/** The report sync's progress (`src/store/report.ts`), under its own key so delivery runs never overwrite it. */
	report: ReportState;
}

export function emptyConfig(): PluginConfig {
	return { channels: {}, collections: {}, utm: { ...DEFAULT_UTM } };
}

export async function readStored(ctx: PluginContext): Promise<Stored> {
	const entries = await ctx.kv.list();
	const map = new Map(entries.map((e) => [e.key, e.value]));
	return {
		config: parseConfig(map.get(CONFIG_KEY)),
		channels: isRecord(map.get(CHANNELS_KEY)) ? (map.get(CHANNELS_KEY) as unknown as ChannelCache) : null,
		state: isRecord(map.get(STATE_KEY)) ? (map.get(STATE_KEY) as PluginState) : {},
		report: parseReportState(map.get(REPORT_KEY)),
	};
}

export function parseConfig(raw: unknown): PluginConfig {
	const config = emptyConfig();
	if (!isRecord(raw)) return config;
	if (isRecord(raw.channels)) {
		for (const [id, value] of Object.entries(raw.channels)) {
			if (!isRecord(value)) continue;
			config.channels[id] = {
				enabled: value.enabled === true,
				mode: CHANNEL_MODES.includes(value.mode as ChannelMode) ? (value.mode as ChannelMode) : "addToQueue",
				attach: ATTACH_MODES.includes(value.attach as AttachMode) ? (value.attach as AttachMode) : "image",
				...(typeof value.template === "string" && value.template.trim() && { template: value.template }),
				...(typeof value.boardServiceId === "string" && value.boardServiceId && { boardServiceId: value.boardServiceId }),
			};
		}
	}
	if (isRecord(raw.collections)) {
		for (const [slug, value] of Object.entries(raw.collections)) {
			if (!isRecord(value)) continue;
			config.collections[slug] = {
				enabled: value.enabled === true,
				image: typeof value.image === "string" && value.image ? value.image : "none",
				...(typeof value.titleField === "string" && { titleField: value.titleField }),
				...(typeof value.label === "string" && { label: value.label }),
			};
		}
	}
	if (isRecord(raw.utm)) {
		config.utm = {
			enabled: raw.utm.enabled === true,
			source: typeof raw.utm.source === "string" && raw.utm.source.trim() ? raw.utm.source.trim() : DEFAULT_UTM.source,
			medium: typeof raw.utm.medium === "string" && raw.utm.medium.trim() ? raw.utm.medium.trim() : DEFAULT_UTM.medium,
		};
	}
	return config;
}

/** A channel's configuration, with the defaults a channel starts with. */
export function channelConfig(config: PluginConfig, id: string): ChannelConfig {
	return config.channels[id] ?? { enabled: false, mode: "addToQueue", attach: "image" };
}

/**
 * Every RateLimit reading still in force, window by window, from the three
 * places the plugin keeps one: the delivery state, the channel snapshot
 * and the report state.
 */
export function storedReadings(stored: Pick<Stored, "state" | "channels" | "report">, now: Date): Map<number, WindowReading> {
	return currentWindows([stored.state.rateLimit, stored.channels?.rateLimit, stored.report.rateLimit], now);
}

/** The newest reading the plugin holds, for the "requests left" line. */
export function latestRateLimit(stored: Pick<Stored, "state" | "channels" | "report">): RateLimitSnapshot | undefined {
	return newestSnapshot([stored.state.rateLimit, stored.channels?.rateLimit, stored.report.rateLimit]);
}

export function hintsFor(cache: ChannelCache | null, id: string): ChannelHints | undefined {
	return cache?.hints?.[id];
}

export function limitFor(cache: ChannelCache | null, id: string): DailyLimit | undefined {
	return cache?.limits.find((l) => l.channelId === id);
}

export type { SkipReason };
