/**
 * What the reports read: the sync's own progress in KV, and two snapshot
 * rows in the `reports` storage collection.
 *
 * Pages never ask Buffer and never page through deliveries. They read the
 * KV list they already need plus one `getMany` of the two snapshot rows,
 * and work everything out in memory. A Block Kit page and the dashboard
 * widget get ten bridge calls each, and reading 90 days of deliveries and
 * per-channel figures row by row would take dozens.
 *
 * - `ledger`: one small line per delivery, kept for `REPORT_DAYS` days. The
 *   sync's scan phase copies changed deliveries into it, oldest change
 *   first, so it trails the deliveries by one sync at most.
 * - `aggregates`: Buffer's `aggregatedPostMetrics` per channel and day, and
 *   per channel over the last 7, 30 and 90 days, with the backfill's
 *   progress kept beside the figures it describes.
 * - `origins`: the same channels' figures per day split by where each post
 *   was made (PostVia: on the network itself, or through Buffer or its
 *   API), summed from the metrics read's list of sent posts.
 *
 * One row each because storage writes are counted in rows: rewriting one
 * row is cheaper than touching a row per day per channel.
 */

import type { MetricMap } from "../buffer/metrics.js";
import type { RateLimitSnapshot } from "../buffer/ratelimit.js";
import { engagementOf, engagementRateOf, impressionsOf } from "../buffer/metrics.js";
import { addDays, daysBetween, type Day } from "../time/zone.js";
import { capText, isRecord } from "../values.js";
import type { Delivery } from "./deliveries.js";

export { addDays, daysBetween, type Day };

export const REPORTS = "reports";
export const LEDGER_ID = "ledger";
export const AGGREGATES_ID = "aggregates";
export const ORIGINS_ID = "origins";
export const REPORT_KEY = "report";

/** The page offers 90 days and compares with the 90 before: 180 days of history. */
export const REPORT_DAYS = 180;

/** The ranges the page offers, in days. */
export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];

/** A ledger keeps at most this many lines, oldest dropped first, so its row stays small. */
export const LEDGER_MAX = 3000;

export interface LedgerEntry {
	title: string;
	collection: string;
	channelId: string;
	channelName: string;
	service: string;
	status: Delivery["status"];
	postStatus?: string;
	reason?: string;
	createdAt: string;
	sentAt?: string;
	dueAt?: string;
	link?: string;
	/** Absent when Buffer reported none of the engagement types. Never zero-filled. */
	engagement?: number;
	impressions?: number;
	engagementRate?: number;
	postError?: string;
}

export interface Ledger {
	entries: Record<string, LedgerEntry>;
}

export interface AggregateDay {
	/** postCount: posts Buffer matched for the day. */
	posts: number;
	metrics: MetricMap;
	/** Null when Buffer has read no post of the day yet: the figures are not in. */
	metricsUpdatedAt: string | null;
}

export interface ChannelProgress {
	/** The oldest day fetched; every day from it to `recentOn` has been read once. */
	backTo?: Day;
	/** The day on which the last 30 days were last read in full. */
	recentOn?: Day;
	/** Where today's pass over the last 30 days continues, going back. */
	recentNext?: Day;
}

export interface RangeFigures {
	metrics: MetricMap;
	metricsUpdatedAt: string | null;
	/** The days the window really covered, when Buffer's history limit made it shorter than the range. */
	days?: number;
}

export interface Aggregates {
	/**
	 * The IANA time zone the days are keyed in. Rows written before 0.1.5
	 * have none: they were keyed by UTC day, and are read as empty.
	 */
	zone?: string;
	days: Record<string, Record<Day, AggregateDay>>;
	/** Per channel, keyed by the range the page offers ("7", "30", "90"). */
	ranges: Record<string, Partial<Record<string, RangeFigures>>>;
	progress: Record<string, ChannelProgress>;
	/** The day the range figures were last read. */
	rangesOn?: Day;
	/** The day a request failed, so the phase rests until tomorrow. */
	failedOn?: Day;
}

