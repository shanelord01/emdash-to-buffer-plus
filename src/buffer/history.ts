/**
 * How far back Buffer gives figures on the account's plan.
 *
 * Buffer does not document a per-plan history limit for insights: the
 * reference's OrganizationLimits has no such field, and neither
 * /guides/post-metrics.md nor /guides/api-limits.md mention one. It shows
 * up only as Buffer's refusal of a window that starts too long ago. On the
 * Free plan, aggregatedPostMetrics answered "Free-plan Insights are limited
 * to the last 31 days of history." (fueloracle.com.au, 3 October 2026).
 *
 * So the limit is learnt from that message and never written down per
 * plan: another plan may name another number, or none. The patterns are
 * loose on purpose (case, "the", "last" or "past", "day" or "days"), and a
 * number outside 1 to 3650 is not believed.
 */

const PATTERNS = [/limited to (?:the )?(?:last|past) (\d+) days?/i, /(\d+) days? of history/i];

/** Buffer caps an aggregate window at 365 days (reference.md: AggregatedPostMetricsInput); ten years is beyond any plan. */
const MAX_DAYS = 3650;

/** The number of days a Buffer error message says the plan's figures go back, or null when it says nothing of the kind. */
export function historyLimitDays(message: string | undefined | null): number | null {
	if (!message) return null;
	for (const pattern of PATTERNS) {
		const match = pattern.exec(message);
		if (!match) continue;
		const days = Number(match[1]);
		if (Number.isInteger(days) && days >= 1 && days <= MAX_DAYS) return days;
	}
	return null;
}

export interface HistoryRefusal {
	/** The smallest limit any of the messages named. */
	days: number;
	/** True when every message was a history refusal, so the request failed for that reason alone. */
	only: boolean;
	/** The first message that was not a history refusal, when there was one. */
	other?: { message: string; code?: string };
}

/**
 * What a set of Buffer error messages says about the history limit: null
 * when none of them is a history refusal.
 */
export function historyRefusal(errors: Array<{ message: string; code?: string }>): HistoryRefusal | null {
	let days: number | null = null;
	let other: { message: string; code?: string } | undefined;
	for (const error of errors) {
		const n = historyLimitDays(error.message);
		if (n === null) {
			other ??= error.code ? { message: error.message, code: error.code } : { message: error.message };
			continue;
		}
		days = days === null ? n : Math.min(days, n);
	}
	if (days === null) return null;
	return { days, only: !other, ...(other && { other }) };
}

/** The days a figure over `days` really covers when Buffer gives only `limit`. */
export function effectiveDays(days: number, limit: number | undefined): number {
	return limit !== undefined && limit < days ? limit : days;
}
