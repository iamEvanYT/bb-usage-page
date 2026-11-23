import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { MAX_CLAUDE_DIRS } from "./preferences";
import { machineScanSchema, providerKind } from "./rpc-schema";
import type { UsageProviderKind } from "./types";

/** Providers a machine reads locally; Cursor is account-wide and read by the server. */
export type MachineProviderKind = Exclude<UsageProviderKind, "cursor">;

export function machineProviders(
  providers: readonly UsageProviderKind[],
): MachineProviderKind[] {
  return providers.filter(
    (provider): provider is MachineProviderKind => provider !== "cursor",
  );
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const claudeDirs = z.array(z.string().max(4096)).min(1).max(MAX_CLAUDE_DIRS);

/**
 * RPC between the server entry and the host worker that bb runs on every
 * other machine (`bb.host`). Each machine scans its own transcripts and
 * databases; the server merges the results.
 */
export const hostContract = defineRpcContract({
  scan: {
    experimental_retryable: true,
    input: z
      .object({
        sinceDay: day,
        untilDay: day,
        timeZone: z.string().min(1),
        force: z.boolean(),
        providers: z.array(providerKind.exclude(["cursor"])),
        claudeDirs,
      })
      .strict(),
    output: machineScanSchema,
  },
  detect: {
    experimental_retryable: true,
    input: z.object({ claudeDirs }).strict(),
    output: z
      .object({
        /** Paths (home shown as `~`) where each provider's data was found. */
        detected: z.record(providerKind, z.array(z.string())),
        claudeDirs: z.array(z.object({ path: z.string(), found: z.boolean() }).strict()),
      })
      .strict(),
  },
});
