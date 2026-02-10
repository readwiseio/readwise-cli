import type { ToolDef, SchemaProperty } from "../config.js";
import { resolveProperty } from "../commands.js";
import { callTool } from "../mcp.js";
import { ensureValidToken } from "../auth.js";
import { LOGO } from "./logo.js";
import { style, paint, screenSize, fitWidth, ansiSlice, stripAnsi, parseKey, type KeyEvent } from "./term.js";

// --- Types ---

type View = "commands" | "form" | "loading" | "results";

interface FormField {
  name: string;
  prop: SchemaProperty;
  required: boolean;
}

interface AppState {
  view: View;
  tools: ToolDef[];
  // Command list
  listCursor: number;
  listScrollTop: number;
  quitConfirm: boolean;
  // Form
  selectedTool: ToolDef | null;
  fields: FormField[];
  nameColWidth: number;
  formCursor: number;
  formEditing: boolean;
  formInputBuf: string;
  formEnumCursor: number;
  formValues: Record<string, string>;
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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RESET = "\x1b[0m";

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
  const items = buildCommandList(state.tools);
  const content: string[] = [];

  // Logo
  for (let i = 0; i < LOGO.length; i++) {
    const logoLine = style.yellow(LOGO[i]!);
    if (i === Math.floor(LOGO.length / 2) - 1) {
      content.push(` ${logoLine}  ${style.boldYellow("Readwise")}`);
    } else if (i === Math.floor(LOGO.length / 2)) {
      content.push(` ${logoLine}  ${style.dim("Command-line interface")}`);
    } else {
      content.push(` ${logoLine}`);
    }
  }
  content.push("");

  // Reserve space for description at bottom
  const descReserve = 3; // blank + up to 2 wrapped lines
  const logoUsed = content.length;
  const listHeight = Math.max(1, contentHeight - logoUsed - descReserve);

  // Scrollable list
  const visible = items.slice(state.listScrollTop, state.listScrollTop + listHeight);
  for (let i = 0; i < visible.length; i++) {
    const item = visible[i]!;
    const realIdx = state.listScrollTop + i;
    if (item.isSeparator) {
      content.push(`   ${style.dim("── " + item.label + " ──")}`);
    } else {
      const selected = realIdx === state.listCursor;
      const prefix = selected ? " ❯ " : "   ";
      const label = prefix + item.label;
      content.push(selected ? style.boldYellow(label) : label);
    }
  }

  // Pad list area so description is always at the bottom
  while (content.length < logoUsed + listHeight) content.push("");

  // Description of highlighted item
  const currentItem = items[state.listCursor];
  if (currentItem && !currentItem.isSeparator && currentItem.description) {
    content.push("");
    const wrapped = wrapText(currentItem.description, innerWidth - 4);
    for (const line of wrapped.slice(0, 2)) {
      content.push("   " + style.dim(line));
    }
  }

  const footer = state.quitConfirm
    ? style.yellow("Press q or esc again to quit")
    : style.dim("↑↓ navigate  enter select  q/esc quit");

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
  const title = humanLabel(tool.name, toolPrefix(tool));
  const content: string[] = [];

  // Tool header inside the box
  content.push("");
  content.push("  " + style.bold(title));
  if (tool.description) {
    const wrapped = wrapText(tool.description, innerWidth - 4);
    for (const line of wrapped) {
      content.push("  " + style.dim(line));
    }
  }
  content.push("");

  // Fields
  for (let idx = 0; idx < fields.length; idx++) {
    const field = fields[idx]!;
    const isCurrent = idx === state.formCursor;
    const val = state.formValues[field.name] || "";
    const nameLabel = field.name + (field.required ? " *" : "");
    const paddedName = nameLabel.padEnd(state.nameColWidth);
    const isEditingThis = isCurrent && state.formEditing;
    const eVals = field.prop.enum || field.prop.items?.enum;
    const dateFmt = dateFieldFormat(field.prop);

    if (isEditingThis && dateFmt) {
      // Date picker
      content.push(
        " " + style.boldYellow("❯ " + paddedName) + renderDateParts(state.dateParts, state.datePartCursor, dateFmt)
      );
    } else if (isEditingThis && !eVals && field.prop.type !== "boolean") {
      content.push(
        " " + style.boldYellow("❯ " + paddedName) + style.cyan(state.formInputBuf) + style.inverse(" ")
      );
    } else {
      const cursor = isCurrent ? " ❯ " : "   ";
      const fmtHint = !val && dateFmt && isCurrent ? style.dim(dateFmt === "date" ? "YYYY-MM-DD" : "YYYY-MM-DDThh:mm:ssZ") : "";
      const valDisplay = val || fmtHint || style.dim("–");
      const line = cursor + paddedName + valDisplay;
      content.push(isCurrent ? style.boldYellow(line) : line);
    }
  }

