/**
 * Per-entry choices made in the editor panel before an entry is first sent:
 * channels to leave out, and custom text per channel. One record per entry,
 * in the `overrides` storage collection, read by id.
 *
 * Storage rather than KV because `readStored()` lists every KV key in one
 * call, and one key per entry would grow that list without bound.
 *
 * The publish hook reads the record once, when it prepares the entry's
 * deliveries; after that the text is on each delivery record and the
 * override is not read again. Records older than the retention setting are
 * pruned with the delivery records (src/sync/sync.ts).
 */

import { isRecord } from "../values.js";

export const OVERRIDES = "overrides";

/** Longest custom text kept per channel. No network Buffer posts to takes more. */
export const MAX_OVERRIDE_TEXT = 5000;

export interface EntryOverride {
	collection: string;
	entryId: string;
	/** Channel ids left out for this entry. */
	skip: string[];
	/** Custom text (a template: {title}, {description} or {excerpt}, and {url} still work) per channel id. */
	text: Record<string, string>;
	updatedAt: string;
}

export function overrideId(collection: string, entryId: string): string {
	return `${collection}:${entryId}`;
}

/** A stored override, or null when there is none or it is not shaped as one. */
export function parseOverride(raw: unknown): EntryOverride | null {
	if (!isRecord(raw) || typeof raw.collection !== "string" || typeof raw.entryId !== "string") return null;
	const skip = Array.isArray(raw.skip) ? raw.skip.filter((v): v is string => typeof v === "string") : [];
	const text: Record<string, string> = {};
	if (isRecord(raw.text)) {
		for (const [id, value] of Object.entries(raw.text)) {
			if (typeof value === "string" && value.trim()) text[id] = value;
		}
	}
	return {
		collection: raw.collection,
		entryId: raw.entryId,
		skip,
		text,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
	};
}
