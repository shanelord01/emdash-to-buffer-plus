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

/** One line or bar series of a daily chart: a value per label, null where the day has none. */
export interface DailySeries {
	name: string;
	data: Array<number | null>;
}

/** The host palette's first colour, the same in light and dark mode (kumo ChartPalette.categorical(0)). */
const FIRST_COLOUR = { r: 66, g: 144, b: 240 };

/**
 * A chart of one value per day, drawn as `chart_type: "custom"` with a
 * category x-axis of day labels ("23 Sept").
 *
 * Why not `timeseries`: EmDash 1.1 draws it with kumo's TimeseriesChart,
 * whose tooltip formats the x value with a fixed Intl.DateTimeFormat (month,
 * day, hour, minute, second) in the viewer's zone, so a UTC day showed as
 * "23 Sept, 10:00:00" in Sydney. No timestamp gives a date alone. Its
 * series take only [number, number] points, so a day with no figure cannot
 * be a gap and the axis cannot span days without points: it ran from the
 * first point to the last and joined them with a straight line. A custom
 * chart's tooltip is ECharts' own: the category label as the header, a
 * row per series and "-" for a missing day. The host strips every
 * `formatter` key and registers no legend, so the options are plain data
 * and series are told apart in the tooltip, as on the timeseries chart.
 * Everything else copies kumo's timeseries options (axes, dashed split
 * lines, grid, a gradient under a single line, bars stacked).
 */
export function dailyChart(opts: {
	labels: string[];
	series: DailySeries[];
	style: "line" | "bar";
	height: number;
	yAxisName?: string;
	gradient?: boolean;
	blockId?: string;
}): ChartBlock {
	const { r, g, b } = FIRST_COLOUR;
	const gradient = opts.gradient && opts.style === "line" && opts.series.length === 1;
	const series = opts.series.map((s) => ({
		type: opts.style,
		name: s.name,
		data: s.data,
		emphasis: { focus: "series" },
		...(opts.style === "bar"
			? { stack: "total" }
			: {
					// A day between two missing days is a point of its own, so every point gets its mark.
					showSymbol: true,
					showAllSymbol: true,
					symbolSize: 4,
					connectNulls: false,
				}),
		...(gradient && {
			areaStyle: {
				color: {
					type: "linear",
					x: 0,
					y: 0,
					x2: 0,
					y2: 1,
					colorStops: [
						{ offset: 0, color: `rgba(${r}, ${g}, ${b}, 0.4)` },
						{ offset: 1, color: `rgba(${r}, ${g}, ${b}, 0)` },
					],
				},
			},
		}),
	}));
	return {
		type: "chart",
		config: {
			chart_type: "custom",
			height: opts.height,
			options: {
				aria: { enabled: true },
				tooltip: { trigger: "axis" },
				xAxis: { type: "category", data: opts.labels, boundaryGap: opts.style === "bar", axisLine: { show: false }, splitLine: { show: false } },
				yAxis: {
					type: "value",
					minInterval: 1,
					...(opts.yAxisName !== undefined && { name: opts.yAxisName, nameLocation: "middle", nameGap: 40 }),
					axisTick: { show: true },
					axisLabel: { margin: 15 },
					splitLine: { show: true, lineStyle: { type: "dashed", width: 1 } },
				},
				grid: { left: opts.yAxisName !== undefined ? 30 : 24, right: 24, top: 24, bottom: 24 },
				series,
			},
		},
		...(opts.blockId !== undefined && { block_id: opts.blockId }),
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
