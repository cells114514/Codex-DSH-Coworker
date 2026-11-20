import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * Coworker binding: the explicit association between one bridge task and the
 * exact Codex chat that must be notified when the task's execution terminates.
 *
 * A binding is a sidecar file, so the task record keeps its existing shape. The
 * outbox is a directory of durable completion records: the bridge writes a
 * record when the background event handler observes the terminal event, and a
 * separate sender process consumes it. Nothing here sends anything.
 */

export interface CoworkerBinding {
  taskId: string;
  /** Exact Codex chat identity; never derived from a title, cwd or recency. */
  threadId: string;
  outboxDir: string;
  boundAt: string;
}

export interface CoworkerBindingInput {
  threadId?: unknown;
  outboxDir?: string | undefined;
}

export interface CoworkerBindingResult {
  registered: boolean;
  threadId?: string;
  outboxDir?: string;
  reason?: string;
  /** A binding file exists; delivery still needs a running sender. */
  bindingSaved?: boolean;
  /** A live sender heartbeat was seen in the outbox. */
  senderReady?: boolean;
  reused?: boolean;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Normalize and validate a binding request without touching the filesystem. */
export function normalizeBinding(
  input: CoworkerBindingInput | undefined,
  defaultOutbox: string,
  allowedOutboxRoots: readonly string[] = [],
): CoworkerBindingResult & { threadId?: string; outboxDir?: string } {
  if (input === undefined) return { registered: false, reason: "no binding requested" };
  const threadId = typeof input.threadId === "string" ? input.threadId.trim() : "";
  if (!UUID.test(threadId)) {
    return { registered: false, reason: "threadId must be the exact Codex chat UUID" };
  }
  const requested = typeof input.outboxDir === "string" && input.outboxDir.trim() !== "" ? resolve(input.outboxDir.trim()) : resolve(defaultOutbox);
  // The outbox is part of the controlled configuration: a caller may not point
  // it outside the bridge home or an explicitly allowed root.
  const allowed = [resolve(defaultOutbox), ...allowedOutboxRoots.map((root) => resolve(root))];
  const contained = allowed.some((root) => requested === root || requested.startsWith(`${root}${sep}`));
  if (!contained) {
    return { registered: false, reason: "outboxDir is outside the controlled configuration" };
  }
  return { registered: true, threadId, outboxDir: requested };
}

export class CoworkerBindings {
  private readonly dir: string;

  constructor(homeDir: string) {
    this.dir = join(homeDir, "coworker");
  }

  private bindingPath(taskId: string): string {
    return join(this.dir, `${taskId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  }

  private outboxPath(binding: CoworkerBinding): string {
    return binding.outboxDir;
  }

  async bind(
    taskId: string,
    input: CoworkerBindingInput | undefined,
    defaultOutbox: string,
    allowedOutboxRoots: readonly string[] = [],
  ): Promise<CoworkerBindingResult> {
    const normalized = normalizeBinding(input, defaultOutbox, allowedOutboxRoots);
    if (!normalized.registered || normalized.threadId === undefined || normalized.outboxDir === undefined) {
      return { registered: false, reason: normalized.reason ?? "invalid binding" };
    }
    const binding: CoworkerBinding = {
      taskId,
      threadId: normalized.threadId,
      outboxDir: normalized.outboxDir,
      boundAt: new Date().toISOString(),
    };
    try {
      await mkdir(this.dir, { recursive: true });
      await mkdir(binding.outboxDir, { recursive: true });
      const temp = `${this.bindingPath(taskId)}.${process.pid}-${randomUUID()}.tmp`;
      const body = `${JSON.stringify(binding, null, 2)}\n`;
      await writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
      // Concurrent binds race on the rename target; a bounded retry keeps the
      // last writer's binding instead of reporting a spurious failure.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temp, this.bindingPath(taskId));
          break;
        } catch (error) {
          if (attempt >= 5) {
            await writeFile(this.bindingPath(taskId), body, { encoding: "utf8", mode: 0o600 });
            break;
          }
          await new Promise((done) => setTimeout(done, 20 * (attempt + 1)));
        }
      }
      return {
        registered: true,
        bindingSaved: true,
        senderReady: await this.senderReady(binding.outboxDir),
        threadId: binding.threadId,
        outboxDir: binding.outboxDir,
      };
    } catch (error) {
      // The task still exists; only the callback is unavailable.
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "unknown";
      return { registered: false, reason: `binding write failed (${code})` };
    }
  }

  /** A sender is considered ready only while its heartbeat is fresh. */
  async senderReady(outboxDir: string, nowMs = Date.now(), maxAgeMs = 60_000): Promise<boolean> {
    try {
      const stats = await stat(join(outboxDir, ".sender-heartbeat"));
      return nowMs - stats.mtimeMs <= maxAgeMs;
    } catch {
      return false;
    }
  }

  async get(taskId: string): Promise<CoworkerBinding | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.bindingPath(taskId), "utf8")) as Partial<CoworkerBinding>;
      if (typeof parsed.threadId !== "string" || typeof parsed.outboxDir !== "string") return undefined;
      return { taskId, threadId: parsed.threadId, outboxDir: parsed.outboxDir, boundAt: parsed.boundAt ?? "" };
    } catch {
      return undefined;
    }
  }

  /**
   * Persist one terminal record. Identity is the execution generation plus the
   * terminal kind, so a later turn cannot reuse an earlier completion and the
   * record does not move when the global cursor advances.
   */
  async writeCompletion(
    binding: CoworkerBinding,
    detail: { taskId: string; executionId: string; execution: "turn_completed" | "failed"; turnSeq?: number },
  ): Promise<{ written: boolean; deduped: boolean; eventId: string; path: string }> {
    const eventId = `${detail.taskId}:${detail.executionId}:${detail.execution}`;
    const path = join(this.outboxPath(binding), `${eventId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    const existing = await readFile(path, "utf8").then(() => true, () => false);
    if (existing) return { written: false, deduped: true, eventId, path };
    const record = {
      eventId,
      taskId: detail.taskId,
      executionId: detail.executionId,
      execution: detail.execution,
      ...(detail.turnSeq === undefined ? {} : { turnSeq: detail.turnSeq }),
      threadId: binding.threadId,
      outboxDir: binding.outboxDir,
      createdAt: new Date().toISOString(),
      status: "pending",
      notification: `[coworker] 事件 ${eventId} / 任务 ${detail.taskId} / 状态 ${detail.execution}。用 dsh_status 读取结果。`,
    };
    const temp = `${path}.${process.pid}-${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
    return { written: true, deduped: false, eventId, path };
  }
}
/** Sidecar for the per-task execution counter; survives bridge restarts. */
export class ExecutionCounter {
  private readonly dir: string;

  constructor(homeDir: string) {
    this.dir = join(homeDir, "coworker", "execution-seq");
  }

  private path(taskId: string): string {
    return join(this.dir, `${taskId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  }

  async load(taskId: string): Promise<number> {
    try {
      const parsed = JSON.parse(await readFile(this.path(taskId), "utf8")) as { executionSeq?: unknown };
      return typeof parsed.executionSeq === "number" && Number.isInteger(parsed.executionSeq) && parsed.executionSeq > 0
        ? parsed.executionSeq
        : 0;
    } catch {
      return 0;
    }
  }

  /** Await the durable write; a failure must abort the submit, not silently continue. */
  async persist(taskId: string, executionSeq: number): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const temp = `${this.path(taskId)}.${process.pid}-${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ taskId, executionSeq, updatedAt: new Date().toISOString() }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temp, this.path(taskId));
  }
}