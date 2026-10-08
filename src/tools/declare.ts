/**
 * The MCP tool declarations.
 *
 * Only `src/plugin.ts` references `mcpTools()`, from its `mcp` property,
 * which the plugin build strips from the runtime: these schemas end up in
 * the manifest as JSON Schema, and neither zod nor this module ships in the
 * bundle. Keep it that way. A schema used by a route handler would pull zod
 * into every sandboxed invocation.
 *
 * Output schemas become strict JSON Schema (`additionalProperties: false`)
 * that the MCP server checks every answer against, so each one has to match
 * its loader's result type in `./load.ts` exactly. `tests/tools.test.ts`
 * holds each loader's output against the schema the build wrote.
 *
 * Every tool is read-only and answers from stored data; none calls Buffer.
 */

import type { SandboxedMcpTool } from "emdash/plugin";
import { z } from "zod";

import { SKIP_REASONS } from "../buffer/services.js";
import { DEFAULT_LIMIT, DEFAULT_SUMMARY_DAYS, DELIVERY_STATUSES, MAX_COLLECTION, MAX_ENTRY_ID, MAX_LIMIT, TOOL_ROUTES } from "./load.js";

export function mcpTools(): Record<string, SandboxedMcpTool> {
	// Days follow the "Time zone" setting (src/time/zone.ts). Moments are
	// still UTC instants.
	const iso = z.string().describe("ISO 8601, UTC.");
	const day = z.string().describe("A day in the plugin's Time zone setting, YYYY-MM-DD.");
	const lastSync = iso.nullable().describe("When the plugin last synced with Buffer, or null before the first sync.");
	const status = z
		.enum(DELIVERY_STATUSES as [string, ...string[]])
		.describe(
			"The plugin's delivery state: pending (waiting to be sent), sending, sent (Buffer took the post), unknown (the request may have reached Buffer; it is looked up before any resend), failed (Buffer refused; sent again only by Retry), skipped (the channel could not take the entry, see reason).",
		);
	const figure = (what: string) => z.number().nullable().describe(`${what}. Null when Buffer has no figure yet or the network does not report it: missing, not zero.`);

	const delivery = z.object({
		entryId: z.string(),
		collection: z.string(),
		entryTitle: z.string(),
		channelId: z.string(),
		channelName: z.string(),
		service: z.string().describe("Buffer's service name, such as linkedin or bluesky."),
		status,
		bufferStatus: z
			.string()
			.nullable()
			.describe("The post's status at Buffer after it was taken: scheduled, sending, sent, error, draft, needs_approval, or notFound when it is no longer in Buffer. Null before Buffer took it."),
		reason: z.string().nullable().describe("Why a skipped delivery was skipped, as a reason code."),
		error: z.string().nullable().describe("Buffer's own message when it refused the post or could not publish it."),
		postUrl: z.string().nullable().describe("The live post on the network, once Buffer published it."),
		dueAt: iso.nullable().describe("When Buffer plans to publish the post."),
		sentAt: iso.nullable().describe("When the network published the post."),
		createdAt: iso,
		attempts: z.number().int(),
		shortened: z.boolean().describe("True when the excerpt was shortened to fit the network's limit."),
		engagement: figure("Reactions, comments, shares, reposts, saves and quotes, as Buffer counts them"),
		impressions: figure("How often the post was shown"),
		engagementRate: figure("Buffer's engagement rate for the post, 0 to 100"),
		metricsUpdatedAt: iso.nullable().describe("When Buffer last read the post's figures. Buffer refreshes them about once a day."),
	});

	return {
		entry_status: {
			description:
				"Where one entry's posts to Buffer stand, one line per channel and per send, newest first. " +
				"Pass entryId (the entry's id), or id with collection. " +
				"found is false when the plugin has no delivery for the entry: it was published before the plugin started watching, its collection is not shared, or it is not published yet. " +
				"Answers from stored data; status at Buffer is as of lastSync.",
			route: TOOL_ROUTES.entryStatus,
			input: z.object({
				entryId: z.string().min(1).max(MAX_ENTRY_ID).optional().describe("The entry's id."),
				id: z.string().min(1).max(MAX_ENTRY_ID).optional().describe("The entry's id, used with collection when entryId is not given."),
				collection: z
					.string()
					.max(MAX_COLLECTION)
					.regex(/^[a-z][a-z0-9_]*$/)
					.optional()
					.describe("The entry's collection slug, such as posts."),
			}),
			output: z.object({
				found: z.boolean(),
				entryId: z.string().nullable(),
				collection: z.string().nullable(),
				title: z.string().nullable(),
				deliveries: z.array(delivery),
				lastSync,
			}),
			destructive: false,
		},
		recent_deliveries: {
			description:
				"The newest deliveries to Buffer across every entry, newest first, optionally only those of one status (failed, for example). " +
				"Use it to answer what went out recently or what failed. Answers from stored data.",
			route: TOOL_ROUTES.recentDeliveries,
			input: z.object({
				limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`How many, 1 to ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`),
				status: status.optional().describe("Only deliveries in this state."),
			}),
			output: z.object({
				status: status.nullable().describe("The status filter used, or null for all."),
				items: z.array(delivery),
				lastSync,
			}),
			destructive: false,
		},
		channel_health: {
			description:
				"Every Buffer channel the plugin discovered: whether it shares to it, why not when it cannot (disconnected, locked, a service Buffer cannot post to from the API, a missing Pinterest board), queue paused, today's posting limit, and the rules that apply (image needed or allowed, link card, text limit). " +
				"Also the number of failed deliveries, the newest Buffer rate-limit reading and the last problem reading Buffer. " +
				"Channel state is as of fetchedAt; the plugin refreshes it daily.",
			route: TOOL_ROUTES.channelHealth,
			input: z.object({}),
			output: z.object({
				fetchedAt: iso.nullable().describe("When the channels were last read from Buffer."),
				discoveryError: z.object({ at: iso, message: z.string() }).nullable(),
				channels: z.array(
					z.object({
						channelId: z.string(),
						name: z.string(),
						service: z.string(),
						organizationId: z.string(),
						sharing: z.boolean().describe("Turned on in the plugin and able to take entries."),
						blocked: z
							.object({ reason: z.enum(SKIP_REASONS as [string, ...string[]]), message: z.string() })
							.nullable()
							.describe("Why the channel cannot take entries now."),
						disconnected: z.boolean(),
						locked: z.boolean(),
						queuePaused: z.boolean(),
						dailyLimit: z
							.object({ atLimit: z.boolean(), limit: z.number().nullable().describe("Null means no limit."), scheduled: z.number(), sent: z.number() })
							.nullable(),
						rules: z.object({
							image: z.enum(["needed", "allowed", "never"]),
							linkCard: z.boolean(),
							textLimit: z.number().nullable().describe("Characters as Buffer counts them for the network, or null when Buffer documents none."),
							fromConfiguration: z.boolean().describe("True when part of the rule comes from Buffer's per-channel configuration, which Buffer marks experimental."),
						}),
					}),
				),
				failedDeliveries: z.number().int(),
				rateLimit: z
					.object({
						at: iso,
						windows: z.array(
							z.object({
								name: z.string(),
								remaining: z.number(),
								quota: z.number().nullable(),
								windowSeconds: z.number().nullable(),
								resetSeconds: z.number().nullable(),
							}),
						),
					})
					.nullable()
					.describe("Requests left on the API key in each of Buffer's windows, at the newest reading. Other tools using the same key share these."),
				lastProblem: z.object({ at: iso, message: z.string() }).nullable().describe("The last failed read of Buffer by the sync."),
				pausedUntil: iso.nullable().describe("Buffer asked the plugin to slow down; reads resume after this."),
				lastSync,
			}),
			destructive: false,
		},
		engagement_summary: {
			description:
				"How the plugin's posts did over the last 7, 30 or 90 days: sent, failed and queued posts, impressions and engagement, the period before for comparison, per channel and the top entries by engagement. " +
				"Sent, failed and queued count this plugin's posts. Impressions and engagement are Buffer's figures for every post on the shared channels by the day each went out, including posts made in Buffer itself. " +
				"Null means missing, never zero: Buffer refreshes figures about once a day and leaves out what a network does not report. previous fields are null when stored data does not reach back that far; figuresSince is the first day Buffer's figures cover.",
			route: TOOL_ROUTES.engagementSummary,
			input: z.object({
				days: z
					.union([z.literal(7), z.literal(30), z.literal(90)])
					.optional()
					.describe(`Window in days, ending today in the Time zone setting. Default ${DEFAULT_SUMMARY_DAYS}.`),
			}),
			output: z.object({
				window: z.object({ days: z.number().int(), since: day, until: day.describe("Today in the Time zone setting. Its figures still move.") }),
				sent: z.number().int(),
				failed: z.number().int(),
				queued: z.number().int().describe("Waiting to be sent or queued in Buffer now."),
				impressions: figure("Impressions over the window"),
				engagement: figure("Engagement over the window"),
				previous: z.object({
					sent: z.number().int().nullable(),
					failed: z.number().int().nullable(),
					impressions: z.number().nullable(),
					engagement: z.number().nullable(),
				}),
				figuresSince: day.nullable(),
				channels: z.array(
					z.object({
						channelId: z.string(),
						name: z.string(),
						service: z.string(),
						sent: z.number().int(),
						failed: z.number().int(),
						impressions: figure("Buffer's impressions for the channel over the window"),
						engagementRate: figure("Buffer's engagement rate for the channel over the window, 0 to 100"),
					}),
				),
				topEntries: z.array(
					z.object({
						title: z.string(),
						collection: z.string(),
						channelName: z.string(),
						service: z.string(),
						engagement: z.number(),
						impressions: z.number().nullable(),
						postUrl: z.string().nullable(),
						sentAt: iso.nullable(),
					}),
				),
				lastSync,
			}),
			destructive: false,
		},
	};
}
