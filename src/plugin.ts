/**
 * Hooks, the cron dispatcher, the admin route (the Buffer page and the
 * dashboard widget), the editor panel's route and the MCP tools.
 *
 * Hooks and routes live here rather than in `emdash-plugin.jsonc`: the
 * authored manifest is strict and rejects both, and the build probes this
 * module and writes them into the wire manifest.
 *
 * The route's `permission` is load-bearing. Without one, dispatch falls back
 * to `plugins:manage`; `plugins:read` lets editors see the page, and the
 * handler checks `plugins:manage` itself before changing anything.
 */

import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { CONTINUATION_TASKS, onPublished, runDeliveries } from "./publish/pipeline.js";
import { readSettings } from "./settings.js";
import { readStored, STATE_KEY } from "./store/kv.js";
import { ensureScheduled, isSyncTask, newSyncOffset, runSync } from "./sync/sync.js";
import { channelHealth, engagementSummary, entryStatus, recentDeliveries, TOOL_ROUTES } from "./tools/load.js";
import { mcpTools } from "./tools/declare.js";
import { handleAdmin } from "./ui/handlers.js";
import { handlePanel, PANEL_ROUTE } from "./ui/panel.js";
import { isRecord } from "./values.js";

/**
 * The hooks' own timeout. The default is 5,000 ms, and a publish that sends
 * to Buffer makes up to three requests of up to 8 s each. The sandbox stops
 * every invocation at 30 s of wall time anyway.
 */
const HOOK_TIMEOUT_MS = 30_000;

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => {
			await startWatching(ctx);
		},
		/**
		 * Fires only when an administrator clicks Enable. A site that lists
		 * the plugin in `plugins: []` never gets it, which is why the admin
		 * page also starts the watch and schedules the sync.
		 */
		"plugin:activate": async (_event, ctx) => {
			await startWatching(ctx);
		},

		cron: {
			timeout: HOOK_TIMEOUT_MS,
			handler: async (event, ctx) => {
				// The recurring sync, a Refresh, or a catch-up run (src/sync/sync.ts).
				if (isSyncTask(event.name)) {
					await runSync(ctx, event.name);
					return;
				}
				if ((CONTINUATION_TASKS as readonly string[]).includes(event.name)) {
					await runDeliveries(ctx, { task: event.name });
				}
			},
		},

		// Sharing never blocks a save: a failure is recorded on the delivery,
		// and an editor pressing Publish never sees it.
		"content:afterPublish": {
			errorPolicy: "continue",
			timeout: HOOK_TIMEOUT_MS,
			handler: async (event, ctx) => {
				await share(ctx, event);
			},
		},
		/**
		 * Creating an entry with status "published" fires only
		 * `content:afterSave` with `isNew` (emdash src/emdash-runtime.ts
		 * `handleContentCreate`); `content:afterPublish` fires from the publish
		 * action and the scheduler. Updates are left to afterPublish.
		 */
		"content:afterSave": {
			errorPolicy: "continue",
			timeout: HOOK_TIMEOUT_MS,
			handler: async (event, ctx) => {
				if (!event.isNew || !isRecord(event.content) || event.content.status !== "published") return;
				await share(ctx, event);
			},
		},
	},

	routes: {
		admin: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => await handleAdmin(routeCtx, ctx),
		},

		// The entry editor's Buffer panel (`admin.editorPanels` in the
		// manifest). Same permission as the page: Retry and Send again check
		// `plugins:manage` in the handler.
		[PANEL_ROUTE]: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => await handlePanel(routeCtx, ctx),
		},

		// The MCP tools' routes. They read what the Buffer page shows, so they
		// need the same permission, and they never call Buffer.
		[TOOL_ROUTES.entryStatus]: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => await entryStatus(ctx, routeCtx.input),
		},
		[TOOL_ROUTES.recentDeliveries]: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => await recentDeliveries(ctx, routeCtx.input),
		},
		[TOOL_ROUTES.channelHealth]: {
			permission: "plugins:read",
			handler: async (_routeCtx, ctx) => await channelHealth(ctx),
		},
		[TOOL_ROUTES.engagementSummary]: {
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => await engagementSummary(ctx, routeCtx.input, new Date()),
		},
	},

	mcp: { tools: mcpTools() },
};

async function share(ctx: PluginContext, event: unknown): Promise<void> {
	try {
		await onPublished(ctx, event);
	} catch (error) {
		// One more bridge call. If the error came from a spent budget this
		// fails as well, and errorPolicy "continue" still keeps the save.
		ctx.log.warn("buffer: could not share entry", { error: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * Start watching for new entries (once), pick the install's sync offset
 * (once, in the same write) and schedule the sync at the chosen interval.
 */
async function startWatching(ctx: PluginContext): Promise<void> {
	const settings = await readSettings(ctx);
	const stored = await readStored(ctx);
	const state = {
		...stored.state,
		watchSince: stored.state.watchSince ?? new Date().toISOString(),
		syncOffset: stored.state.syncOffset ?? newSyncOffset(),
	};
	if (!stored.state.watchSince || stored.state.syncOffset === undefined) await ctx.kv.set(STATE_KEY, state);
	await ensureScheduled(ctx, settings.syncInterval, state.syncOffset);
}

export default plugin;
