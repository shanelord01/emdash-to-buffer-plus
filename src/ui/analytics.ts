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
import { effectiveDays, historyLimitDays } from "../buffer/history.js";
import { channelBlocker } from "../buffer/services.js";
import { reasonText, t, type Lang } from "../i18n.js";
import {
	aggregatesReach,
	aggregatesSince,
	channelTotals,
	daysIn,
	type OriginSeries,
	failedIn,
	figuresByDay,
	ledgerReaches,
	nextQueued,
	originSeries,
	originTotals,
	periodOf,
	queued,
	reported,
	reportedTotal,
	sendsByDay,
	sentIn,
	topEntries,
	total,
} from "../report/figures.js";
import type { PluginSettings } from "../settings.js";
import { channelConfig, hintsFor, limitFor, storedReadings, type Stored } from "../store/kv.js";
import { daysBetween, RANGES, type Aggregates, type Day, type Ledger, type Origins, type RangeDays } from "../store/report.js";
import { actions, banner, button, colourName, columns, context, dailyChart, empty, header, LINE_TYPES, link, MARKERS, SERIES_COLOURS, stats, table, type LineType, type Marker, type PageBlock, type StatItem } from "./blocks.js";
import { dayOf } from "../time/zone.js";
import { comparisonText, formatAge, formatCount, formatDay, formatRate, formatShortDay, formatTime, trendOf } from "./format.js";

/**
 * The range buttons' action. Each button carries its own id,
 * `buffer:range:<days>` (`rangeAction`): the admin renders an actions
 * block's buttons keyed by `action_id`, so three buttons sharing one id
 * logged React's "two children with the same key". The bare id is what
 * 0.1.5 and earlier sent, with the days in the value, and still works for
 * a page drawn by them.
 */
export const RANGE_ACTION = "buffer:range";

export function rangeAction(days: RangeDays): string {
	return `${RANGE_ACTION}:${days}`;
}

/** Whether an action id is a range button's, new or old. */
export function isRangeAction(actionId: string): boolean {
	return actionId === RANGE_ACTION || actionId.startsWith(`${RANGE_ACTION}:`);
}

/** The range an action asks for: the days in a `buffer:range:<days>` id, else the value (0.1.5 and earlier, and the other buttons). */
export function rangeOf(actionId: string, value: unknown): RangeDays {
	return actionId.startsWith(`${RANGE_ACTION}:`) ? parseRange(actionId.slice(RANGE_ACTION.length + 1)) : parseRange(value);
}
export const PAGE_REFRESH_ACTION = "buffer:refresh";
export const SETUP_ACTION = "buffer:setup";
export const ANALYTICS_ACTION = "buffer:analytics";
export const RETRY_ALL_ACTION = "buffer:retry-all";
export const DEFAULT_RANGE: RangeDays = 30;
export const BUFFER_APP_URL = "https://publish.buffer.com";

const TOP_ENTRIES = 10;

/**
 * Values one figure chart may hold, day labels included. A Block Kit
 * response is capped at 2,000 JSON nodes (BLOCK_RESPONSE_LIMITS.maxNodes),
 * every value is a node, and the page has two figure charts beside the
 * sent chart and the tables: ten channels split two ways over 90 days
 * would be 3,600 values. Past this, a chart keeps its busiest lines.
 */
