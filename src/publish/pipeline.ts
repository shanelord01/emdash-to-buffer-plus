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
 *
 * Buffer counts every API key and MCP connection on the account against one
 * bucket (api-limits.md). Publishing does not keep the reserve the
 * background reports keep for other tools (`src/buffer/headroom.ts`): it
 * sends unless a window is spent (`r` = 0 in the newest reading), and then
 * waits for that window to reset, exactly as after a 429.
 */

import type { PluginContext } from "emdash/plugin";

import { BufferClient, type BufferResult, type CreatedPost, type CreatePostInput, type BufferPost } from "../buffer/client.js";
import { currentWindows, publishDecision } from "../buffer/headroom.js";
import type { RateLimitSnapshot } from "../buffer/ratelimit.js";
import { postShape, ruleFor } from "../buffer/services.js";
import { readSettings, type PluginSettings } from "../settings.js";
import { DELIVERIES, deliveryId, isDue, OPEN_STATUSES, UNKNOWN_GIVE_UP_MS, type Delivery } from "../store/deliveries.js";
import { readStored, STATE_KEY, storedReadings, type PluginState, type Stored } from "../store/kv.js";
import { OVERRIDES, overrideId, parseOverride } from "../store/overrides.js";
import { shapeProblem } from "./aspect.js";
import { metered, type Meter } from "./budget.js";
import { isSignedInMediaUrl, resolveImage } from "./image.js";
import { entryFromEvent, imageSourceOf, prepareDeliveries, type EntryRef } from "./prepare.js";

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

/** An entry as `ctx.content.get()` returns it, or null when it could not be read. */
type EntryItem = Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>;

/**
 * Whether a record carries an image address that needs signing in: 0.1.3
 * and earlier stored `ctx.media.get()`'s `/_emdash/api/media/asset/` URL,
 * which Buffer cannot read ("Image could not be read from its URL").
 */
export function needsImageRepair(row: Delivery): boolean {
	return Boolean(row.imageUrl) && isSignedInMediaUrl(row.imageUrl!);
}

/**
 * A record from 0.1.3 or earlier with its image worked out again from the
 * entry, by the rules a new record follows (`./image.ts`). One bridge call
 * (`content.get`) per entry not in `entries` yet. The caller keeps the map
 * for the other records of the same entry. When there is no public address,
 * or the entry cannot be read, the record goes without the image and says
 * why in `imageIssue`, and a network that needs an image is skipped as a new
 * record would be (`needsImage`). An Instagram record whose image is known
 * to be outside 4:5 to 1.91:1 is skipped as `imageAspect`, as a new record
 * would be (`./aspect.ts`).
 *
 * Send again of an Instagram record goes through here too, so a record
 * skipped for the image's shape is sent once the entry's image is changed.
 */
