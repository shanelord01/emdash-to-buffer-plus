/**
 * Buffer's post metrics, read the way Buffer documents them.
 *
 * Sources: developers.buffer.com /guides/post-metrics.md and /reference.md
 * (PostMetric, PostMetricType, PostMetricUnit, AggregatedPostMetrics). In
 * the local copy of the reference (scratchpad/buffer-reference.md) the
 * PostMetricType list starts at line 4228.
 *
 * Three rules from the guide drive everything here:
 *
 * - A missing metric is missing, not zero: "The `metrics` array on a single
 *   post only includes metric types that the network has actually reported
 *   for that post." So a type that is absent stays absent, and a post whose
 *   `metricsUpdatedAt` is null has not been read by Buffer yet at all.
 * - Aggregates always carry `postCount`, `reactions` and `comments`; other
 *   types appear only when every channel in the filter reports them. That
 *   is why the sync asks for one channel per aggregate.
 * - `engagementRate` is a percentage from 0 to 100 that Buffer works out
 *   itself. It is shown as Buffer gives it and never recomputed from other
 *   figures, which may come from different posts or windows.
 */

import { isRecord } from "../values.js";

/** A metric type and its value, as stored: `{ reactions: 12, impressions: 340 }`. */
export type MetricMap = Record<string, number>;

/**
 * The PostMetricType values that count as engagement: people acting on a
 * post. From the reference's PostMetricType list (line 4228 on): the
 * cross-network `reactions`, `comments`, `shares` and `reposts`, and the
 * network-specific `saves` and `quotes`.
 *
 * Left out on purpose: `likes` (Facebook's Like subcount, already inside
 * `reactions`, so adding it would count twice), `clicks` (visits, not
 * engagement on the post itself), `impressions`, `reach`, `views`,
 * `viewers` and the watch times (being shown, not acting), `follows` and
 * the Substack subscriptions (results, not engagement), `engagementRate`
 * (a rate), `postCount` (aggregate only), and every deprecated value.
 */
export const ENGAGEMENT_TYPES = ["reactions", "comments", "shares", "reposts", "saves", "quotes"] as const;

/** `impressions`: "How many times your post was shown on screen." */
export const IMPRESSIONS = "impressions";

/** `engagementRate`: Buffer's own percentage, unit `percentage`, 0 to 100. */
export const ENGAGEMENT_RATE = "engagementRate";

/** `postCount`: the number of posts an aggregate matched. Aggregates only. */
export const POST_COUNT = "postCount";

/** Read a `[PostMetric!]` list into a map. Entries without a type or a finite value are dropped. */
export function metricMap(raw: unknown): MetricMap | null {
	if (!Array.isArray(raw)) return null;
	const out: MetricMap = {};
	for (const item of raw) {
		if (!isRecord(item) || typeof item.type !== "string") continue;
		const value = typeof item.value === "number" ? item.value : Number.NaN;
		if (Number.isFinite(value)) out[item.type] = value;
	}
	return out;
}

/** The sum of the engagement types present, or undefined when none is. */
export function engagementOf(metrics: MetricMap | null | undefined): number | undefined {
	if (!metrics) return undefined;
	let total: number | undefined;
	for (const type of ENGAGEMENT_TYPES) {
		const value = metrics[type];
		if (typeof value === "number") total = (total ?? 0) + value;
	}
	return total;
}

export function impressionsOf(metrics: MetricMap | null | undefined): number | undefined {
	const value = metrics?.[IMPRESSIONS];
	return typeof value === "number" ? value : undefined;
}

export function engagementRateOf(metrics: MetricMap | null | undefined): number | undefined {
	const value = metrics?.[ENGAGEMENT_RATE];
	return typeof value === "number" ? value : undefined;
}
