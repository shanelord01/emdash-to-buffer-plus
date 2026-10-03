/**
 * The Analytics view of the Buffer page, laid out like the Umami plugin's
 * Analytics page: one actions row (range buttons, Refresh, links), banners
 * for anything that needs a person, stats with a trend against the
 * previous period, the main chart at 300 px, two smaller charts side by
 * side at 220 px, then tables.
 *
 * Reads stored snapshots only (`src/store/report.ts`). Block Kit keeps no
 * state, so the range travels in the buttons' `value`.
 */

import type { BufferChannel } from "../buffer/client.js";
import { backgroundDecision } from "../buffer/headroom.js";
import { channelBlocker } from "../buffer/services.js";
import { reasonText, t, type Lang } from "../i18n.js";
import {
	aggregatesReach,
	aggregatesSince,
	channelTotals,
	failedIn,
	figuresByDay,
	ledgerReaches,
	nextQueued,
	periodOf,
	queued,
	sendsByDay,
	sentIn,
	topEntries,
	total,
} from "../report/figures.js";
import type { PluginSettings } from "../settings.js";
import { channelConfig, hintsFor, limitFor, storedReadings, type Stored } from "../store/kv.js";
import { daysBetween, RANGES, type Aggregates, type Ledger, type RangeDays } from "../store/report.js";
import { actions, banner, button, columns, context, empty, header, link, stats, table, timeseries, type PageBlock, type StatItem } from "./blocks.js";
import { comparisonText, formatAge, formatCount, formatDay, formatRate, formatTime, trendOf } from "./format.js";

export const RANGE_ACTION = "buffer:range";
export const PAGE_REFRESH_ACTION = "buffer:refresh";
export const SETUP_ACTION = "buffer:setup";
export const ANALYTICS_ACTION = "buffer:analytics";
export const RETRY_ALL_ACTION = "buffer:retry-all";
export const DEFAULT_RANGE: RangeDays = 30;
export const BUFFER_APP_URL = "https://publish.buffer.com";

const TOP_ENTRIES = 10;

export function parseRange(value: unknown): RangeDays {
	const n = typeof value === "string" ? Number(value) : value;
	return (RANGES as readonly unknown[]).includes(n) ? (n as RangeDays) : DEFAULT_RANGE;
}

export interface AnalyticsInput {
	lang: Lang;
	settings: PluginSettings;
	stored: Stored;
	ledger: Ledger;
	aggregates: Aggregates;
	/** Deliveries Buffer refused, counted from storage. */
	failed: number;
	range: RangeDays;
	canManage: boolean;
	now: Date;
}

const at = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

/** The channels the report covers: the ones switched on, in Buffer's order. */
export function sharedChannels(stored: Stored): BufferChannel[] {
	return (stored.channels?.channels ?? []).filter((c) => stored.config.channels[c.id]?.enabled);
}