export const CHART_VALUES = 500;

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
	/** Figures per channel and day by origin (direct or through Buffer). */
	origins: Origins;
	/** Deliveries Buffer refused, counted from storage. */
	failed: number;
	range: RangeDays;
	canManage: boolean;
	now: Date;
}

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
	// Buffer's history limit is a fact about the plan, not a fault: a line of context, not a banner.
	const limit = stored.report.insightsHistory?.days;
	if (limit !== undefined) out.push(context(t(lang, "historyLimit", { days: limit }), { blockId: "buffer:history" }));
	out.push(...banners(input, shared));

	const zone = settings.timeZone;
	const { current, previous } = periodOf(range, now, zone);
	const watch = stored.state.watchSince;
	const ledgerPrev = ledgerReaches(watch, previous, zone);
	const ids = shared.map((c) => c.id);
	// Buffer's figures cover what the plan allows: the last `figureRange` days.
	const figureRange = effectiveDays(range, limit);
	const limited = figureRange < range;
	const figurePeriod = periodOf(figureRange, now, zone);
	const days = figuresByDay(aggregates, ids, figurePeriod.current);
	const prevDays = aggregatesReach(aggregates, ids, figurePeriod.previous) ? figuresByDay(aggregates, ids, figurePeriod.previous) : null;
	const methods = Object.fromEntries(Object.entries(stored.report.origins?.channels ?? {}).map(([id, row]) => [id, row.method]));
	// The last pass of the post list covered every day up to the one it ran on.
	const coveredTo = stored.report.origins ? dayOf(stored.report.origins.at, zone) : undefined;
	const series = originSeries(aggregates, input.origins, shared.map((c) => ({ id: c.id, service: c.service, name: c.displayName || c.name })), methods, figurePeriod.current, coveredTo);

	const sent = sentIn(ledger, current, zone);
	const sentPrev = ledgerPrev ? sentIn(ledger, previous, zone) : null;
	const failed = failedIn(ledger, current, zone);
	const failedPrev = ledgerPrev ? failedIn(ledger, previous, zone) : null;
	const waiting = queued(ledger);
	const next = nextQueued(ledger, now);
	const items: StatItem[] = [
		countStat(t(lang, "sentLastDays", { days: range }), sent, sentPrev, lang, true),
		{
			label: t(lang, "queuedNow"),
			value: formatCount(waiting.length, lang),
			description: waiting.length === 0 ? t(lang, "queuedNone") : next?.dueAt ? t(lang, "queuedNext", { date: formatDay(next.dueAt, lang, zone) }) : t(lang, "queuedWaiting"),
		},
		// No arrow on failures: an arrow up reads as good news.
		countStat(t(lang, "failedLastDays", { days: range }), failed, failedPrev, lang, false),
		figureStat(t(lang, "impressionsLastDays", { days: figureRange }), total(days, "impressions"), prevDays ? total(prevDays, "impressions") : null, prevDays !== null, t(lang, "noImpressionsYet"), lang, splitText(series, "impressions", lang)),
		figureStat(t(lang, "engagementLastDays", { days: figureRange }), total(days, "engagement"), prevDays ? total(prevDays, "engagement") : null, prevDays !== null, t(lang, "noEngagementYet"), lang, splitText(series, "engagement", lang)),
	];
	out.push(stats(items, { blockId: "buffer:stats" }));

	// Every day of the range is on the axis. A day before the plugin watched has no bar and shows "-".
	const sends = new Map(sendsByDay(ledger, current, watch, zone).map((d) => [d.day, d]));
	// A chart of nothing draws an empty 0 to 1 axis: say so instead.
	if (![...sends.values()].some((d) => d.sent > 0 || d.failed > 0)) {
		out.push(empty({ title: t(lang, "chartNothingTitle"), description: t(lang, "chartNothingText"), blockId: "buffer:chart:sent" }));
	} else {
		const rangeDays = daysIn(current);
		out.push(
			dailyChart({
				labels: rangeDays.map((d) => formatShortDay(d, lang)),
				series: [
					{ name: t(lang, "seriesSent"), data: rangeDays.map((d) => sends.get(d)?.sent ?? null) },
					{ name: t(lang, "seriesFailed"), data: rangeDays.map((d) => sends.get(d)?.failed ?? null) },
				],
				style: "bar",
				height: 300,
				blockId: "buffer:chart:sent",
			}),
		);
	}
	const since = aggregatesSince(aggregates, ids);
	const notes = [
		input.stored.report.lastSyncAt ? t(lang, "syncedAgo", { age: formatAge(input.stored.report.lastSyncAt, now, lang) ?? "" }) : t(lang, "notSyncedYet"),
		t(lang, "todayCounting"),
		...(since && daysBetween(figurePeriod.current.start, since) > 0 ? [t(lang, "figuresSince", { date: formatDay(since, lang, zone) })] : []),
	];
	out.push(context(notes.join(" · ")));

	const figureDays = daysIn(figurePeriod.current);
	const drawn = figureCharts(series, ids, figureDays, limited ? figureRange : null, lang);
	out.push(drawn.block);
	const chartNotes = [
		...(drawn.capped ? [t(lang, "chartBusiest", { count: drawn.capped.shown, total: drawn.capped.total })] : []),
		t(lang, "figuresNote"),
		...(series.some((s) => s.origin === "direct" && s.derived) ? [t(lang, "derivedNote")] : []),
		...(series.some((s) => s.origin === "unsplit") ? [t(lang, "unsplitNote")] : []),
	];
	out.push(context(chartNotes.join(" ")));

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
			rows: topEntries(ledger, current, TOP_ENTRIES, zone).map((e) => ({
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
				{ key: "impressions", label: limited ? t(lang, "colImpressionsDays", { days: figureRange }) : t(lang, "colImpressions"), format: "number" },
				{ key: "rate", label: limited ? t(lang, "colEngagementRateDays", { days: figureRange }) : t(lang, "colEngagementRate"), format: "text" },
			],
			rows,
			emptyText: t(lang, "channelsTableEmpty"),
		}),
	);
	out.push(context(limited ? t(lang, "channelsNoteLimited", { days: figureRange }) : t(lang, "channelsNote")));

	const skipped = skippedChannels(input);
	if (skipped) out.push(context(skipped));
	return out;
}

