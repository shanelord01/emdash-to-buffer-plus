/**
 * Instagram's image shape.
 *
 * Instagram refuses a feed image narrower than 4:5 or wider than 1.91:1,
 * strictly, with no rounding. Buffer then reports "Instagram could not
 * publish this post: the image's aspect ratio is not supported. Use an
 * image between 4:5 and 1.91:1." Buffer cannot crop: `CreatePostInput.assets`
 * takes an image's `url` and `metadata.altText` only (developers.buffer.com
 * /reference.md, ImageAssetInput). So when the entry carries the image's
 * width and height and the shape is outside that range, the Instagram
 * delivery is skipped up front (`imageAspect`) instead of being sent to
 * fail, and the editor panel warns before the first share. An image whose
 * size is not known goes as before: Buffer may still take it.
 *
 * Every test is integer maths: 4:5 is `5 * w >= 4 * h` and 1.91:1 is
 * `100 * w <= 191 * h`. 1024x536 looks like 1.91:1 but is 1.9104:1, which
 * Instagram refuses.
 *
 * Pure: no bridge call.
 */

/** The service whose images must be inside 4:5 to 1.91:1. */
export const ASPECT_SERVICE = "instagram";

/** Whether Instagram takes an image of this size: from 4:5 to 1.91:1, both edges included. */
export function fitsInstagram(width: number, height: number): boolean {
	return 5 * width >= 4 * height && 100 * width <= 191 * height;
}

/**
 * The image's size when a channel of `service` would refuse its shape, else
 * null: another service, a size the entry does not carry, or a shape
 * inside the range.
 */
export function shapeProblem(service: string, image: { width?: number; height?: number }): { width: number; height: number } | null {
	if (service !== ASPECT_SERVICE) return null;
	const { width, height } = image;
	if (!isSize(width) || !isSize(height)) return null;
	return fitsInstagram(width, height) ? null : { width, height };
}

/**
 * An image's shape for people to read: "3:1", "3:10", "2.4:1", "1:2.5".
 * Small whole ratios are shown as they are, others as a decimal against 1,
 * with enough places that a shape just outside the range never reads as
 * its edge (1024x536 is "1.9104:1", not "1.91:1").
 */
export function formatRatio(width: number, height: number): string {
	const g = gcd(width, height);
	if (width / g <= 20 && height / g <= 20) return `${width / g}:${height / g}`;
	const wide = width >= height;
	const value = wide ? width / height : height / width;
	const edge = wide ? "1.91" : "1.25";
	let text = "";
	for (let places = 2; places <= 4; places++) {
		text = String(Number(value.toFixed(places)));
		if (text !== edge) break;
	}
	return wide ? `${text}:1` : `1:${text}`;
}

function gcd(a: number, b: number): number {
	while (b) [a, b] = [b, a % b];
	return a;
}

function isSize(n: number | undefined): n is number {
	return typeof n === "number" && Number.isInteger(n) && n > 0;
}
