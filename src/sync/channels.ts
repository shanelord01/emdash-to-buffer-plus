/**
 * Channel discovery: the organizations, their channels, today's posting
 * limits and Buffer's per-channel configuration hints, stored as one
 * snapshot in KV so pages and publishing never ask Buffer live.
 *
 * Four requests at most: organizations, channels (one alias per
 * organization), daily limits (likewise), configuration (likewise), then one
 * KV write. The Discover button runs it now; the sync runs it daily.
 *
 * The recurring sync passes `mayRequest`, the shared-bucket guard, which
 * is asked before each request with the newest reading so far; when it
 * says no, the refresh stops, writes nothing and hands back the reading,
 * and the last good snapshot stays. Discover, pressed by a person, does not.
 *
 * A failure keeps the last good channel list and records what went wrong.
 * The configuration query is Experimental and only a hint: when it fails,
 * the snapshot has no hints and the documented rules apply.
 */

import type { PluginContext } from "emdash/plugin";

import { BufferClient, MAX_ORGANIZATIONS } from "../buffer/client.js";
import type { RateLimitSnapshot } from "../buffer/ratelimit.js";
import type { PluginSettings } from "../settings.js";
import { CHANNELS_KEY, type ChannelCache, type Stored } from "../store/kv.js";

export type RefreshOutcome =
	| { ok: true; cache: ChannelCache }
	| { ok: false; kind: string; message: string; cache: ChannelCache | null }
	/** Stopped by the shared-bucket guard before a request. Nothing was written. */
	| { ok: false; kind: "headroom"; paused: true; message: string; cache: ChannelCache | null; rateLimit?: RateLimitSnapshot };

export async function refreshChannels(
	ctx: PluginContext,
	settings: PluginSettings,
	stored: Stored,
	now: Date,
	mayRequest?: (latest: RateLimitSnapshot | undefined) => boolean,
): Promise<RefreshOutcome> {
	if (!settings.accessToken || !ctx.http) {
		return { ok: false, kind: "noToken", message: "No Buffer API key is set.", cache: stored.channels };
	}
	const http = ctx.http;
	const client = new BufferClient({ fetch: (url, init) => http.fetch(url, init), token: settings.accessToken });
	const stamp = now.toISOString();
	let rateLimit: RateLimitSnapshot | undefined;

	const fail = async (kind: string, message: string): Promise<RefreshOutcome> => {
		const cache: ChannelCache = {
			...(stored.channels ?? { fetchedAt: "", organizations: [], channels: [], limits: [] }),
			error: { at: stamp, kind, message },
			...(rateLimit && { rateLimit }),
		};
		await ctx.kv.set(CHANNELS_KEY, cache);
		return { ok: false, kind, message, cache };
	};

	const pause = (): RefreshOutcome => ({
		ok: false,
		kind: "headroom",
		paused: true,
		message: "Paused to leave Buffer requests for other tools.",
		cache: stored.channels,
		...(rateLimit && { rateLimit }),
	});
	const allowed = () => !mayRequest || mayRequest(rateLimit);

	if (!allowed()) return pause();
	const orgs = await client.organizations();
	if (orgs.rateLimit) rateLimit = orgs.rateLimit;
	if (!orgs.ok) return await fail(orgs.kind, orgs.message);

	const orgIds = orgs.data.map((o) => o.id).slice(0, MAX_ORGANIZATIONS);
	if (!allowed()) return pause();
	const channels = await client.channels(orgIds);
	if (channels.rateLimit) rateLimit = channels.rateLimit;
	if (!channels.ok) return await fail(channels.kind, channels.message);

	const byOrg = new Map<string, string[]>();
	for (const c of channels.data) byOrg.set(c.organizationId, [...(byOrg.get(c.organizationId) ?? []), c.id]);
	if (!allowed()) return pause();
	const limits = await client.dailyLimits(byOrg);
	if (limits.rateLimit) rateLimit = limits.rateLimit;

	if (!allowed()) return pause();
	const config = await client.configurationHints(orgIds);
	if (config.rateLimit) rateLimit = config.rateLimit;

	const cache: ChannelCache = {
		fetchedAt: stamp,
		organizations: orgs.data.slice(0, MAX_ORGANIZATIONS),
		channels: channels.data,
		limits: limits.ok ? limits.data : (stored.channels?.limits ?? []),
		...(orgs.data.length > MAX_ORGANIZATIONS && { truncated: true }),
		...(config.ok ? { hints: config.data } : { hintsNote: config.message }),
		...(rateLimit && { rateLimit }),
	};
	await ctx.kv.set(CHANNELS_KEY, cache);
	return { ok: true, cache };
}