export function renderAnalytics(input: AnalyticsInput): PageBlock[] {
	const { lang, settings, stored, ledger, aggregates, range, now } = input;
	const shared = sharedChannels(stored);
	const hasData = Object.keys(ledger.entries).length > 0;

	if (!hasData && input.failed === 0 && (!settings.accessToken || shared.length === 0)) {
		return [
			empty({
				title: t(lang, "nothingYetTitle"),
				description: t(lang, settings.accessToken ? "nothingYetNoChannels" : "nothingYetNoKey"),
				actions: [button(SETUP_ACTION, t(lang, "setup"), { style: "primary", value: range })],
			}),
		];
	}

	const out: PageBlock[] = [controls(range, lang)];
	out.push(...banners(input, shared));

	const { current, previous } = periodOf(range, now);
	const watch = stored.state.watchSince;
	const ledgerPrev = ledgerReaches(watch, previous);
	const ids = shared.map((c) => c.id);
	const days = figuresByDay(aggregates, ids, current);
	const prevDays = aggregatesReach(aggregates, ids, previous) ? figuresByDay(aggregates, ids, previous) : null;

	const sent = sentIn(ledger, current);
	const sentPrev = ledgerPrev ? sentIn(ledger, previous) : null;
	const failed = failedIn(ledger, current);
	const failedPrev = ledgerPrev ? failedIn(ledger, previous) : null;
	const waiting = queued(ledger);
	const next = nextQueued(ledger, now);
	const items: StatItem[] = [
		countStat(t(lang, "sentLastDays", { days: range }), sent, sentPrev, lang, true),
		{
			label: t(lang, "queuedNow"),
			value: formatCount(waiting.length, lang),
			description: waiting.length === 0 ? t(lang, "queuedNone") : next?.dueAt ? t(lang, "queuedNext", { date: formatDay(next.dueAt, lang) }) : t(lang, "queuedWaiting"),
		},
		// No arrow on failures: an arrow up reads as good news.
		countStat(t(lang, "failedLastDays", { days: range }), failed, failedPrev, lang, false),
		figureStat(t(lang, "impressionsLastDays", { days: range }), total(days, "impressions"), prevDays ? total(prevDays, "impressions") : null, prevDays !== null, t(lang, "noImpressionsYet"), lang),
		figureStat(t(lang, "engagementLastDays", { days: range }), total(days, "engagement"), prevDays ? total(prevDays, "engagement") : null, prevDays !== null, t(lang, "noEngagementYet"), lang),
	];
	out.push(stats(items, { blockId: "buffer:stats" }));

	const sends = sendsByDay(ledger, current, watch);
	// A chart of nothing draws an empty 0 to 1 axis: say so instead.
	if (!sends.some((d) => d.sent > 0 || d.failed > 0)) {
		out.push(empty({ title: t(lang, "chartNothingTitle"), description: t(lang, "chartNothingText"), blockId: "buffer:chart:sent" }));
	} else {
		out.push(
			timeseries(
				[
					{ name: t(lang, "seriesSent"), data: sends.map((d) => [at(d.day), d.sent] as [number, number]) },
					{ name: t(lang, "seriesFailed"), data: sends.map((d) => [at(d.day), d.failed] as [number, number]) },
				],
				{ blockId: "buffer:chart:sent", height: 300, style: "bar" },
			),
		);
	}
	const since = aggregatesSince(aggregates, ids);
	const notes = [
		input.stored.report.lastSyncAt ? t(lang, "syncedAgo", { age: formatAge(input.stored.report.lastSyncAt, now, lang) ?? "" }) : t(lang, "notSyncedYet"),
		t(lang, "todayCounting"),
		...(since && daysBetween(current.start, since) > 0 ? [t(lang, "figuresSince", { date: formatDay(since, lang) })] : []),
	];
	out.push(context(notes.join(" · ")));

	out.push(figureCharts(days, lang));
	out.push(context(t(lang, "figuresNote")));

	out.push(header(t(lang, "topEntries")));
	out.push(
		table({
			blockId: "buffer:top",
			pageActionId: "buffer:top:page",
			columns: [
				{ key: "entry", label: t(lang, "colEntry"), format: "text" },
				{ key: "channel", label: t(lang, "colChannel"), format: "text" },
				{ key: "service", label: t(lang, "colService"), format: "code" },
				{ key: "engagement", label: t(lang, "colEngagement"), format: "number" },
				{ key: "impressions", label: t(lang, "colImpressions"), format: "number" },
				{ key: "post", label: t(lang, "colPost"), format: "element" },
			],
			rows: topEntries(ledger, current, TOP_ENTRIES).map((e) => ({
				entry: e.title || t(lang, "untitled"),
				channel: channelName(stored, e.channelId) ?? e.channelName,
				service: e.service,
				engagement: e.engagement!,
				// A number column turns null into 0 (Number(null)), so a missing
				// figure is sent as text, which the renderer shows as it is.
				impressions: e.impressions ?? t(lang, "noFigures"),
				post: e.link ? link(t(lang, "viewPost"), { kind: "external", url: e.link }, { appearance: "inline" }) : null,
			})),
			emptyText: t(lang, "topEntriesEmpty"),
		}),
	);

	out.push(header(t(lang, "channelsHeader")));
	const rows = channelRows(input, shared, current);
	out.push(
		table({
			blockId: "buffer:channels-report",
			pageActionId: "buffer:channels-report:page",
			columns: [
				{ key: "channel", label: t(lang, "colChannel"), format: "text" },
				{ key: "service", label: t(lang, "colService"), format: "code" },
				{ key: "sent", label: t(lang, "colSent"), format: "number" },
				{ key: "failed", label: t(lang, "colFailed"), format: "number" },
				{ key: "impressions", label: t(lang, "colImpressions"), format: "number" },
				{ key: "rate", label: t(lang, "colEngagementRate"), format: "text" },
			],
			rows,
			emptyText: t(lang, "channelsTableEmpty"),
		}),
	);
	out.push(context(t(lang, "channelsNote")));

	const skipped = skippedChannels(input);
	if (skipped) out.push(context(skipped));
	return out;
}

