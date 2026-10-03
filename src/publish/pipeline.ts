/**
 * The publishing pipeline: from a published entry to Buffer posts, inside
 * the ten bridge calls a sandboxed invocation may make.
 *
 * Three entry points share it:
 *
 * - `onPublished` (content hooks): prepares the entry's records and sends
 *   as many as the budget allows. The rest go to a one-shot continuation.
 * - `runDeliveries` (continuation tasks and the recurring sync): sends due
 *   records, resolves unknown ones first, waits out 429s.
 * - `retryFailed` (the Retry button): puts failed records back and schedules
 *   a continuation. It sends nothing itself, so the page stays fast.
 *
 * See `src/store/deliveries.ts` for the delivery states.
 */

import type { PluginContext } from "emdash/plugin";

import { BufferClient, type BufferResult, type CreatedPost, type CreatePostInput, type BufferPost } from "../buffer/client.js";
import type { RateLimitSnapshot } from "../buffer/ratelimit.js";
import { postShape } from "../buffer/services.js";
import { readSettings, type PluginSettings } from "../settings.js";
import { DELIVERIES, deliveryId, isDue, OPEN_STATUSES, UNKNOWN_GIVE_UP_MS, type Delivery } from "../store/deliveries.js";
import { readStored, STATE_KEY, type PluginState, type Stored } from "../store/kv.js";
import { OVERRIDES, overrideId, parseOverride } from "../store/overrides.js";
import { metered, type Meter } from "./budget.js";
import { entryFromEvent, prepareDeliveries } from "./prepare.js";

/**
 * Two names for the one-shot continuation, alternated. EmDash deletes a
 * one-shot task when its run succeeds, including a row the run itself just
 * rescheduled under the same name (emdash src/plugins/cron.ts
 * `CronExecutor.tick`), so a run that wants another run must use the other
 * name.
 */
export const CONTINUATION_TASKS = ["deliver-a", "deliver-b"] as const;
export type ContinuationTask = (typeof CONTINUATION_TASKS)[number];

/** How soon a continuation runs. EmDash's Node scheduler polls every 60 s. */
export const CONTINUATION_DELAY_MS = 60_000;

/** How long an unconfirmed record waits before its next lookup. */
const UNKNOWN_RECHECK_MS = 15 * 60_000;

/** How far before the attempt the lookup starts, for clock skew between Buffer and this host. */
const LOOKUP_SLACK_MS = 10 * 60_000;

/** Records one run reads. */
const RUN_PAGE = 50;

export function continuationAfter(last: string | undefined): ContinuationTask {
	return last === "deliver-a" ? "deliver-b" : "deliver-a";
}

/** The createPost input for a prepared record. */
export function createInput(row: Delivery): CreatePostInput {
	const shape = postShape(
		row.service,
		row.attach,
		{ url: row.url, title: row.entryTitle, description: row.linkDescription ?? "" },
		row.imageUrl ? { url: row.imageUrl, alt: row.imageAlt ?? "" } : null,
		{ boardServiceId: row.boardServiceId },
		row.hints,
	);
	return {
		channelId: row.channelId,
		text: row.text,
		schedulingType: "automatic",
		// ShareMode is required; a draft is queued mode with saveToDraft
		// (reference.md CreatePostInput.saveToDraft).
		mode: row.mode === "draft" ? "addToQueue" : row.mode,
		...(row.mode === "draft" && { saveToDraft: true }),
		assets: shape.assets,
		...(shape.metadata && { metadata: shape.metadata }),
	};
}

/** A record after Buffer answered a create. */
export function applyResult(row: Delivery, result: BufferResult<CreatedPost>, now: Date): Delivery {
	const stamp = now.toISOString();
	const base = { ...row, updatedAt: stamp, lastAttemptAt: row.lastAttemptAt ?? stamp };
	delete base.error;
	delete base.errorKind;
	if (result.ok) {
		return {
			...base,
			status: "sent",
			postId: result.data.id,
			...(result.data.status && { postStatus: result.data.status }),
			...(result.data.dueAt && { dueAt: result.data.dueAt }),
			...(result.data.externalLink && { externalLink: result.data.externalLink }),
			nextAttemptAt: "",
		};
	}
	if (result.kind === "rate_limited") {
		const wait = (result.retryAfterSeconds ?? 60) * 1000;
		return { ...base, status: "pending", error: result.message, errorKind: result.kind, nextAttemptAt: new Date(now.getTime() + wait).toISOString() };
	}
	if (result.kind === "uncertain") {
		return { ...base, status: "unknown", error: result.message, errorKind: result.kind, nextAttemptAt: "" };
	}
	return { ...base, status: "failed", error: result.message, errorKind: result.kind, nextAttemptAt: "" };
}

