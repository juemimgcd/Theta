import { SystemMessage } from "@langchain/core/messages";
import type { Hook } from "../agent/hooks.ts";
import { truncateOutput } from "../agent/tools.ts";

export function createCodingPolicy(
  { readOnly, stopAfterTurn }: { readOnly: boolean; stopAfterTurn: boolean },
  log: (message: string) => void,
): Hook {
  return {
    beforeModel(messages) {
      if (readOnly) {
        return [
          ...messages.slice(0, 1),
          new SystemMessage("本次只读，只允许 read；write、edit、bash 都会被策略拒绝。"),
          ...messages.slice(1),
        ];
      }
    },
    afterModel(response) {
      const usage = response.usage_metadata;
      if (usage !== undefined) {
        log(`[usage] 输入 ${usage.input_tokens}，输出 ${usage.output_tokens}`);
      }
    },
    beforeTool(call) {
      if (readOnly && call.name !== "read") {
        return "本次只读，只允许 read";
      }
    },
    afterTool(result) {
      return truncateOutput(result.content, 8_000);
    },
    afterTurn(turn) {
      if (stopAfterTurn && !turn.hasAnswer) {
        return `练习策略：第 ${turn.turn} 轮工具结果已提交，暂不请求下一轮模型`;
      }
    },
  };
}
