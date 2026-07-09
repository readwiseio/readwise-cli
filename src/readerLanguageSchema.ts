import type { SchemaProperty, ToolDef } from "./config.js";

function languageProperty(description: string): SchemaProperty {
  return {
    anyOf: [{ type: "string", maxLength: 30 }, { type: "null" }],
    default: null,
    description,
    examples: ["de", "en-US"],
  };
}

function addLanguageProperty(
  properties: Record<string, SchemaProperty> | undefined,
  description: string,
): Record<string, SchemaProperty> | undefined {
  if (!properties || properties.language) return properties;
  return { ...properties, language: languageProperty(description) };
}

function addCreateDocumentLanguage(tool: ToolDef): ToolDef {
  const properties = addLanguageProperty(
    tool.inputSchema.properties,
    "Language code for the document. When omitted, Reader will auto-detect it.",
  );
  if (!properties || properties === tool.inputSchema.properties) return tool;

  return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
}

function addBulkEditLanguage(tool: ToolDef): ToolDef {
  const item = tool.inputSchema.$defs?.BulkEditDocumentMetadataItem;
  const properties = addLanguageProperty(item?.properties, "The new language code for the document");
  if (!item || !properties || properties === item.properties) return tool;

  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      $defs: {
        ...tool.inputSchema.$defs,
        BulkEditDocumentMetadataItem: { ...item, properties },
      },
    },
  };
}

export function addReaderLanguageSchemas(tools: ToolDef[]): ToolDef[] {
  return tools.map((tool) => {
    if (tool.name === "reader_create_document") return addCreateDocumentLanguage(tool);
    if (tool.name === "reader_bulk_edit_document_metadata") return addBulkEditLanguage(tool);
    return tool;
  });
}
