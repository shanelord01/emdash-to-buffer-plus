/**
 * Delivery records: one per (entry, channel), in the `deliveries` storage
 * collection.
 *
 * States, and what moves a record between them:
 *
 *   pending   waiting to be sent: new, waiting out a 429's Retry-After
 *             (`nextAttemptAt`), or put back by the Retry action.
 *   sending   claimed by an invocation that is about to call createPost.
 *             Written before the request, so an invocation that dies
 *             mid-request leaves a record that says so. One older than
 *             `STALE_SENDING_MS` is treated as unknown.
 *   sent      Buffer created the post: `postId` is set.
 *   unknown   the request may have reached Buffer (timeout, lost
 *             connection, 5xx, UNEXPECTED). Never sent again blind: the
 *             channel's recent posts are looked up first and matched on text.
 *   failed    Buffer refused (MutationError or another definite refusal).
 *             Buffer's message is kept, capped. Sent again only by an
 *             explicit Retry.
 *   skipped   the channel could not take this entry (named `reason`).
 *
 * The text, link and image are prepared once when the entry is published and
 * stored on the record, so a continuation run needs no content reads and an
 * unknown record can be matched against exactly what was sent.
 */

import type { MetricMap } from "../buffer/metrics.js";
import type { ChannelHints } from "../buffer/services.js";

export const DELIVERIES = "deliveries";

export type DeliveryStatus = "pending" | "sending" | "sent" | "unknown" | "failed" | "skipped";

/** Statuses a delivery run picks up. */
export const OPEN_STATUSES: readonly DeliveryStatus[] = ["pending", "sending", "unknown"];

/**
 * A `sending` record older than this belongs to an invocation that ended:
 * the sandbox stops every invocation after 30 s of wall time
 * (sandbox-workerd DEFAULT_LIMITS.wallTimeMs).
 */
export const STALE_SENDING_MS = 60_000;

/** An unknown record that still cannot be resolved after this long is failed for a person to check. */
export const UNKNOWN_GIVE_UP_MS = 24 * 60 * 60 * 1000;

export interface Delivery {
	collection: string;
	entryId: string;
	entryTitle: string;
	channelId: string;
	organizationId: string;
	service: string;
	channelName: string;
	status: DeliveryStatus;
	/** The prepared post. */
	text: string;
	url: string;
	imageUrl?: string;
	imageAlt?: string;
	/**
	 * Why a record whose stored image address needed signing in (0.1.3 and
	 * earlier) goes without an image after its repair: "noPublicAddress"
	 * when the entry has no public address for it, "entryUnreadable" when
	 * the entry could not be read.
	 */
	imageIssue?: "noPublicAddress" | "entryUnreadable";
	/** The link card's description: the entry's excerpt. */
	linkDescription?: string;
	/** Pinterest: the board chosen for the channel when the record was prepared. */
	boardServiceId?: string;
	/** The channel's configuration hints when the record was prepared, so the send builds the same post. */
	hints?: ChannelHints;
	/**
	 * "manual": an administrator shared the entry with the editor panel's
	 * Share now, because it was published before the plugin started
	 * watching. Absent for the automatic share on publish.
	 */
	origin?: "manual";
	mode: "addToQueue" | "shareNext" | "shareNow" | "draft";
	attach: "image" | "link" | "none";
	/** Why the record is skipped or failed, as a message key or Buffer's own words. */
	reason?: string;
	error?: string;
	errorKind?: string;
	attempts: number;
	createdAt: string;
	updatedAt: string;
	lastAttemptAt?: string;
	/** Not before this moment (429 Retry-After). ISO; "" when due now. */
	nextAttemptAt: string;
	postId?: string;
	postStatus?: string;
	dueAt?: string;
	externalLink?: string;
	/** True when the text was shortened to fit the network's limit. */
	shortened?: boolean;
	/** When the network published the post (Post.sentAt), from the status and metrics reads. */
	sentAt?: string;
	/** Buffer's PostPublishingError.message when it could not publish the post. */
	postError?: string;
	/** Status lookups in a row that did not find the post at Buffer. */
	statusMisses?: number;
	/** Post.metrics as a map: only the types Buffer reported. Absent until Buffer has read the post. */
	metrics?: MetricMap;
	/** Post.metricsUpdatedAt: when Buffer last read the figures from the network. */
	metricsUpdatedAt?: string;
}

/**
 * Buffer statuses after which a post can still change
 * (reference.md: PostStatus). The status read follows these.
 */
export const OPEN_POST_STATUSES = ["scheduled", "sending", "needs_approval", "draft"] as const;

/**
 * Not a Buffer status: the plugin's own mark for a post that three status
 * lookups in a row could not find at Buffer, most likely deleted there.
 * It is final, so the post is not looked up again.
 */
export const POST_NOT_FOUND = "notFound";

export function deliveryId(collection: string, entryId: string, channelId: string): string {
	return `${collection}:${entryId}:${channelId}`;
}

/** Whether a record is due for a delivery run now. */
export function isDue(d: Delivery, now: Date): boolean {
	if (d.status === "sending") {
		return !d.lastAttemptAt || now.getTime() - Date.parse(d.lastAttemptAt) >= STALE_SENDING_MS;
	}
	if (d.status !== "pending" && d.status !== "unknown") return false;
	return !d.nextAttemptAt || Date.parse(d.nextAttemptAt) <= now.getTime();
}
