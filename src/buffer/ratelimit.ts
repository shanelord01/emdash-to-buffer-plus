/**
 * Buffer's RateLimit headers (developers.buffer.com /guides/api-limits.md).
 *
 * Every authenticated response carries one `RateLimit` and one
 * `RateLimit-Policy` entry per window (15 minutes, 24 hours, 30 days).
 * `fetch` joins repeated headers into one string, so the entries are split on
 * the comma before each quoted policy name. Policy names change with the plan,
 * so a window is matched by its length `w` from `RateLimit-Policy`, joined to
 * `RateLimit` by name, as the guide advises.
 */

export interface RateLimitWindow {
	/** The policy name, e.g. "100-in-15min". */
	name: string;
	/** Window length in seconds (900, 86400, 2592000), when the policy header named it. */
	window?: number;
	/** The quota, when the policy header named it. */
	quota?: number;
	/** Requests remaining. */
	remaining: number;
	/** Seconds until the window resets. */
	resetSeconds?: number;
}

export interface RateLimitSnapshot {
	at: string;
	windows: RateLimitWindow[];
}

export function parseRateLimit(headers: Headers, now: Date): RateLimitSnapshot | undefined {
	const live = headers.get("ratelimit");
	if (!live) return undefined;
	const policies = new Map<string, { window?: number; quota?: number }>();
	for (const entry of splitEntries(headers.get("ratelimit-policy") ?? "")) {
		const name = policyName(entry);
		if (!name) continue;
		policies.set(name, { window: param(entry, "w"), quota: param(entry, "q") });
	}
	const windows: RateLimitWindow[] = [];
	for (const entry of splitEntries(live)) {
		const name = policyName(entry);
		const remaining = param(entry, "r");
		if (!name || remaining === undefined) continue;
		const policy = policies.get(name);
		windows.push({
			name,
			remaining,
			...(param(entry, "t") !== undefined && { resetSeconds: param(entry, "t") }),
			...(policy?.window !== undefined && { window: policy.window }),
			...(policy?.quota !== undefined && { quota: policy.quota }),
		});
	}
	return windows.length > 0 ? { at: now.toISOString(), windows } : undefined;
}

function splitEntries(value: string): string[] {
	return value
		.split(/,\s*(?=")/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function policyName(entry: string): string | undefined {
	return /"([^"]+)"/.exec(entry)?.[1];
}

/** A numeric parameter; the API sends a space after each `;`, so spaces are allowed. */
function param(entry: string, key: string): number | undefined {
	const match = new RegExp(`;\\s*${key}=(\\d+)`).exec(entry);
	return match ? Number(match[1]) : undefined;
}
