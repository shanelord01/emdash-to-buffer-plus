/**
 * Status phase: where the posts this plugin created and that can still
 * change (scheduled, sending, awaiting approval, drafts) stand at Buffer
 * now, so the page can say what went out, what is queued and what Buffer
 * could not publish.
 *
 * Bridge calls: the deliveries query, one Buffer request, one putMany of
 * the records that changed (3 at most).
 *
 * Buffer has no webhooks (spec, verified on developers.buffer.com), so
 * this is a poll. Records are taken oldest first and the pass walks on
 * across runs: `after` and `seen` remember where it stopped, because
 * several records can share a `createdAt` (a publish writes them in one
 * batch) and a plain "greater than" would skip the rest of a tie.
 */

import type { StatusLookup } from "../buffer/client.js";
import { DELIVERIES, OPEN_POST_STATUSES, POST_NOT_FOUND, type Delivery } from "../store/deliveries.js";
import { noteFailure, type PhaseContext } from "./common.js";

/** Records looked up per run: inside Buffer's 30 aliases per query. */
export const STATUS_BATCH = 25;

/** How often the status pass starts again from the oldest open record. */
export const STATUS_EVERY_MS = 55 * 60_000;

/**
 * How far either side of the create the lookup reaches. Buffer stamps
 * `createdAt` within seconds of the request; the slack covers clock skew
 * between this host and Buffer.
 */
export const STATUS_WINDOW_MS = 10 * 60_000;

/** Lookups in a row that miss before a post counts as gone from Buffer. */
export const MISSES_BEFORE_NOT_FOUND = 3;

export const STATUS_COST = 3;

export async function runStatusPhase(p: PhaseContext): Promise<void> {
	const client = p.client;
	if (!client) return;
	const state = p.report.status ?? {};
	const seen = new Set(state.after ? (state.seen ?? []) : []);
	const page = await p.ctx.storage[DELIVERIES]!.query({
		where: {
			postStatus: { in: [...OPEN_POST_STATUSES] },
			...(state.after && { createdAt: { gte: state.after } }),
		},
		orderBy: { createdAt: "asc" },
		limit: Math.min(100, STATUS_BATCH + seen.size),
	});
	const unseen = page.items.filter((i) => !seen.has(i.id));
	const rows = unseen
		.slice(0, STATUS_BATCH)
		.map((i) => ({ id: i.id, data: i.data as Delivery }));
	const stamp = p.now.toISOString();

	if (rows.length === 0) {
		p.report.status = { at: stamp };
		return;
	}

	const lookups: StatusLookup[] = rows.flatMap(({ data }) => {
		if (!data.postId || !data.organizationId) return [];
		const t = Date.parse(data.lastAttemptAt ?? data.createdAt);
		return [
			{
				postId: data.postId,
				organizationId: data.organizationId,
				channelId: data.channelId,
				start: new Date(t - STATUS_WINDOW_MS).toISOString(),
				end: new Date(t + STATUS_WINDOW_MS).toISOString(),
			},
		];
	});
	const result = await client.postStatuses(lookups);
	if (!result.ok) {
		noteFailure(p, result);
		return;
	}

	const changed: Array<{ id: string; data: Delivery }> = [];
	for (const { id, data } of rows) {
		if (!data.postId) continue;
		const post = result.data.get(data.postId);
		let next: Delivery;
		if (post) {
			next = { ...data };
			delete next.statusMisses;
			if (post.status) next.postStatus = post.status;
			if (post.dueAt) next.dueAt = post.dueAt;
			if (post.sentAt) next.sentAt = post.sentAt;
			if (post.externalLink) next.externalLink = post.externalLink;
			if (post.status === "error" && post.error) next.postError = post.error;
			else delete next.postError;
		} else {
			const misses = (data.statusMisses ?? 0) + 1;
			next = misses >= MISSES_BEFORE_NOT_FOUND ? { ...data, postStatus: POST_NOT_FOUND, statusMisses: misses } : { ...data, statusMisses: misses };
		}
		// Read before write: only records that changed are written.
		if (JSON.stringify(next) !== JSON.stringify(data)) changed.push({ id, data: { ...next, updatedAt: stamp } });
	}
	if (changed.length > 0) await p.ctx.storage[DELIVERIES]!.putMany(changed);

	const last = rows[rows.length - 1]!.data.createdAt;
	const tie = rows.filter((r) => r.data.createdAt === last).map((r) => r.id);
	const more = page.hasMore || unseen.length > rows.length;
	p.report.status = more
		? { ...state, after: last, seen: last === state.after ? [...seen, ...tie] : tie, pending: true }
		: { at: stamp };
	delete p.report.problem;
}
