/**
 * Metrics phase: Buffer's list of sent posts on the shared channels over
 * the last 30 days, once a day, with each post's figures and where it was
 * made.
 *
 * Bridge calls: one Buffer request (a page of up to 100 sent posts), the
 * deliveries holding those post ids, one putMany of the records that
 * changed (3 at most). An organization with more sent posts than one page
 * continues on the next run from Buffer's cursor.
 *
 * The same page feeds two things:
 *
 * - This plugin's deliveries get their post's status and figures.
 * - Every post Buffer lists, whoever made it, is summed per channel, per
 *   UTC day it went out and per origin (PostVia: `network` is made on the
 *   network itself, `buffer` and `api` through Buffer). The sums ride in
 *   the report state while a pass spans several pages, and the origins
 *   phase files them in the `origins` row once the pass is done
 *   (`runOriginsPhase`, 2 calls), so this phase stays at 3.
 *
 * `posts` filters on `createdAt` and `dueAt` but not on the time a post
 * went out (reference.md: PostsFiltersInput), so the window asks from a
 * few days before the first day counted and each post is placed by its
 * `sentAt` here. The window keeps inside Buffer's history limit when one
 * is known (src/buffer/history.ts): a page refused for it is asked again
 * at once, cut to the limit, while the invocation has the calls.
 *
 * Buffer pulls figures from each network once a day
 * (post-metrics.md, "Data freshness"), so reading more often buys nothing.
 * A post Buffer has not read yet (`metricsUpdatedAt` null) keeps no
 * figures at all, rather than zeros.
 */

import type { MetricsPost } from "../buffer/client.js";
import { effectiveDays } from "../buffer/history.js";
import { engagementOf, impressionsOf } from "../buffer/metrics.js";
import { DELIVERIES, type Delivery } from "../store/deliveries.js";
import {
	addDays,
	daysBetween,
	ORIGINS_ID,
	parseOrigins,
	REPORT_DAYS,
	REPORTS,
	utcDay,
	type Day,
	type OriginDay,
	type OriginSum,
	type OriginWork,
} from "../store/report.js";
import { headroom, historyDays, learnHistory, noteOtherFailure, observe, refusalOf, RUN_RESERVE, type PhaseContext } from "./common.js";

export const METRICS_DAYS = 30;
export const METRICS_COST = 3;
export const ORIGINS_COST = 2;

/** Days asked for before the first day counted, for posts created before it and sent in it. */
export const SLACK_DAYS = 7;

/** The organizations to read, each with the channels this plugin shares to. */
export function metricsTargets(p: PhaseContext): Array<{ organizationId: string; channelIds: string[] }> {
	const byOrg = new Map<string, string[]>();
	for (const channel of p.stored.channels?.channels ?? []) {
		if (!p.stored.config.channels[channel.id]?.enabled || !channel.organizationId) continue;
		byOrg.set(channel.organizationId, [...(byOrg.get(channel.organizationId) ?? []), channel.id]);
	}
	return [...byOrg.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([organizationId, channelIds]) => ({ organizationId, channelIds }));
}

/**
 * The window a pass reads: `from` is the first day counted, `since` the
 * first creation day asked for. Under a history limit both stay inside it.
 */
export function metricsWindow(today: Day, limit: number | undefined): { from: Day; since: Day } {
	const days = effectiveDays(METRICS_DAYS, limit);
	const slack = Math.max(0, Math.min(SLACK_DAYS, (limit ?? REPORT_DAYS) - days));
	const from = addDays(today, -(days - 1));
	return { from, since: addDays(from, -slack) };
}

export function metricsDue(p: PhaseContext): boolean {
	// A finished pass waits until the origins phase has filed it.
	if (p.report.originsWork?.ready) return false;
	const state = p.report.metrics;
	if (!state?.day) return true;
	if (state.cursor || state.org) return true;
	if (p.report.forcedAt && (!state.at || state.at < p.report.forcedAt)) return true;
	return state.day !== utcDay(p.now);
}

