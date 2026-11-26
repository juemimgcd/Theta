import { z } from "zod";

export function readRunSettings(env: NodeJS.ProcessEnv) {
  return {
    readOnly: (env.THETA_READ_ONLY ?? env.ALPHA_READ_ONLY) === "1",
    stopAfterTurn: (env.THETA_STOP_AFTER_TURN ?? env.ALPHA_STOP_AFTER_TURN) === "1",
    debugContext: (env.THETA_DEBUG_CONTEXT ?? env.ALPHA_DEBUG_CONTEXT) === "1",
    contextWindow: z.coerce.number().int().min(8192).optional().parse(env.THETA_CONTEXT_WINDOW ?? env.ALPHA_CONTEXT_WINDOW),
    compactAt: z.coerce.number().int().positive().optional().parse(env.THETA_COMPACT_AT ?? env.ALPHA_COMPACT_AT),
  };
}
