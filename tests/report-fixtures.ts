import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

import type { Aggregates, Ledger, LedgerEntry, ReportState } from "../src/store/report.js";
import { json, NOW } from "./host.js";

/**
 * Buffer answers for the report reads, shaped as developers.buffer.com's
 * reference describes them: `posts` returns PostsResults { edges { node }
 * pageInfo }, Post carries status, dueAt, sentAt, externalLink, error
 * { message }, metrics [{ type, value, unit }] and metricsUpdatedAt, and
 * `aggregatedPostMetrics` returns { metrics, metricsUpdatedAt } with the
 * baseline postCount, reactions and comments always present.
 */

export const DAY = 24 * 60 * 60 * 1000;
export const today = NOW.toISOString().slice(0, 10);
export const dayAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);

export function metric(type: string, value: number, unit: "count" | "percentage" = "count") {
	return { type, value, unit };
}

export function postNode(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		status: "sent",
		dueAt: NOW.toISOString(),
		sentAt: NOW.toISOString(),
		externalLink: `https://www.linkedin.com/feed/update/${id}`,
		error: null,
		...extra,
	};
}

/** The status read's answer: alias s<i> holds the nodes for the i-th record looked up. */
export function statusAnswer(...aliases: Array<Array<Record<string, unknown>>>) {
	return json({ data: Object.fromEntries(aliases.map((nodes, i) => [`s${i}`, { edges: nodes.map((node) => ({ node })) }])) });
}

export function metricsAnswer(nodes: Array<Record<string, unknown>>, page: { endCursor?: string | null; hasNextPage?: boolean } = {}) {
	return json({
		data: {
			posts: {
				edges: nodes.map((node) => ({ node })),
				pageInfo: { endCursor: page.endCursor ?? null, hasNextPage: page.hasNextPage ?? false },
			},
		},
	});
}

/** An aggregates answer for aliases a0 to a<count - 1>, each with the same figures. */
export function aggregatesAnswer(count: number, metrics: Array<{ type: string; value: number; unit: string }>, updated: string | null = NOW.toISOString()) {
	return json({ data: Object.fromEntries(Array.from({ length: count }, (_, i) => [`a${i}`, { metrics, metricsUpdatedAt: updated }])) });
}

export const baseline = (posts: number, reactions: number, comments: number) => [metric("postCount", posts), metric("reactions", reactions), metric("comments", comments)];

export async function seedReport(host: PluginRuntimeTestHost, report: ReportState) {
	await host.fixtures.plugin.kv("report", report);
}

/** A report state in which nothing is due, so a test can switch on only the phase it wants. */
export function nothingDue(): ReportState {
	const stamp = NOW.toISOString();
	return {
		channelsAt: stamp,
		lastPruneAt: stamp,
		status: { at: stamp },
		scan: { at: stamp },
		metrics: { day: today, at: stamp },
		aggregates: { at: stamp, done: today },
	};
}

export function entry(extra: Partial<LedgerEntry> = {}): LedgerEntry {
	return {
		title: "Hello world",
		collection: "posts",
		channelId: "c1",
		channelName: "LinkedIn",
		service: "linkedin",
		status: "sent",
		postStatus: "sent",
		createdAt: NOW.toISOString(),
		sentAt: NOW.toISOString(),
		...extra,
	};
}

export async function seedLedger(host: PluginRuntimeTestHost, entries: Record<string, LedgerEntry>) {
	const ledger: Ledger = { entries };
	await host.fixtures.plugin.storage("reports", "ledger", ledger);
}

export async function seedAggregates(host: PluginRuntimeTestHost, aggregates: Aggregates) {
	await host.fixtures.plugin.storage("reports", "aggregates", aggregates);
}