/**
 * Whether a post Buffer holds is the one this record sent. Buffer may
 * shorten links, so the text matches with or without its URLs.
 */
export function matchesPost(row: Delivery, post: BufferPost): boolean {
	const norm = (s: string) => s.replace(/\s+/g, " ").trim();
	if (norm(post.text) === norm(row.text)) return true;
	const strip = (s: string) => norm(s.replace(/https?:\/\/\S+/g, ""));
	const body = strip(row.text);
	return body.length >= 20 && strip(post.text) === body;
}

function clientFor(ctx: PluginContext, settings: PluginSettings): BufferClient | null {
	if (!settings.accessToken || !ctx.http) return null;
	const http = ctx.http;
	return new BufferClient({ fetch: (url, init) => http.fetch(url, init), token: settings.accessToken });
}

/** Store the state with the newest rate-limit reading, when the budget allows. */
async function saveState(ctx: PluginContext, meter: Meter, state: PluginState, patch: Partial<PluginState>): Promise<void> {
	if (meter.left() < 1) return;
	await ctx.kv.set(STATE_KEY, { ...state, ...patch });
}

async function scheduleContinuation(ctx: PluginContext, task: ContinuationTask, at: Date): Promise<boolean> {
	if (!ctx.cron) return false;
	await ctx.cron.schedule(task, { schedule: at.toISOString() });
	return true;
}

export type PublishOutcome =
	| { kind: "ignored"; why: string }
	| { kind: "prepared"; sent: number; deferred: number; skipped: number };

/**
 * The content hooks. Bridge calls, worst case: settings, KV, the existing
 * record lookup, the editor's override, public URL, media (6); the records
 * written as claims (7); then one createPost per send while two calls stay
 * in reserve for the results and the continuation (see `sendPrepared`).
 */
export async function onPublished(rawCtx: PluginContext, event: unknown, now = new Date()): Promise<PublishOutcome> {
	const { ctx, meter } = metered(rawCtx);
	const entry = entryFromEvent(event);
	if (!entry || entry.status !== "published") return { kind: "ignored", why: "notPublished" };

	const settings = await readSettings(ctx);
	if (!settings.accessToken) return { kind: "ignored", why: "noToken" };
	if (!settings.enabled) return { kind: "ignored", why: "disabled" };

	const stored = await readStored(ctx);
	if (!stored.state.watchSince) {
		// First sight of the plugin: start watching from now and send nothing,
		// so registering the plugin never shares the back catalogue.
		await ctx.kv.set(STATE_KEY, { ...stored.state, watchSince: now.toISOString() });
		return { kind: "ignored", why: "startedWatching" };
	}
	if (!stored.config.collections[entry.collection]?.enabled) return { kind: "ignored", why: "collectionOff" };
	if (!entry.publishedAt || Date.parse(entry.publishedAt) < Date.parse(stored.state.watchSince)) {
		return { kind: "ignored", why: "beforeWatch" };
	}

	// Republishing never sends again: any record for this entry means it was handled.
	const existing = await ctx.storage[DELIVERIES]!.query({ where: { entryId: entry.id }, limit: 1 });
	if (existing.items.length > 0) return { kind: "ignored", why: "alreadyHandled" };

	// The editor panel's choices for this entry, when an editor made any.
	const override = parseOverride(await ctx.storage[OVERRIDES]!.get(overrideId(entry.collection, entry.id)));
	const rows = await prepareDeliveries(ctx, {
		entry,
		settings,
		config: stored.config,
		channels: stored.channels,
		now,
		...(override && { overrides: { skip: override.skip, text: override.text } }),
	});
	if (rows.length === 0) return { kind: "ignored", why: "noChannels" };

	return await sendPrepared(ctx, meter, settings, stored, rows, now);
}

