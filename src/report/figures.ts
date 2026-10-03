/**
 * The figures the Analytics page and the widget show, worked out from the
 * two snapshot rows. Pure, so the page, the widget and later the MCP tools
 * agree.
 *
 * Two sources, never mixed in one figure:
 *
 * - The ledger: what this plugin sent and how each post did (sent, queued,
 *   failed, the top entries). Complete from the moment the plugin started
 *   watching.
 * - Buffer's aggregates per channel and day: impressions and engagement for
 *   every post on the channels this plugin shares to, by the day posts went
 *   out, and Buffer's own engagement rate per channel. These include posts
 *   made in Buffer itself; the page says so.
 *
 * Missing stays missing: a day Buffer has not read (`metricsUpdatedAt`
 * null) adds nothing, a metric a network does not report is absent, and a
 * total over nothing is `undefined`, which the page shows as "No figures
 * yet" rather than 0.
 */

import { engagementOf, engagementRateOf, impressionsOf } from "../buffer/metrics.js";
import { OPEN_POST_STATUSES } from "../store/deliveries.js";
import { addDays, daysBetween, utcDay, type Aggregates, type Day, type Ledger, type LedgerEntry, type OriginMethod, type Origins } from "../store/report.js";

export interface Period {
	start: Day;
	end: Day;
}

export function periodOf(days: number, now: Date): { current: Period; previous: Period } {
	const end = utcDay(now);
	const start = addDays(end, -(days - 1));
	return { current: { start, end }, previous: { start: addDays(start, -days), end: addDays(start, -1) } };
}

export function within(day: Day, p: Period): boolean {
	return daysBetween(p.start, day) >= 0 && daysBetween(day, p.end) >= 0;
}

/** The day a post went out: Buffer's sentAt, else the time it was due. */
export function sentDay(e: LedgerEntry): Day | null {
	const at = e.sentAt ?? e.dueAt;
	return at ? at.slice(0, 10) : null;
}

export function isSent(e: LedgerEntry): boolean {
	return e.status === "sent" && e.postStatus === "sent";
}

export function isQueued(e: LedgerEntry): boolean {
	if (e.status === "pending" || e.status === "sending" || e.status === "unknown") return true;
	return e.status === "sent" && (!e.postStatus || (OPEN_POST_STATUSES as readonly string[]).includes(e.postStatus));
}

/** Refused by Buffer when sent, or accepted and then not published (PostStatus `error`). */
export function isFailed(e: LedgerEntry): boolean {
	return e.status === "failed" || e.postStatus === "error";
}

function failedDay(e: LedgerEntry): Day {
	return e.createdAt.slice(0, 10);
}

export function sentIn(ledger: Ledger, p: Period): number {
	return Object.values(ledger.entries).filter((e) => isSent(e) && within(sentDay(e) ?? "", p)).length;
}

export function failedIn(ledger: Ledger, p: Period): number {
	return Object.values(ledger.entries).filter((e) => isFailed(e) && within(failedDay(e), p)).length;
}

export function queued(ledger: Ledger): LedgerEntry[] {
	return Object.values(ledger.entries).filter(isQueued);
}

/** The queued post due soonest, when Buffer gave it a time. */
export function nextQueued(ledger: Ledger, now: Date): LedgerEntry | undefined {
	return queued(ledger)
		.filter((e) => e.dueAt && Date.parse(e.dueAt) >= now.getTime() - 60_000)
		.sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))[0];
}

/** Sent and failed per day over a period, from the first day the plugin watched. */
export function sendsByDay(ledger: Ledger, p: Period, watchSince: string | undefined): Array<{ day: Day; sent: number; failed: number }> {
	const first = watchSince ? watchSince.slice(0, 10) : p.start;
	const out: Array<{ day: Day; sent: number; failed: number }> = [];
	for (let day = daysBetween(first, p.start) >= 0 ? p.start : first; daysBetween(day, p.end) >= 0; day = addDays(day, 1)) {
		out.push({ day, sent: 0, failed: 0 });
	}
	const index = new Map(out.map((row) => [row.day, row]));
	for (const e of Object.values(ledger.entries)) {
		if (isSent(e)) {
			const row = index.get(sentDay(e) ?? "");
			if (row) row.sent++;
		}
		if (isFailed(e)) {
			const row = index.get(failedDay(e));
			if (row) row.failed++;
		}
	}
	return out;
}

/** Whether the ledger covers a whole period: the plugin was watching from its first day. */
export function ledgerReaches(watchSince: string | undefined, p: Period): boolean {
	return Boolean(watchSince) && daysBetween(watchSince!.slice(0, 10), p.start) >= 0;
}

export interface DayFigures {
	day: Day;
	engagement?: number;
	impressions?: number;
}

