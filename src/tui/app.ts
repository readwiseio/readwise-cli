import type { ToolDef, SchemaProperty } from "../config.js";
import { resolveProperty, resolveRef } from "../commands.js";
import { callTool } from "../mcp.js";
import { ensureValidToken } from "../auth.js";
import { LOGO } from "./logo.js";
import { style, paint, screenSize, fitWidth, ansiSlice, stripAnsi, parseKey, type KeyEvent } from "./term.js";
import { VERSION } from "../version.js";

// --- Types ---

type View = "commands" | "form" | "loading" | "results";

interface FormField {
  name: string;
  prop: SchemaProperty;
  required: boolean;
}

interface FormStackEntry {
  parentFieldName: string;   // field name in parent form (e.g. "highlights")
  parentFields: FormField[];
  parentValues: Record<string, string>;
  parentNameColWidth: number;
  parentTitle: string;        // for breadcrumb
  editIndex: number;          // -1 = adding new item, >= 0 = editing existing item at this index
}

function isArrayOfObjects(prop: SchemaProperty): boolean {
  return prop.type === "array" && !!prop.items?.properties;
}

interface AppState {
  view: View;
  tools: ToolDef[];
  // Command list
  listCursor: number;
  listScrollTop: number;
  quitConfirm: boolean;
  searchQuery: string;
  searchCursorPos: number;
  filteredItems: ListItem[];
  // Form
  selectedTool: ToolDef | null;
  fields: FormField[];
  nameColWidth: number;
  formSearchQuery: string;
  formSearchCursorPos: number;
  formFilteredIndices: number[];
  formListCursor: number;
  formScrollTop: number;
  formEditFieldIdx: number;
  formEditing: boolean;
  formInputBuf: string;
  formEnumCursor: number;
  formEnumSelected: Set<number>;
  formValues: Record<string, string>;
  formShowRequired: boolean;
  formStack: FormStackEntry[];
  // Date picker
  dateParts: number[];       // [year, month, day] or [year, month, day, hour, minute]
  datePartCursor: number;    // which part is focused
  // Results
  result: string;
  error: string;
  resultScroll: number;
  resultScrollX: number;
  // Spinner
  spinnerFrame: number;
}

// --- Helpers ---

function humanLabel(toolName: string, prefix: string): string {
  return toolName
    .replace(prefix + "_", "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function toolPrefix(tool: ToolDef): string {
  return tool.name.startsWith("reader_") ? "reader" : "readwise";
}

interface ListItem {
  label: string;
  value: string;
  description?: string;
  isSeparator?: boolean;
}

function buildCommandList(tools: ToolDef[]): ListItem[] {
  const groups: Record<string, { label: string; items: ListItem[] }> = {};
  for (const tool of tools) {
    let groupKey: string;
    let prefix: string;
    if (tool.name.startsWith("readwise_")) { groupKey = "Readwise"; prefix = "readwise"; }
    else if (tool.name.startsWith("reader_")) { groupKey = "Reader"; prefix = "reader"; }
    else { groupKey = "Other"; prefix = ""; }

    if (!groups[groupKey]) groups[groupKey] = { label: groupKey, items: [] };
    groups[groupKey].items.push({
      label: prefix ? humanLabel(tool.name, prefix) : tool.name,
      value: tool.name,
      description: tool.description,
    });
  }
  // Reader first, then Readwise, then anything else
  const order = ["Reader", "Readwise", "Other"];
  const result: ListItem[] = [];
  for (const key of order) {
    const group = groups[key];
    if (group) {
      result.push({ label: group.label, value: "", isSeparator: true });
      result.push(...group.items);
    }
  }
  return result;
}

function selectableIndices(items: ListItem[]): number[] {
  return items.map((item, i) => item.isSeparator ? -1 : i).filter((i) => i >= 0);
}

function filterCommands(tools: ToolDef[], query: string): ListItem[] {
  if (!query) return buildCommandList(tools);
  const q = query.toLowerCase();
  const items: ListItem[] = [];
  for (const tool of tools) {
    const prefix = toolPrefix(tool);
    const label = prefix ? humanLabel(tool.name, prefix) : tool.name;
    const haystack = (label + " " + tool.name + " " + (tool.description || "")).toLowerCase();
    if (haystack.includes(q)) {
      items.push({ label, value: tool.name, description: tool.description });
    }
  }
  return items;
}

function truncateVisible(s: string, maxWidth: number): string {
  if (s.length <= maxWidth) return s;
  if (maxWidth <= 1) return "\u2026";
  return s.slice(0, maxWidth - 1) + "\u2026";
}

function filterFormFields(fields: FormField[], query: string): number[] {
  if (!query) {
    const indices = fields.map((_, i) => i);
    indices.push(-1); // Execute sentinel
    return indices;
  }
  const q = query.toLowerCase();
  const indices: number[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    const haystack = f.name.toLowerCase();
    if (haystack.includes(q)) indices.push(i);
  }
  indices.push(-1); // Execute sentinel always present
  return indices;
}

function executeIndex(filtered: number[]): number {
  return filtered.indexOf(-1);
}

function missingRequiredFields(fields: FormField[], values: Record<string, string>): FormField[] {
  return fields.filter((f) => {
    if (!f.required) return false;
    const val = values[f.name]?.trim();
    if (!val) return true;
    // Array-of-objects: require at least one item
    if (isArrayOfObjects(f.prop)) {
      try { return JSON.parse(val).length === 0; } catch { return true; }
    }
    return false;
  });
}

function defaultFormCursor(fields: FormField[], filtered: number[], values: Record<string, string>): number {
  // Focus first blank required field if any, otherwise Execute
  const missing = new Set(missingRequiredFields(fields, values).map((f) => f.name));
  const firstBlank = filtered.findIndex((idx) => idx >= 0 && missing.has(fields[idx]!.name));
  return firstBlank >= 0 ? firstBlank : executeIndex(filtered);
}

function formFieldValueDisplay(value: string, maxWidth: number): string {
  if (!value) return style.dim("–");
  // JSON array display (for array-of-objects)
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return style.dim(`[${parsed.length} item${parsed.length !== 1 ? "s" : ""}]`);
    }
  } catch { /* not JSON */ }
  const lines = value.split("\n");
  if (lines.length > 1) {
    const first = truncateVisible(lines[0]!, Math.max(1, maxWidth - 12));
    return first + " " + style.dim(`[+${lines.length - 1} lines]`);
  }
  return truncateVisible(value, maxWidth);
}