/**
 * Store freshly prepared records and send what the budget allows.
 * Shared with the editor panel's "Send again".
 *
 * After the claim write, each send costs one call and the results one more.
 * When every record fits, that is all; otherwise one more call schedules
 * the continuation that sends the rest. The rate-limit reading is stored
 * only when a call is still left over: the next run stores a newer one.
 */
export async function sendPrepared(
	ctx: PluginContext,
	meter: Meter,
	settings: PluginSettings,
	stored: Stored,
	rows: Array<{ id: string; data: Delivery }>,
	now: Date,
): Promise<PublishOutcome> {
	const stamp = now.toISOString();
	const pending = rows.filter((r) => r.data.status === "pending");
	const skipped = rows.length - pending.length;

	const afterClaim = meter.left() - 1;
	const canSendAll = afterClaim - 1 >= pending.length;
	const sendCount = Math.max(0, Math.min(pending.length, canSendAll ? pending.length : afterClaim - 2));
	const toSend = pending.slice(0, sendCount);
	for (const row of toSend) {
		row.data = { ...row.data, status: "sending", lastAttemptAt: stamp, attempts: row.data.attempts + 1, updatedAt: stamp };
	}

	// The claim: written before any request, so a run that dies mid-request
	// leaves "sending", which is resolved by lookup, never resent blind.
	await ctx.storage[DELIVERIES]!.putMany(rows);

	const client = clientFor(ctx, settings);
	const results: Array<{ id: string; data: Delivery }> = [];
	let rateLimit: RateLimitSnapshot | undefined;
	let waitUntil: number | undefined;
	if (client) {
		for (const row of toSend) {
			if (waitUntil !== undefined) {
				// Rate-limited: the rest wait as well, without a request.
				results.push({ id: row.id, data: { ...row.data, status: "pending", nextAttemptAt: new Date(waitUntil).toISOString(), attempts: row.data.attempts - 1 } });
				continue;
			}
			const result = await client.createPost(createInput(row.data));
			if (result.rateLimit) rateLimit = result.rateLimit;
			const updated = applyResult(row.data, result, now);
			if (!result.ok && result.kind === "rate_limited") waitUntil = Date.parse(updated.nextAttemptAt);
			results.push({ id: row.id, data: updated });
		}
	}
	if (results.length > 0) await ctx.storage[DELIVERIES]!.putMany(results);
	// The caller's rows end up as stored, for a caller that shows them.
	for (const result of results) {
		const row = rows.find((r) => r.id === result.id);
		if (row) row.data = result.data;
	}

	const deferred = pending.length - toSend.length + results.filter((r) => r.data.status === "pending").length;
	if (deferred > 0 && meter.left() >= 1) {
		const at = Math.max(now.getTime() + CONTINUATION_DELAY_MS, waitUntil ?? 0);
		await scheduleContinuation(ctx, continuationAfter(stored.state.lastContinuation), new Date(at));
	}
	if (rateLimit) await saveState(ctx, meter, stored.state, { rateLimit });

	return { kind: "prepared", sent: results.filter((r) => r.data.status === "sent").length, deferred, skipped };
}

export interface RunOutcome {
	sent: number;
	resolved: number;
	remaining: number;
}

/**
 * One delivery run. Bridge calls: settings, KV, the open records (3); per
 * unknown record a lookup; per send a claim and a createPost; then the
 * results, the next continuation and the state (3 in reserve).
 *
 * `rawCtx` may already be metered by the caller (the recurring sync spends
 * calls on pruning first); pass its meter so the budget is shared.
 */
