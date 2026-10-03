/**
 * Counting bridge calls as they are made.
 *
 * A sandboxed invocation gets ten subrequests on Cloudflare and every `ctx`
 * call spends one, `log` and `cron` included (sandbox-workerd runner.ts
 * DEFAULT_LIMITS.subrequests); the eleventh aborts the invocation. Code that
 * decides how many posts it can still send in this invocation needs the
 * count so far, so the context is wrapped once at the entry point and every
 * method call through it is counted. `ctx.site`, `ctx.plugin` and `ctx.url()`
 * are local and not counted.
 *
 * `tests/budget.test.ts` counts the real bridge calls independently, so a
 * miscount here fails a test rather than an invocation.
 */

import type { PluginContext } from "emdash/plugin";

export const CALL_LIMIT = 10;

export interface Meter {
	readonly used: number;
	/** Calls still available in this invocation. */
	left(): number;
}

const LOCAL = new Set<PropertyKey>(["site", "plugin", "url"]);

export function metered(ctx: PluginContext, limit = CALL_LIMIT): { ctx: PluginContext; meter: Meter } {
	let used = 0;
	const meter: Meter = {
		get used() {
			return used;
		},
		left: () => limit - used,
	};

	const wrap = (target: object): object =>
		new Proxy(target, {
			get(obj, prop, receiver) {
				const value = Reflect.get(obj, prop, receiver);
				if (typeof value === "function") {
					return (...args: unknown[]) => {
						used++;
						return (value as (...a: unknown[]) => unknown).apply(obj, args);
					};
				}
				if (typeof value === "object" && value !== null) return wrap(value);
				return value;
			},
		});

	const root = new Proxy(ctx, {
		get(obj, prop, receiver) {
			const value = Reflect.get(obj, prop, receiver);
			if (LOCAL.has(prop)) return value;
			if (typeof value === "object" && value !== null) return wrap(value);
			return value;
		},
	});

	return { ctx: root, meter };
}
