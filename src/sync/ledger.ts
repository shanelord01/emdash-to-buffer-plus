/**
 * Scan phase: copy deliveries that changed since the last scan into the
 * `ledger` snapshot row the pages read.
 *
 * Bridge calls: the deliveries changed since the last scan (one page, by
 * `updatedAt`), the ledger row, its write when anything changed (3).
 *
 * Every write to a delivery sets `updatedAt`, so walking that index finds
 * every change. Records can share an `updatedAt` (a batch write), so the
 * scan keeps the ids it has already copied at the last moment it reached,
 * as the status pass does. Copying a record twice is harmless: its line
 * is replaced.
 */

import { DELIVERIES, type Delivery } from "../store/deliveries.js";
import { LEDGER_ID, ledgerEntry, parseLedger, REPORTS, trimLedger } from "../store/report.js";
import type { PhaseContext } from "./common.js";

export const SCAN_PAGE = 100;

/** How often the scan runs when it has caught up. */
export const SCAN_EVERY_MS = 25 * 60_000;

export const SCAN_COST = 3;

export async function runScanPhase(p: PhaseContext): Promise<void> {
	const state = p.report.scan ?? {};
	const seen = new Set(state.seen ?? []);
	const page = await p.ctx.storage[DELIVERIES]!.query({
		...(state.after && { where: { updatedAt: { gte: state.after } } }),
		orderBy: { updatedAt: "asc" },
		limit: SCAN_PAGE,
		...(state.cursor && { cursor: state.cursor }),
	});
	const fresh = page.items.filter((i) => !(seen.has(i.id) && (i.data as Delivery).updatedAt === state.after));
	const stamp = p.now.toISOString();

	if (fresh.length > 0) {
		const row = await p.ctx.storage[REPORTS]!.get(LEDGER_ID);
		const before = JSON.stringify(row ?? null);
		const ledger = parseLedger(row);
		for (const item of fresh) ledger.entries[item.id] = ledgerEntry(item.data as Delivery);
		const trimmed = trimLedger(ledger, p.now);
		if (JSON.stringify(trimmed) !== before) await p.ctx.storage[REPORTS]!.put(LEDGER_ID, trimmed);
	}

	const last = page.items[page.items.length - 1];
	if (!last) {
		p.report.scan = { ...(state.after && { after: state.after, seen: [...seen] }), at: stamp };
		return;
	}
	const lastAt = (last.data as Delivery).updatedAt;
	const tie = page.items.filter((i) => (i.data as Delivery).updatedAt === lastAt).map((i) => i.id);
	const seenNext = lastAt === state.after ? [...new Set([...seen, ...tie])] : tie;
	// A full page of one moment that was all seen before cannot move `after`
	// on: carry on from the storage cursor instead.
	const stuck = page.hasMore && fresh.length === 0;
	p.report.scan = {
		after: lastAt,
		seen: seenNext,
		...(stuck && page.cursor && { cursor: page.cursor }),
		...(page.hasMore ? { pending: true, ...(state.at && { at: state.at }) } : { at: stamp }),
	};
}