export async function runDeliveries(
	rawCtx: PluginContext,
	opts: { now?: Date; task?: string; meter?: Meter; stored?: Stored; settings?: PluginSettings } = {},
): Promise<RunOutcome> {
	const now = opts.now ?? new Date();
	const { ctx, meter } = opts.meter ? { ctx: rawCtx, meter: opts.meter } : metered(rawCtx);
	const settings = opts.settings ?? (await readSettings(ctx));
	const client = clientFor(ctx, settings);
	if (!client) return { sent: 0, resolved: 0, remaining: 0 };
	const stored = opts.stored ?? (await readStored(ctx));

	const page = await ctx.storage[DELIVERIES]!.query({
		where: { status: { in: [...OPEN_STATUSES] } },
		orderBy: { nextAttemptAt: "asc" },
		limit: RUN_PAGE,
	});
	const open = page.items.map((i) => ({ id: i.id, data: i.data as Delivery }));
	const due = open.filter((r) => isDue(r.data, now));

	const RESERVE = 3;
	const updates = new Map<string, Delivery>();
	let rateLimit: RateLimitSnapshot | undefined;
	let waitUntil: number | undefined;
	let sent = 0;
	let resolved = 0;
	const stamp = now.toISOString();

	for (const row of due) {
		if (waitUntil !== undefined) break;
		let current = row.data;

		if (current.status === "unknown" || current.status === "sending") {
			if (meter.left() < RESERVE + 1) break;
			const since = new Date(Date.parse(current.lastAttemptAt ?? current.createdAt) - LOOKUP_SLACK_MS).toISOString();
			const lookup = await client.recentPosts(current.organizationId, current.channelId, since);
			if (lookup.rateLimit) rateLimit = lookup.rateLimit;
			if (!lookup.ok) {
				if (lookup.kind === "rate_limited") {
					waitUntil = now.getTime() + (lookup.retryAfterSeconds ?? 60) * 1000;
					break;
				}
				const age = now.getTime() - Date.parse(current.lastAttemptAt ?? current.createdAt);
				updates.set(
					row.id,
					age >= UNKNOWN_GIVE_UP_MS
						? { ...current, status: "failed", errorKind: "unconfirmed", error: lookup.message, updatedAt: stamp, nextAttemptAt: "" }
						: { ...current, status: "unknown", error: lookup.message, updatedAt: stamp, nextAttemptAt: new Date(now.getTime() + UNKNOWN_RECHECK_MS).toISOString() },
				);
				continue;
			}
			const match = lookup.data.find((post) => matchesPost(current, post));
			if (match) {
				resolved++;
				const confirmed: Delivery = {
					...current,
					status: "sent",
					postId: match.id,
					...(match.status && { postStatus: match.status }),
					...(match.dueAt && { dueAt: match.dueAt }),
					...(match.externalLink && { externalLink: match.externalLink }),
					updatedAt: stamp,
					nextAttemptAt: "",
				};
				delete confirmed.error;
				delete confirmed.errorKind;
				updates.set(row.id, confirmed);
				continue;
			}
			// Buffer has no such post: safe to send.
		}

		if (meter.left() < RESERVE + 2) {
			if (current !== row.data) updates.set(row.id, current);
			break;
		}
		// The claim is atomic: two runs that read the same record cannot both
		// send it. `updatedAt` is indexed and changes on every write.
		const claim = await ctx.storage[DELIVERIES]!.updateIf(row.id, {
			where: { status: row.data.status, updatedAt: row.data.updatedAt },
			set: { status: "sending", lastAttemptAt: stamp, updatedAt: stamp, attempts: current.attempts + 1 },
		});
		if (!claim.applied) continue;
		current = { ...current, status: "sending", lastAttemptAt: stamp, updatedAt: stamp, attempts: current.attempts + 1 };
		const result = await client.createPost(createInput(current));
		if (result.rateLimit) rateLimit = result.rateLimit;
		const updated = applyResult(current, result, now);
		updates.set(row.id, updated);
		if (updated.status === "sent") sent++;
		if (!result.ok && result.kind === "rate_limited") waitUntil = Date.parse(updated.nextAttemptAt);
	}

	if (updates.size > 0) {
		await ctx.storage[DELIVERIES]!.putMany([...updates].map(([id, data]) => ({ id, data })));
	}

	// Anything still open goes to the next continuation, at its earliest due time.
	const stillOpen = open.filter((r) => {
		const d = updates.get(r.id) ?? r.data;
		return d.status === "pending" || d.status === "unknown" || d.status === "sending";
	});
	let next: ContinuationTask | undefined;
	if (stillOpen.length > 0 || page.hasMore) {
		const earliest = Math.min(
			...stillOpen.map((r) => {
				const d = updates.get(r.id) ?? r.data;
				return d.nextAttemptAt ? Date.parse(d.nextAttemptAt) : now.getTime();
			}),
			waitUntil ?? Number.POSITIVE_INFINITY,
		);
		const at = Math.max(now.getTime() + CONTINUATION_DELAY_MS, Number.isFinite(earliest) ? earliest : 0);
		next = continuationAfter(opts.task ?? stored.state.lastContinuation);
		if (meter.left() >= 1) await scheduleContinuation(ctx, next, new Date(at));
	}

	await saveState(ctx, meter, stored.state, {
		lastRunAt: stamp,
		...(rateLimit && { rateLimit }),
		...(next && { lastContinuation: next }),
	});

	return { sent, resolved, remaining: stillOpen.length };
}