  // Enum/bool picker
  if (state.formEditing) {
    const field = fields[state.formCursor];
    if (field) {
      const eVals = field.prop.enum || field.prop.items?.enum;
      const isBool = field.prop.type === "boolean";
      if (eVals || isBool) {
        content.push("");
        const choices = isBool ? ["true", "false"] : eVals!;
        for (let ci = 0; ci < choices.length; ci++) {
          const sel = ci === state.formEnumCursor;
          const choiceLine = (sel ? "   › " : "     ") + choices[ci]!;
          content.push(sel ? style.cyan(style.bold(choiceLine)) : choiceLine);
        }
      }
    }
  }

  // Submit button
  content.push("");
  const isOnSubmit = state.formCursor === fields.length;
  content.push(isOnSubmit ? "   " + style.inverse(style.green(" Submit ")) : "     Submit");

  // Description of focused field (word-wrapped)
  if (!state.formEditing && state.formCursor < fields.length) {
    const desc = fields[state.formCursor]!.prop.description;
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
    footer: style.dim("↑↓ navigate  enter edit/confirm  esc back"),
  });
}

function renderLoading(state: AppState): string[] {
  const { contentHeight } = getBoxDimensions();
  const tool = state.selectedTool;
  const title = tool ? humanLabel(tool.name, toolPrefix(tool)) : "";
  const content: string[] = [];

  const midRow = Math.floor(contentHeight / 2);
  while (content.length < midRow) content.push("");

  const frame = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]!;
  content.push(`   ${style.cyan(frame)} Executing…`);

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
  const isEmpty = !isError && !state.result.trim();

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
      footer: style.dim("esc back  q quit"),
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
    footer: style.dim(scrollHint + "↑↓←→ scroll  esc back  q quit"),
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
  const items = buildCommandList(state.tools);
  const selectable = selectableIndices(items);
  const { contentHeight } = getBoxDimensions();
  const descReserve = 3;
  const listHeight = Math.max(1, contentHeight - LOGO.length - 1 - descReserve);

  if (key.name === "q" || key.name === "escape") {
    if (state.quitConfirm) return "exit";
    return { ...state, quitConfirm: true };
  }
  if (key.ctrl && key.name === "c") return "exit";

  // Any other key cancels quit confirm
  const s = state.quitConfirm ? { ...state, quitConfirm: false } : state;

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

  if (key.name === "return") {
    const item = items[s.listCursor];
    if (item && !item.isSeparator) {
      const tool = s.tools.find((t) => t.name === item.value);
      if (tool) {
        const properties = tool.inputSchema.properties || {};
        const requiredSet = new Set(tool.inputSchema.required || []);
        const fields = Object.entries(properties).map(([name, rawProp]) => ({
          name,
          prop: resolveProperty(rawProp),
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
            formCursor: 0,
            formEditing: false,
            formInputBuf: "",
            formEnumCursor: 0,
          };
        }

        return {
          ...s,
          view: "form",
          selectedTool: tool,
          fields,
          nameColWidth,
          formValues,
          formCursor: 0,
          formEditing: false,
          formInputBuf: "",
          formEnumCursor: 0,
        };
      }
    }
    return s;
  }

  return s;
}