/**
 * Engagement and impressions per day across the given channels. A day
 * Buffer has not read for any channel is left out, and impressions only
 * add up channels whose network reported them.
 */
export function figuresByDay(agg: Aggregates, channelIds: string[], p: Period): DayFigures[] {
	const byDay = new Map<Day, DayFigures>();
	for (const c of channelIds) {
		for (const [day, row] of Object.entries(agg.days[c] ?? {})) {
			if (!within(day, p) || !row.metricsUpdatedAt) continue;
			const acc = byDay.get(day) ?? { day };
			const engagement = engagementOf(row.metrics);
			const impressions = impressionsOf(row.metrics);
			if (engagement !== undefined) acc.engagement = (acc.engagement ?? 0) + engagement;
			if (impressions !== undefined) acc.impressions = (acc.impressions ?? 0) + impressions;
			byDay.set(day, acc);
		}
	}
	return [...byDay.values()].sort((a, b) => daysBetween(b.day, a.day));
}

export function total(rows: DayFigures[], key: "engagement" | "impressions"): number | undefined {
	let sum: number | undefined;
	for (const row of rows) if (row[key] !== undefined) sum = (sum ?? 0) + row[key]!;
	return sum;
}

/** Whether every channel's stored days reach back to the start of a period. */
export function aggregatesReach(agg: Aggregates, channelIds: string[], p: Period): boolean {
	return channelIds.length > 0 && channelIds.every((c) => {
		const back = agg.progress[c]?.backTo;
		return Boolean(back) && daysBetween(back!, p.start) >= 0;
	});
}

/** The oldest day the stored figures cover for all the channels, when any. */
export function aggregatesSince(agg: Aggregates, channelIds: string[]): Day | undefined {
	let latest: Day | undefined;
	for (const c of channelIds) {
		const back = agg.progress[c]?.backTo;
		if (!back) return undefined;
		if (!latest || daysBetween(latest, back) > 0) latest = back;
	}
	return latest;
}

export interface ChannelFigures {
	impressions?: number;
	engagementRate?: number;
	/** The days Buffer's figures cover, when its history limit made the window shorter than the range. */
	figureDays?: number;
}

/** Buffer's own figures for a channel over the last `days` days, read daily. */
export function channelFigures(agg: Aggregates, channelId: string, days: number): ChannelFigures {
	const range = agg.ranges[channelId]?.[String(days)];
	if (!range || !range.metricsUpdatedAt) return {};
	const impressions = impressionsOf(range.metrics);
	const rate = engagementRateOf(range.metrics);
	return {
		...(impressions !== undefined && { impressions }),
		...(rate !== undefined && { engagementRate: rate }),
		...(range.days !== undefined && range.days < days && { figureDays: range.days }),
	};
}

/** Our posts with figures, most engaging first. */
export function topEntries(ledger: Ledger, p: Period, limit: number): LedgerEntry[] {
	return Object.values(ledger.entries)
		.filter((e) => isSent(e) && e.engagement !== undefined && within(sentDay(e) ?? "", p))
		.sort((a, b) => b.engagement! - a.engagement! || (b.impressions ?? -1) - (a.impressions ?? -1) || a.title.localeCompare(b.title))
		.slice(0, limit);
}

export interface ChannelTotals extends ChannelFigures {
	channelId: string;
	/** From the newest ledger line, for a channel no longer in Buffer's list. */
	channelName?: string;
	service?: string;
	sent: number;
	failed: number;
}

/**
 * Per channel over a period: this plugin's sent and failed posts from the
 * ledger, and Buffer's own impressions and engagement rate for the channel
 * over the same number of days. Covers the channels given and any other
 * channel the ledger has a post on in the period.
 */
export function channelTotals(ledger: Ledger, agg: Aggregates, channelIds: string[], p: Period, days: number): ChannelTotals[] {
	const entries = Object.values(ledger.entries);
	const ids = new Set(channelIds);
	for (const e of entries) if (within((isSent(e) ? sentDay(e) : e.createdAt.slice(0, 10)) ?? "", p)) ids.add(e.channelId);
	return [...ids].map((id) => {
		const mine = entries.filter((e) => e.channelId === id);
		const sample = mine[0];
		return {
			channelId: id,
			...(sample && { channelName: sample.channelName, service: sample.service }),
			sent: mine.filter((e) => isSent(e) && within(sentDay(e) ?? "", p)).length,
			failed: mine.filter((e) => isFailed(e) && within(failedDay(e), p)).length,
			...channelFigures(agg, id, days),
		};
	});
}

/**
 * The network names the charts use, by Buffer's Service value
 * (reference.md: Service).
 */
