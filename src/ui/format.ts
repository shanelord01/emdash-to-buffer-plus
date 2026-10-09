/**
 * Formatting for the admin UI, after the Umami plugin's `src/ui/format.ts`.
 * Pure. Numbers, dates and relative times use the catalogue's language so
 * they never mix with the text around them.
 */

import { t, type Lang } from "../i18n.js";
import { dayOf, isDay } from "../time/zone.js";

export function formatCount(value: number, lang: Lang): string {
	if (!Number.isFinite(value)) return "0";
	try {
		return new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(value);
	} catch {
		return String(Math.round(value));
	}
}

/**
 * Buffer's engagementRate is 0 to 100 (PostMetricUnit `percentage`). Always
 * one decimal place, so rates in one column line up ("3.0%" beside "4.2%").
 */
export function formatRate(percent: number, lang: Lang): string {
	try {
		return new Intl.NumberFormat(lang, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(percent / 100);
	} catch {
		return `${(Math.round(percent * 10) / 10).toFixed(1)}%`;
	}
}

/** "3 minutes ago", or null for a missing or unreadable timestamp. */
export function formatAge(iso: string | undefined, now: Date, lang: Lang): string | null {
	if (!iso) return null;
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return null;
	const seconds = Math.round((then - now.getTime()) / 1000);
	const abs = Math.abs(seconds);
	const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
		abs < 60 ? [seconds, "second"] : abs < 3600 ? [Math.round(seconds / 60), "minute"] : abs < 86_400 ? [Math.round(seconds / 3600), "hour"] : [Math.round(seconds / 86_400), "day"];
	try {
		return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(value, unit);
	} catch {
		return `${Math.abs(value)} ${unit}s ago`;
	}
}

function localeOf(lang: Lang): string {
	return lang === "en" ? "en-AU" : lang;
}

/**
 * A day the reader's way: "18 Sept 2026". A calendar day (`YYYY-MM-DD`,
 * already worked out in the "Time zone" setting) is shown as that date.
 * A moment (`Post.dueAt` and the like) is shown as the day it falls on in
 * `zone`.
 */
export function formatDay(day: string, lang: Lang, zone: string): string {
	const calendar = isDay(day);
	const ms = calendar ? Date.parse(`${day}T00:00:00.000Z`) : Date.parse(day);
	if (Number.isNaN(ms)) return day;
	try {
		return new Intl.DateTimeFormat(localeOf(lang), { dateStyle: "medium", timeZone: calendar ? "UTC" : zone }).format(ms);
	} catch {
		return calendar ? day : dayOf(ms, zone);
	}
}

/**
 * A calendar day as a chart label: "23 Sept". The day is already in the
 * "Time zone" setting, so it is shown as the date it names, never moved.
 */
export function formatShortDay(day: string, lang: Lang): string {
	const ms = Date.parse(`${day.slice(0, 10)}T00:00:00.000Z`);
	if (Number.isNaN(ms)) return day;
	try {
		return new Intl.DateTimeFormat(localeOf(lang), { day: "numeric", month: "short", timeZone: "UTC" }).format(ms);
	} catch {
		return day.slice(5, 10);
	}
}

export type Trend = "up" | "down" | "neutral";

/** Null when there is no earlier period to compare with: "neutral" would claim "unchanged". */
export function trendOf(current: number, previous: number | null): Trend | null {
	if (previous === null) return null;
	if (current > previous) return "up";
	if (current < previous) return "down";
	return "neutral";
}

/** The sentence under a stat. Growth from zero has no percentage. */
export function comparisonText(current: number, previous: number | null, lang: Lang): string {
	if (previous === null) return t(lang, "noEarlierPeriod");
	if (previous === 0 && current === 0) return t(lang, "noneEitherPeriod");
	if (previous === 0) return t(lang, "upFromNone");
	const ratio = (current - previous) / previous;
	const change = new Intl.NumberFormat(lang, {
		style: "percent",
		signDisplay: "exceptZero",
		maximumFractionDigits: Math.abs(ratio) < 0.01 ? 1 : 0,
	}).format(ratio);
	return t(lang, "vsPrevious", { change });
}

/**
 * A moment with its time in the "Time zone" setting, labelled with the
 * zone's short name: "4 Oct 2026, 9:30 am AEST". Buffer's own times
 * (Post.dueAt, Post.sentAt) are UTC instants.
 */
export function formatTime(iso: string, lang: Lang, zone: string): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return iso;
	try {
		return new Intl.DateTimeFormat(localeOf(lang), {
			day: "numeric",
			month: "short",
			year: "numeric",
			hour: "numeric",
			minute: "2-digit",
			timeZone: zone,
			timeZoneName: "short",
		}).format(ms);
	} catch {
		return `${iso.slice(0, 16).replace("T", " ")} UTC`;
	}
}
