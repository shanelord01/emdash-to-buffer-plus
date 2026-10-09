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
	/** A fixed colour ("#4290F0"), so a series keeps it on every chart. Without one, ECharts picks by position. */
	colour?: string;
	/** A line chart's line: solid (ECharts' default), dashed or dotted. */
	line?: LineType;
	/** A line chart's point marker. Circle is ECharts' default. */
	marker?: Marker;
}

/** ECharts `lineStyle.type` values. The host's sanitiser keeps `lineStyle` whole. */
export const LINE_TYPES = ["solid", "dashed", "dotted"] as const;
export type LineType = (typeof LINE_TYPES)[number];

/**
 * ECharts' built-in point markers, circle first. A larger marker than the
 * usual 4 px circle is drawn for the others, so the shape can be seen.
 */
export const MARKERS = ["circle", "rect", "triangle", "diamond", "pin", "arrow"] as const;
export type Marker = (typeof MARKERS)[number];

/**
 * The host's categorical chart palette in light mode, in kumo's order
 * (@cloudflare/kumo 2.6.0, ChartPalette.categorical and CHART_LIGHT_COLORS:
 * Blue, Yellow, Pink, Purple, Teal, Orange). Kumo's dark palette differs
 * only in Yellow (#EEB720), and a colour set in the options replaces the
 * host's palette in both modes.
 */
export const CHART_COLOURS = ["#4290F0", "#F5B647", "#E8649D", "#8D58EE", "#50C3B6", "#D37536"] as const;

/**
 * Colours for lines past the host palette's six, chosen far from its hues
 * (blue 213, amber 38, pink 334, purple 263, teal 173 and orange 24
 * degrees) and from each other: green (122), red (356), olive (66) and
 * grey. Each reads against kumo's light and dark backgrounds.
 */
export const EXTRA_COLOURS = ["#3A9C3E", "#C8323C", "#8A9A1B", "#7D8590"] as const;

/** Every line colour, the host palette first. */
export const SERIES_COLOURS = [...CHART_COLOURS, ...EXTRA_COLOURS] as const;

/**
 * Each line colour's name, in the same order, as a message key. EmDash
 * registers no ECharts legend component (@emdash-cms/blocks 1.1.0 and
 * 1.2.0 `echarts.use`: bar, line, pie, aria, axis pointer, grid, tooltip),
 * so a `legend` option would draw nothing. The page names each line and
 * its colour in a line of text under the chart instead. Kumo calls
 * #F5B647 Yellow, but its hue (38 degrees) sits between yellow (60) and
 * the palette's orange #D37536 (24), so it is named amber: "yellow" beside
 * "orange" for two orange-looking lines would mislead.
 */
export const SERIES_COLOUR_NAMES = [
	"colourBlue",
	"colourAmber",
	"colourPink",
	"colourPurple",
	"colourTeal",
	"colourOrange",
	"colourGreen",
	"colourRed",
	"colourOlive",
	"colourGrey",
] as const;

/** The name key of a line colour, or null for a colour outside `SERIES_COLOURS`. */
export function colourName(colour: string): (typeof SERIES_COLOUR_NAMES)[number] | null {
	const at = SERIES_COLOURS.indexOf(colour.toUpperCase() as (typeof SERIES_COLOURS)[number]);
	return at < 0 ? null : SERIES_COLOUR_NAMES[at]!;
}

/** The palette colour at a position, wrapping round as kumo's ChartPalette.categorical does. */
export function chartColour(index: number): string {
	return CHART_COLOURS[((index % CHART_COLOURS.length) + CHART_COLOURS.length) % CHART_COLOURS.length]!;
}

/** "rgba(66, 144, 240, 0.4)" from "#4290F0". */
function rgba(hex: string, alpha: number): string {
	const n = Number.parseInt(hex.slice(1), 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

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
 * `formatter` key and registers no legend component, so the options are
 * plain data, series are told apart in the tooltip, and the caller names
 * the lines and their colours in text under the chart (`SERIES_COLOUR_NAMES`).
 * Everything else copies kumo's timeseries options (axes, dashed split
 * lines, grid, a gradient under a single line, bars stacked).
 *
 * A series with no value on any day is left out: it would draw nothing,
 * yet take a palette colour and a row of "-" in the tooltip. A series
 * with a `colour` carries it in `itemStyle` (points, bars and the tooltip
 * marker) and `lineStyle`, a `line` in `lineStyle.type` and a `marker` in
 * `symbol`. The host strips only `formatter`, `rich`, `graphic` and
 * `axisPointer` from custom options (@emdash-cms/blocks 1.1.0
 * `sanitizeOptions`), so all three reach ECharts.
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
	const drawn = opts.series.filter((s) => s.data.some((v) => typeof v === "number"));
	const gradient = opts.gradient && opts.style === "line" && drawn.length === 1;
	const series = drawn.map((s) => ({
		type: opts.style,
		name: s.name,
		data: s.data,
		emphasis: { focus: "series" },
		...(s.colour !== undefined && { itemStyle: { color: s.colour } }),
		...(opts.style === "line" &&
			(s.colour !== undefined || s.line !== undefined) && {
				lineStyle: { ...(s.colour !== undefined && { color: s.colour }), ...(s.line !== undefined && { type: s.line }) },
			}),
		...(opts.style === "bar"
			? { stack: "total" }
			: {
					// A day between two missing days is a point of its own, so every point gets its mark.
					showSymbol: true,
					showAllSymbol: true,
					...(s.marker !== undefined && s.marker !== "circle" ? { symbol: s.marker, symbolSize: 7 } : { symbolSize: 4 }),
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
						// Without a colour of its own, the only line is the palette's first.
						{ offset: 0, color: rgba(s.colour ?? chartColour(0), 0.4) },
						{ offset: 1, color: rgba(s.colour ?? chartColour(0), 0) },
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