export async function runMetricsPhase(p: PhaseContext): Promise<void> {
	const client = p.client;
	if (!client) return;
	const stamp = p.now.toISOString();
	const today = utcDay(p.now);
	const targets = metricsTargets(p);
	const state = p.report.metrics ?? {};
	const index = state.day === today || state.cursor ? (state.org ?? 0) : 0;
	const target = targets[index];
	if (!target) {
		p.report.metrics = { day: today, at: stamp };
		return;
	}

	// A pass under way keeps the window it started with; a new pass works it out.
	const midPass = Boolean(state.cursor) || (state.day === today && index > 0);
	let window = midPass && state.from && state.since ? { from: state.from, since: state.since } : metricsWindow(today, historyDays(p));
	if (!headroom(p)) return;
	let result = await client.sentPostMetrics(target.organizationId, target.channelIds, `${window.since}T00:00:00Z`, state.cursor);
	observe(p, result.rateLimit);
	if (!result.ok) {
		const refusal = refusalOf(result);
		if (refusal) learnHistory(p, refusal.days);
		if (!refusal?.only) {
			noteOtherFailure(p, result, refusal);
			return;
		}
		// Refused for the history limit alone: the pass starts again inside
		// it, at once when this is its first page and the calls allow.
		delete p.report.originsWork;
		p.report.metrics = { day: "", ...(state.at && { at: state.at }) };
		if (midPass || p.meter.left() < RUN_RESERVE + 3 || !headroom(p)) return;
		window = metricsWindow(today, historyDays(p));
		result = await client.sentPostMetrics(target.organizationId, target.channelIds, `${window.since}T00:00:00Z`);
		observe(p, result.rateLimit);
		if (!result.ok) {
			const again = refusalOf(result);
			if (again) learnHistory(p, again.days);
			if (!again?.only) noteOtherFailure(p, result, again);
			return;
		}
	}
	delete p.report.problem;

	const posts = new Map(result.data.posts.map((post) => [post.id, post]));
	if (posts.size > 0) {
		const page = await p.ctx.storage[DELIVERIES]!.query({ where: { postId: { in: [...posts.keys()] } }, limit: 100 });
		const changed: Array<{ id: string; data: Delivery }> = [];
		for (const item of page.items) {
			const data = item.data as Delivery;
			const post = data.postId ? posts.get(data.postId) : undefined;
			if (!post) continue;
			const next: Delivery = { ...data };
			if (post.status) next.postStatus = post.status;
			if (post.sentAt) next.sentAt = post.sentAt;
			if (post.dueAt) next.dueAt = post.dueAt;
			if (post.externalLink) next.externalLink = post.externalLink;
			if (post.metricsUpdatedAt && post.metrics) {
				next.metrics = post.metrics;
				next.metricsUpdatedAt = post.metricsUpdatedAt;
			}
			if (JSON.stringify(next) !== JSON.stringify(data)) changed.push({ id: item.id, data: { ...next, updatedAt: stamp } });
		}
		if (changed.length > 0) await p.ctx.storage[DELIVERIES]!.putMany(changed);
	}

	const previous = p.report.originsWork;
	const work: OriginWork =
		midPass && previous && !previous.ready && previous.since === window.from ? previous : { day: today, since: window.from, days: {}, counts: {} };
	addOrigins(work, result.data.posts, new Set(target.channelIds), window.from, today);

	if (result.data.hasNextPage && result.data.endCursor) {
		p.report.metrics = { ...state, day: state.day || today, org: index, cursor: result.data.endCursor, from: window.from, since: window.since };
		p.report.originsWork = work;
	} else if (index + 1 < targets.length) {
		p.report.metrics = { day: today, org: index + 1, from: window.from, since: window.since, ...(state.at && { at: state.at }) };
		p.report.originsWork = work;
	} else {
		p.report.metrics = { day: today, at: stamp };
		p.report.originsWork = { ...work, ready: true, channels: targets.flatMap((t) => t.channelIds) };
	}
}

/** Which origin a PostVia value is: made on the network, or through Buffer (the app, this plugin, other API tools). */
export function originOf(via: string | null): "direct" | "buffer" | null {
	if (via === "network") return "direct";
	if (via === "buffer" || via === "api") return "buffer";
	return null;
}

