/**
 * The Buffer GraphQL client.
 *
 * Sources: developers.buffer.com /reference.md (types and fields),
 * /guides/error-handling.md (the two kinds of error), /guides/api-limits.md
 * (429, Retry-After, RateLimit headers), /guides/posts-and-scheduling.md.
 * Nothing Buffer marks Experimental or deprecated is used.
 *
 * Every request goes through `graphql()`, which never throws. It sorts each
 * failure by one question that decides what the publishing pipeline may do
 * next: could the request have taken effect at Buffer?
 *
 * - `rejected` (and `unauthorized`, `forbidden`, `not_found`): no. Buffer
 *   answered and refused, so nothing was created.
 * - `uncertain`: maybe. A timeout, a lost connection, a 5xx or an
 *   `UNEXPECTED` error can all happen after Buffer created the post. A
 *   create that ends here is never retried blind; the pipeline looks the
 *   post up first.
 * - `rate_limited`: no. A 429 does not consume quota and creates nothing
 *   (api-limits.md, FAQ), and the answer says how long to wait.
 *
 * No idempotency key is documented for `createPost`, which is why a blind
 * retry after an uncertain answer could post twice.
 */

import { capText, isRecord } from "../values.js";
import { parseRateLimit, type RateLimitSnapshot } from "./ratelimit.js";
import { metricMap, type MetricMap } from "./metrics.js";
import { boardsOf, parseChannelHints, type ChannelHints } from "./services.js";

export const BUFFER_API_URL = "https://api.buffer.com";

/**
 * Per-request timeout. A sandboxed invocation has 30 s of wall time
 * (sandbox-workerd DEFAULT_LIMITS.wallTimeMs) and the pipeline sends at most
 * three requests in one, so 8 s each leaves room for the storage calls.
 */
export const REQUEST_TIMEOUT_MS = 8_000;

/** Stored error text is capped: Buffer's messages are short, a proxy's HTML page is not. */
export const MAX_ERROR_LENGTH = 500;

/** Used when a 429 carries no usable Retry-After. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type FailureKind = "rejected" | "unauthorized" | "forbidden" | "not_found" | "uncertain" | "rate_limited";

export type BufferResult<T> =
	| { ok: true; data: T; rateLimit?: RateLimitSnapshot }
	| {
			ok: false;
			kind: FailureKind;
			message: string;
			status?: number;
			code?: string;
			retryAfterSeconds?: number;
			rateLimit?: RateLimitSnapshot;
	  };

type Failure = Extract<BufferResult<never>, { ok: false }>;

/** GraphQL error codes that prove the operation did not run (error-handling.md, plus GraphQL's own). */
const DEFINITE_CODES: Record<string, FailureKind> = {
	UNAUTHORIZED: "unauthorized",
	FORBIDDEN: "forbidden",
	NOT_FOUND: "not_found",
	GRAPHQL_PARSE_FAILED: "rejected",
	GRAPHQL_VALIDATION_FAILED: "rejected",
	BAD_USER_INPUT: "rejected",
};

export interface BufferClientOptions {
	fetch: Fetcher;
	token: string;
	timeoutMs?: number;
	now?: () => Date;
}

export class BufferClient {
	readonly #fetch: Fetcher;
	readonly #token: string;
	readonly #timeoutMs: number;
	readonly #now: () => Date;

	constructor(opts: BufferClientOptions) {
		this.#fetch = opts.fetch;
		this.#token = opts.token;
		this.#timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
		this.#now = opts.now ?? (() => new Date());
	}

