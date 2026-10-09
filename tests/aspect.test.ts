import { describe, expect, it } from "vitest";

import { fitsInstagram, formatRatio, shapeProblem } from "../src/publish/aspect.js";
import { sizeOf } from "../src/publish/image.js";

/**
 * Instagram takes 4:5 to 1.91:1, strictly (Buffer's message: "Use an image
 * between 4:5 and 1.91:1"). The expectations are worked out by hand from
 * those two edges, not from the implementation.
 */

describe("fitsInstagram", () => {
	it("takes both edges exactly", () => {
		expect(fitsInstagram(800, 1000)).toBe(true); // 0.8
		expect(fitsInstagram(4, 5)).toBe(true);
		expect(fitsInstagram(191, 100)).toBe(true); // 1.91
		expect(fitsInstagram(1910, 1000)).toBe(true);
		expect(fitsInstagram(382, 200)).toBe(true);
	});

	it("refuses one pixel past either edge", () => {
		expect(fitsInstagram(799, 1000)).toBe(false); // 0.799
		expect(fitsInstagram(1911, 1000)).toBe(false); // 1.911
	});

	it("refuses 1024x536, which is 1.9104:1 and only looks like 1.91:1", () => {
		expect(fitsInstagram(1024, 536)).toBe(false);
		expect(fitsInstagram(1023, 536)).toBe(true); // 1.9086
	});

	it("refuses 3000x600 (5:1) and 600x2000 (3:10), takes square and 4:3", () => {
		expect(fitsInstagram(3000, 600)).toBe(false);
		expect(fitsInstagram(600, 2000)).toBe(false);
		expect(fitsInstagram(1000, 1000)).toBe(true);
		expect(fitsInstagram(1024, 768)).toBe(true);
	});
});

describe("shapeProblem", () => {
	it("names the size only for Instagram with a known shape outside the range", () => {
		expect(shapeProblem("instagram", { width: 3000, height: 1000 })).toEqual({ width: 3000, height: 1000 });
		expect(shapeProblem("instagram", { width: 1200, height: 1000 })).toBeNull();
		expect(shapeProblem("facebook", { width: 3000, height: 1000 })).toBeNull();
		expect(shapeProblem("instagram", {})).toBeNull();
		expect(shapeProblem("instagram", { width: 3000 })).toBeNull();
		expect(shapeProblem("instagram", { width: 0, height: 100 })).toBeNull();
	});
});

describe("formatRatio", () => {
	it("shows small whole ratios as they are", () => {
		expect(formatRatio(3000, 1000)).toBe("3:1");
		expect(formatRatio(3000, 600)).toBe("5:1");
		expect(formatRatio(600, 2000)).toBe("3:10");
	});

	it("shows others against 1, never as the edge they are just past", () => {
		expect(formatRatio(1024, 536)).toBe("1.9104:1");
		expect(formatRatio(2400, 1001)).toBe("2.4:1");
		expect(formatRatio(1001, 2600)).toBe("1:2.6");
		expect(formatRatio(799, 1000)).toBe("1:1.252");
	});
});

describe("sizeOf", () => {
	it("reads the value's own width and height, else meta's, as whole numbers only", () => {
		expect(sizeOf({ width: 10, height: 20 })).toEqual({ width: 10, height: 20 });
		expect(sizeOf({ meta: { width: 10, height: 20 } })).toEqual({ width: 10, height: 20 });
		expect(sizeOf({ width: 10, meta: { width: 30, height: 40 } })).toEqual({ width: 30, height: 40 });
		expect(sizeOf({ width: "10", height: "20" })).toBeNull();
		expect(sizeOf({ width: 10.5, height: 20 })).toBeNull();
		expect(sizeOf({})).toBeNull();
	});
});
