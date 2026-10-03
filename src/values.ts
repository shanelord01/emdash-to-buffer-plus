/** Small value helpers shared across the plugin. */

export function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}

/** Cut a string to at most `max` UTF-16 units, never through a surrogate pair. */
export function capText(value: string, max: number): string {
	if (value.length <= max) return value;
	let cut = value.slice(0, max);
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
	return cut;
}

/** A lowercase slug of letters, digits and dashes, for UTM values. */
export function slugify(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}