function controls(range: RangeDays, lang: Lang): PageBlock {
	// Buttons, not a select, as on the Umami page: the host's select shows
	// the raw value when closed.
	return actions(
		[
			...RANGES.map((days) => button(rangeAction(days), t(lang, "rangeDays", { count: days }), { style: days === range ? "primary" : "secondary", value: days })),
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
function figureStat(
	label: string,
	current: number | undefined,
	previous: number | undefined | null,
	reaches: boolean,
	missing: string,
	lang: Lang,
	split: string | null = null,
): StatItem {
	// The big value stays short ("None yet"); the description says why.
	if (current === undefined) return { label, value: t(lang, "noneYet"), description: missing };
	const prev = reaches ? (previous ?? null) : null;
	const trend = trendOf(current, prev);
	const comparison = comparisonText(current, prev, lang);
	return { label, value: formatCount(current, lang), description: split ? `${split} · ${comparison}` : comparison, ...(trend && { trend }) };
}

/** "612 direct, 108 via Buffer", when every figure in the range is split by origin and both are known. */
function splitText(series: OriginSeries[], key: "engagement" | "impressions", lang: Lang): string | null {
	const totals = originTotals(series, key);
	return totals ? t(lang, "originSplit", { direct: formatCount(totals.direct, lang), buffer: formatCount(totals.buffer, lang) }) : null;
}

/** "Lines: Facebook (Direct) in solid blue, Facebook (Buffer) in dashed blue." The host's charts have no legend. */
export function linesKey(lines: Array<{ name: string } & SeriesLook>, lang: Lang): string {
	const named = lines.map((line) => {
		const key = colourName(line.colour);
		if (!key) return line.name;
		const look =
			line.marker === "circle"
				? t(lang, "chartLook", { line: t(lang, LINE_KEY[line.line]), colour: t(lang, key) })
				: t(lang, "chartLookMarked", { line: t(lang, LINE_KEY[line.line]), colour: t(lang, key), marker: t(lang, MARKER_KEY[line.marker]) });
		return t(lang, "chartLine", { name: line.name, look });
	});
	return t(lang, "chartLines", { list: named.join(", ") });
}

const SERIES_KEY = { direct: "seriesDirect", buffer: "seriesBuffer", unsplit: "seriesUnsplit" } as const;
const LINE_KEY = { solid: "lineSolid", dashed: "lineDashed", dotted: "lineDotted" } as const;
const MARKER_KEY = { circle: "markerCircle", rect: "markerRect", triangle: "markerTriangle", diamond: "markerDiamond", pin: "markerPin", arrow: "markerArrow" } as const;

/** How a line is drawn: its colour, its line and its point marker. */
export interface SeriesLook {
	colour: string;
	line: LineType;
	marker: Marker;
}

/** Each origin's line: Direct solid, Buffer dashed, Not split dotted. */
const ORIGIN_LINE: Record<OriginSeries["origin"], LineType> = { direct: "solid", buffer: "dashed", unsplit: "dotted" };

/** Every look in order: colours fastest, then markers, then lines. */
const LOOK_COUNT = SERIES_COLOURS.length * MARKERS.length * LINE_TYPES.length;

function lookAt(place: number, line: LineType): SeriesLook {
	const n = SERIES_COLOURS.length;
	return { colour: SERIES_COLOURS[place % n]!, line, marker: MARKERS[Math.floor(place / n) % MARKERS.length]! };
}

const lookKey = (look: SeriesLook) => `${look.colour} ${look.line} ${look.marker}`;

/**
 * A line's look, fixed by its channel and origin. The colour is the
 * channel's: its place among the shared channels in Buffer's order picks
 * from `SERIES_COLOURS` (the host's six, then four more), so every line of
 * one channel has one colour and a channel keeps it on both charts and
 * every range whatever other lines are left out. The origin picks the line
 * (`ORIGIN_LINE`), so a channel's Direct, Buffer and Not split lines are
 * told apart on one chart. Past ten channels the colours come round again
 * with another marker (squares, then triangles, diamonds, pins, arrows),
 * which covers sixty channels before a look repeats; `distinctLooks`
 * settles any repeat on a chart.
 */
export function seriesLook(channelIds: string[], channelId: string, origin: OriginSeries["origin"]): SeriesLook {
	const at = channelIds.indexOf(channelId);
	return lookAt(at < 0 ? channelIds.length : at, ORIGIN_LINE[origin]);
}

/**
 * The looks of one chart's lines, made distinct. A line whose look an
 * earlier line already has moves to the next free one: first the next
 * place with the same line, so the origin still shows, then any free look.
 * Only a channel missing from the shared list or more than sixty channels
 * can repeat a look, so the usual lines keep `seriesLook`'s.
 */
export function distinctLooks<T extends SeriesLook>(lines: T[]): T[] {
	const taken = new Set<string>();
	return lines.map((line) => {
		let look: SeriesLook = line;
		if (taken.has(lookKey(look))) {
			const place = SERIES_COLOURS.indexOf(line.colour as (typeof SERIES_COLOURS)[number]) + SERIES_COLOURS.length * MARKERS.indexOf(line.marker);
			const perLine = SERIES_COLOURS.length * MARKERS.length;
			const candidates = [
				...Array.from({ length: perLine }, (_, i) => lookAt(place + 1 + i, line.line)),
				...Array.from({ length: LOOK_COUNT }, (_, i) => lookAt(i % perLine, LINE_TYPES[Math.floor(i / perLine)]!)),
			];
			look = candidates.find((c) => !taken.has(lookKey(c))) ?? look;
		}
		taken.add(lookKey(look));
		return { ...line, colour: look.colour, line: look.line, marker: look.marker };
	});
}

/**
 * One line per channel and origin, "Facebook (Direct)", in its channel's
 * colour and its origin's line, over every day Buffer's figures can cover. A day with no value
 * is a gap, not a zero. A line with no figure Buffer reported for the
 * chart's metric is left out, so a network that does not report
 * impressions draws no line of zeros, and so is a line with no value on
 * the days drawn. Each line's look comes from `seriesLook`, so a
 * channel and origin look the same on both charts. Past `CHART_VALUES`,
 * each chart keeps its busiest lines and the page says so.
 */
function figureCharts(series: OriginSeries[], channelIds: string[], days: Day[], limitedTo: number | null, lang: Lang): { block: PageBlock; capped: { shown: number; total: number } | null } {
	const labels = days.map((d) => formatShortDay(d, lang));
	const maxLines = Math.max(1, Math.floor((CHART_VALUES - days.length) / Math.max(1, days.length)));
	let capped: { shown: number; total: number } | null = null;
	const chart = (key: "engagement" | "impressions", blockId: string, yAxisName: string) => {
		let lines = series
			.filter((s) => s.days.some((d) => reported(d, key)))
			.map((s) => {
				const byDay = new Map(s.days.map((d) => [d.day, d[key]]));
				return {
					name: t(lang, SERIES_KEY[s.origin], { network: s.name }),
					data: days.map((d) => byDay.get(d) ?? null),
					...seriesLook(channelIds, s.channelId, s.origin),
					size: reportedTotal(s.days, key) ?? 0,
				};
			})
			.filter((line) => line.data.some((v) => typeof v === "number"));
		if (lines.length > maxLines) {
			const keep = new Set([...lines].sort((a, b) => b.size - a.size).slice(0, maxLines));
			capped = { shown: maxLines, total: Math.max(lines.length, capped?.total ?? 0) };
			lines = lines.filter((line) => keep.has(line));
		}
		if (lines.length === 0) return [context(t(lang, "noFigures"))];
		lines = distinctLooks(lines);
		return [
			dailyChart({ labels, series: lines.map(({ name, data, colour, line, marker }) => ({ name, data, colour, line, marker })), style: "line", height: 220, gradient: true, yAxisName, blockId }),
			// The host draws no legend: name each line and its colour.
			context(linesKey(lines, lang), { blockId: `${blockId}:lines` }),
		];
	};
	const block = columns([
		[
			header(limitedTo ? t(lang, "engagementByDayLast", { days: limitedTo }) : t(lang, "engagementByDay")),
			...chart("engagement", "buffer:chart:engagement", t(lang, "axisInteractions")),
		],
		[
			header(limitedTo ? t(lang, "impressionsByDayLast", { days: limitedTo }) : t(lang, "impressionsByDay")),
			...chart("impressions", "buffer:chart:impressions", t(lang, "axisTimesShown")),
		],
	]);
	return { block, capped };
}

function channelName(stored: Stored, id: string): string | undefined {
	const c = stored.channels?.channels.find((ch) => ch.id === id);
	return c ? c.displayName || c.name : undefined;
}

function channelRows(input: AnalyticsInput, shared: BufferChannel[], current: { start: string; end: string }): Array<Record<string, unknown>> {
	const { lang, ledger, aggregates, range, stored } = input;
	return channelTotals(ledger, aggregates, shared.map((c) => c.id), current, range, input.settings.timeZone).map((row) => ({
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
	if (until) out.push(banner({ description: t(lang, "headroomPaused", { time: formatTime(until, lang, settings.timeZone) }), variant: "alert", blockId: "buffer:headroom" }));

	const report = stored.report;
	if (report.pausedUntil && Date.parse(report.pausedUntil) > now.getTime()) {
		out.push(banner({ description: t(lang, "bannerRateLimited", { time: formatAge(report.pausedUntil, now, lang) ?? report.pausedUntil }), variant: "alert" }));
	} else if (report.problem && historyLimitDays(report.problem.message) === null) {
		// A history refusal stored by 0.1.1 is not a fault: the context line above says it.
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
