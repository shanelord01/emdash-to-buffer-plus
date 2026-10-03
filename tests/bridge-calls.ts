import { PluginBridge } from "@emdash-cms/plugin-test/worker";

/**
 * The bridge calls a sandboxed invocation makes.
 *
 * On Cloudflare every `ctx` call crosses the bridge as one subrequest, and
 * EmDash gives a sandboxed invocation ten; the eleventh aborts it. The
 * local test host enforces no limit, so this wraps the class those calls
 * land on, the test host's own `PluginBridge`. workerd constructs a fresh
 * entrypoint instance for every incoming RPC call, so the first method
 * that runs on an instance is the call; later ones on the same instance
 * are the bridge using its own helpers.
 */

const calls: string[] = [];
const seen = new WeakSet<object>();
const failing = new Set<string>();
let installed = false;

function install(): void {
	if (installed) return;
	installed = true;
	const proto = PluginBridge.prototype as unknown as Record<string, unknown>;
	for (const name of Object.getOwnPropertyNames(proto)) {
		const original = Object.getOwnPropertyDescriptor(proto, name)?.value;
		if (name === "constructor" || typeof original !== "function") continue;
		proto[name] = function (this: object, ...args: unknown[]) {
			if (!seen.has(this)) {
				seen.add(this);
				calls.push(name);
				if (failing.delete(name)) return Promise.reject(new Error(`${name} failed (test)`));
			}
			return (original as (...a: unknown[]) => unknown).apply(this, args);
		};
	}
}

/** Run one invocation and return the bridge calls it made, in order. */
export async function bridgeCalls(invocation: () => Promise<unknown>): Promise<string[]> {
	install();
	calls.length = 0;
	await invocation();
	return [...calls];
}

/**
 * Make the next call to a bridge method fail, as a lost subrequest would.
 *
 * The test host's RPC wrapper also prints the rejection as an uncaught
 * exception. The plugin still receives it; the test run is unaffected.
 */
export function failNextCall(method: string): void {
	install();
	failing.add(method);
}