function handleFormInput(state: AppState, key: KeyEvent): AppState | "submit" {
  const { fields, formCursor, formEditing, formInputBuf, formEnumCursor, formValues } = state;
  const itemCount = fields.length + 1;
  const currentField = formCursor < fields.length ? fields[formCursor]! : null;
  const isOnSubmit = formCursor === fields.length;
  const enumValues = currentField ? (currentField.prop.enum || currentField.prop.items?.enum) : null;
  const isBoolField = currentField?.prop.type === "boolean";
  const dateFmt = currentField ? dateFieldFormat(currentField.prop) : null;

  if (key.name === "escape") {
    if (formEditing) {
      return { ...state, formEditing: false };
    }
    return { ...state, view: "commands", selectedTool: null };
  }

  if (key.ctrl && key.name === "c") return "submit";

  // Date picker mode
  if (formEditing && dateFmt) {
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
      const newValues = currentField
        ? { ...formValues, [currentField.name]: val }
        : formValues;
      const nextCursor = formCursor < itemCount - 1 ? formCursor + 1 : formCursor;
      return { ...state, formEditing: false, formValues: newValues, formCursor: nextCursor };
    }
    // "t" for today
    if (key.name === "t") {
      return { ...state, dateParts: todayParts(dateFmt), datePartCursor: 0 };
    }
    // Backspace clears the date value
    if (key.name === "backspace") {
      const newValues = currentField
        ? { ...formValues, [currentField.name]: "" }
        : formValues;
      return { ...state, formEditing: false, formValues: newValues };
    }
    return state;
  }

  // Text editing mode
  if (formEditing && !enumValues && !isBoolField) {
    if (key.name === "return") {
      const newValues = currentField
        ? { ...formValues, [currentField.name]: formInputBuf }
        : formValues;
      const nextCursor = formCursor < itemCount - 1 ? formCursor + 1 : formCursor;
      return { ...state, formEditing: false, formValues: newValues, formCursor: nextCursor };
    }
    if (key.name === "backspace") {
      return { ...state, formInputBuf: formInputBuf.slice(0, -1) };
    }
    if (!key.ctrl && key.name !== "escape" && !key.raw.startsWith("\x1b")) {
      return { ...state, formInputBuf: formInputBuf + key.raw };
    }
    return state;
  }

  // Enum/bool picker mode
  if (formEditing && (enumValues || isBoolField)) {
    const choices = isBoolField ? ["true", "false"] : enumValues!;
    if (key.name === "up") {
      return { ...state, formEnumCursor: Math.max(0, formEnumCursor - 1) };
    }
    if (key.name === "down") {
      return { ...state, formEnumCursor: Math.min(choices.length - 1, formEnumCursor + 1) };
    }
    if (key.name === "return") {
      const val = choices[formEnumCursor]!;
      const newValues = currentField
        ? { ...formValues, [currentField.name]: val }
        : formValues;
      const nextCursor = formCursor < itemCount - 1 ? formCursor + 1 : formCursor;
      return { ...state, formEditing: false, formValues: newValues, formCursor: nextCursor };
    }
    return state;
  }

  // Navigation
  if (key.name === "up") {
    return { ...state, formCursor: Math.max(0, formCursor - 1) };
  }
  if (key.name === "down") {
    return { ...state, formCursor: Math.min(itemCount - 1, formCursor + 1) };
  }
  if (key.name === "tab") {
    if (key.shift) {
      return { ...state, formCursor: Math.max(0, formCursor - 1) };
    }
    return { ...state, formCursor: Math.min(itemCount - 1, formCursor + 1) };
  }

  if (key.name === "return") {
    if (isOnSubmit) return "submit";
    if (currentField) {
      // Date field → open date picker
      if (dateFmt) {
        const existing = formValues[currentField.name] || "";
        const parts = parseDateParts(existing, dateFmt) || todayParts(dateFmt);
        return { ...state, formEditing: true, dateParts: parts, datePartCursor: 0 };
      }
      if (enumValues || isBoolField) {
        const choices = isBoolField ? ["true", "false"] : enumValues!;
        const curVal = formValues[currentField.name] || "";
        const idx = choices.indexOf(curVal);
        return { ...state, formEditing: true, formEnumCursor: idx >= 0 ? idx : 0 };
      }
      return { ...state, formEditing: true, formInputBuf: formValues[currentField.name] || "" };
    }
  }

  return state;
}

function handleResultsInput(state: AppState, key: KeyEvent): AppState | "exit" {
  const { contentHeight } = getBoxDimensions();
  const contentLines = (state.error || state.result).split("\n");
  const visibleCount = Math.max(1, contentHeight - 3);

  if (key.name === "q" && !key.ctrl) return "exit";
  if (key.ctrl && key.name === "c") return "exit";

  if (key.name === "escape") {
    const isEmpty = !state.error && !state.result.trim();
    if (isEmpty) {
      // Success screen → back to main menu
      return { ...state, view: "commands", selectedTool: null, result: "", error: "", resultScroll: 0, resultScrollX: 0 };
    }
    // Data or error → back to form if it has params, otherwise main menu
    const hasParams = state.selectedTool && Object.keys(state.selectedTool.inputSchema.properties || {}).length > 0;
    if (hasParams) {
      return { ...state, view: "form", result: "", error: "", resultScroll: 0, resultScrollX: 0 };
    }
    return { ...state, view: "commands", selectedTool: null, result: "", error: "", resultScroll: 0, resultScrollX: 0 };
  }

  if (key.name === "up") {
    return { ...state, resultScroll: Math.max(0, state.resultScroll - 1) };
  }
  if (key.name === "down") {
    return { ...state, resultScroll: Math.min(Math.max(0, contentLines.length - visibleCount), state.resultScroll + 1) };
  }
  if (key.name === "left") {
    return { ...state, resultScrollX: Math.max(0, state.resultScrollX - 4) };
  }
  if (key.name === "right") {
    return { ...state, resultScrollX: state.resultScrollX + 4 };
  }
  if (key.name === "pageup") {
    return { ...state, resultScroll: Math.max(0, state.resultScroll - visibleCount) };
  }
  if (key.name === "pagedown") {
    return { ...state, resultScroll: Math.min(Math.max(0, contentLines.length - visibleCount), state.resultScroll + visibleCount) };
  }

  return state;
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
    let formatted: string;
    try {
      formatted = formatJsonPretty(JSON.parse(text));
    } catch {
      formatted = text;
    }
    return { ...state, view: "results", result: formatted, error: "", resultScroll: 0, resultScrollX: 0 };
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
    selectedTool: null,
    fields: [],
    nameColWidth: 6,
    formCursor: 0,
    formEditing: false,
    formInputBuf: "",
    formEnumCursor: 0,
    formValues: {},
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
    const cleanup = () => {
      clearInterval(spinnerInterval);
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
        return;
      }

      if (result.view === "loading") {
        state = { ...result, spinnerFrame: 0 };
        paint(renderState(state));
        state = await executeTool(state);
        paint(renderState(state));
        return;
      }

      state = result;
      paint(renderState(state));
    };

    process.stdin.on("data", onData);
  });
}