	/** One GraphQL request. Never throws. */
	async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<BufferResult<T>> {
		let response: Response;
		try {
			response = await withTimeout(
				this.#fetch(BUFFER_API_URL, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${this.#token}`,
					},
					body: JSON.stringify({ query, variables }),
				}),
				this.#timeoutMs,
			);
		} catch (error) {
			const message = error instanceof TimeoutError ? error.message : `Buffer could not be reached: ${errorText(error)}`;
			return { ok: false, kind: "uncertain", message: capText(message, MAX_ERROR_LENGTH) };
		}

		const rateLimit = parseRateLimit(response.headers, this.#now());
		const withLimit = <R extends object>(result: R) => (rateLimit ? { ...result, rateLimit } : result);

		if (response.status === 429) {
			const body = await readJson(response);
			return withLimit<Failure>({
				ok: false,
				kind: "rate_limited",
				status: 429,
				code: "RATE_LIMIT_EXCEEDED",
				retryAfterSeconds: retryAfter(response.headers, this.#now()),
				message: capText(firstErrorMessage(body) ?? "Buffer rate-limited the request (429).", MAX_ERROR_LENGTH),
			});
		}

		if (response.status >= 500) {
			return withLimit<Failure>({
				ok: false,
				kind: "uncertain",
				status: response.status,
				message: `Buffer answered with HTTP ${response.status}.`,
			});
		}

		const body = await readJson(response);

		if (response.status === 401 || response.status === 403) {
			return withLimit<Failure>({
				ok: false,
				kind: response.status === 401 ? "unauthorized" : "forbidden",
				status: response.status,
				message: capText(firstErrorMessage(body) ?? `Buffer refused the API key (HTTP ${response.status}).`, MAX_ERROR_LENGTH),
			});
		}

		if (!response.ok) {
			return withLimit<Failure>({
				ok: false,
				kind: "rejected",
				status: response.status,
				message: capText(firstErrorMessage(body) ?? `Buffer answered with HTTP ${response.status}.`, MAX_ERROR_LENGTH),
			});
		}

		if (body === undefined) {
			// A 2xx we cannot read: a mutation may well have run.
			return withLimit<Failure>({
				ok: false,
				kind: "uncertain",
				status: response.status,
				message: "Buffer's answer could not be read as JSON.",
			});
		}

		const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
		if (errors.length > 0) {
			const first = isRecord(errors[0]) ? errors[0] : {};
			const extensions = isRecord(first.extensions) ? first.extensions : {};
			const code = typeof extensions.code === "string" ? extensions.code : undefined;
			const message = capText(typeof first.message === "string" ? first.message : "Buffer reported an error.", MAX_ERROR_LENGTH);
			if (code === "RATE_LIMIT_EXCEEDED") {
				return withLimit<Failure>({
					ok: false,
					kind: "rate_limited",
					code,
					status: response.status,
					retryAfterSeconds: retryAfter(response.headers, this.#now()),
					message,
				});
			}
			const kind = (code && DEFINITE_CODES[code]) || "uncertain";
			return withLimit<Failure>({ ok: false, kind, code, status: response.status, message });
		}

		if (!isRecord(body) || !isRecord(body.data)) {
			return withLimit<Failure>({ ok: false, kind: "uncertain", status: response.status, message: "Buffer's answer had no data." });
		}

		return withLimit({ ok: true as const, data: body.data as T });
	}

	/** `account { organizations { id name } }` (reference.md: Account, Organization). */
	async organizations(): Promise<BufferResult<BufferOrganization[]>> {
		const result = await this.graphql<{ account?: { organizations?: unknown } }>(ORGANIZATIONS_QUERY);
		if (!result.ok) return result;
		const list = Array.isArray(result.data.account?.organizations) ? result.data.account.organizations : [];
		const organizations = list.flatMap((org): BufferOrganization[] =>
			isRecord(org) && typeof org.id === "string" ? [{ id: org.id, name: typeof org.name === "string" ? org.name : org.id }] : [],
		);
		return { ...result, data: organizations };
	}

	/**
	 * Every organization's channels in one request, one alias per
	 * organization. Buffer allows 30 aliases per query (api-limits.md,
	 * Aliases), so at most `MAX_ORGANIZATIONS` organizations are read.
	 */
	async channels(organizationIds: string[]): Promise<BufferResult<BufferChannel[]>> {
		const ids = organizationIds.slice(0, MAX_ORGANIZATIONS);
		if (ids.length === 0) return { ok: true, data: [] };
		const variables: Record<string, unknown> = {};
		const params: string[] = [];
		const selections: string[] = [];
		ids.forEach((id, i) => {
			variables[`o${i}`] = { organizationId: id };
			params.push(`$o${i}: ChannelsInput!`);
			selections.push(`o${i}: channels(input: $o${i}) { ...ChannelFields }`);
		});
		const query = `query Channels(${params.join(", ")}) {\n\t${selections.join("\n\t")}\n}\n${CHANNEL_FIELDS}`;
		const result = await this.graphql<Record<string, unknown>>(query, variables);
		if (!result.ok) return result;
		const channels: BufferChannel[] = [];
		ids.forEach((_, i) => {
			const list = result.data[`o${i}`];
			if (!Array.isArray(list)) return;
			for (const raw of list) {
				const channel = parseChannel(raw);
				if (channel) channels.push(channel);
			}
		});
		return { ...result, data: channels };
	}

	/**
	 * Today's posting limit per channel, one alias per organization because
	 * `dailyPostingLimits` takes channels of one organization only
	 * (reference.md: DailyPostingLimitsInput).
	 */
	async dailyLimits(byOrganization: Map<string, string[]>): Promise<BufferResult<DailyLimit[]>> {
		const groups = [...byOrganization.values()].filter((ids) => ids.length > 0).slice(0, MAX_ORGANIZATIONS);
		if (groups.length === 0) return { ok: true, data: [] };
		const variables: Record<string, unknown> = {};
		const params: string[] = [];
		const selections: string[] = [];
		groups.forEach((channelIds, i) => {
			variables[`l${i}`] = { channelIds };
			params.push(`$l${i}: DailyPostingLimitsInput!`);
			selections.push(`l${i}: dailyPostingLimits(input: $l${i}) { channelId isAtLimit limit scheduled sent }`);
		});
		const query = `query DailyLimits(${params.join(", ")}) {\n\t${selections.join("\n\t")}\n}`;
		const result = await this.graphql<Record<string, unknown>>(query, variables);
		if (!result.ok) return result;
		const limits: DailyLimit[] = [];
		groups.forEach((_, i) => {
			const list = result.data[`l${i}`];
			if (!Array.isArray(list)) return;
			for (const raw of list) {
				if (!isRecord(raw) || typeof raw.channelId !== "string") continue;
				limits.push({
					channelId: raw.channelId,
					isAtLimit: raw.isAtLimit === true,
					limit: typeof raw.limit === "number" ? raw.limit : null,
					scheduled: typeof raw.scheduled === "number" ? raw.scheduled : 0,
					sent: typeof raw.sent === "number" ? raw.sent : 0,
				});
			}
		});
		return { ...result, data: limits };
	}

	/**
	 * Per-channel content rules from Buffer's `configuration` query, one
	 * alias per organization. The query is marked Experimental
	 * (reference.md: configuration, ChannelConfiguration), so it is read as a
	 * hint only (Shane, 2026-10-03): a failed request or a shape this code
	 * does not recognise gives no hints, and the documented rules apply.
	 * Rule fields are selected inside each `__typename` fragment so the query
	 * stays valid whether ValidationRule is served as an interface or a union.
	 */
	async configurationHints(organizationIds: string[]): Promise<BufferResult<Record<string, ChannelHints>>> {
		const ids = organizationIds.slice(0, MAX_ORGANIZATIONS);
		if (ids.length === 0) return { ok: true, data: {} };
		const variables: Record<string, unknown> = {};
		const params: string[] = [];
		const selections: string[] = [];
		ids.forEach((id, i) => {
			variables[`c${i}`] = { organizationId: id };
			params.push(`$c${i}: ConfigurationInput!`);
			selections.push(`c${i}: configuration(input: $c${i}) { ...ConfigurationFields }`);
		});
		const query = `query Configuration(${params.join(", ")}) {\n\t${selections.join("\n\t")}\n}\n${CONFIGURATION_FIELDS}`;
		const result = await this.graphql<Record<string, unknown>>(query, variables);
		if (!result.ok) return result;
		const hints: Record<string, ChannelHints> = {};
		ids.forEach((_, i) => {
			const config = result.data[`c${i}`];
			if (!isRecord(config) || !Array.isArray(config.channels)) return;
			for (const channel of config.channels) {
				const parsed = parseChannelHints(channel);
				if (parsed) hints[parsed.channelId] = parsed.hints;
			}
		});
		return { ...result, data: hints };
	}

	/**
	 * `createPost`. A `MutationError` in the payload is a definite refusal
	 * (error-handling.md: typed mutation errors), returned as `rejected`
	 * with Buffer's own message.
	 */
	async createPost(input: CreatePostInput): Promise<BufferResult<CreatedPost>> {
		const result = await this.graphql<{ createPost?: unknown }>(CREATE_POST_MUTATION, { input });
		if (!result.ok) return result;
		const payload = result.data.createPost;
		if (isRecord(payload) && isRecord(payload.post) && typeof payload.post.id === "string") {
			const post = payload.post;
			return {
				...result,
				data: {
					id: post.id as string,
					status: typeof post.status === "string" ? post.status : null,
					dueAt: typeof post.dueAt === "string" ? post.dueAt : null,
					externalLink: typeof post.externalLink === "string" ? post.externalLink : null,
				},
			};
		}
		if (isRecord(payload) && typeof payload.message === "string") {
			const failure: Failure = {
				ok: false,
				kind: "rejected",
				code: "MUTATION_ERROR",
				message: capText(payload.message, MAX_ERROR_LENGTH),
			};
			return result.rateLimit ? { ...failure, rateLimit: result.rateLimit } : failure;
		}
		// Data came back but neither branch did: the post may exist.
		const failure: Failure = { ok: false, kind: "uncertain", message: "Buffer's createPost answer had neither a post nor an error." };
		return result.rateLimit ? { ...failure, rateLimit: result.rateLimit } : failure;
	}

	/**
	 * A channel's posts created since a moment, newest first: how an
	 * uncertain create is resolved before anything is sent again
	 * (reference.md: posts, PostsInput, PostsFiltersInput.createdAt).
	 */
	async recentPosts(organizationId: string, channelId: string, since: string): Promise<BufferResult<BufferPost[]>> {
		const input = {
			organizationId,
			filter: { channelIds: [channelId], createdAt: { start: since } },
			sort: [{ field: "createdAt", direction: "desc" }],
		};
		const result = await this.graphql<{ posts?: { edges?: unknown } }>(RECENT_POSTS_QUERY, { input });
		if (!result.ok) return result;
		const edges = Array.isArray(result.data.posts?.edges) ? result.data.posts.edges : [];
		const posts = edges.flatMap((edge): BufferPost[] => {
			const node = isRecord(edge) && isRecord(edge.node) ? edge.node : null;
			if (!node || typeof node.id !== "string") return [];
			return [
				{
					id: node.id,
					text: typeof node.text === "string" ? node.text : "",
					status: typeof node.status === "string" ? node.status : null,
					dueAt: typeof node.dueAt === "string" ? node.dueAt : null,
					externalLink: typeof node.externalLink === "string" ? node.externalLink : null,
					createdAt: typeof node.createdAt === "string" ? node.createdAt : null,
					channelId: typeof node.channelId === "string" ? node.channelId : channelId,
				},
			];
		});
		return { ...result, data: posts };
	}
	/**
	 * Where each of our posts stands now, one alias per post. `posts` filters
	 * on channel, status and dates but not on id (efficient-api-usage.md,
	 * "Use aliases"), so each alias asks for the one channel's posts created
	 * in a narrow window around the moment this plugin created the post, and
	 * the answer is matched on id. A filter that matches nothing answers with
	 * an empty list, never an error, so one deleted post cannot spoil the
	 * other lookups in the request (a `post(input: {id})` lookup would: it
	 * returns `Post!`, and an error there nulls the whole answer).
	 * At most `MAX_ALIASES` lookups per request (api-limits.md: 30 aliases).
	 */
	async postStatuses(lookups: StatusLookup[]): Promise<BufferResult<Map<string, PostState | null>>> {
		const list = lookups.slice(0, MAX_ALIASES);
		if (list.length === 0) return { ok: true, data: new Map() };
		const variables: Record<string, unknown> = {};
		const params: string[] = [];
		const selections: string[] = [];
		list.forEach((l, i) => {
			variables[`s${i}`] = {
				organizationId: l.organizationId,
				filter: { channelIds: [l.channelId], createdAt: { start: l.start, end: l.end } },
			};
			params.push(`$s${i}: PostsInput!`);
			selections.push(`s${i}: posts(first: ${STATUS_PAGE}, input: $s${i}) { edges { node { ...PostState } } }`);
		});
		const query = `query PostStatuses(${params.join(", ")}) {\n\t${selections.join("\n\t")}\n}\n${POST_STATE_FIELDS}`;
		const result = await this.graphql<Record<string, unknown>>(query, variables);
		if (!result.ok) return result;
		const found = new Map<string, PostState | null>();
		list.forEach((l, i) => {
			const alias = result.data[`s${i}`];
			const edges = isRecord(alias) && Array.isArray(alias.edges) ? alias.edges : [];
			const match = edges.map((e) => parsePostState(isRecord(e) ? e.node : null)).find((p) => p?.id === l.postId);
			found.set(l.postId, match ?? null);
		});
		return { ...result, data: found };
	}

	/**
	 * One page of an organization's sent posts with their metrics, newest
	 * first (reference.md: posts, PostsFiltersInput.status and createdAt;
	 * post-metrics.md: "Reading metrics for a single post"). Pages hold at
	 * most 100 posts (efficient-api-usage.md, "Use pagination").
	 */
	async sentPostMetrics(
		organizationId: string,
		channelIds: string[],
		since: string,
		after?: string,
	): Promise<BufferResult<{ posts: PostState[]; endCursor: string | null; hasNextPage: boolean }>> {
		const input = {
			organizationId,
			filter: { channelIds, status: ["sent"], createdAt: { start: since } },
			sort: [{ field: "createdAt", direction: "desc" }],
		};
		const result = await this.graphql<{ posts?: { edges?: unknown; pageInfo?: unknown } }>(SENT_METRICS_QUERY, {
			input,
			...(after && { after }),
		});
		if (!result.ok) return result;
		const edges = Array.isArray(result.data.posts?.edges) ? result.data.posts.edges : [];
		const pageInfo = isRecord(result.data.posts?.pageInfo) ? result.data.posts.pageInfo : {};
		const posts = edges.flatMap((e) => {
			const post = parsePostState(isRecord(e) ? e.node : null);
			return post ? [post] : [];
		});
		return {
			...result,
			data: {
				posts,
				endCursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
				hasNextPage: pageInfo.hasNextPage === true,
			},
		};
	}

	/**
	 * `aggregatedPostMetrics`, one alias per window and channel
	 * (reference.md: AggregatedPostMetricsInput, AggregatedPostMetrics).
	 * One channel per alias because a mixed-network filter keeps only the
	 * metric types every network in it reports (post-metrics.md,
	 * "Cross-channel intersection"), which would drop impressions and
	 * engagementRate for most sites.
	 */
	async aggregates(windows: AggregateWindow[]): Promise<BufferResult<AggregateResult[]>> {
		const list = windows.slice(0, MAX_ALIASES);
		if (list.length === 0) return { ok: true, data: [] };
		const variables: Record<string, unknown> = {};
		const params: string[] = [];
		const selections: string[] = [];
		list.forEach((w, i) => {
			variables[`a${i}`] = {
				organizationId: w.organizationId,
				startDateTime: w.start,
				endDateTime: w.end,
				channelIds: [w.channelId],
			};
			params.push(`$a${i}: AggregatedPostMetricsInput!`);
			selections.push(`a${i}: aggregatedPostMetrics(input: $a${i}) { metrics { type value unit } metricsUpdatedAt }`);
		});
		const query = `query Aggregates(${params.join(", ")}) {\n\t${selections.join("\n\t")}\n}`;
		const result = await this.graphql<Record<string, unknown>>(query, variables);
		if (!result.ok) return result;
		const out: AggregateResult[] = [];
		list.forEach((w, i) => {
			const raw = result.data[`a${i}`];
			if (!isRecord(raw)) return;
			const metrics = metricMap(raw.metrics);
			if (!metrics) return;
			out.push({ window: w, metrics, metricsUpdatedAt: typeof raw.metricsUpdatedAt === "string" ? raw.metricsUpdatedAt : null });
		});
		return { ...result, data: out };
	}
}

/** Buffer's cap on aliases in one query (api-limits.md, Query Limits: Aliases). */
export const MAX_ALIASES = 30;

/** Posts asked for per status lookup: the window is minutes wide, so a handful is plenty. */
export const STATUS_PAGE = 10;

/** Sent posts per metrics page: Buffer's maximum page (efficient-api-usage.md). */
export const METRICS_PAGE = 100;

export interface StatusLookup {
	postId: string;
	organizationId: string;
	channelId: string;
	start: string;
	end: string;
}

/** A post as the status and metrics reads see it (reference.md: Post). */
export interface PostState {
	id: string;
	status: string | null;
	dueAt: string | null;
	sentAt: string | null;
	externalLink: string | null;
	/** PostPublishingError.message, when Buffer could not publish. */
	error: string | null;
	/** Null when the read did not ask for metrics or Buffer has none for the post yet. */
	metrics: MetricMap | null;
	metricsUpdatedAt: string | null;
}

export interface AggregateWindow {
	organizationId: string;
	channelId: string;
	start: string;
	end: string;
	/** What the caller files the answer under: a day, or a range in days. */
	key: string;
}

export interface AggregateResult {
	window: AggregateWindow;
	metrics: MetricMap;
	metricsUpdatedAt: string | null;
}

const POST_STATE_FIELDS = `fragment PostState on Post {
	id
	status
	dueAt
	sentAt
	externalLink
	error {
		message
	}
}`;

const SENT_METRICS_QUERY = `query SentPostMetrics($input: PostsInput!, $after: String) {
	posts(first: ${METRICS_PAGE}, after: $after, input: $input) {
		edges {
			node {
				...PostState
				metrics {
					type
					value
					unit
				}
				metricsUpdatedAt
			}
		}
		pageInfo {
			endCursor
			hasNextPage
		}
	}
}
${POST_STATE_FIELDS}`;

function parsePostState(node: unknown): PostState | null {
	if (!isRecord(node) || typeof node.id !== "string") return null;
	const error = isRecord(node.error) && typeof node.error.message === "string" ? capText(node.error.message, MAX_ERROR_LENGTH) : null;
	return {
		id: node.id,
		status: typeof node.status === "string" ? node.status : null,
		dueAt: typeof node.dueAt === "string" ? node.dueAt : null,
		sentAt: typeof node.sentAt === "string" ? node.sentAt : null,
		externalLink: typeof node.externalLink === "string" ? node.externalLink : null,
		error,
		metrics: metricMap(node.metrics),
		metricsUpdatedAt: typeof node.metricsUpdatedAt === "string" ? node.metricsUpdatedAt : null,
	};
}

/** Organizations read per discovery: two aliases each (channels, limits) stay well under 30. */
export const MAX_ORGANIZATIONS = 10;

/** Posts asked for when resolving an uncertain create. */
export const RECENT_POSTS_PAGE = 20;

export interface BufferOrganization {
	id: string;
	name: string;
}

export interface BufferChannel {
	id: string;
	organizationId: string;
	name: string;
	displayName: string | null;
	service: string;
	avatar: string | null;
	isDisconnected: boolean;
	isLocked: boolean;
	isQueuePaused: boolean;
	/** Mastodon only: the server's own text limit (reference.md: MastodonMetadata.maxCharacters). */
	maxCharacters?: number;
	/** Pinterest only: the boards a Pin can go to (reference.md: PinterestMetadata.boards). */
	boards?: Array<{ serviceId: string; name: string }>;
}

export interface DailyLimit {
	channelId: string;
	isAtLimit: boolean;
	/** Null means unlimited (reference.md: DailyPostingLimitStatus.limit). */
	limit: number | null;
	scheduled: number;
	sent: number;
}

export type ShareMode = "addToQueue" | "shareNext" | "shareNow";

export interface CreatePostInput {
	channelId: string;
	text: string;
	mode: ShareMode;
	schedulingType: "automatic";
	assets: Array<{ image: { url: string; metadata?: { altText: string } } }>;
	metadata?: Record<string, unknown>;
	saveToDraft?: boolean;
}

export interface CreatedPost {
	id: string;
	status: string | null;
	dueAt: string | null;
	externalLink: string | null;
}

export interface BufferPost {
	id: string;
	text: string;
	status: string | null;
	dueAt: string | null;
	externalLink: string | null;
	createdAt: string | null;
	channelId: string;
}

const ORGANIZATIONS_QUERY = `query Organizations {
	account {
		organizations {
			id
			name
		}
	}
}`;

const CHANNEL_FIELDS = `fragment ChannelFields on Channel {
	id
	organizationId
	name
	displayName
	service
	avatar
	isDisconnected
	isLocked
	isQueuePaused
	metadata {
		... on MastodonMetadata {
			maxCharacters
		}
		... on PinterestMetadata {
			boards {
				serviceId
				name
			}
		}
	}
}`;

const CONFIGURATION_FIELDS = `fragment ConfigurationFields on Configuration {
	channels {
		channelId
		service
		content {
			configurationContentTypes
			supportedProperties
			rules {
				__typename
				... on CountRule {
					property
					min
					max
				}
				... on LengthRule {
					property
					maxLength
				}
			}
		}
	}
}`;

const CREATE_POST_MUTATION = `mutation CreatePost($input: CreatePostInput!) {
	createPost(input: $input) {
		... on PostActionSuccess {
			post {
				id
				status
				dueAt
				externalLink
			}
		}
		... on MutationError {
			message
		}
	}
}`;

const RECENT_POSTS_QUERY = `query RecentPosts($input: PostsInput!) {
	posts(first: ${RECENT_POSTS_PAGE}, input: $input) {
		edges {
			node {
				id
				text
				status
				dueAt
				externalLink
				createdAt
				channelId
			}
		}
	}
}`;

function parseChannel(raw: unknown): BufferChannel | null {
	if (!isRecord(raw) || typeof raw.id !== "string") return null;
	const metadata = isRecord(raw.metadata) ? raw.metadata : {};
	return {
		id: raw.id,
		organizationId: typeof raw.organizationId === "string" ? raw.organizationId : "",
		name: typeof raw.name === "string" ? raw.name : raw.id,
		displayName: typeof raw.displayName === "string" ? raw.displayName : null,
		service: typeof raw.service === "string" ? raw.service : "unknown",
		avatar: typeof raw.avatar === "string" ? raw.avatar : null,
		isDisconnected: raw.isDisconnected === true,
		isLocked: raw.isLocked === true,
		isQueuePaused: raw.isQueuePaused === true,
		...(typeof metadata.maxCharacters === "number" && { maxCharacters: metadata.maxCharacters }),
		...(Array.isArray(metadata.boards) && { boards: boardsOf(metadata) }),
	};
}

class TimeoutError extends Error {}

/**
 * Race the request against a timer. `AbortSignal` alone is not enough: the
 * sandbox marshals only method, headers, redirect and body across the
 * bridge (sandbox-workerd wrapper.ts `marshalRequestInit`), so a signal never
 * reaches the host's fetch. The race at least gives the invocation its time
 * back; the request itself may still complete at Buffer, which is exactly
 * the case the pipeline treats as uncertain.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new TimeoutError(`Buffer did not answer within ${Math.round(ms / 1000)} s.`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

function firstErrorMessage(body: unknown): string | undefined {
	if (!isRecord(body) || !Array.isArray(body.errors)) return undefined;
	const first = body.errors[0];
	return isRecord(first) && typeof first.message === "string" ? first.message : undefined;
}

/** Retry-After in seconds or as an HTTP date (api-limits.md: "the number to sleep on"). */
export function retryAfter(headers: Headers, now: Date): number {
	const raw = headers.get("retry-after");
	if (!raw) return DEFAULT_RETRY_AFTER_SECONDS;
	const seconds = Number(raw.trim());
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
	const date = Date.parse(raw);
	if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now.getTime()) / 1000));
	return DEFAULT_RETRY_AFTER_SECONDS;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
