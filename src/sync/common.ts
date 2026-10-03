/**
 * What every report phase shares: the metered context, the Buffer client,
 * the stored state, and one way to record a failed read.
 */

import type { PluginContext } from "emdash/plugin";

import { BufferClient, type BufferResult } from "../buffer/client.js";
import type { Meter } from "../publish/budget.js";
import type { PluginSettings } from "../settings.js";
import type { Stored } from "../store/kv.js";
import type { ReportState } from "../store/report.js";

export interface PhaseContext {
	ctx: PluginContext;
	meter: Meter;
	settings: PluginSettings;
	stored: Stored;
	/** Null without an API key or network access: Buffer phases do not run. */
	client: BufferClient | null;
	now: Date;
	/** The report state, updated in place by each phase and written once at the end. */
	report: ReportState;
}

export function bufferClient(ctx: PluginContext, settings: PluginSettings): BufferClient | null {
	if (!settings.accessToken || !ctx.http) return null;
	const http = ctx.http;
	return new BufferClient({ fetch: (url, init) => http.fetch(url, init), token: settings.accessToken });
}

/**
 * Record a failed Buffer read on the report state. A 429 pauses every
 * report read until Buffer's Retry-After has passed (api-limits.md: "This
 * is the number to sleep on"); anything else is shown on the page and the
 * phase tries again when it is next due.
 */
export function noteFailure(p: PhaseContext, result: Extract<BufferResult<unknown>, { ok: false }>): void {
	const at = p.now.toISOString();
	if (result.kind === "rate_limited") {
		p.report.pausedUntil = new Date(p.now.getTime() + (result.retryAfterSeconds ?? 60) * 1000).toISOString();
	}
	p.report.problem = { at, kind: result.kind, message: result.message };
}

/** Whether a phase last done at `at` is due again after `everyMs`, or after a Refresh. */
export function isDue(p: PhaseContext, at: string | undefined, everyMs: number): boolean {
	if (!at) return true;
	if (p.report.forcedAt && at < p.report.forcedAt) return true;
	return p.now.getTime() - Date.parse(at) >= everyMs;
}

/** After a failed read, Buffer is left alone this long, so a chain of runs never retries a failing request every minute. */
export const BACKOFF_MS = 15 * 60_000;

export function paused(p: PhaseContext): boolean {
	if (p.report.pausedUntil && Date.parse(p.report.pausedUntil) > p.now.getTime()) return true;
	return Boolean(p.report.problem && p.now.getTime() - Date.parse(p.report.problem.at) < BACKOFF_MS);
}
