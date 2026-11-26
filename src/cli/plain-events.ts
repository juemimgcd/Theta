import type { AgentEvent } from "../agent/events.ts";

export function plainEvents(): (event: AgentEvent) => void {
  let lineOpen = false;
  return event => {
    if (event.type === "text_delta") {
      process.stdout.write(event.text);
      lineOpen = !event.text.endsWith("\n");
      return;
    }
    if (lineOpen) process.stdout.write("\n");
    lineOpen = false;
    switch (event.type) {
      case "message_end": console.error(`[message_end] ${event.message.type}`); break;
      case "tool_start": console.error(`[tool_start] ${event.name} ${event.callId}`); break;
      case "tool_end": console.error(`[tool_end] ${event.name} ${event.status}`); break;
      case "turn_end": console.error(`[turn_end] 第 ${event.turn} 轮，${event.toolCount} 次调用`); break;
      case "run_boundary": console.error(`[checkpoint] ${event.next} ${event.turns}/${event.maxTurns}`); break;
      case "agent_end": console.error(`[agent_end] ${event.status}`); break;
    }
  };
}