export async function repairImage(ctx: PluginContext, stored: Stored, row: Delivery, entries: Map<string, EntryItem>): Promise<Delivery> {
	const key = `${row.collection}:${row.entryId}`;
	if (!entries.has(key)) {
		let item: EntryItem = null;
		try {
			item = ctx.content ? await ctx.content.get(row.collection, row.entryId) : null;
		} catch {
			item = null;
		}
		entries.set(key, item);
	}
	const item = entries.get(key) ?? null;
	const image = item ? resolveImage(imageSourceOf(stored.config.collections[row.collection]), { data: item.data, seo: item.seo }, ctx.site.url) : null;
	const rule = ruleFor(row.service, row.hints);
	const out: Delivery = { ...row };
	delete out.imageUrl;
	delete out.imageAlt;
	delete out.imageIssue;
	delete out.imageWidth;
	delete out.imageHeight;
	if (image?.ok && rule.image !== "never") {
		const shape = shapeProblem(row.service, image);
		if (shape) {
			delete out.error;
			delete out.errorKind;
			return { ...out, imageUrl: image.url, imageAlt: image.alt, status: "skipped", reason: "imageAspect", nextAttemptAt: "", imageWidth: shape.width, imageHeight: shape.height };
		}
		return { ...out, imageUrl: image.url, imageAlt: image.alt };
	}
	if (rule.image === "needed") {
		delete out.error;
		delete out.errorKind;
		return { ...out, status: "skipped", reason: "needsImage", nextAttemptAt: "", imageIssue: item ? "noPublicAddress" : "entryUnreadable" };
	}
	return { ...out, imageIssue: item ? "noPublicAddress" : "entryUnreadable" };
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

/** When a spent window resets, if any window is spent: before the first request from what is stored, after each from the response. */
function spentUntil(stored: Stored, now: Date): number | undefined {
	const decision = publishDecision(storedReadings(stored, now));
	return decision.allowed ? undefined : Date.parse(decision.until);
}

function spentAfter(rateLimit: RateLimitSnapshot | undefined, now: Date): number | undefined {
	if (!rateLimit) return undefined;
	const decision = publishDecision(currentWindows([rateLimit], now));
	return decision.allowed ? undefined : Date.parse(decision.until);
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
 * record lookup, the editor's override, public URL (5); the records
 * written as claims (6); then one createPost per send while two calls stay
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

	// A spent window: nothing is sent, the records wait for its reset.
	const hold = spentUntil(stored, now);
	if (hold !== undefined) {
		for (const row of pending) row.data = { ...row.data, nextAttemptAt: new Date(hold).toISOString() };
	}

	const afterClaim = meter.left() - 1;
	const canSendAll = afterClaim - 1 >= pending.length;
	const sendCount = hold !== undefined ? 0 : Math.max(0, Math.min(pending.length, canSendAll ? pending.length : afterClaim - 2));
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
	let waitUntil: number | undefined = hold;
	if (client) {
		for (const row of toSend) {
			if (waitUntil !== undefined) {
				// Rate-limited or a window spent: the rest wait as well, without a request.
				results.push({ id: row.id, data: { ...row.data, status: "pending", nextAttemptAt: new Date(waitUntil).toISOString(), attempts: row.data.attempts - 1 } });
				continue;
			}
			const result = await client.createPost(createInput(row.data));
			if (result.rateLimit) rateLimit = result.rateLimit;
			const updated = applyResult(row.data, result, now);
			if (!result.ok && result.kind === "rate_limited") waitUntil = Date.parse(updated.nextAttemptAt);
			else waitUntil = spentAfter(result.rateLimit, now);
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

/**
 * The editor panel's Share now: the first send of one entry that was
 * published before the plugin started watching, done by hand. The same
 * preparation and sending as a publish (link, image, UTM, per-service
 * rules, skip reasons, claims, continuations, the publish check), with the
 * editor's saved choices for the entry, and every record marked
 * `origin: "manual"`. The watch itself is left as it is, so no other old
 * entry is shared. The caller has checked that the entry is published,
 * older than the watch and has no records yet.
 *
 * Bridge calls: the public URL (1 at most), then
 * `sendPrepared`'s claim, sends, results and continuation from what is left.
 */
export async function shareNow(
	ctx: PluginContext,
	meter: Meter,
	settings: PluginSettings,
	stored: Stored,
	entry: EntryRef,
	overrides: { skip: string[]; text: Record<string, string> } | null,
	now: Date,
): Promise<{ outcome: PublishOutcome; rows: Array<{ id: string; data: Delivery }> }> {
	const rows = await prepareDeliveries(ctx, {
		entry,
		settings,
		config: stored.config,
		channels: stored.channels,
		now,
		...(overrides && { overrides }),
	});
	for (const row of rows) row.data = { ...row.data, origin: "manual" };
	if (rows.length === 0) return { outcome: { kind: "ignored", why: "noChannels" }, rows };
	return { outcome: await sendPrepared(ctx, meter, settings, stored, rows, now), rows };
}

export interface RunOutcome {
	sent: number;
	resolved: number;
	remaining: number;
}

/**
 * One delivery run. Bridge calls: settings, KV, the open records (3); per
 * unknown record a lookup; per entry whose records carry a 0.1.3 image
 * address, a read of the entry (`repairImage`); per send a claim and a
 * createPost; then the results, the next continuation and the state (3 in
 * reserve).
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
	const entries = new Map<string, EntryItem>();
	let rateLimit: RateLimitSnapshot | undefined;
	// A spent window stops the run before any request: sends and look-ups both count.
	let waitUntil: number | undefined = spentUntil(stored, now);
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
			if (lookup.ok) waitUntil = spentAfter(lookup.rateLimit, now);
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
			// Buffer has no such post: safe to send, unless the look-up spent a window.
			if (waitUntil !== undefined) break;
		}

		// An image address from 0.1.3 or earlier is worked out again before the send: one read per entry.
		const repair = needsImageRepair(current);
		const reads = repair && !entries.has(`${current.collection}:${current.entryId}`) ? 1 : 0;
		if (meter.left() < RESERVE + 2 + reads) {
			if (current !== row.data) updates.set(row.id, current);
			break;
		}
		if (repair) {
			current = await repairImage(ctx, stored, current, entries);
			if (current.status === "skipped") {
				updates.set(row.id, { ...current, updatedAt: stamp });
				continue;
			}
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
		else waitUntil = spentAfter(result.rateLimit, now);
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
		// While Buffer says wait (a 429 or a spent window), nothing goes before it.
		const at = Math.max(now.getTime() + CONTINUATION_DELAY_MS, waitUntil ?? (Number.isFinite(earliest) ? earliest : 0));
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