/** The UTC day a post went out: `sentAt`, else when it was due, else when it was made. */
function sentDayOf(post: MetricsPost): Day | null {
	const at = post.sentAt ?? post.dueAt ?? post.createdAt;
	return at ? at.slice(0, 10) : null;
}

function addTo(sum: OriginSum | undefined, post: MetricsPost): OriginSum {
	const next: OriginSum = { ...(sum ?? { posts: 0 }) };
	next.posts++;
	const engagement = engagementOf(post.metrics);
	const impressions = impressionsOf(post.metrics);
	if (engagement !== undefined) next.engagement = (next.engagement ?? 0) + engagement;
	if (impressions !== undefined) next.impressions = (next.impressions ?? 0) + impressions;
	return next;
}

/**
 * Sum a page of posts into a pass: per channel, per day the post went out
 * (from `from` to today), per origin. A post Buffer has not read yet is
 * counted as unread and adds no figure. Posts on other channels, outside
 * the days or with an unknown PostVia add nothing to the sums.
 */
export function addOrigins(work: OriginWork, posts: MetricsPost[], channels: Set<string>, from: Day, today: Day): void {
	for (const post of posts) {
		const channel = post.channelId;
		const day = sentDayOf(post);
		if (!channel || !channels.has(channel) || !day || daysBetween(from, day) < 0 || daysBetween(day, today) < 0) continue;
		const counts = (work.counts[channel] ??= { network: 0, buffer: 0, api: 0 });
		if (post.via === "network" || post.via === "buffer" || post.via === "api") counts[post.via]++;
		const origin = originOf(post.via);
		if (!origin) continue;
		const days = (work.days[channel] ??= {});
		const entry: OriginDay = (days[day] ??= {});
		if (!post.metricsUpdatedAt || !post.metrics) {
			entry.unread = (entry.unread ?? 0) + 1;
			continue;
		}
		entry[origin] = addTo(entry[origin], post);
	}
}

export function originsDue(p: PhaseContext): boolean {
	return Boolean(p.report.originsWork?.ready);
}

/**
 * File a finished pass in the `origins` row: each channel's days from the
 * pass's first day are replaced, older days keep what was filed before,
 * and the summary the Setup view shows goes on the report state. Bridge
 * calls: one read and one write of the row.
 */
export async function runOriginsPhase(p: PhaseContext): Promise<void> {
	const work = p.report.originsWork;
	if (!work?.ready) return;
	const today = utcDay(p.now);
	const origins = parseOrigins(await p.ctx.storage[REPORTS]!.get(ORIGINS_ID));
	const channels = work.channels ?? Object.keys(work.days);
	for (const c of channels) {
		const kept = Object.fromEntries(Object.entries(origins.days[c] ?? {}).filter(([day]) => daysBetween(day, work.since) > 0));
		origins.days[c] = { ...kept, ...(work.days[c] ?? {}) };
		const covered = origins.coveredFrom[c];
		origins.coveredFrom[c] = covered && daysBetween(covered, work.since) > 0 ? covered : work.since;
	}
	const known = new Set((p.stored.channels?.channels ?? []).map((c) => c.id));
	const floor = addDays(today, -(REPORT_DAYS - 1));
	for (const c of Object.keys(origins.days)) {
		if (!known.has(c)) {
			delete origins.days[c];
			delete origins.coveredFrom[c];
			continue;
		}
		for (const day of Object.keys(origins.days[c]!)) if (daysBetween(floor, day) < 0) delete origins.days[c]![day];
		if (origins.coveredFrom[c] && daysBetween(floor, origins.coveredFrom[c]!) < 0) origins.coveredFrom[c] = floor;
	}
	await p.ctx.storage[REPORTS]!.put(ORIGINS_ID, origins);
	p.report.origins = {
		at: p.now.toISOString(),
		since: work.since,
		channels: Object.fromEntries(
			channels.map((c) => {
				const counts = work.counts[c] ?? { network: 0, buffer: 0, api: 0 };
				return [c, { method: counts.network > 0 ? "listed" : "derived", counts }];
			}),
		),
	};
	delete p.report.originsWork;
}