export const NETWORK_NAMES: Record<string, string> = {
	bluesky: "Bluesky",
	facebook: "Facebook",
	googlebusiness: "Google Business",
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

export function networkName(service: string): string {
	return NETWORK_NAMES[service] ?? service;
}

export type Origin = "direct" | "buffer" | "unsplit";

export interface OriginSeries {
	channelId: string;
	/** The network's name, with the channel's when two shared channels are on the same network. */
	name: string;
	origin: Origin;
	/** Direct figures worked out as the channel's total minus the posts Buffer listed. */
	derived: boolean;
	days: DayFigures[];
}

/**
 * Each shared channel's figures per day, split by where the posts were
 * made: on the network ("direct") or through Buffer, this plugin included
 * ("buffer"). Days the post list has not covered stay in one "unsplit"
 * series holding the channel's total, so nothing is dropped.
 *
 * How a channel is split is the method its last pass recorded:
 * - `listed`: both origins are the sums of the posts Buffer listed.
 * - `derived`: Buffer listed no post made on the network, so the direct
 *   figure is the channel's aggregate for the day minus the listed posts,
 *   when larger, and only on a day whose listed posts all have figures.
 * Missing stays missing: a series holds only days with a figure.
 */
export function originSeries(
	agg: Aggregates,
	origins: Origins,
	channels: Array<{ id: string; service: string; name: string }>,
	methods: Record<string, OriginMethod | undefined>,
	p: Period,
): OriginSeries[] {
	const perNetwork = new Map<string, number>();
	for (const c of channels) perNetwork.set(c.service, (perNetwork.get(c.service) ?? 0) + 1);
	const out: OriginSeries[] = [];
	for (const c of channels) {
		const name = (perNetwork.get(c.service) ?? 0) > 1 ? `${networkName(c.service)} ${c.name}` : networkName(c.service);
		const method = methods[c.id];
		const covered = origins.coveredFrom[c.id];
		const series = {
			direct: { channelId: c.id, name, origin: "direct" as const, derived: method === "derived", days: [] as DayFigures[] },
			buffer: { channelId: c.id, name, origin: "buffer" as const, derived: false, days: [] as DayFigures[] },
			unsplit: { channelId: c.id, name, origin: "unsplit" as const, derived: false, days: [] as DayFigures[] },
		};
		const dayRows = agg.days[c.id] ?? {};
		const originRows = origins.days[c.id] ?? {};
		const all = new Set([...Object.keys(dayRows), ...Object.keys(originRows)]);
		for (const day of [...all].sort()) {
			if (!within(day, p)) continue;
			const row = dayRows[day];
			const total: DayFigures | null = row?.metricsUpdatedAt ? figuresOf(day, engagementOf(row.metrics), impressionsOf(row.metrics)) : null;
			const split = method && covered && daysBetween(covered, day) >= 0;
			if (!split) {
				if (total && (total.engagement !== undefined || total.impressions !== undefined)) series.unsplit.days.push(total);
				continue;
			}
			const o = originRows[day] ?? {};
			if (o.buffer) push(series.buffer.days, figuresOf(day, o.buffer.engagement, o.buffer.impressions));
			if (method === "listed") {
				if (o.direct) push(series.direct.days, figuresOf(day, o.direct.engagement, o.direct.impressions));
			} else if (total && !o.unread) {
				push(series.direct.days, figuresOf(day, minus(total.engagement, o.buffer?.engagement), minus(total.impressions, o.buffer?.impressions)));
			}
		}
		out.push(series.direct, series.buffer, series.unsplit);
	}
	return out.filter((s) => s.days.length > 0);
}

function figuresOf(day: Day, engagement: number | undefined, impressions: number | undefined): DayFigures {
	return { day, ...(engagement !== undefined && { engagement }), ...(impressions !== undefined && { impressions }) };
}

function push(list: DayFigures[], row: DayFigures): void {
	if (row.engagement !== undefined || row.impressions !== undefined) list.push(row);
}

/** The channel's total less the listed posts, only when the total is larger. */
function minus(total: number | undefined, listed: number | undefined): number | undefined {
	if (total === undefined) return undefined;
	const rest = total - (listed ?? 0);
	return rest > 0 ? rest : undefined;
}

/**
 * Direct and via-Buffer totals of one figure over the series, or null when
 * any of it is unsplit (the parts would not add up to the total).
 */
export function originTotals(series: OriginSeries[], key: "engagement" | "impressions"): { direct: number; buffer: number } | null {
	let direct: number | undefined;
	let buffer: number | undefined;
	for (const s of series) {
		const sum = total(s.days, key);
		if (sum === undefined) continue;
		if (s.origin === "unsplit") return null;
		if (s.origin === "direct") direct = (direct ?? 0) + sum;
		else buffer = (buffer ?? 0) + sum;
	}
	return direct !== undefined && buffer !== undefined ? { direct, buffer } : null;
}
