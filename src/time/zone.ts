/**
 * Calendar days in one IANA time zone, worked out with
 * `Intl.DateTimeFormat` parts and never with hand-written offsets, so
 * daylight saving moves the day boundaries by itself.
 *
 * A day is a calendar date, `YYYY-MM-DD`, in the zone the caller names.
 * Adding days to a date and counting the days between two dates is
 * calendar arithmetic and does not depend on the zone. Only turning an
 * instant into its day (`dayOf`) and a day into the instants it spans
 * (`dayStart`, `dayEnd`) needs the zone.
 *
 * Self-contained, with no imports, so other plugins can copy it as it is.
 */

/** A calendar day, `YYYY-MM-DD`, in the zone it was worked out in. */
export type Day = string;

/** The zone used when none is set or the one set is not a time zone the runtime knows. */
export const DEFAULT_TIME_ZONE = "Australia/Sydney";

const DAY_MS = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One cached formatter per zone, giving every part of a moment on the 24-hour clock. */
function partsFormatter(zone: string): Intl.DateTimeFormat {
	let f = formatters.get(zone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		});
		formatters.set(zone, f);
	}
	return f;
}

/**
 * The IANA zone to use: `raw` when the runtime knows it (in its canonical
 * spelling, so "australia/sydney" becomes "Australia/Sydney"), else
 * `fallback`. Never throws.
 */
export function resolveTimeZone(raw: unknown, fallback = DEFAULT_TIME_ZONE): string {
	if (typeof raw !== "string" || raw.trim() === "") return fallback;
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: raw.trim() }).resolvedOptions().timeZone;
	} catch {
		return fallback;
	}
}

interface WallClock {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function wallClock(ms: number, zone: string): WallClock {
	const out: Record<string, number> = {};
	for (const part of partsFormatter(zone).formatToParts(ms)) {
		if (part.type !== "literal") out[part.type] = Number(part.value);
	}
	return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour!, minute: out.minute!, second: out.second! };
}

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

/** The zone's offset from UTC at a moment, in milliseconds (positive east of Greenwich). */
function offsetAt(ms: number, zone: string): number {
	const w = wallClock(ms, zone);
	const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
	return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The day a moment falls on in the zone. Takes a Date, an ISO string or epoch milliseconds. */
export function dayOf(at: Date | string | number, zone: string): Day {
	const ms = at instanceof Date ? at.getTime() : typeof at === "string" ? Date.parse(at) : at;
	const w = wallClock(ms, zone);
	return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** The day `n` calendar days after `day` (before, when `n` is negative). */
export function addDays(day: Day, n: number): Day {
	return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: Day, b: Day): number {
	return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / DAY_MS);
}

/** Whether a string is a calendar day, `YYYY-MM-DD`, rather than a moment. */
export function isDay(value: string): boolean {
	return DAY_RE.test(value);
}

const starts = new Map<string, number>();

/**
 * The first moment of a day in the zone, in epoch milliseconds. Usually
 * local midnight. Where a clock change skips midnight, it is the moment
 * the day's clock starts, and where midnight happens twice, the first.
 */
export function dayStartMs(day: Day, zone: string): number {
	const key = `${zone} ${day}`;
	const known = starts.get(key);
	if (known !== undefined) return known;
	const midnight = Date.parse(`${day}T00:00:00.000Z`);
	// Local midnight read as if it were UTC, corrected by the offset at the
	// guess and then by the offset at the result: either can be right when
	// the offset changes near midnight, so both are tried.
	const first = midnight - offsetAt(midnight, zone);
	const second = midnight - offsetAt(first, zone);
	const onDay = [first, second].filter((ms) => dayOf(ms, zone) === day);
	const start = onDay.length > 0 ? Math.min(...onDay) : first;
	starts.set(key, start);
	return start;
}

/** A moment as Buffer's DateTime takes it, to the second: `2026-09-26T14:00:00Z`. */
export function isoSeconds(ms: number): string {
	return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** The first moment of a day in the zone, as an ISO 8601 UTC instant to the second. */
export function dayStart(day: Day, zone: string): string {
	return isoSeconds(dayStartMs(day, zone));
}

/**
 * The last second of a day in the zone, as an ISO 8601 UTC instant: one
 * second before the next day starts. A day is 23 or 25 hours long when
 * the clocks change during it.
 */
export function dayEnd(day: Day, zone: string): string {
	return isoSeconds(dayStartMs(addDays(day, 1), zone) - 1000);
}