function popFormStack(state: AppState): AppState {
  const stack = [...state.formStack];
  const entry = stack.pop()!;
  // Serialize sub-form values into a JSON object (only non-empty values)
  const subObj: Record<string, unknown> = {};
  for (const f of state.fields) {
    const val = state.formValues[f.name];
    if (!val) continue;
    if (f.prop.type === "integer" || f.prop.type === "number") {
      const n = Number(val);
      if (!isNaN(n)) subObj[f.name] = n;
    } else if (f.prop.type === "boolean") {
      subObj[f.name] = val === "true";
    } else if (f.prop.type === "array") {
      try {
        const parsed = JSON.parse(val);
        subObj[f.name] = Array.isArray(parsed) ? parsed : val.split(",").map((s) => s.trim()).filter(Boolean);
      } catch {
        subObj[f.name] = val.split(",").map((s) => s.trim()).filter(Boolean);
      }
    } else {
      subObj[f.name] = val;
    }
  }
  // Append or replace in parent array
  const parentVal = entry.parentValues[entry.parentFieldName] || "[]";
  let parentArr: unknown[] = [];
  try { parentArr = JSON.parse(parentVal); } catch { /* */ }
  if (entry.editIndex >= 0) {
    parentArr[entry.editIndex] = subObj;
  } else {
    parentArr.push(subObj);
  }
  const newParentValues = { ...entry.parentValues, [entry.parentFieldName]: JSON.stringify(parentArr) };
  const parentFiltered = filterFormFields(entry.parentFields, "");
  // Return to parent's array editor (editing the array-of-objects field)
  const parentFieldIdx = entry.parentFields.findIndex((f) => f.name === entry.parentFieldName);
  return {
    ...state,
    formStack: stack,
    fields: entry.parentFields,
    nameColWidth: entry.parentNameColWidth,
    formValues: newParentValues,
    formEditing: true,
    formEditFieldIdx: parentFieldIdx,
    formEnumCursor: parentArr.length, // cursor on "Add new item"
    formEnumSelected: new Set(),
    formSearchQuery: "",
    formSearchCursorPos: 0,
    formFilteredIndices: parentFiltered,
    formListCursor: defaultFormCursor(entry.parentFields, parentFiltered, newParentValues),
    formScrollTop: 0,
    formShowRequired: false,
    formInputBuf: "",
  };
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const shuffledLoadingMessages = (() => {
  const msgs = [
    "Fetching data…", "Processing…", "Reaching out to Readwise…",
    "Loading…", "Crunching…", "Almost there…", "Querying…",
    "Thinking…", "Connecting…", "Gathering results…", "Brewing…",
    "Searching…", "Talking to the API…", "Hang tight…",
    "One moment…", "Just a sec…",
  ];
  for (let i = msgs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [msgs[i], msgs[j]] = [msgs[j]!, msgs[i]!];
  }
  return msgs;
})();
const RESET = "\x1b[0m";
const EMPTY_LIST_SENTINEL = "\x00__EMPTY_LIST__";

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

// --- Date helpers ---

type DateFormat = "date" | "date-time";

function dateFieldFormat(prop: SchemaProperty): DateFormat | null {
  if (prop.format === "date") return "date";
  if (prop.format === "date-time") return "date-time";
  return null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function todayParts(fmt: DateFormat): number[] {
  const now = new Date();
  const parts = [now.getFullYear(), now.getMonth() + 1, now.getDate()];
  if (fmt === "date-time") parts.push(now.getHours(), now.getMinutes());
  return parts;
}

function parseDateParts(value: string, fmt: DateFormat): number[] | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (fmt === "date-time") {
    const tm = value.match(/T(\d{2}):(\d{2})/);
    parts.push(tm ? Number(tm[1]) : 0, tm ? Number(tm[2]) : 0);
  }
  return parts;
}

function datePartsToString(parts: number[], fmt: DateFormat): string {
  const y = String(parts[0]).padStart(4, "0");
  const mo = String(parts[1]).padStart(2, "0");
  const d = String(parts[2]).padStart(2, "0");
  if (fmt === "date") return `${y}-${mo}-${d}`;
  const h = String(parts[3] ?? 0).padStart(2, "0");
  const mi = String(parts[4] ?? 0).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:00Z`;
}

function renderDateParts(parts: number[], cursor: number, fmt: DateFormat): string {
  const segments: string[] = [
    String(parts[0]).padStart(4, "0"),
    String(parts[1]).padStart(2, "0"),
    String(parts[2]).padStart(2, "0"),
  ];
  if (fmt === "date-time") {
    segments.push(
      String(parts[3] ?? 0).padStart(2, "0"),
      String(parts[4] ?? 0).padStart(2, "0"),
    );
  }
  const labels = fmt === "date" ? ["Y", "M", "D"] : ["Y", "M", "D", "h", "m"];
  const seps = fmt === "date" ? ["-", "-"] : ["-", "-", " ", ":"];
  let out = "";
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) out += style.dim(seps[i - 1]!);
    const seg = segments[i]!;
    if (i === cursor) {
      out += style.inverse(style.cyan(seg));
    } else {
      out += style.cyan(seg);
    }
  }
  out += "  " + style.dim("←→ part  ↑↓ adjust  " + labels.map((l, i) => (i === cursor ? `[${l}]` : l)).join(" "));
  return out;
}

function adjustDatePart(parts: number[], cursor: number, delta: number, fmt: DateFormat): number[] {
  const p = [...parts];
  if (cursor === 0) {
    // Year
    p[0] = Math.max(1900, Math.min(2100, p[0]! + delta));
  } else if (cursor === 1) {
    // Month: wrap 1-12
    p[1] = ((p[1]! - 1 + delta + 120) % 12) + 1;
  } else if (cursor === 2) {
    // Day: wrap 1-daysInMonth
    const max = daysInMonth(p[0]!, p[1]!);
    p[2] = ((p[2]! - 1 + delta + max * 100) % max) + 1;
  } else if (cursor === 3 && fmt === "date-time") {
    // Hour: wrap 0-23
    p[3] = ((p[3]! + delta + 240) % 24);
  } else if (cursor === 4 && fmt === "date-time") {
    // Minute: wrap 0-59
    p[4] = ((p[4]! + delta + 600) % 60);
  }
  // Clamp day to valid range after month/year changes
  const maxDay = daysInMonth(p[0]!, p[1]!);
  if (p[2]! > maxDay) p[2] = maxDay;
  return p;
}

function datePartCount(fmt: DateFormat): number {
  return fmt === "date" ? 3 : 5;
}

// --- Layout ---

function getBoxDimensions(): { innerWidth: number; fillWidth: number; contentHeight: number } {
  const { cols, rows } = screenSize();
  return {
    innerWidth: Math.max(0, cols - 5),    // visible content width inside │ ... │
    fillWidth: Math.max(0, cols - 3),     // dash count between ╭ and ╮
    contentHeight: Math.max(1, rows - 4), // rows available inside the box
  };
}

function renderLayout(opts: {
  breadcrumb: string;
  content: string[];
  footer: string;
}): string[] {
  const { innerWidth, fillWidth, contentHeight } = getBoxDimensions();
  const lines: string[] = [];

  // Header
  lines.push("  " + opts.breadcrumb);

  // Top border
  lines.push(` ╭${"─".repeat(fillWidth)}╮`);

  // Content (pad or truncate to fill box)
  for (let i = 0; i < contentHeight; i++) {
    const raw = i < opts.content.length ? opts.content[i] ?? "" : "";
    lines.push(` │ ${fitWidth(raw, innerWidth)}${RESET} │`);
  }

  // Bottom border
  lines.push(` ╰${"─".repeat(fillWidth)}╯`);

  // Footer
  lines.push("  " + opts.footer);

  return lines;
}

// --- Rendering ---

function renderCommandList(state: AppState): string[] {
  const { contentHeight, innerWidth } = getBoxDimensions();
  const items = state.filteredItems;
  const content: string[] = [];

  // Logo
  for (let i = 0; i < LOGO.length; i++) {
    const logoLine = style.blue(LOGO[i]!);
    if (i === Math.floor(LOGO.length / 2) - 1) {
      content.push(` ${logoLine}  ${style.boldYellow("Readwise")} ${style.dim("v" + VERSION)}`);
    } else if (i === Math.floor(LOGO.length / 2)) {
      content.push(` ${logoLine}  ${style.dim("Command-line interface")}`);
    } else {
      content.push(` ${logoLine}`);
    }
  }
  content.push("");

  // Search input line
  const queryText = state.searchQuery;
  const before = queryText.slice(0, state.searchCursorPos);
  const cursorChar = state.searchCursorPos < queryText.length
    ? queryText[state.searchCursorPos]!
    : " ";
  const after = state.searchCursorPos < queryText.length
    ? queryText.slice(state.searchCursorPos + 1)
    : "";
  const searchLine = " " + style.yellow("❯") + " " + before + style.inverse(cursorChar) + after;
  content.push(searchLine);
  content.push("");

  // List area (remaining space)
  const logoUsed = content.length;
  const listHeight = Math.max(1, contentHeight - logoUsed);

  if (items.length === 0) {
    content.push("   " + style.dim("No matching commands"));
  } else {
    // Find max label width for alignment
    const labelWidths = items.filter((it) => !it.isSeparator).map((it) => it.label.length);
    const maxLabelWidth = Math.max(...labelWidths, 0);
    // Space budget: "   " prefix (3) + label + "  " gap (2) + description
    const descAvail = Math.max(0, innerWidth - 3 - maxLabelWidth - 2);

    const hiddenBelow = Math.max(0, items.length - (state.listScrollTop + listHeight));
    const visibleSlots = hiddenBelow > 0 ? listHeight - 1 : listHeight;
    const visible = items.slice(state.listScrollTop, state.listScrollTop + visibleSlots);
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]!;
      const realIdx = state.listScrollTop + i;
      if (item.isSeparator) {
        content.push(`   ${style.dim("── " + item.label + " ──")}`);
      } else {
        const selected = realIdx === state.listCursor;
        const prefix = selected ? " ❯ " : "   ";
        const paddedLabel = item.label.padEnd(maxLabelWidth);
        const desc = item.description && descAvail > 3
          ? "  " + style.dim(truncateVisible(item.description, descAvail))
          : "";
        if (selected) {
          content.push(style.boldYellow(prefix + paddedLabel) + desc);
        } else {
          content.push(prefix + paddedLabel + desc);
        }
      }
    }
    if (hiddenBelow > 0) {
      content.push("   " + style.dim(`(${hiddenBelow} more)`));
    }
  }

  const footer = state.quitConfirm
    ? style.yellow("Press q or esc again to quit")
    : style.dim("type to search  ↑↓ navigate  enter select  esc clear/quit");

  return renderLayout({
    breadcrumb: style.boldYellow("Readwise"),
    content,
    footer,
  });
}

function renderForm(state: AppState): string[] {
  const { contentHeight, innerWidth } = getBoxDimensions();
  const tool = state.selectedTool!;
  const fields = state.fields;
  const toolTitle = humanLabel(tool.name, toolPrefix(tool));
  // Build title: tool name + any stack breadcrumb
  const stackParts = state.formStack.map((e) => e.parentFieldName);
  const title = stackParts.length > 0
    ? toolTitle + " › " + stackParts.join(" › ")
    : toolTitle;

  if (state.formEditing && state.formEditFieldIdx >= 0) {
    return renderFormEditMode(state, title, fields, contentHeight, innerWidth);
  }
  return renderFormPaletteMode(state, title, fields, contentHeight, innerWidth);
}

function renderFormPaletteMode(
  state: AppState, title: string, fields: FormField[],
  contentHeight: number, innerWidth: number,
): string[] {
  const content: string[] = [];

  // Tool header
  content.push("");
  content.push("  " + style.bold(title));
  // In sub-form, show the item schema description; otherwise show tool description
  const headerDesc = state.formStack.length > 0
    ? state.formStack[state.formStack.length - 1]!.parentFields
        .find((f) => f.name === state.formStack[state.formStack.length - 1]!.parentFieldName)
        ?.prop.items?.description
    : state.selectedTool!.description;
  if (headerDesc) {
    const wrapped = wrapText(headerDesc, innerWidth - 4);
    for (const line of wrapped) {
      content.push("  " + style.dim(line));
    }
  }
  content.push("");

  // Search input
  const queryText = state.formSearchQuery;
  const before = queryText.slice(0, state.formSearchCursorPos);
  const cursorChar = state.formSearchCursorPos < queryText.length
    ? queryText[state.formSearchCursorPos]!
    : " ";
  const after = state.formSearchCursorPos < queryText.length
    ? queryText.slice(state.formSearchCursorPos + 1)
    : "";
  content.push(" " + style.yellow("❯") + " " + before + style.inverse(cursorChar) + after);
  content.push("");

  // Compute maxLabelWidth
  const maxLabelWidth = Math.max(
    ...fields.map((f) => f.name.length + (f.required ? 2 : 0)),
    6,
  ) + 1;

  // Value display width budget: innerWidth - prefix(3) - label - gap(2)
  const valueAvail = Math.max(0, innerWidth - 3 - maxLabelWidth - 2);

  const headerUsed = content.length;
  // Reserve space for: blank + Execute + blank + description (up to 4 lines)
  const listHeight = Math.max(1, contentHeight - headerUsed - 8);

  const filtered = state.formFilteredIndices;
  const hasOnlyExecute = filtered.length === 1 && filtered[0] === -1;

  if (hasOnlyExecute && state.formSearchQuery) {
    content.push("   " + style.dim("No matching parameters"));
    content.push("");
  } else {
    // Scrolling: items before the Execute sentinel
    const paramItems = filtered.filter((idx) => idx !== -1);
    const visStart = state.formScrollTop;
    const visEnd = Math.min(paramItems.length, visStart + listHeight);
    const visible = paramItems.slice(visStart, visEnd);

    for (const fieldIdx of visible) {
      const field = fields[fieldIdx]!;
      const nameLabel = field.name + (field.required ? " *" : "");
      const paddedName = nameLabel.padEnd(maxLabelWidth);
      const val = state.formValues[field.name] || "";
      const valStr = formFieldValueDisplay(val, valueAvail);
      const listPos = filtered.indexOf(fieldIdx);
      const selected = listPos === state.formListCursor;
      const prefix = selected ? " ❯ " : "   ";
      if (selected) {
        content.push(style.boldYellow(prefix + paddedName) + "  " + valStr);
      } else {
        content.push(prefix + paddedName + "  " + valStr);
      }
    }
  }

  // Execute / Add / Save entry
  const inSubForm = state.formStack.length > 0;
  const isEditing = inSubForm && state.formStack[state.formStack.length - 1]!.editIndex >= 0;
  const actionLabel = inSubForm ? (isEditing ? "Save" : "Add") : "Execute";
  const actionIcon = inSubForm ? (isEditing ? "✓" : "+") : "▶";
  content.push("");
  const executeListPos = filtered.indexOf(-1);
  const executeSelected = executeListPos === state.formListCursor;
  if (executeSelected) {
    content.push(" " + style.inverse(style.green(` ${actionIcon} ${actionLabel} `)));
  } else {
    content.push(" " + style.dim(actionIcon) + " " + actionLabel);
  }

  // Show missing required fields only after a failed submit attempt
  if (state.formShowRequired) {
    const missing = missingRequiredFields(fields, state.formValues);
    if (missing.length > 0) {
      content.push("");
      const names = missing.map((f) => f.name).join(", ");
      content.push("   " + style.red("Required: " + names));
    }
  }

  // Description of highlighted field
  const highlightedIdx = filtered[state.formListCursor];
  if (highlightedIdx !== undefined && highlightedIdx >= 0 && highlightedIdx < fields.length) {
    const desc = fields[highlightedIdx]!.prop.description;
    if (desc) {
      content.push("");
      const wrapped = wrapText(desc, innerWidth - 4);
      for (const line of wrapped) {
        content.push("   " + style.dim(line));
      }
    }
  }

  return renderLayout({
    breadcrumb: style.boldYellow("Readwise") + style.dim(" › ") + style.bold(title),
    content,
    footer: style.dim("type to filter  ↑↓ navigate  enter edit/run  esc back"),
  });
}

function renderFormEditMode(
  state: AppState, title: string, fields: FormField[],
  _contentHeight: number, innerWidth: number,
): string[] {
  const field = fields[state.formEditFieldIdx]!;
  const content: string[] = [];

  content.push("");
  content.push("  " + style.bold(title));
  content.push("");

  // Field name
  const nameLabel = field.name + (field.required ? " *" : "");
  content.push(" " + style.boldYellow("❯ " + nameLabel));

  // Field description
  if (field.prop.description) {
    const wrapped = wrapText(field.prop.description, innerWidth - 4);
    for (const line of wrapped) {
      content.push("  " + style.dim(line));
    }
  }
  content.push("");

  // Editor area
  const eVals = field.prop.enum || field.prop.items?.enum;
  const isArrayObj = isArrayOfObjects(field.prop);
  const isArrayEnum = !isArrayObj && field.prop.type === "array" && !!field.prop.items?.enum;
  const isArrayText = !isArrayObj && field.prop.type === "array" && !field.prop.items?.enum;
  const isBool = field.prop.type === "boolean";
  const dateFmt = dateFieldFormat(field.prop);

  if (isArrayObj) {
    // Array-of-objects editor: show existing items + "Add new item"
    const existing = state.formValues[field.name] || "[]";
    let items: unknown[] = [];
    try { items = JSON.parse(existing); } catch { /* */ }
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Record<string, unknown>;
      const summary = Object.entries(item)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ");
      const isCursor = i === state.formEnumCursor;
      const prefix = isCursor ? " ❯ " : "   ";
      const line = prefix + truncateVisible(summary || "(empty)", innerWidth - 6);
      content.push(isCursor ? style.boldYellow(line) : style.dim(line));
    }
    if (items.length > 0) content.push("");
    const addIdx = items.length;
    const addCursor = state.formEnumCursor === addIdx;
    if (addCursor) {
      content.push(" " + style.inverse(style.green(" + Add new item ")));
    } else {
      content.push(" " + style.dim("+") + " Add new item");
    }
  } else if (dateFmt) {
    content.push("  " + renderDateParts(state.dateParts, state.datePartCursor, dateFmt));
  } else if (isArrayEnum && eVals) {
    // Multi-select picker
    for (let ci = 0; ci < eVals.length; ci++) {
      const isCursor = ci === state.formEnumCursor;
      const isChecked = state.formEnumSelected.has(ci);
      const check = isChecked ? style.cyan("[x]") : style.dim("[ ]");
      const marker = isCursor ? " › " : "   ";
      const label = marker + check + " " + eVals[ci]!;
      content.push(isCursor ? style.bold(label) : label);
    }
  } else if (isArrayText) {
    // Tag-style list editor: navigable items + text input at bottom
    const existing = state.formValues[field.name] || "";
    const items = existing ? existing.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const inputIdx = items.length; // cursor index for the text input line
    for (let i = 0; i < items.length; i++) {
      const isCursor = i === state.formEnumCursor;
      const prefix = isCursor ? " ❯ " : "   ";
      const line = prefix + items[i]!;
      content.push(isCursor ? style.boldYellow(line) : style.cyan(line));
    }
    if (items.length > 0) content.push("");
    const onInput = state.formEnumCursor === inputIdx;
    const inputPrefix = onInput ? " " + style.yellow("❯") + " " : "   ";
    content.push(inputPrefix + style.cyan(state.formInputBuf) + (onInput ? style.inverse(" ") : ""));
    content.push("");
    if (onInput) {
      content.push("   " + style.dim("enter  ") + style.dim(state.formInputBuf ? "add item" : "confirm"));
      content.push("   " + style.dim("esc    ") + style.dim("confirm"));
    } else {
      content.push("   " + style.dim("enter  ") + style.dim("edit item"));
      content.push("   " + style.dim("bksp   ") + style.dim("remove item"));
    }
  } else if (eVals || isBool) {
    const choices = isBool ? ["true", "false"] : eVals!;
    for (let ci = 0; ci < choices.length; ci++) {
      const sel = ci === state.formEnumCursor;
      const choiceLine = (sel ? "   › " : "     ") + choices[ci]!;
      content.push(sel ? style.cyan(style.bold(choiceLine)) : choiceLine);
    }
  } else {
    // Text editor
    const lines = state.formInputBuf.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const prefix = li === 0 ? " " + style.yellow("❯") + " " : "   ";
      if (li === lines.length - 1) {
        content.push(prefix + style.cyan(lines[li]!) + style.inverse(" "));
      } else {
        content.push(prefix + style.cyan(lines[li]!));
      }
    }
  }

  let footer: string;
  if (isArrayObj) {
    footer = style.dim("↑↓ navigate  enter add/select  backspace delete  esc back");
  } else if (dateFmt) {
    footer = style.dim("←→ part  ↑↓ adjust  t today  enter confirm  esc cancel");
  } else if (isArrayEnum) {
    footer = style.dim("space toggle  enter select  esc confirm");
  } else if (isArrayText) {
    footer = style.dim("↑↓ navigate  enter add/edit  backspace delete  esc confirm");
  } else if (eVals || isBool) {
    footer = style.dim("↑↓ navigate  enter confirm  esc cancel");
  } else {
    footer = style.dim("enter confirm  shift+enter newline  esc cancel");
  }

  return renderLayout({
    breadcrumb: style.boldYellow("Readwise") + style.dim(" › ") + style.bold(title),
    content,
    footer,
  });
}

function renderLoading(state: AppState): string[] {
  const { contentHeight } = getBoxDimensions();
  const tool = state.selectedTool;
  const title = tool ? humanLabel(tool.name, toolPrefix(tool)) : "";
  const content: string[] = [];

  const midRow = Math.floor(contentHeight / 2);
  while (content.length < midRow) content.push("");

  const msgIdx = Math.floor(state.spinnerFrame / 13) % shuffledLoadingMessages.length; // ~1s per message (80ms × 13)
  const loadingMsg = shuffledLoadingMessages[msgIdx]!;
  const frame = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]!;
  content.push(`   ${style.cyan(frame)} ${loadingMsg}`);

  return renderLayout({
    breadcrumb: style.boldYellow("Readwise") + style.dim(" › ") + style.bold(title) + style.dim(" › running…"),
    content,
    footer: "",
  });
}

const SUCCESS_ICON = [
  " ██████╗ ██╗  ██╗",
  "██╔═══██╗██║ ██╔╝",
  "██║   ██║█████╔╝ ",
  "██║   ██║██╔═██╗ ",
  "╚██████╔╝██║  ██╗",
  " ╚═════╝ ╚═╝  ╚═╝",
];

function renderResults(state: AppState): string[] {
  const { contentHeight, innerWidth } = getBoxDimensions();
  const tool = state.selectedTool;
  const title = tool ? humanLabel(tool.name, toolPrefix(tool)) : "";
  const isError = !!state.error;
  const isEmptyList = !isError && state.result === EMPTY_LIST_SENTINEL;
  const isEmpty = !isError && !isEmptyList && !state.result.trim();

  // No results screen for empty lists
  if (isEmptyList) {
    const ghost = [
      "  ╔══════════╗  ",
      " ╔╝░░░░░░░░░░╚╗ ",
      "╔╝░░╔══╗░╔══╗░░╚╗",
      "║░░░║  ║░║  ║░░░║",
      "║░░░╚══╝░╚══╝░░░║",
      "║░░░░░░░░░░░░░░░║",
      "║░░░░╔══════╗░░░║",
      "╚╗░░╚╝░░░░░░╚╝░╔╝",
      " ╚╗░░╗░╔╗░╔╗░╔╝ ",
      "  ╚══╝░╚╝░╚╝░╚╝  ",
    ];
    const content: string[] = [];
    const midRow = Math.floor(contentHeight / 2) - Math.floor(ghost.length / 2) - 2;
    while (content.length < midRow) content.push("");
    for (const line of ghost) {
      content.push("  " + style.dim(line));
    }
    content.push("");
    content.push("  " + "No results found");
    content.push("");
    content.push("  " + style.dim("Try adjusting your search parameters."));

    return renderLayout({
      breadcrumb: style.boldYellow("Readwise") + style.dim(" › ") + style.bold(title) + style.dim(" › done"),
      content,
      footer: state.quitConfirm
        ? style.yellow("Press q again to quit")
        : style.dim("enter/esc back  q quit"),
    });
  }

  // Success screen for empty results
  if (isEmpty) {
    const content: string[] = [];
    const toolLabel = tool ? humanLabel(tool.name, toolPrefix(tool)) : "Command";
    const midRow = Math.floor(contentHeight / 2) - Math.floor(SUCCESS_ICON.length / 2) - 1;
    while (content.length < midRow) content.push("");
    for (const line of SUCCESS_ICON) {
      content.push("  " + style.green(line));
    }
    content.push("");
    content.push("  " + style.bold(style.green(toolLabel + " completed successfully")));

    return renderLayout({
      breadcrumb: style.boldYellow("Readwise") + style.dim(" › ") + style.bold(title) + style.dim(" › done"),
      content,
      footer: state.quitConfirm
        ? style.yellow("Press q again to quit")
        : style.dim("enter/esc back  q quit"),
    });
  }

  const rawContent = state.error || state.result;
  const contentLines = rawContent.split("\n");
  const content: string[] = [];

  // Results header
  let resultHeader = isError ? style.red(style.bold("  Error")) : style.bold("  Results");
  const visibleCount = Math.max(1, contentHeight - 3); // header + blank + content
  if (contentLines.length > visibleCount) {
    const from = state.resultScroll + 1;
    const to = Math.min(state.resultScroll + visibleCount, contentLines.length);
    resultHeader += style.dim(` (${from}–${to} of ${contentLines.length})`);
  }
  content.push(resultHeader);
  content.push("");

  // Content (with horizontal scroll)
  const visible = contentLines.slice(state.resultScroll, state.resultScroll + visibleCount);
  for (const line of visible) {
    const shifted = state.resultScrollX > 0 ? ansiSlice(line, state.resultScrollX) : line;
    content.push("  " + (isError ? style.red(shifted) : shifted));
  }

  const scrollHint = state.resultScrollX > 0 ? `←${state.resultScrollX} ` : "";
  return renderLayout({
    breadcrumb: style.boldYellow("Readwise") + style.dim(" › ") + style.bold(title) + style.dim(" › results"),
    content,
    footer: state.quitConfirm
      ? style.yellow("Press q again to quit")
      : style.dim(scrollHint + "↑↓←→ scroll  esc back  q quit"),
  });
}

function renderState(state: AppState): string[] {
  switch (state.view) {
    case "commands": return renderCommandList(state);
    case "form": return renderForm(state);
    case "loading": return renderLoading(state);
    case "results": return renderResults(state);
  }
}

// --- Input handling ---

function handleInput(state: AppState, key: KeyEvent): AppState | "exit" | "submit" {
  switch (state.view) {
    case "commands": return handleCommandListInput(state, key);
    case "form": return handleFormInput(state, key);
    case "results": return handleResultsInput(state, key);
    default: return state;
  }
}

function handleCommandListInput(state: AppState, key: KeyEvent): AppState | "exit" {
  const items = state.filteredItems;
  const selectable = selectableIndices(items);
  const { contentHeight } = getBoxDimensions();
  // search input uses: LOGO.length + 1 (blank) + 1 (search line) + 1 (blank)
  const logoUsed = LOGO.length + 3;
  const listHeight = Math.max(1, contentHeight - logoUsed);

  if (key.ctrl && key.name === "c") return "exit";

  // Escape: clear query if non-empty, otherwise quit confirm
  if (key.name === "escape") {
    if (state.searchQuery) {
      const filtered = filterCommands(state.tools, "");
      const sel = selectableIndices(filtered);
      return { ...state, searchQuery: "", searchCursorPos: 0, filteredItems: filtered, listCursor: sel[0] ?? 0, listScrollTop: 0, quitConfirm: false };
    }
    if (state.quitConfirm) return "exit";
    return { ...state, quitConfirm: true };
  }

  // q: quit confirm when query empty, otherwise insert as text
  if (key.name === "q" && !key.ctrl && !state.searchQuery) {
    if (state.quitConfirm) return "exit";
    return { ...state, quitConfirm: true };
  }

  // Any other key cancels quit confirm
  const s = state.quitConfirm ? { ...state, quitConfirm: false } : state;

  // Arrow left/right: move text cursor within search input
  if (key.name === "left") {
    return { ...s, searchCursorPos: Math.max(0, s.searchCursorPos - 1) };
  }
  if (key.name === "right") {
    return { ...s, searchCursorPos: Math.min(s.searchQuery.length, s.searchCursorPos + 1) };
  }

  // Arrow up/down: navigate filtered command list
  if (key.name === "up") {
    const curIdx = selectable.indexOf(s.listCursor);
    if (curIdx > 0) {
      const next = selectable[curIdx - 1]!;
      let scroll = s.listScrollTop;
      if (next < scroll) scroll = next;
      return { ...s, listCursor: next, listScrollTop: scroll };
    }
    return s;
  }
  if (key.name === "down") {
    const curIdx = selectable.indexOf(s.listCursor);
    if (curIdx < selectable.length - 1) {
      const next = selectable[curIdx + 1]!;
      let scroll = s.listScrollTop;
      if (next >= scroll + listHeight) scroll = next - listHeight + 1;
      return { ...s, listCursor: next, listScrollTop: scroll };
    }
    return s;
  }

  // PgUp/PgDown: jump by a page of selectable items
  if (key.name === "pageup") {
    const curIdx = selectable.indexOf(s.listCursor);
    const next = selectable[Math.max(0, curIdx - listHeight)]!;
    let scroll = s.listScrollTop;
    if (next < scroll) scroll = next;
    return { ...s, listCursor: next, listScrollTop: scroll };
  }
  if (key.name === "pagedown") {
    const curIdx = selectable.indexOf(s.listCursor);
    const next = selectable[Math.min(selectable.length - 1, curIdx + listHeight)]!;
    let scroll = s.listScrollTop;
    if (next >= scroll + listHeight) scroll = next - listHeight + 1;
    return { ...s, listCursor: next, listScrollTop: scroll };
  }

  // Enter: select highlighted command
  if (key.name === "return") {
    const item = items[s.listCursor];
    if (item && !item.isSeparator) {
      const tool = s.tools.find((t) => t.name === item.value);
      if (tool) {
        const properties = tool.inputSchema.properties || {};
        const requiredSet = new Set(tool.inputSchema.required || []);
        const defs = tool.inputSchema.$defs;
        const fields = Object.entries(properties).map(([name, rawProp]) => ({
          name,
          prop: resolveProperty(rawProp, defs),
          required: requiredSet.has(name),
        }));
        const nameColWidth = Math.max(
          ...fields.map((f) => f.name.length + (f.required ? 2 : 0)),
          6
        ) + 1;

        const formValues: Record<string, string> = {};
        for (const f of fields) {
          if (f.prop.default != null) {
            formValues[f.name] = String(f.prop.default);
          } else {
            formValues[f.name] = "";
          }
        }

        if (fields.length === 0) {
          return {
            ...s,
            view: "loading",
            selectedTool: tool,
            fields,
            nameColWidth,
            formValues,
            formSearchQuery: "",
            formSearchCursorPos: 0,
            formFilteredIndices: [],
            formListCursor: 0,
            formScrollTop: 0,
            formEditFieldIdx: -1,
            formEditing: false,
            formInputBuf: "",
            formEnumCursor: 0,
            formEnumSelected: new Set(),
            formShowRequired: false,
            formStack: [],
          };
        }

        return {
          ...s,
          view: "form",
          selectedTool: tool,
          fields,
          nameColWidth,
          formValues,
          formSearchQuery: "",
          formSearchCursorPos: 0,
          formFilteredIndices: filterFormFields(fields, ""),
          formListCursor: defaultFormCursor(fields, filterFormFields(fields, ""), formValues),
          formScrollTop: 0,
          formEditFieldIdx: -1,
          formEditing: false,
          formInputBuf: "",
          formEnumCursor: 0,
          formEnumSelected: new Set(),
          formShowRequired: false,
          formStack: [],
        };
      }
    }
    return s;
  }

  // Backspace: delete char before cursor
  if (key.name === "backspace") {
    if (s.searchCursorPos > 0) {
      const newQuery = s.searchQuery.slice(0, s.searchCursorPos - 1) + s.searchQuery.slice(s.searchCursorPos);
      const filtered = filterCommands(s.tools, newQuery);
      const sel = selectableIndices(filtered);
      return { ...s, searchQuery: newQuery, searchCursorPos: s.searchCursorPos - 1, filteredItems: filtered, listCursor: sel[0] ?? 0, listScrollTop: 0 };
    }
    return s;
  }

  // Printable characters: insert into search query
  if (!key.ctrl && key.raw && key.raw.length === 1 && key.raw >= " ") {
    const newQuery = s.searchQuery.slice(0, s.searchCursorPos) + key.raw + s.searchQuery.slice(s.searchCursorPos);
    const filtered = filterCommands(s.tools, newQuery);
    const sel = selectableIndices(filtered);
    return { ...s, searchQuery: newQuery, searchCursorPos: s.searchCursorPos + 1, filteredItems: filtered, listCursor: sel[0] ?? 0, listScrollTop: 0 };
  }

  return s;
}

function handleFormInput(state: AppState, key: KeyEvent): AppState | "submit" {
  if (state.formEditing) return handleFormEditInput(state, key);
  return handleFormPaletteInput(state, key);
}

function handleFormPaletteInput(state: AppState, key: KeyEvent): AppState | "submit" {
  const { fields, formFilteredIndices: filtered, formListCursor, formSearchQuery } = state;
  const { contentHeight } = getBoxDimensions();
  // Approximate list height (same as in renderFormPaletteMode)
  const headerUsed = 6 + (state.selectedTool?.description ? wrapText(state.selectedTool.description, getBoxDimensions().innerWidth - 4).length : 0);
  const listHeight = Math.max(1, contentHeight - headerUsed - 8);

  if (key.ctrl && key.name === "c") return "submit";

  // Escape: cancel search or go back
  if (key.name === "escape") {
    if (formSearchQuery) {
      const newFiltered = filterFormFields(fields, "");
      return { ...state, formSearchQuery: "", formSearchCursorPos: 0, formFilteredIndices: newFiltered, formListCursor: defaultFormCursor(fields, newFiltered, state.formValues), formScrollTop: 0 };
    }
    // If in sub-form, cancel and go back to parent array editor
    if (state.formStack.length > 0) {
      const stack = [...state.formStack];
      const entry = stack.pop()!;
      const parentFiltered = filterFormFields(entry.parentFields, "");
      const parentFieldIdx = entry.parentFields.findIndex((f) => f.name === entry.parentFieldName);
      const existing = entry.parentValues[entry.parentFieldName] || "[]";
      let items: unknown[] = [];
      try { items = JSON.parse(existing); } catch { /* */ }
      return {
        ...state,
        formStack: stack,
        fields: entry.parentFields,
        nameColWidth: entry.parentNameColWidth,
        formValues: entry.parentValues,
        formEditing: true,
        formEditFieldIdx: parentFieldIdx,
        formEnumCursor: items.length, // cursor on "Add new item"
        formEnumSelected: new Set(),
        formSearchQuery: "",
        formSearchCursorPos: 0,
        formFilteredIndices: parentFiltered,
        formListCursor: defaultFormCursor(entry.parentFields, parentFiltered, entry.parentValues),
        formScrollTop: 0,
        formShowRequired: false,
        formInputBuf: "",
      };
    }
    const resetFiltered = buildCommandList(state.tools);
    const resetSel = selectableIndices(resetFiltered);
    return { ...state, view: "commands", selectedTool: null, searchQuery: "", searchCursorPos: 0, filteredItems: resetFiltered, listCursor: resetSel[0] ?? 0, listScrollTop: 0 };
  }

  // Arrow left/right: move text cursor within search input
  if (key.name === "left") {
    return { ...state, formSearchCursorPos: Math.max(0, state.formSearchCursorPos - 1) };
  }
  if (key.name === "right") {
    return { ...state, formSearchCursorPos: Math.min(formSearchQuery.length, state.formSearchCursorPos + 1) };
  }

  // Arrow up/down: navigate filtered list (cycling)
  if (key.name === "up") {
    const next = formListCursor > 0 ? formListCursor - 1 : filtered.length - 1;
    let scroll = state.formScrollTop;
    const itemIdx = filtered[next]!;
    if (itemIdx !== -1) {
      const paramItems = filtered.filter((idx) => idx !== -1);
      const posInParams = paramItems.indexOf(itemIdx);
      if (posInParams < scroll) scroll = posInParams;
      // Wrap to bottom: reset scroll to show end of list
      if (next > formListCursor) scroll = Math.max(0, paramItems.length - listHeight);
    }
    return { ...state, formListCursor: next, formScrollTop: scroll };
  }
  if (key.name === "down") {
    const next = formListCursor < filtered.length - 1 ? formListCursor + 1 : 0;
    let scroll = state.formScrollTop;
    const itemIdx = filtered[next]!;
    if (itemIdx !== -1) {
      const paramItems = filtered.filter((idx) => idx !== -1);
      const posInParams = paramItems.indexOf(itemIdx);
      if (posInParams >= scroll + listHeight) scroll = posInParams - listHeight + 1;
      // Wrap to top: reset scroll
      if (next < formListCursor) scroll = 0;
    } else if (next < formListCursor) {
      scroll = 0;
    }
    return { ...state, formListCursor: next, formScrollTop: scroll };
  }

  // Enter: edit field or execute/add
  if (key.name === "return") {
    const highlightedIdx = filtered[formListCursor];
    if (highlightedIdx === -1) {
      // Execute/Add — only if all required fields are filled
      if (missingRequiredFields(fields, state.formValues).length === 0) {
        if (state.formStack.length > 0) {
          // Pop sub-form: serialize values and append to parent array
          return popFormStack(state);
        }
        return "submit";
      }
      return { ...state, formShowRequired: true };
    }
    if (highlightedIdx !== undefined && highlightedIdx >= 0 && highlightedIdx < fields.length) {
      const field = fields[highlightedIdx]!;
      // Array-of-objects: enter edit mode with cursor on "Add new item"
      if (isArrayOfObjects(field.prop)) {
        const existing = state.formValues[field.name] || "[]";
        let items: unknown[] = [];
        try { items = JSON.parse(existing); } catch { /* */ }
        return { ...state, formEditing: true, formEditFieldIdx: highlightedIdx, formEnumCursor: items.length };
      }
      const dateFmt = dateFieldFormat(field.prop);
      const enumValues = field.prop.enum || field.prop.items?.enum;
      const isBool = field.prop.type === "boolean";
      if (dateFmt) {
        const existing = state.formValues[field.name] || "";
        const parts = parseDateParts(existing, dateFmt) || todayParts(dateFmt);
        return { ...state, formEditing: true, formEditFieldIdx: highlightedIdx, dateParts: parts, datePartCursor: 0 };
      }
      const isArrayEnum = !isArrayOfObjects(field.prop) && field.prop.type === "array" && !!field.prop.items?.enum;
      if (isArrayEnum && enumValues) {
        const curVal = state.formValues[field.name] || "";
        const selected = new Set<number>();
        if (curVal) {
          const parts = curVal.split(",").map((s) => s.trim());
          for (const p of parts) {
            const idx = enumValues.indexOf(p);
            if (idx >= 0) selected.add(idx);
          }
        }
        return { ...state, formEditing: true, formEditFieldIdx: highlightedIdx, formEnumCursor: 0, formEnumSelected: selected };
      }
      if (enumValues || isBool) {
        const choices = isBool ? ["true", "false"] : enumValues!;
        const curVal = state.formValues[field.name] || "";
        const idx = choices.indexOf(curVal);
        return { ...state, formEditing: true, formEditFieldIdx: highlightedIdx, formEnumCursor: idx >= 0 ? idx : 0 };
      }
      if (field.prop.type === "array" && !field.prop.items?.enum) {
        const existing = state.formValues[field.name] || "";
        const itemCount = existing ? existing.split(",").map((s) => s.trim()).filter(Boolean).length : 0;
        return { ...state, formEditing: true, formEditFieldIdx: highlightedIdx, formInputBuf: "", formEnumCursor: itemCount };
      }
      return { ...state, formEditing: true, formEditFieldIdx: highlightedIdx, formInputBuf: state.formValues[field.name] || "" };
    }
    return state;
  }

  // Backspace: delete char before cursor
  if (key.name === "backspace") {
    if (state.formSearchCursorPos > 0) {
      const newQuery = formSearchQuery.slice(0, state.formSearchCursorPos - 1) + formSearchQuery.slice(state.formSearchCursorPos);
      const newFiltered = filterFormFields(fields, newQuery);
      return { ...state, formSearchQuery: newQuery, formSearchCursorPos: state.formSearchCursorPos - 1, formFilteredIndices: newFiltered, formListCursor: 0, formScrollTop: 0 };
    }
    return state;
  }

  // Printable characters: insert into search query
  if (!key.ctrl && key.raw && key.raw.length === 1 && key.raw >= " ") {
    const newQuery = formSearchQuery.slice(0, state.formSearchCursorPos) + key.raw + formSearchQuery.slice(state.formSearchCursorPos);
    const newFiltered = filterFormFields(fields, newQuery);
    return { ...state, formSearchQuery: newQuery, formSearchCursorPos: state.formSearchCursorPos + 1, formFilteredIndices: newFiltered, formListCursor: 0, formScrollTop: 0 };
  }

  return state;
}

function handleFormEditInput(state: AppState, key: KeyEvent): AppState | "submit" {
  const { fields, formEditFieldIdx, formInputBuf, formEnumCursor, formValues } = state;
  const field = fields[formEditFieldIdx]!;
  const dateFmt = dateFieldFormat(field.prop);
  const enumValues = field.prop.enum || field.prop.items?.enum;
  const isBool = field.prop.type === "boolean";

  const resetPalette = (updatedValues?: Record<string, string>) => {
    const f = filterFormFields(fields, "");
    return { formSearchQuery: "", formSearchCursorPos: 0, formFilteredIndices: f, formListCursor: defaultFormCursor(fields, f, updatedValues ?? formValues), formScrollTop: 0, formShowRequired: false };
  };

  // Escape: cancel edit (for multi-select and tag editor, escape confirms since items are saved live)
  if (key.name === "escape") {
    const isArrayEnum = field.prop.type === "array" && !!field.prop.items?.enum;
    if (isArrayEnum && enumValues) {
      // Confirm current selections
      const selected = [...state.formEnumSelected].sort((a, b) => a - b).map((i) => enumValues[i]!);
      const val = selected.join(", ");
      const newValues = { ...formValues, [field.name]: val };
      return { ...state, formEditing: false, formEditFieldIdx: -1, formValues: newValues, formEnumSelected: new Set(), ...resetPalette(newValues) };
    }
    return { ...state, formEditing: false, formEditFieldIdx: -1, formInputBuf: "", ...resetPalette() };
  }

  if (key.ctrl && key.name === "c") return "submit";

  // Array-of-objects mode
  if (isArrayOfObjects(field.prop)) {
    const existing = formValues[field.name] || "[]";
    let items: unknown[] = [];
    try { items = JSON.parse(existing); } catch { /* */ }
    const addIdx = items.length;
    const total = items.length + 1; // items + "Add new item"

    if (key.name === "up") {
      return { ...state, formEnumCursor: formEnumCursor > 0 ? formEnumCursor - 1 : total - 1 };
    }
    if (key.name === "down") {
      return { ...state, formEnumCursor: formEnumCursor < total - 1 ? formEnumCursor + 1 : 0 };
    }
    if (key.name === "return") {
      // Push form stack and enter sub-form (add new or edit existing)
      const editingExisting = formEnumCursor < addIdx;
      const itemSchema = field.prop.items!;
      const defs = state.selectedTool?.inputSchema.$defs;
      const subProperties = itemSchema.properties || {};
      const subRequired = new Set(itemSchema.required || []);
      const subFields = Object.entries(subProperties).map(([name, rawProp]) => ({
        name,
        prop: resolveProperty(rawProp, defs),
        required: subRequired.has(name),
      }));
      const subValues: Record<string, string> = {};
      if (editingExisting) {
        // Pre-populate from existing item
        const existingItem = items[formEnumCursor] as Record<string, unknown>;
        for (const f of subFields) {
          const v = existingItem[f.name];
          if (v == null) {
            subValues[f.name] = f.prop.default != null ? String(f.prop.default) : "";
          } else if (Array.isArray(v)) {
            subValues[f.name] = JSON.stringify(v);
          } else {
            subValues[f.name] = String(v);
          }
        }
      } else {
        for (const f of subFields) {
          subValues[f.name] = f.prop.default != null ? String(f.prop.default) : "";
        }
      }
      const subFiltered = filterFormFields(subFields, "");
      const toolTitle = humanLabel(state.selectedTool!.name, toolPrefix(state.selectedTool!));
      return {
        ...state,
        formStack: [...state.formStack, {
          parentFieldName: field.name,
          parentFields: fields,
          parentValues: formValues,
          parentNameColWidth: state.nameColWidth,
          parentTitle: toolTitle,
          editIndex: editingExisting ? formEnumCursor : -1,
        }],
        fields: subFields,
        nameColWidth: Math.max(...subFields.map((f) => f.name.length + (f.required ? 2 : 0)), 6) + 1,
        formValues: subValues,
        formEditing: false,
        formEditFieldIdx: -1,
        formSearchQuery: "",
        formSearchCursorPos: 0,
        formFilteredIndices: subFiltered,
        formListCursor: defaultFormCursor(subFields, subFiltered, subValues),
        formScrollTop: 0,
        formShowRequired: false,
        formEnumCursor: 0,
        formEnumSelected: new Set(),
        formInputBuf: "",
      };
    }
    if (key.name === "backspace" && formEnumCursor < items.length) {
      // Delete item at cursor
      const newItems = [...items];
      newItems.splice(formEnumCursor, 1);
      const newValues = { ...formValues, [field.name]: JSON.stringify(newItems) };
      const newCursor = Math.min(formEnumCursor, newItems.length);
      return { ...state, formValues: newValues, formEnumCursor: newCursor };
    }
    return state;
  }

  // Date picker mode
  if (dateFmt) {
    const maxPart = datePartCount(dateFmt) - 1;
    if (key.name === "left") {
      return { ...state, datePartCursor: Math.max(0, state.datePartCursor - 1) };
    }
    if (key.name === "right") {
      return { ...state, datePartCursor: Math.min(maxPart, state.datePartCursor + 1) };
    }
    if (key.name === "up") {
      return { ...state, dateParts: adjustDatePart(state.dateParts, state.datePartCursor, 1, dateFmt) };
    }
    if (key.name === "down") {
      return { ...state, dateParts: adjustDatePart(state.dateParts, state.datePartCursor, -1, dateFmt) };
    }
    if (key.name === "return") {
      const val = datePartsToString(state.dateParts, dateFmt);
      const newValues = { ...formValues, [field.name]: val };
      return { ...state, formEditing: false, formEditFieldIdx: -1, formValues: newValues, ...resetPalette(newValues) };
    }
    if (key.name === "t") {
      return { ...state, dateParts: todayParts(dateFmt), datePartCursor: 0 };
    }
    if (key.name === "backspace") {
      const newValues = { ...formValues, [field.name]: "" };
      return { ...state, formEditing: false, formEditFieldIdx: -1, formValues: newValues, ...resetPalette(newValues) };
    }
    return state;
  }

  // Array enum multi-select mode
  const isArrayEnum = field.prop.type === "array" && !!field.prop.items?.enum;
  if (isArrayEnum && enumValues) {
    if (key.name === "up") {
      return { ...state, formEnumCursor: formEnumCursor <= 0 ? enumValues.length - 1 : formEnumCursor - 1 };
    }
    if (key.name === "down") {
      return { ...state, formEnumCursor: formEnumCursor >= enumValues.length - 1 ? 0 : formEnumCursor + 1 };
    }
    if (key.name === " " || key.raw === " ") {
      // Toggle selection
      const next = new Set(state.formEnumSelected);
      if (next.has(formEnumCursor)) next.delete(formEnumCursor);
      else next.add(formEnumCursor);
      return { ...state, formEnumSelected: next };
    }
    if (key.name === "return") {
      // Select current option and exit
      const next = new Set(state.formEnumSelected);
      next.add(formEnumCursor);
      const selected = [...next].sort((a, b) => a - b).map((i) => enumValues[i]!);
      const val = selected.join(", ");
      const newValues = { ...formValues, [field.name]: val };
      return { ...state, formEditing: false, formEditFieldIdx: -1, formValues: newValues, formEnumSelected: new Set(), ...resetPalette() };
    }
    return state;
  }

  // Enum/bool picker mode
  if (enumValues || isBool) {
    const choices = isBool ? ["true", "false"] : enumValues!;
    if (key.name === "up") {
      return { ...state, formEnumCursor: formEnumCursor <= 0 ? choices.length - 1 : formEnumCursor - 1 };
    }
    if (key.name === "down") {
      return { ...state, formEnumCursor: formEnumCursor >= choices.length - 1 ? 0 : formEnumCursor + 1 };
    }
    if (key.name === "return") {
      const val = choices[formEnumCursor]!;
      const newValues = { ...formValues, [field.name]: val };
      return { ...state, formEditing: false, formEditFieldIdx: -1, formValues: newValues, ...resetPalette(newValues) };
    }
    return state;
  }

  // Array text (list editor) mode
  const isArrayText = field.prop.type === "array" && !field.prop.items?.enum;
  if (isArrayText) {
    const existing = formValues[field.name] || "";
    const items = existing ? existing.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const inputIdx = items.length; // index of the text input line
    const total = items.length + 1;

    if (key.name === "up") {
      return { ...state, formEnumCursor: formEnumCursor > 0 ? formEnumCursor - 1 : total - 1 };
    }
    if (key.name === "down") {
      return { ...state, formEnumCursor: formEnumCursor < total - 1 ? formEnumCursor + 1 : 0 };
    }

    // Cursor on an existing item
    if (formEnumCursor < inputIdx) {
      if (key.name === "return") {
        // Edit: move item value to input, remove from list
        const editVal = items[formEnumCursor]!;
        const newItems = [...items];
        newItems.splice(formEnumCursor, 1);
        const newValues = { ...formValues, [field.name]: newItems.join(", ") };
        return { ...state, formValues: newValues, formInputBuf: editVal, formEnumCursor: newItems.length };
      }
      if (key.name === "backspace") {
        // Delete item
        const newItems = [...items];
        newItems.splice(formEnumCursor, 1);
        const newValues = { ...formValues, [field.name]: newItems.join(", ") };
        const newCursor = Math.min(formEnumCursor, newItems.length);
        return { ...state, formValues: newValues, formEnumCursor: newCursor };
      }
      return state;
    }

    // Cursor on text input
    if (key.name === "return") {
      if (formInputBuf.trim()) {
        items.push(formInputBuf.trim());
        const newValues = { ...formValues, [field.name]: items.join(", ") };
        return { ...state, formValues: newValues, formInputBuf: "", formEnumCursor: items.length };
      }
      // Empty input: confirm and close
      const newValues = { ...formValues, [field.name]: items.join(", ") };
      return { ...state, formEditing: false, formEditFieldIdx: -1, formValues: newValues, ...resetPalette(newValues) };
    }
    if (key.name === "backspace") {
      if (formInputBuf) {
        return { ...state, formInputBuf: formInputBuf.slice(0, -1) };
      }
      return state;
    }
    if (!key.ctrl && key.name !== "escape" && !key.raw.startsWith("\x1b")) {
      return { ...state, formInputBuf: formInputBuf + key.raw };
    }
    return state;
  }

  // Text editing mode
  if (key.name === "return" && key.shift) {
    // Shift+Enter: insert newline
    return { ...state, formInputBuf: formInputBuf + "\n" };
  }
  if (key.name === "return") {
    // Enter: confirm
    const newValues = { ...formValues, [field.name]: formInputBuf };
    return { ...state, formEditing: false, formEditFieldIdx: -1, formValues: newValues, ...resetPalette(newValues) };
  }
  if (key.name === "backspace") {
    return { ...state, formInputBuf: formInputBuf.slice(0, -1) };
  }
  if (!key.ctrl && key.name !== "escape" && !key.raw.startsWith("\x1b")) {
    return { ...state, formInputBuf: formInputBuf + key.raw };
  }
  return state;
}

function handleResultsInput(state: AppState, key: KeyEvent): AppState | "exit" {
  const { contentHeight } = getBoxDimensions();
  const contentLines = (state.error || state.result).split("\n");
  const visibleCount = Math.max(1, contentHeight - 3);

  if (key.ctrl && key.name === "c") return "exit";

  if (key.name === "q" && !key.ctrl) {
    if (state.quitConfirm) return "exit";
    return { ...state, quitConfirm: true };
  }

  // Any other key cancels quit confirm
  const s = state.quitConfirm ? { ...state, quitConfirm: false } : state;

  const goBack = (): AppState => {
    const resetFiltered = buildCommandList(s.tools);
    const resetSel = selectableIndices(resetFiltered);
    const searchReset = { searchQuery: "", searchCursorPos: 0, filteredItems: resetFiltered, listCursor: resetSel[0] ?? 0, listScrollTop: 0 };
    const hasParams = s.selectedTool && Object.keys(s.selectedTool.inputSchema.properties || {}).length > 0;
    if (hasParams) {
      return {
        ...s, view: "form" as View, result: "", error: "", resultScroll: 0, resultScrollX: 0,
        formSearchQuery: "", formSearchCursorPos: 0,
        formFilteredIndices: filterFormFields(s.fields, ""),
        formListCursor: defaultFormCursor(s.fields, filterFormFields(s.fields, ""), s.formValues), formScrollTop: 0,
        formEditing: false, formEditFieldIdx: -1, formShowRequired: false,
      };
    }
    return { ...s, view: "commands" as View, selectedTool: null, result: "", error: "", resultScroll: 0, resultScrollX: 0, ...searchReset };
  };

  // Enter on success/empty-list/error screens → go back
  if (key.name === "return") {
    const isEmpty = !s.error && s.result !== EMPTY_LIST_SENTINEL && !s.result.trim();
    if (isEmpty) {
      // Success screen → back to main menu
      const resetFiltered = buildCommandList(s.tools);
      const resetSel = selectableIndices(resetFiltered);
      const searchReset = { searchQuery: "", searchCursorPos: 0, filteredItems: resetFiltered, listCursor: resetSel[0] ?? 0, listScrollTop: 0 };
      return { ...s, view: "commands", selectedTool: null, result: "", error: "", resultScroll: 0, resultScrollX: 0, ...searchReset };
    }
    return goBack();
  }

  if (key.name === "escape") {
    const isEmpty = !s.error && s.result !== EMPTY_LIST_SENTINEL && !s.result.trim();
    const resetFiltered = buildCommandList(s.tools);
    const resetSel = selectableIndices(resetFiltered);
    const searchReset = { searchQuery: "", searchCursorPos: 0, filteredItems: resetFiltered, listCursor: resetSel[0] ?? 0, listScrollTop: 0 };
    if (isEmpty) {
      // Success screen → back to main menu
      return { ...s, view: "commands", selectedTool: null, result: "", error: "", resultScroll: 0, resultScrollX: 0, ...searchReset };
    }
    // Data or error → back to form if it has params, otherwise main menu
    const hasParams = s.selectedTool && Object.keys(s.selectedTool.inputSchema.properties || {}).length > 0;
    if (hasParams) {
      return {
        ...s, view: "form", result: "", error: "", resultScroll: 0, resultScrollX: 0,
        formSearchQuery: "", formSearchCursorPos: 0,
        formFilteredIndices: filterFormFields(s.fields, ""),
        formListCursor: defaultFormCursor(s.fields, filterFormFields(s.fields, ""), s.formValues), formScrollTop: 0,
        formEditing: false, formEditFieldIdx: -1, formShowRequired: false,
      };
    }
    return { ...s, view: "commands", selectedTool: null, result: "", error: "", resultScroll: 0, resultScrollX: 0, ...searchReset };
  }

  if (key.name === "up") {
    return { ...s, resultScroll: Math.max(0, s.resultScroll - 1) };
  }
  if (key.name === "down") {
    return { ...s, resultScroll: Math.min(Math.max(0, contentLines.length - visibleCount), s.resultScroll + 1) };
  }
  if (key.name === "left") {
    return { ...s, resultScrollX: Math.max(0, s.resultScrollX - 4) };
  }
  if (key.name === "right") {
    return { ...s, resultScrollX: s.resultScrollX + 4 };
  }
  if (key.name === "pageup") {
    return { ...s, resultScroll: Math.max(0, s.resultScroll - visibleCount) };
  }
  if (key.name === "pagedown") {
    return { ...s, resultScroll: Math.min(Math.max(0, contentLines.length - visibleCount), s.resultScroll + visibleCount) };
  }

  return s;
}

// --- Parse form values to tool args ---

function formValuesToArgs(fields: FormField[], values: Record<string, string>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const val = values[field.name];
    if (!val) continue;
    const p = field.prop;
    if (p.type === "integer" || p.type === "number") {
      const n = Number(val);
      if (!isNaN(n)) args[field.name] = n;
    } else if (p.type === "boolean") {
      args[field.name] = val === "true";
    } else if (p.type === "array") {
      try {
        const parsed = JSON.parse(val);
        args[field.name] = Array.isArray(parsed) ? parsed : val.split(",").map((s) => s.trim());
      } catch {
        args[field.name] = val.split(",").map((s) => s.trim()).filter(Boolean);
      }
    } else {
      args[field.name] = val;
    }
  }
  return args;
}

// --- Pretty JSON formatting ---

function isComplex(val: unknown): boolean {
  if (Array.isArray(val)) return val.length > 0;
  return typeof val === "object" && val !== null;
}

function scalarStr(val: unknown): string {
  if (val === null || val === undefined) return style.dim("null");
  if (typeof val === "number") return style.cyan(String(val));
  if (typeof val === "boolean") return style.yellow(String(val));
  const s = String(val);
  if (s === "") return style.dim("–");
  return s;
}

function emitValue(value: unknown, indent: string, lines: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        if (i > 0) lines.push("");
        emitArrayObject(item as Record<string, unknown>, indent, lines);
      } else {
        lines.push(indent + style.dim("─ ") + scalarStr(item));
      }
    }
  } else if (typeof value === "object" && value !== null) {
    emitObject(value as Record<string, unknown>, indent, lines);
  } else {
    lines.push(indent + scalarStr(value));
  }
}

function emitObject(obj: Record<string, unknown>, indent: string, lines: string[]): void {
  const keys = Object.keys(obj);
  if (keys.length === 0) return;
  const maxLen = Math.max(...keys.map((k) => k.length));
  for (const key of keys) {
    const val = obj[key];
    if (isComplex(val)) {
      lines.push(indent + style.bold(key) + style.dim(":"));
      emitValue(val, indent + "  ", lines);
    } else {
      lines.push(indent + style.bold(key.padEnd(maxLen)) + "  " + scalarStr(val));
    }
  }
}

function emitArrayObject(obj: Record<string, unknown>, indent: string, lines: string[]): void {
  const keys = Object.keys(obj);
  if (keys.length === 0) { lines.push(indent + style.dim("─")); return; }
  const maxLen = Math.max(...keys.map((k) => k.length));
  let first = true;
  for (const key of keys) {
    const val = obj[key];
    const marker = first ? style.dim("─ ") : "  ";
    if (isComplex(val)) {
      lines.push(indent + marker + style.bold(key) + style.dim(":"));
      emitValue(val, indent + "    ", lines);
    } else {
      lines.push(indent + marker + style.bold(key.padEnd(maxLen)) + "  " + scalarStr(val));
    }
    first = false;
  }
}

function isEmptyListResult(data: unknown): boolean {
  // Top-level empty array
  if (Array.isArray(data) && data.length === 0) return true;
  // Object where all values are empty arrays, empty strings, zeros, or nulls
  // (e.g. { results: [], count: 0 })
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const values = Object.values(obj);
    if (values.length === 0) return false;
    const hasArray = values.some((v) => Array.isArray(v));
    if (!hasArray) return false;
    return values.every((v) =>
      (Array.isArray(v) && v.length === 0) ||
      v === 0 || v === null || v === ""
    );
  }
  return false;
}

function formatJsonPretty(data: unknown): string {
  const lines: string[] = [];
  emitValue(data, "", lines);
  return lines.join("\n");
}

// --- Execute tool ---

async function executeTool(state: AppState): Promise<AppState> {
  const tool = state.selectedTool!;
  const args = formValuesToArgs(state.fields, state.formValues);
  try {
    const { token, authType } = await ensureValidToken();
    const res = await callTool(token, authType, tool.name, args);

    if (res.isError) {
      const errMsg = res.content.map((c) => c.text || "").filter(Boolean).join("\n");
      return { ...state, view: "results", error: errMsg || "Unknown error", result: "", resultScroll: 0, resultScrollX: 0 };
    }

    const text = res.content.filter((c) => c.type === "text" && c.text).map((c) => c.text!).join("\n");
    // Check structuredContent if text content is empty
    const structured = (res as Record<string, unknown>).structuredContent;
    let formatted: string;
    let emptyList = false;
    if (!text && structured !== undefined) {
      emptyList = isEmptyListResult(structured);
      formatted = formatJsonPretty(structured);
    } else {
      try {
        const parsed = JSON.parse(text);
        emptyList = isEmptyListResult(parsed);
        formatted = formatJsonPretty(parsed);
      } catch {
        formatted = text;
      }
    }
    return { ...state, view: "results", result: emptyList ? EMPTY_LIST_SENTINEL : formatted, error: "", resultScroll: 0, resultScrollX: 0 };
  } catch (err) {
    return { ...state, view: "results", error: (err as Error).message, result: "", resultScroll: 0, resultScrollX: 0 };
  }
}

// --- Main loop ---

export async function runApp(tools: ToolDef[]): Promise<void> {
  const items = buildCommandList(tools);
  const selectable = selectableIndices(items);

  let state: AppState = {
    view: "commands",
    tools,
    listCursor: selectable[0] ?? 0,
    listScrollTop: 0,
    quitConfirm: false,
    searchQuery: "",
    searchCursorPos: 0,
    filteredItems: buildCommandList(tools),
    selectedTool: null,
    fields: [],
    nameColWidth: 6,
    formSearchQuery: "",
    formSearchCursorPos: 0,
    formFilteredIndices: [],
    formListCursor: 0,
    formScrollTop: 0,
    formEditFieldIdx: -1,
    formEditing: false,
    formInputBuf: "",
    formEnumCursor: 0,
    formEnumSelected: new Set(),
    formValues: {},
    formShowRequired: false,
    formStack: [],
    dateParts: [],
    datePartCursor: 0,
    result: "",
    error: "",
    resultScroll: 0,
    resultScrollX: 0,
    spinnerFrame: 0,
  };

  paint(renderState(state));

  process.stdout.on("resize", () => {
    paint(renderState(state));
  });

  const spinnerInterval = setInterval(() => {
    if (state.view === "loading") {
      state = { ...state, spinnerFrame: state.spinnerFrame + 1 };
      paint(renderState(state));
    }
  }, 80);

  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<void>((resolve) => {
    let quitTimer: ReturnType<typeof setTimeout> | null = null;

    const resetQuitTimer = () => {
      if (quitTimer) { clearTimeout(quitTimer); quitTimer = null; }
      if (state.quitConfirm) {
        quitTimer = setTimeout(() => {
          quitTimer = null;
          state = { ...state, quitConfirm: false };
          paint(renderState(state));
        }, 2000);
      }
    };

    const cleanup = () => {
      clearInterval(spinnerInterval);
      if (quitTimer) clearTimeout(quitTimer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      resolve();
    };

    const onData = async (data: Buffer) => {
      const key = parseKey(data);

      if (key.ctrl && key.name === "c") {
        cleanup();
        return;
      }

      if (state.view === "loading") return;

      const result = handleInput(state, key);

      if (result === "exit") {
        cleanup();
        return;
      }

      if (result === "submit") {
        state = { ...state, view: "loading", spinnerFrame: 0 };
        paint(renderState(state));
        state = await executeTool(state);
        paint(renderState(state));
        resetQuitTimer();
        return;
      }

      if (result.view === "loading") {
        state = { ...result, spinnerFrame: 0 };
        paint(renderState(state));
        state = await executeTool(state);
        paint(renderState(state));
        resetQuitTimer();
        return;
      }

      state = result;
      paint(renderState(state));
      resetQuitTimer();
    };

    process.stdin.on("data", onData);
  });
}