function controls(range: RangeDays, lang: Lang): PageBlock {
	// Buttons, not a select, as on the Umami page: the host's select shows
	// the raw value when closed.
	return actions(
		[
			...RANGES.map((days) => button(RANGE_ACTION, t(lang, "rangeDays", { count: days }), { style: days === range ? "primary" : "secondary", value: days })),
			button(PAGE_REFRESH_ACTION, t(lang, "refresh"), { style: "secondary", value: range }),
			link(t(lang, "openInBuffer"), { kind: "external", url: BUFFER_APP_URL }, { appearance: "secondary" }),
			button(SETUP_ACTION, t(lang, "setup"), { style: "secondary", value: range }),
		],
		{ blockId: "buffer:controls" },
	);
}

function countStat(label: string, current: number, previous: number | null, lang: Lang, arrow: boolean): StatItem {
	const trend = arrow ? trendOf(current, previous) : null;
	return { label, value: formatCount(current, lang), description: comparisonText(current, previous, lang), ...(trend && { trend }) };
}

/** A Buffer figure: missing when Buffer reported nothing, never zero. */
function figureStat(label: string, current: number | undefined, previous: number | undefined | null, reaches: boolean, missing: string, lang: Lang): StatItem {
	// The big value stays short ("None yet"); the description says why.
	if (current === undefined) return { label, value: t(lang, "noneYet"), description: missing };
	const prev = reaches ? (previous ?? null) : null;
	const trend = trendOf(current, prev);
	return { label, value: formatCount(current, lang), description: comparisonText(current, prev, lang), ...(trend && { trend }) };
}

function figureCharts(days: ReturnType<typeof figuresByDay>, lang: Lang): PageBlock {
	const engagement = days.filter((d) => d.engagement !== undefined);
	const impressions = days.filter((d) => d.impressions !== undefined);
	return columns([
		[
			header(t(lang, "engagementByDay")),
			engagement.length > 0
				? timeseries([{ name: t(lang, "seriesEngagement"), data: engagement.map((d) => [at(d.day), d.engagement!] as [number, number]) }], {
						blockId: "buffer:chart:engagement",
						height: 220,
						gradient: true,
						yAxisName: t(lang, "axisInteractions"),
					})
				: context(t(lang, "noFigures")),
		],
		[
			header(t(lang, "impressionsByDay")),
			impressions.length > 0
				? timeseries([{ name: t(lang, "seriesImpressions"), data: impressions.map((d) => [at(d.day), d.impressions!] as [number, number]) }], {
						blockId: "buffer:chart:impressions",
						height: 220,
						gradient: true,
						yAxisName: t(lang, "axisTimesShown"),
					})
				: context(t(lang, "noFigures")),
		],
	]);
}

function channelName(stored: Stored, id: string): string | undefined {
	const c = stored.channels?.channels.find((ch) => ch.id === id);
	return c ? c.displayName || c.name : undefined;
}

function channelRows(input: AnalyticsInput, shared: BufferChannel[], current: { start: string; end: string }): Array<Record<string, unknown>> {
	const { lang, ledger, aggregates, range, stored } = input;
	return channelTotals(ledger, aggregates, shared.map((c) => c.id), current, range).map((row) => ({
		channel: channelName(stored, row.channelId) ?? row.channelName ?? row.channelId,
		service: stored.channels?.channels.find((c) => c.id === row.channelId)?.service ?? row.service ?? "",
		sent: row.sent,
		failed: row.failed,
		impressions: row.impressions ?? t(lang, "noFigures"),
		rate: row.engagementRate !== undefined ? formatRate(row.engagementRate, lang) : t(lang, "noFigures"),
	}));
}

