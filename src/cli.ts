#!/usr/bin/env bun
import { main } from "./cli/main.ts";

main(process.argv.slice(2)).catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
});
