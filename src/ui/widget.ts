/**
 * The dashboard widget: the last seven days at a glance.
 *
 * Reads stored snapshots only. The widget dispatches one `page_load` per
 * mount (emdash admin SandboxedPluginWidget, page `widget:<id>`), so a
 * render that asked Buffer would ask once per editor per dashboard visit.
 */

import { effectiveDays } from "../buffer/history.js";
import { t, type Lang } from "../i18n.js";
import { failedIn, figuresByDay, ledgerReaches, nextQueued, periodOf, queued, sentIn, total } from "../report/figures.js";
import type { PluginSettings } from "../settings.js";
import type { Stored } from "../store/kv.js";
import type { Aggregates, Ledger } from "../store/report.js";
import { PAGE_PATH } from "./page.js";
import { sharedChannels } from "./analytics.js";
import { actions, button, context, empty, link, stats, type PageBlock } from "./blocks.js";
import { comparisonText, formatCount, formatDay, trendOf } from "./format.js";

export const WIDGET_ID = "summary";
export const WIDGET_PAGE = `widget:${WIDGET_ID}`;
export const WIDGET_REFRESH_ACTION = "buffer:widget:refresh";
export const WIDGET_DAYS = 7;

export interface WidgetInput {
	lang: Lang;
	settings: PluginSettings;
	stored: Stored;
	ledger: Ledger;
	aggregates: Aggregates;
	now: Date;
}

export function renderWidget(input: WidgetInput): PageBlock[] {
	const { lang, settings, stored, ledger, aggregates, now } = input;
	const shared = sharedChannels(stored);
	const pageLink = link(t(lang, "openPage"), { kind: "plugin-page", path: PAGE_PATH }, { appearance: "secondary" });

	if (Object.keys(ledger.entries).length === 0 && (!settings.accessToken || shared.length === 0)) {
		return [
			empty({
				title: t(lang, "nothingYetTitle"),
				description: t(lang, settings.accessToken ? "nothingYetNoChannels" : "nothingYetNoKey"),
				actions: [pageLink],
			}),
		];
	}

	const { current, previous } = periodOf(WIDGET_DAYS, now);
	const reaches = ledgerReaches(stored.state.watchSince, previous);
	const sent = sentIn(ledger, current);
	const sentPrev = reaches ? sentIn(ledger, previous) : null;
	const failed = failedIn(ledger, current);
	const failedPrev = reaches ? failedIn(ledger, previous) : null;
	// Buffer's figures cover only what the plan allows, should that be under a week.
	const figureDays = effectiveDays(WIDGET_DAYS, stored.report.insightsHistory?.days);
	const engagement = total(figuresByDay(aggregates, shared.map((c) => c.id), periodOf(figureDays, now).current), "engagement");
	const waiting = queued(ledger);
	const next = nextQueued(ledger, now);
	const sentTrend = trendOf(sent, sentPrev);

	// Three short cards fit a half-width widget (the Umami plugin's is half
	// width too). Engagement goes in a line of text, so a missing figure
	// never becomes a card's big value.
	const out: PageBlock[] = [
		stats([
			{ label: t(lang, "widgetSent"), value: formatCount(sent, lang), description: comparisonText(sent, sentPrev, lang), ...(sentTrend && { trend: sentTrend }) },
			{ label: t(lang, "widgetFailed"), value: formatCount(failed, lang), description: comparisonText(failed, failedPrev, lang) },
			{
				label: t(lang, "widgetQueued"),
				value: formatCount(waiting.length, lang),
				description: waiting.length === 0 ? t(lang, "queuedNone") : next?.dueAt ? t(lang, "queuedNext", { date: formatDay(next.dueAt, lang) }) : t(lang, "queuedWaiting"),
			},
		]),
		context(
			engagement === undefined
				? t(lang, "widgetNoEngagement", { days: figureDays })
				: t(lang, "widgetEngagement", { days: figureDays, count: formatCount(engagement, lang) }),
		),
	];
	if (next?.dueAt) out.push(context(t(lang, "nextQueued", { title: next.title || t(lang, "untitled"), date: formatDay(next.dueAt, lang) })));
	out.push(context(t(lang, "thisWeekNote")));
	out.push(actions([button(WIDGET_REFRESH_ACTION, t(lang, "refresh"), { style: "secondary" }), pageLink]));
	return out;
}
