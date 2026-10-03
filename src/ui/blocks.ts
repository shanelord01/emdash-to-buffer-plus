/**
 * The Block Kit constructors this plugin needs.
 *
 * Why not `blocks`/`elements` from `@emdash-cms/blocks/server`? Importing
 * them puts the package in the runtime bundle, which the plugin build
 * inlines whole. Every return type here is upstream's own block interface,
 * imported as a type only so it is erased before bundling: a wrong key is a
 * compile error, not a silent no-op. The renderer reads snake_case and
 * silently ignores camelCase, so these constructors are the one place the
 * keys are spelled. The tests run upstream's `validateBlockResponse()` over
 * every response the routes return.
 */

import type {
	ActionElement,
	ActionsBlock,
	BannerBlock,
	ButtonElement,
	ChartBlock,
	ChartSeries,
	CheckboxElement,
	ColumnsBlock,
	ConfirmDialog,
	ContextBlock,
	DividerBlock,
	EmptyBlock,
	FieldCondition,
	FieldsBlock,
	FormBlock,
	FormField,
	HeaderBlock,
	LinkElement,
	LinkTarget,
	SectionBlock,
	SelectElement,
	StatItem,
	StatsBlock,
	TableBlock,
	TableColumn,
	TextInputElement,
	ToggleElement,
} from "@emdash-cms/blocks";

export type { ActionElement, LinkTarget, TableColumn, StatItem, FormField };

export function header(text: string, opts?: { blockId?: string }): HeaderBlock {
	return { type: "header", text, ...(opts?.blockId !== undefined && { block_id: opts.blockId }) };
}

export function section(text: string, opts?: { accessory?: ActionElement; blockId?: string }): SectionBlock {
	return {
		type: "section",
		text,
		...(opts?.accessory !== undefined && { accessory: opts.accessory }),
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function context(text: string, opts?: { blockId?: string }): ContextBlock {
	return { type: "context", text, ...(opts?.blockId !== undefined && { block_id: opts.blockId }) };
}

export function divider(): DividerBlock {
	return { type: "divider" };
}

export function fields(items: Array<{ label: string; value: string }>, opts?: { blockId?: string }): FieldsBlock {
	return { type: "fields", fields: items, ...(opts?.blockId !== undefined && { block_id: opts.blockId }) };
}

export function stats(items: StatItem[], opts?: { blockId?: string }): StatsBlock {
	return { type: "stats", items, ...(opts?.blockId !== undefined && { block_id: opts.blockId }) };
}

export function actions(elements: ActionElement[], opts?: { blockId?: string }): ActionsBlock {
	return { type: "actions", elements, ...(opts?.blockId !== undefined && { block_id: opts.blockId }) };
}

export function button(
	actionId: string,
	label: string,
	opts?: { style?: "primary" | "danger" | "secondary"; value?: unknown; confirm?: ConfirmDialog },
): ButtonElement {
	return {
		type: "button",
		action_id: actionId,
		label,
		...(opts?.style !== undefined && { style: opts.style }),
		...(opts?.value !== undefined && { value: opts.value }),
		...(opts?.confirm !== undefined && { confirm: opts.confirm }),
	};
}

/** Show a form field only while another field of the same form has (or lacks) a value. */
export function shownWhen(field: FormField, condition: FieldCondition): FormField {
	return { ...field, condition };
}

export function link(
	label: string,
	target: LinkTarget,
	opts?: { appearance?: "inline" | "primary" | "secondary" },
): LinkElement {
	return {
		type: "link",
		label,
		target,
		...(opts?.appearance !== undefined && { appearance: opts.appearance }),
	};
}

export function select(
	actionId: string,
	label: string,
	options: Array<{ label: string; value: string }>,
	opts?: { initialValue?: string },
): SelectElement {
	return {
		type: "select",
		action_id: actionId,
		label,
		options,
		...(opts?.initialValue !== undefined && { initial_value: opts.initialValue }),
	};
}

export function toggle(
	actionId: string,
	label: string,
	opts?: { description?: string; initialValue?: boolean },
): ToggleElement {
	return {
		type: "toggle",
		action_id: actionId,
		label,
		...(opts?.description !== undefined && { description: opts.description }),
		...(opts?.initialValue !== undefined && { initial_value: opts.initialValue }),
	};
}

export function textInput(
	actionId: string,
	label: string,
	opts?: { placeholder?: string; initialValue?: string; multiline?: boolean },
): TextInputElement {
	return {
		type: "text_input",
		action_id: actionId,
		label,
		...(opts?.placeholder !== undefined && { placeholder: opts.placeholder }),
		...(opts?.initialValue !== undefined && { initial_value: opts.initialValue }),
		...(opts?.multiline !== undefined && { multiline: opts.multiline }),
	};
}

export function checkbox(
	actionId: string,
	label: string,
	options: Array<{ label: string; value: string }>,
	opts?: { initialValue?: string[] },
): CheckboxElement {
	return {
		type: "checkbox",
		action_id: actionId,
		label,
		options,
		...(opts?.initialValue !== undefined && { initial_value: opts.initialValue }),
	};
}

export function form(
	formFields: FormField[],
	submit: { label: string; actionId: string },
	opts?: { blockId?: string },
): FormBlock {
	return {
		type: "form",
		fields: formFields,
		submit: { label: submit.label, action_id: submit.actionId },
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function banner(opts: {
	title?: string;
	description?: string;
	variant?: "default" | "alert" | "error";
	blockId?: string;
}): BannerBlock {
	return {
		type: "banner",
		...(opts.title !== undefined && { title: opts.title }),
		...(opts.description !== undefined && { description: opts.description }),
		...(opts.variant !== undefined && { variant: opts.variant }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function columns(cols: PageBlock[][], opts?: { blockId?: string }): ColumnsBlock {
	return {
		type: "columns",
		columns: cols as ColumnsBlock["columns"],
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function timeseries(
	series: ChartSeries[],
	opts?: { blockId?: string; height?: number; style?: "line" | "bar"; gradient?: boolean; yAxisName?: string },
): ChartBlock {
	return {
		type: "chart",
		config: {
			chart_type: "timeseries",
			series,
			...(opts?.style !== undefined && { style: opts.style }),
			...(opts?.yAxisName !== undefined && { y_axis_name: opts.yAxisName }),
			...(opts?.height !== undefined && { height: opts.height }),
			...(opts?.gradient !== undefined && { gradient: opts.gradient }),
		},
		...(opts?.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function table(opts: {
	blockId?: string;
	columns: TableColumn[];
	rows: Array<Record<string, unknown>>;
	pageActionId: string;
	nextCursor?: string;
	emptyText?: string;
}): TableBlock {
	return {
		type: "table",
		columns: opts.columns,
		rows: opts.rows,
		page_action_id: opts.pageActionId,
		...(opts.nextCursor !== undefined && { next_cursor: opts.nextCursor }),
		...(opts.emptyText !== undefined && { empty_text: opts.emptyText }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

export function empty(opts: {
	title: string;
	description?: string;
	actions?: ActionElement[];
	blockId?: string;
}): EmptyBlock {
	return {
		type: "empty",
		title: opts.title,
		...(opts.description !== undefined && { description: opts.description }),
		...(opts.actions !== undefined && { actions: opts.actions }),
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
	};
}

/** Every block shape this plugin can emit. */
export type PageBlock =
	| HeaderBlock
	| SectionBlock
	| ContextBlock
	| DividerBlock
	| FieldsBlock
	| StatsBlock
	| ActionsBlock
	| FormBlock
	| BannerBlock
	| ColumnsBlock
	| ChartBlock
	| TableBlock
	| EmptyBlock;
