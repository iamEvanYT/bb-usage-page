import type { BbPluginApi } from "@bb/plugin-sdk";
import type { ThreadTotals, UsageProviderKind } from "./types";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

const PROVIDERS: Record<string, UsageProviderKind> = {
  codex: "codex",
  "claude-code": "claude",
  claude: "claude",
  pi: "pi",
  opencode2: "opencode",
  opencode: "opencode",
};

export function applyThreadCatalog(
  rows: readonly ThreadTotals[],
  catalog: ReadonlyMap<string, { id: string; title: string } | null>,
): ThreadTotals[] {
  const merged = new Map<string, ThreadTotals>();
  for (const row of rows) {
    const thread = catalog.get(`${row.provider}\0${row.sessionId}`);
    const key = thread ? `thread:${thread.id}` : `${row.provider}\0${row.sessionId}`;
    const existing = merged.get(key);
    if (existing) {
      existing.costUsd += row.costUsd;
      existing.totalTokens += row.totalTokens;
      existing.records += row.records;
      existing.costShare += row.costShare;
    } else {
      merged.set(key, {
        ...row,
        threadId: thread?.id ?? null,
        title: thread?.title ?? row.title,
      });
    }
  }
  return [...merged.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens,
  );
}

/** Resolve exact provider session identities, never infer a thread from its cwd. */
export class ThreadResolver {
  private identities = new Map<string, {
    afterSeq: number;
    updatedAt: number;
    sessionIds: Set<string>;
  }>();

  async resolve(bb: BbPluginApi, rows: readonly ThreadTotals[]): Promise<ThreadTotals[]> {
    const providers = new Set(rows.filter((row) => row.sessionId).map((row) => row.provider));
    if (providers.size === 0) return [...rows];
    const threads: Thread[] = [];
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += 200) {
        const page = await bb.sdk.threads.list({ includeHidden: true, archived, limit: 200, offset });
        threads.push(...page.filter((thread) =>
          thread.deletedAt === null && providers.has(PROVIDERS[thread.providerId]),
        ));
        if (page.length < 200) break;
      }
    }

    // Bound concurrent history reads. Warm reads only request new events.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(8, threads.length) }, async () => {
      while (index < threads.length) {
        const thread = threads[index++];
        const state = this.identities.get(thread.id) ?? {
          afterSeq: 0, updatedAt: -1, sessionIds: new Set<string>(),
        };
        this.identities.set(thread.id, state);
        if (state.updatedAt === thread.updatedAt && thread.status !== "active") continue;
        try {
          for (;;) {
            const page = await bb.sdk.threads.events.list({
              threadId: thread.id, afterSeq: String(state.afterSeq), limit: "100",
            });
            const previousSeq = state.afterSeq;
            for (const event of page) {
              if (event.type === "thread/identity" || event.type === "turn/started") {
                if (event.data.providerThreadId) state.sessionIds.add(event.data.providerThreadId);
              }
              state.afterSeq = Math.max(state.afterSeq, event.seq);
            }
            if (state.afterSeq === previousSeq) break;
          }
          state.updatedAt = thread.updatedAt;
        } catch (error) {
          // Keep known identities and retry unread events next time.
          bb.log.warn(`Thread identity lookup failed for ${thread.id}: ${String(error)}`);
        }
      }
    }));

    const catalog = new Map<string, { id: string; title: string } | null>();
    for (const thread of threads) {
      for (const sessionId of this.identities.get(thread.id)?.sessionIds ?? []) {
        const key = `${PROVIDERS[thread.providerId]}\0${sessionId}`;
        const existing = catalog.get(key);
        // A shared provider session cannot safely be assigned to either thread.
        catalog.set(key, existing === null || (existing && existing.id !== thread.id)
          ? null
          : { id: thread.id, title: thread.title || thread.titleFallback || thread.id });
      }
    }
    return applyThreadCatalog(rows, catalog);
  }
}
