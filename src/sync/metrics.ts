/**
 * Metrics phase: Buffer's figures for the posts this plugin sent in the
 * last 30 days, once a day.
 *
 * Bridge calls: one Buffer request (a page of up to 100 sent posts), the
 * deliveries holding those post ids, one putMany of the records that
 * changed (3 at most). An organization with more sent posts than one page
 * continues on the next run from Buffer's cursor.
 *
 * Buffer pulls figures from each network once a day
 * (post-metrics.md, "Data freshness"), so reading more often buys nothing.
 * The 30 days are the spec's: older posts keep the last figures read.
 * A post Buffer has not read yet (`metricsUpdatedAt` null) keeps no
 * figures at all, rather than zeros.
 */

import { DELIVERIES, type Delivery } from "../store/deliveries.js";
import { utcDay } from "../store/report.js";
import { noteFailure, type PhaseContext } from "./common.js";

export const METRICS_DAYS = 30;
export const METRICS_COST = 3;

/** The organizations to read, each with the channels this plugin shares to. */
export function metricsTargets(p: PhaseContext): Array<{ organizationId: string; channelIds: string[] }> {
	const byOrg = new Map<string, string[]>();
	for (const channel of p.stored.channels?.channels ?? []) {
		if (!p.stored.config.channels[channel.id]?.enabled || !channel.organizationId) continue;
		byOrg.set(channel.organizationId, [...(byOrg.get(channel.organizationId) ?? []), channel.id]);
	}
	return [...byOrg.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([organizationId, channelIds]) => ({ organizationId, channelIds }));
}

export function metricsDue(p: PhaseContext): boolean {
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

	const since = new Date(p.now.getTime() - METRICS_DAYS * 86_400_000).toISOString();
	const result = await client.sentPostMetrics(target.organizationId, target.channelIds, since, state.cursor);
	if (!result.ok) {
		noteFailure(p, result);
		return;
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

	if (result.data.hasNextPage && result.data.endCursor) {
		p.report.metrics = { ...state, day: state.day ?? "", org: index, cursor: result.data.endCursor };
	} else if (index + 1 < targets.length) {
		p.report.metrics = { day: today, org: index + 1, ...(state.at && { at: state.at }) };
	} else {
		p.report.metrics = { day: today, at: stamp };
	}
}
