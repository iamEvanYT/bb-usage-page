import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

import {
  assertValidWindow,
  isValidTimeZone,
  makeWindow,
} from "./lib/format";
import { USAGE_DATA_DIR } from "./lib/plugin-data";
import { mergedUsageSchema } from "./lib/rpc-schema";
import { UsageScanner } from "./lib/scan";

export const rpcContract = defineRpcContract({
  getUsage: {
    input: z
      .object({
        timeZone: z
          .string()
          .min(1)
          .refine((value) => isValidTimeZone(value), {
            message: "Invalid IANA time zone",
          }),
        sinceDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        untilDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        force: z.boolean().optional(),
      })
      .strict()
      .refine((value) => value.sinceDay <= value.untilDay, {
        message: "sinceDay must be on or before untilDay",
        path: ["sinceDay"],
      }),
    output: mergedUsageSchema,
  },
});

function parseDays(argv: readonly string[]): 7 | 30 | 90 {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--days" && argv[i + 1]) {
      const value = Number(argv[i + 1]);
      if (value === 7 || value === 30 || value === 90) return value;
    }
  }
  return 30;
}

export default async function plugin(bb: BbPluginApi) {
  const scanner = new UsageScanner({
    dataDir: USAGE_DATA_DIR,
    log: (message) => bb.log.info(message),
  });

  bb.rpc.register(rpcContract, {
    async getUsage({ sinceDay, untilDay, timeZone, force }) {
      assertValidWindow({ sinceDay, untilDay, timeZone });
      const { merged } = await scanner.readSummary({
        sinceDay,
        untilDay,
        timeZone,
        force: force === true,
      });
      return merged;
    },
  });

  bb.onDispose(() => {
    void scanner.flush();
  });

  bb.cli.register({
    name: "usage",
    summary: "Show Claude / Codex / Pi usage totals",
    commands: [
      {
        name: "show",
        summary: "Print usage for a window (default 30 days)",
        usage: "bb usage show [--days 7|30|90] [--force]",
      },
    ],
    async run(argv) {
      const days = parseDays(argv);
      const force = argv.includes("--force");
      const { sinceDay, untilDay, timeZone } = makeWindow(days);
      const { merged } = await scanner.readSummary({
        sinceDay,
        untilDay,
        timeZone,
        force,
      });

      const cacheLabel = merged.cache.summaryHit
        ? "summary cache"
        : `${merged.cache.fileHits} file hits / ${merged.cache.filesParsed} parsed`;

      const lines = [
        `Usage ${sinceDay} to ${untilDay}`,
        `Raw token cost: $${merged.costUsd.toFixed(2)}`,
        ...merged.providers.map(
          (provider) =>
            `  ${provider.provider}: $${provider.costUsd.toFixed(2)} (${provider.totalTokens} tokens)`,
        ),
        `Sessions: ${merged.sessions}`,
        `Scan: ${merged.scanDurationMs}ms · ${cacheLabel} · pricing ${merged.pricing.status}`,
      ];
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    },
  });
}