/**
 * The Retry button: failed records go back to pending, records that failed
 * because a post could not be confirmed go back to unknown (so they are
 * looked up first), and a continuation is scheduled. Bridge calls: the
 * failed records, their write, the schedule (3).
 */
export async function retryFailed(ctx: PluginContext, stored: Stored, now = new Date()): Promise<number> {
	const page = await ctx.storage[DELIVERIES]!.query({ where: { status: "failed" }, limit: RUN_PAGE });
	if (page.items.length === 0) return 0;
	const stamp = now.toISOString();
	const items = page.items.map((i) => {
		const d = i.data as Delivery;
		const back: Delivery = {
			...d,
			status: d.errorKind === "unconfirmed" ? "unknown" : "pending",
			updatedAt: stamp,
			nextAttemptAt: "",
			...(d.errorKind === "unconfirmed" && { lastAttemptAt: stamp }),
		};
		return { id: i.id, data: back };
	});
	await ctx.storage[DELIVERIES]!.putMany(items);
	await scheduleContinuation(ctx, continuationAfter(stored.state.lastContinuation), new Date(now.getTime() + CONTINUATION_DELAY_MS));
	return items.length;
}

/**
 * The editor panel's Retry for one channel: the record goes back the way
 * `retryFailed` puts records back, and a continuation sends it. Bridge
 * calls: the write and the schedule (2). Returns the record as written, or
 * null when it is not failed.
 */
export async function retryOne(ctx: PluginContext, stored: Stored, row: { id: string; data: Delivery }, now = new Date()): Promise<Delivery | null> {
	if (row.data.status !== "failed") return null;
	const stamp = now.toISOString();
	const unconfirmed = row.data.errorKind === "unconfirmed";
	const back: Delivery = {
		...row.data,
		status: unconfirmed ? "unknown" : "pending",
		updatedAt: stamp,
		nextAttemptAt: "",
		...(unconfirmed && { lastAttemptAt: stamp }),
	};
	await ctx.storage[DELIVERIES]!.put(row.id, back);
	await scheduleContinuation(ctx, continuationAfter(stored.state.lastContinuation), new Date(now.getTime() + CONTINUATION_DELAY_MS));
	return back;
}

/**
 * A new record that sends the same post again: the text, link and image an
 * earlier record went out with, under a new id so the earlier post keeps its
 * own record, status and figures. Everything Buffer said about the earlier
 * post is left behind.
 */
export function againRecord(row: { id: string; data: Delivery }, now: Date): { id: string; data: Delivery } {
	const stamp = now.toISOString();
	const data: Delivery = {
		collection: row.data.collection,
		entryId: row.data.entryId,
		entryTitle: row.data.entryTitle,
		channelId: row.data.channelId,
		organizationId: row.data.organizationId,
		service: row.data.service,
		channelName: row.data.channelName,
		status: "pending",
		text: row.data.text,
		url: row.data.url,
		mode: row.data.mode,
		attach: row.data.attach,
		attempts: 0,
		createdAt: stamp,
		updatedAt: stamp,
		nextAttemptAt: "",
		...(row.data.imageUrl && { imageUrl: row.data.imageUrl, imageAlt: row.data.imageAlt ?? "" }),
		...(row.data.linkDescription && { linkDescription: row.data.linkDescription }),
		...(row.data.boardServiceId && { boardServiceId: row.data.boardServiceId }),
		...(row.data.hints && { hints: row.data.hints }),
		...(row.data.shortened && { shortened: true }),
	};
	const base = deliveryId(row.data.collection, row.data.entryId, row.data.channelId);
	return { id: `${base}:${now.getTime().toString(36)}`, data };
}
