import type { ToolDef } from "../config.js";
import { enterFullScreen, exitFullScreen } from "./term.js";
import { runApp } from "./app.js";

export async function startTui(tools: ToolDef[], token: string, authType: "oauth" | "token"): Promise<void> {
  enterFullScreen();
  try {
    await runApp(tools);
  } finally {
    exitFullScreen();
  }
}