function banners(input: AnalyticsInput, shared: BufferChannel[]): PageBlock[] {
	const { lang, settings, stored, ledger, canManage, now, range } = input;
	const out: PageBlock[] = [];
	if (!settings.enabled) out.push(banner({ description: t(lang, "paused"), variant: "alert" }));

	if (input.failed > 0) {
		out.push(banner({ description: t(lang, "failedBanner", { count: input.failed }), variant: "error", blockId: "buffer:failed" }));
		if (canManage) out.push(actions([button(RETRY_ALL_ACTION, t(lang, "retryAll"), { style: "primary", value: range })]));
	}

	const publishErrors = Object.values(ledger.entries)
		.filter((e) => e.postStatus === "error")
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
	if (publishErrors.length > 0) {
		out.push(
			banner({
				description: `${t(lang, "publishErrors", { count: publishErrors.length, message: publishErrors[0]!.postError ?? "" })} ${t(lang, "publishErrorsHelp")}`,
				variant: "error",
			}),
		);
	}

	const names = (pick: (c: BufferChannel) => boolean) => shared.filter(pick).map((c) => c.displayName || c.name).join(", ");
	const disconnected = names((c) => c.isDisconnected);
	if (disconnected) out.push(banner({ description: t(lang, "bannerDisconnected", { names: disconnected }), variant: "error" }));
	const locked = names((c) => c.isLocked);
	if (locked) out.push(banner({ description: t(lang, "bannerLocked", { names: locked }), variant: "error" }));
	const pausedQueue = names((c) => c.isQueuePaused);
	if (pausedQueue) out.push(banner({ description: t(lang, "bannerQueuePaused", { names: pausedQueue }), variant: "alert" }));
	const atLimit = names((c) => Boolean(limitFor(stored.channels, c.id)?.isAtLimit));
	if (atLimit) out.push(banner({ description: t(lang, "bannerAtLimit", { names: atLimit }), variant: "alert" }));

	const until = headroomPausedUntil(settings, stored, now);
	if (until) out.push(banner({ description: t(lang, "headroomPaused", { time: formatTime(until, lang) }), variant: "alert", blockId: "buffer:headroom" }));

	const report = stored.report;
	if (report.pausedUntil && Date.parse(report.pausedUntil) > now.getTime()) {
		out.push(banner({ description: t(lang, "bannerRateLimited", { time: formatAge(report.pausedUntil, now, lang) ?? report.pausedUntil }), variant: "alert" }));
	} else if (report.problem) {
		out.push(banner({ description: t(lang, "bannerProblem", { message: report.problem.message }), variant: "alert" }));
	}
	return out;
}

/**
 * When background reads are paused to leave Buffer requests for the
 * account's other tools, the moment they resume; null while they run.
 * Worked out from the stored readings now, so the notice goes the moment
 * the window that ran low resets, without waiting for a sync.
 */
export function headroomPausedUntil(settings: PluginSettings, stored: Stored, now: Date): string | null {
	const decision = backgroundDecision(storedReadings(stored, now), settings.headroomPercent);
	return decision.allowed ? null : decision.until;
}

/** Channels the plugin cannot post to, each with Buffer's or the rule table's reason. */
export function skippedChannels(input: AnalyticsInput): string | null {
	const { lang, stored } = input;
	const list = (stored.channels?.channels ?? []).flatMap((c) => {
		const cfg = channelConfig(stored.config, c.id);
		const reason = channelBlocker(c.service, c, { boardServiceId: cfg.boardServiceId }, hintsFor(stored.channels, c.id));
		return reason ? [`${c.displayName || c.name} (${reasonText(lang, reason).replace(/\.$/, "")})`] : [];
	});
	return list.length > 0 ? t(lang, "skippedNote", { list: list.join("; ") }) : null;
}
