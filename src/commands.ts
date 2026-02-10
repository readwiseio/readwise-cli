import { Command } from "commander";
import { ensureValidToken } from "./auth.js";
import { callTool } from "./mcp.js";
import type { ToolDef, SchemaProperty } from "./config.js";

export function toolNameToCommand(name: string): string {
  return name.replace(/_/g, "-");
}

export function resolveProperty(prop: SchemaProperty): SchemaProperty {
  if (prop.anyOf) {
    const nonNull = prop.anyOf.find((v) => v.type !== "null");
    if (nonNull) {
      return { ...prop, ...nonNull, anyOf: undefined };
    }
  }
  return prop;
}

function optionFlag(name: string, prop: SchemaProperty): string {
  const flag = `--${name.replace(/_/g, "-")}`;

  if (prop.type === "boolean") {
    return flag;
  }
  return `${flag} <value>`;
}

function parseValue(value: string, prop: SchemaProperty): unknown {
  if (prop.type === "integer" || prop.type === "number") {
    const n = Number(value);
    if (isNaN(n)) throw new Error(`Expected a number for value: ${value}`);
    return n;
  }
  if (prop.type === "array") {
    // Try JSON first, then comma-separated
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
    return value.split(",").map((s) => s.trim());
  }
  if (prop.type === "boolean") {
    return true;
  }
  return value;
}

export function displayResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }, json: boolean): void {
  if (result.isError) {
    for (const item of result.content) {
      if (item.text) {
        process.stderr.write(`\x1b[31mError: ${item.text}\x1b[0m\n`);
      }
    }
    process.exitCode = 1;
    return;
  }

  for (const item of result.content) {
    if (item.type === "text" && item.text) {
      if (json) {
        process.stdout.write(item.text + "\n");
      } else {
        try {
          const parsed = JSON.parse(item.text);
          console.log(JSON.stringify(parsed, null, 2));
        } catch {
          console.log(item.text);
        }
      }
    }
  }
}

export function registerTools(program: Command, tools: ToolDef[]): void {
  for (const tool of tools) {
    const cmd = program
      .command(toolNameToCommand(tool.name))
      .description(tool.description || "");

    const properties = tool.inputSchema.properties || {};
    const required = new Set(tool.inputSchema.required || []);

    for (const [propName, rawProp] of Object.entries(properties)) {
      const prop = resolveProperty(rawProp);
      const flag = optionFlag(propName, prop);
      const parts: string[] = [];
      if (prop.description) parts.push(prop.description);
      if (required.has(propName)) parts.push("(required)");
      const enumValues = prop.enum || prop.items?.enum;
      if (enumValues) parts.push(`[${enumValues.join(", ")}]`);
      if (prop.default !== undefined) parts.push(`(default: ${JSON.stringify(prop.default)})`);

      cmd.option(flag, parts.join(" ") || undefined);
    }

    cmd.action(async (options: Record<string, string>) => {
      try {
        const { token, authType } = await ensureValidToken();

        // Convert commander options back to tool arguments
        const args: Record<string, unknown> = {};
        for (const [propName, rawProp] of Object.entries(properties)) {
          const prop = resolveProperty(rawProp);
          const camelKey = propName.replace(/_/g, "-").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
          const value = options[camelKey];
          if (value !== undefined) {
            args[propName] = parseValue(String(value), prop);
          }
        }

        const result = await callTool(token, authType, tool.name, args);
        displayResult(result, program.opts().json || false);
      } catch (err) {
        process.stderr.write(`\x1b[31m${(err as Error).message}\x1b[0m\n`);
        process.exitCode = 1;
      }
    });
  }
}