export interface ReportState {
	/**
	 * The IANA time zone the state's days (`metrics.day`, `aggregates.done`,
	 * the origins pass) are in. Absent before 0.1.5, when they were UTC
	 * days. When it differs from the setting, those days are dropped and
	 * read again (`settleDayZone`).
	 */
	dayZone?: string;
	scan?: { after?: string; seen?: string[]; cursor?: string; at?: string; pending?: boolean };
	status?: { at?: string; after?: string; seen?: string[]; pending?: boolean };
	metrics?: { day?: Day; org?: number; cursor?: string; at?: string; from?: Day; since?: Day };
	aggregates?: { at?: string; done?: Day; pending?: boolean; failedAt?: string };
	lastPruneAt?: string;
	/** The last daily channel refresh, whether it worked or not. */
	channelsAt?: string;
	/** A Refresh asked for everything to be read again after this moment. */
	forcedAt?: string;
	/** Buffer rate-limited a report read; no report reads before this. */
	pausedUntil?: string;
	/** The last report read that failed, for the page. */
	problem?: { at: string; kind: string; message: string };
	/** The newest RateLimit reading a report run received, kept with the state the run writes anyway. */
	rateLimit?: RateLimitSnapshot;
	/**
	 * Background reads are paused to leave Buffer requests for the account's
	 * other tools, until `until` (when the window that ran low resets).
	 * Not a failure: posts still go out.
	 */
	headroom?: { at: string; until: string; window: number };
	/**
	 * How far back Buffer gives figures on the account's plan, learnt from
	 * Buffer's own refusal (src/buffer/history.ts). Absent while Buffer has
	 * refused nothing for its age. `checkedAt` is the last time a day just
	 * beyond the limit was asked for, to notice a plan that now goes further.
	 */
	insightsHistory?: { days: number; learntAt: string; checkedAt?: string };
	/**
	 * The last finished pass of the metrics read over posts by origin: when,
	 * the first day it covered, and per channel the posts Buffer listed by
	 * PostVia and how the page splits that channel's figures.
	 */
	origins?: { at: string; since: Day; channels: Record<string, OriginSummary> };
	/** Sums of a pass that spans several pages, until its last page is read. */
	originsWork?: OriginWork;
	/** The chained one-shot run scheduled last. */
	chain?: { next: string; at: string };
	lastSyncAt?: string;
}

/** Figures summed over posts. `engagement` and `impressions` are absent when no post reported them. */
export interface OriginSum {
	posts: number;
	engagement?: number;
	impressions?: number;
}

/** One channel's day, split by where the posts were made. */
export interface OriginDay {
	/** PostVia `network`: made on the network itself. */
	direct?: OriginSum;
	/** PostVia `buffer` or `api`: made in Buffer, by this plugin or another API tool. */
	buffer?: OriginSum;
	/** Posts listed whose figures Buffer has not read yet (`metricsUpdatedAt` null). */
	unread?: number;
}

/**
 * - `listed`: Buffer's post list had posts made on the network, so both
 *   origins are summed from it.
 * - `derived`: it had none, so the direct figure is the channel's
 *   aggregate for the day minus the posts listed (when larger).
 */
export type OriginMethod = "listed" | "derived";

export interface OriginSummary {
	method: OriginMethod;
	counts: { network: number; buffer: number; api: number };
}

export interface OriginWork {
	day: Day;
	/** The first day the pass counts. */
	since: Day;
	/** Every page is read: the origins phase files it. */
	ready?: boolean;
	/** The channels the pass covered, so a channel with no posts is filed as empty. */
	channels?: string[];
	days: Record<string, Record<Day, OriginDay>>;
	counts: Record<string, OriginSummary["counts"]>;
}

export interface Origins {
	/** The IANA time zone the days are keyed in, as for `Aggregates.zone`. */
	zone?: string;
	days: Record<string, Record<Day, OriginDay>>;
	/** Per channel, the oldest day a pass covered: inside it, a day with no entry had no posts listed. */
	coveredFrom: Record<string, Day>;
}

export function emptyOrigins(zone: string): Origins {
	return { zone, days: {}, coveredFrom: {} };
}

/** The `origins` row, or an empty one when it is missing or keyed in another zone (a row from before 0.1.5 is keyed by UTC day). */
export function parseOrigins(raw: unknown, zone: string): Origins {
	if (!isRecord(raw) || raw.zone !== zone) return emptyOrigins(zone);
	return {
		zone,
		days: isRecord(raw.days) ? (raw.days as Origins["days"]) : {},
		coveredFrom: isRecord(raw.coveredFrom) ? (raw.coveredFrom as Origins["coveredFrom"]) : {},
	};
}

export function parseReportState(raw: unknown): ReportState {
	return isRecord(raw) ? (raw as ReportState) : {};
}

export function emptyLedger(): Ledger {
	return { entries: {} };
}

export function emptyAggregates(zone: string): Aggregates {
	return { zone, days: {}, ranges: {}, progress: {} };
}

export function parseLedger(raw: unknown): Ledger {
	return isRecord(raw) && isRecord(raw.entries) ? (raw as unknown as Ledger) : emptyLedger();
}

/** The `aggregates` row, or an empty one when it is missing or keyed in another zone (a row from before 0.1.5 is keyed by UTC day). */
export function parseAggregates(raw: unknown, zone: string): Aggregates {
	if (!isRecord(raw) || raw.zone !== zone) return emptyAggregates(zone);
	return {
		zone,
		days: isRecord(raw.days) ? (raw.days as Aggregates["days"]) : {},
		ranges: isRecord(raw.ranges) ? (raw.ranges as Aggregates["ranges"]) : {},
		progress: isRecord(raw.progress) ? (raw.progress as Aggregates["progress"]) : {},
		...(typeof raw.rangesOn === "string" && { rangesOn: raw.rangesOn }),
		...(typeof raw.failedOn === "string" && { failedOn: raw.failedOn }),
	};
}

/** The ledger line for a delivery. Text is capped so the row stays small. */
export function ledgerEntry(d: Delivery): LedgerEntry {
	const fresh = Boolean(d.metricsUpdatedAt) && d.metrics;
	const engagement = fresh ? engagementOf(d.metrics) : undefined;
	const impressions = fresh ? impressionsOf(d.metrics) : undefined;
	const rate = fresh ? engagementRateOf(d.metrics) : undefined;
	return {
		title: capText(d.entryTitle, 120),
		collection: d.collection,
		channelId: d.channelId,
		channelName: capText(d.channelName, 80),
		service: d.service,
		status: d.status,
		createdAt: d.createdAt,
		...(d.postStatus && { postStatus: d.postStatus }),
		...(d.reason && { reason: capText(d.reason, 120) }),
		...(d.sentAt && { sentAt: d.sentAt }),
		...(d.dueAt && { dueAt: d.dueAt }),
		...(d.externalLink && { link: d.externalLink }),
		...(engagement !== undefined && { engagement }),
		...(impressions !== undefined && { impressions }),
		...(rate !== undefined && { engagementRate: rate }),
		...(d.postError && { postError: capText(d.postError, 200) }),
	};
}

/** Drop lines older than the report window, then the oldest beyond the cap. */
export function trimLedger(ledger: Ledger, now: Date): Ledger {
	const floor = new Date(now.getTime() - REPORT_DAYS * 86_400_000).toISOString();
	const kept = Object.entries(ledger.entries).filter(([, e]) => e.createdAt >= floor);
	kept.sort((a, b) => (a[1].createdAt < b[1].createdAt ? 1 : -1));
	return { entries: Object.fromEntries(kept.slice(0, LEDGER_MAX)) };
}

/**
 * Bring the report state's days into `zone`. When they were worked out in
 * another zone (or in UTC, before 0.1.5, which kept no zone), every day
 * the state holds is dropped: the metrics pass and the aggregates phase
 * are due at once and start again, the origins pass in progress and its
 * summary go, and the history limit Buffer named is kept. The `aggregates`
 * and `origins` rows carry their own zone and read as empty until those
 * phases write them again, so the rebuild costs no extra bridge call.
 * Returns true when anything was dropped.
 */
export function settleDayZone(report: ReportState, zone: string): boolean {
	if (report.dayZone === zone) return false;
	report.dayZone = zone;
	delete report.metrics;
	delete report.aggregates;
	delete report.origins;
	delete report.originsWork;
	return true;
}
