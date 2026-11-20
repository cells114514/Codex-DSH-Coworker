import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RuntimeRegistry, RuntimeRegistryError } from "../src/runtime-registry.js";
import type { SdkRuntimeClaimInput, SdkRuntimePatch } from "../src/runtime-registry.js";
import { assertPortablePrivateMode } from "./support/platform.js";

const taskA = "dsh_0000000000b1";
const taskB = "dsh_0000000000b2";
const taskC = "dsh_0000000000b3";
const startedAt = "2026-01-01T00:00:00.000Z";

function claimInput(home: string, overrides: Partial<SdkRuntimeClaimInput> = {}): SdkRuntimeClaimInput {
  const base: SdkRuntimeClaimInput = {
    taskId: taskA,
    rootSessionId: "session-root",
    canonicalCwd: join(home, "repo"),
    dshHome: join(home, "dsh-home"),
    profile: "default",
    route: { provider: "openai", model: "gpt-5", reasoningEffort: "high" },
    configFingerprint: RuntimeRegistry.configFingerprint({
      backend: "sdk",
      dshHome: join(home, "dsh-home"),
      profile: "default",
      route: { provider: "openai", model: "gpt-5", reasoningEffort: "high" },
    }),
    observationEpoch: 0,
    owner: { bridgeInstanceId: "bridge-a", pid: 4100, startedAt },
    title: "Investigate flaky test",
  };
  return { ...base, ...overrides };
}

const otherOwner = { bridgeInstanceId: "bridge-b", pid: 4200, startedAt };

async function withHome(work: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-runtimes-"));
  try {
    await work(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const isRegistryError = (code: string) => (error: unknown): boolean =>
  error instanceof RuntimeRegistryError && error.code === code;

test("RuntimeRegistry claims an SDK runtime identity and persists only documented fields privately", async () => {
  await withHome(async (home) => {
    const registry = new RuntimeRegistry(home);
    assert.equal(registry.dir, join(home, "runtimes"));
    const { record, created } = await registry.claim(claimInput(home));

    assert.equal(created, true);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.taskId, taskA);
    assert.equal(record.backend, "sdk");
    assert.equal(record.cleanShutdown, false);
    assert.equal(record.observationEpoch, 0);
    assert.equal(record.title, "Investigate flaky test");
    assert.equal(record.titleSource, "bridge");
    assert.deepEqual(record.owner, { bridgeInstanceId: "bridge-a", pid: 4100, startedAt });
    assert.deepEqual(await registry.get(taskA), record);

    const path = join(home, "runtimes", `${taskA}.json`);
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw).sort(), [
      "backend",
      "canonicalCwd",
      "cleanShutdown",
      "configFingerprint",
      "createdAt",
      "dshHome",
      "observationEpoch",
      "owner",
      "profile",
      "rootSessionId",
      "route",
      "schemaVersion",
      "taskId",
      "title",
      "titleSource",
      "updatedAt",
    ]);
    assert.equal(raw.apiKey, undefined);
    assert.equal(raw.token, undefined);
    assert.equal(raw.env, undefined);
    assertPortablePrivateMode((await stat(join(home, "runtimes"))).mode, 0o700);
    assertPortablePrivateMode((await stat(path)).mode, 0o600);
  });
});

test("explicit orphan recovery rejects live owners and stale snapshots without changing the record", async () => {
  await withHome(async (home) => {
    const registry = new RuntimeRegistry(home);
    const input = claimInput(home, { owner: { ...otherOwner, pid: process.pid } });
    const first = (await registry.claim(input)).record;
    await assert.rejects(registry.recoverOrphan({ ...input, owner: { ...otherOwner, bridgeInstanceId: "new" } }, {
      ownerInstanceId: first.owner.bridgeInstanceId, updatedAt: first.updatedAt,
    }), isRegistryError("owner_conflict"));
    await assert.rejects(registry.recoverOrphan({ ...input, owner: { ...otherOwner, bridgeInstanceId: "new" } }, {
      ownerInstanceId: first.owner.bridgeInstanceId, updatedAt: "stale",
    }), isRegistryError("owner_conflict"));
    assert.deepEqual(await registry.get(taskA), first);
  });
});

test("RuntimeRegistry re-claim by the same owner instance is idempotent", async () => {
  await withHome(async (home) => {
    const registry = new RuntimeRegistry(home);
    const first = await registry.claim(claimInput(home));
    const second = await registry.claim({ ...claimInput(home), observationEpoch: 3 });
    assert.equal(second.created, false);
    assert.deepEqual(second.record, first.record);
    assert.equal((await registry.list()).length, 1);
  });
});

test("RuntimeRegistry rejects identity mismatches and reports the differing fields", async () => {
  await withHome(async (home) => {
    const registry = new RuntimeRegistry(home);
    const first = await registry.claim(claimInput(home));

    await assert.rejects(
      () => registry.claim({ ...claimInput(home), canonicalCwd: join(home, "other-repo") }),
      (error: unknown) => {
        assert.equal(isRegistryError("identity_mismatch")(error), true);
        const details = (error as RuntimeRegistryError).details;
        assert.deepEqual(details.differingFields, ["canonicalCwd"]);
        return true;
      },
    );
    await assert.rejects(
      () => registry.claim({ ...claimInput(home), profile: "work" }),
      (error: unknown) => {
        assert.deepEqual((error as RuntimeRegistryError).details.differingFields, ["profile"]);
        return true;
      },
    );
    await assert.rejects(
      () =>
        registry.claim({
          ...claimInput(home),
          route: { provider: "anthropic", model: "gpt-5", reasoningEffort: "high" },
        }),
      (error: unknown) => {
        assert.deepEqual((error as RuntimeRegistryError).details.differingFields, ["route"]);
        return true;
      },
    );
    await assert.rejects(
      () => registry.claim({ ...claimInput(home), rootSessionId: "session-other" }),
      isRegistryError("identity_mismatch"),
    );

    assert.deepEqual(await registry.get(taskA), first.record);
  });
});

test("RuntimeRegistry refuses a second bridge while ownership is not cleanly released", async () => {
  await withHome(async (home) => {
    const registry = new RuntimeRegistry(home);
    await registry.claim(claimInput(home));

    await assert.rejects(
      () => registry.claim({ ...claimInput(home), owner: otherOwner }),
      (error: unknown) => {
        assert.equal(isRegistryError("owner_conflict")(error), true);
        assert.deepEqual((error as RuntimeRegistryError).details.owner, {
          bridgeInstanceId: "bridge-a",
          pid: 4100,
          startedAt,
        });
        return true;
      },
    );
    // Stale-looking state is never auto-released: the record still belongs to bridge-a.
    assert.equal((await registry.describe(taskA)).ownership, "owned");
    assert.equal((await registry.get(taskA))?.owner.bridgeInstanceId, "bridge-a");
  });
});

test("RuntimeRegistry only allows takeover after a recorded clean shutdown", async () => {
  await withHome(async (home) => {
    const registry = new RuntimeRegistry(home);
    const first = await registry.claim(claimInput(home));

    assert.equal(await registry.markOwnerExited(taskA, "bridge-b", { clean: true, at: startedAt }), undefined);
    const dirty = await registry.markOwnerExited(taskA, "bridge-a", { clean: false, at: startedAt });
    assert.equal(dirty?.cleanShutdown, false);
    assert.equal(dirty?.cleanShutdownAt, undefined);
    await assert.rejects(() => registry.claim({ ...claimInput(home), owner: otherOwner }), isRegistryError("owner_conflict"));

    const settled = await registry.markOwnerExited(taskA, "bridge-a", { clean: true, at: "2026-01-01T01:00:00.000Z" });
    assert.equal(settled?.cleanShutdown, true);
    assert.equal(settled?.cleanShutdownAt, "2026-01-01T01:00:00.000Z");
    assert.equal((await registry.describe(taskA)).ownership, "unowned");

    const takeover = await registry.claim({ ...claimInput(home), owner: otherOwner, observationEpoch: 1 });
    assert.equal(takeover.created, false);
    assert.equal(takeover.record.owner.bridgeInstanceId, "bridge-b");
    assert.equal(takeover.record.cleanShutdown, false);
    assert.equal(takeover.record.cleanShutdownAt, undefined);
    assert.equal(takeover.record.observationEpoch, 1);
    assert.equal(takeover.record.createdAt, first.record.createdAt);
    assert.equal((await registry.describe(taskA)).ownership, "owned");
  });
});

test("RuntimeRegistry update patches mutable metadata but never identity or owner", async () => {
  await withHome(async (home) => {
    const registry = new RuntimeRegistry(home);
    const first = await registry.claim(claimInput(home));

    const updated = await registry.update(taskA, {
      title: "Renamed by bridge",
      lastObservationAt: "2026-01-01T02:00:00.000Z",
      lastObservedRootSeq: 17,
      diagnostic: { runtimePid: 4242, lastError: "transient stream reset" },
      observationEpoch: 2,
    });
    assert.equal(updated.title, "Renamed by bridge");
    assert.equal(updated.titleSource, "bridge");
    assert.equal(updated.lastObservedRootSeq, 17);
    assert.equal(updated.observationEpoch, 2);
    assert.deepEqual(updated.diagnostic, { runtimePid: 4242, lastError: "transient stream reset" });
    assert.equal(updated.rootSessionId, first.record.rootSessionId);
    assert.equal(updated.canonicalCwd, first.record.canonicalCwd);
    assert.deepEqual(updated.owner, first.record.owner);
    assert.deepEqual(await registry.get(taskA), updated);

    for (const patch of [
      { canonicalCwd: join(home, "elsewhere") },
      { rootSessionId: "session-other" },
      { owner: otherOwner },
      { taskId: taskB },
      { prompt: "must-not-surface" },
      { observationEpoch: -1 },
      { cleanShutdown: "yes" },
      { cleanShutdownAt: "2026-01-01T03:00:00.000Z" },
      { diagnostic: { runtimePid: 0 } },
      { titleSource: "bridge" },
    ]) {
      await assert.rejects(
        () => registry.update(taskA, patch as unknown as SdkRuntimePatch),
        isRegistryError("invalid_record"),
        JSON.stringify(patch),
      );
    }
    assert.deepEqual(await registry.get(taskA), updated);

    const clean = await registry.update(taskA, { cleanShutdown: true, cleanShutdownAt: "2026-01-01T04:00:00.000Z" });
    assert.equal(clean.cleanShutdown, true);
    assert.equal(clean.cleanShutdownAt, "2026-01-01T04:00:00.000Z");
    assert.equal((await registry.describe(taskA)).ownership, "unowned");
    const reopened = await registry.update(taskA, { cleanShutdown: false });
    assert.equal(reopened.cleanShutdown, false);
    assert.equal(reopened.cleanShutdownAt, undefined);

    await assert.rejects(() => registry.update(taskB, { observationEpoch: 1 }), isRegistryError("not_found"));
  });
});

test("RuntimeRegistry reports invalid persisted records instead of skipping them", async () => {
  await withHome(async (home) => {
    const registry = new RuntimeRegistry(home);
    await mkdir(join(home, "runtimes"), { recursive: true });
    await assert.equal(await registry.get(taskB), undefined);
    assert.deepEqual(await registry.describe(taskB), { ownership: "missing" });
    assert.equal(await registry.remove(taskB), false);

    await writeFile(join(home, "runtimes", `${taskB}.json`), "{not-json\n");
    await assert.rejects(() => registry.get(taskB), isRegistryError("invalid_record"));
    await assert.rejects(() => registry.list(), isRegistryError("invalid_record"));
    await assert.rejects(() => registry.describe(taskB), isRegistryError("invalid_record"));

    await rm(join(home, "runtimes", `${taskB}.json`));
    const claimed = await registry.claim(claimInput(home));
    await writeFile(
      join(home, "runtimes", `${taskC}.json`),
      JSON.stringify({ ...claimed.record, taskId: taskC, prompt: "must-not-surface" }),
    );
    await assert.rejects(() => registry.list(), isRegistryError("invalid_record"));
    await assert.rejects(() => registry.get(taskC), isRegistryError("invalid_record"));
  });
});

test("RuntimeRegistry lists records sorted by taskId and removes them", async () => {
  await withHome(async (home) => {
    const registry = new RuntimeRegistry(home);
    await registry.claim(claimInput(home, { taskId: taskC }));
    await registry.claim(claimInput(home, { taskId: taskA }));
    await registry.claim(claimInput(home, { taskId: taskB }));

    assert.deepEqual(
      (await registry.list()).map((record) => record.taskId),
      [taskA, taskB, taskC],
    );
    assert.deepEqual(
      (await registry.list()).map((record) => record.owner.bridgeInstanceId),
      ["bridge-a", "bridge-a", "bridge-a"],
    );

    assert.equal(await registry.remove(taskA), true);
    assert.equal(await registry.get(taskA), undefined);
    assert.equal(await registry.remove(taskA), false);
    assert.deepEqual(
      (await registry.list()).map((record) => record.taskId),
      [taskB, taskC],
    );
  });
});

test("RuntimeRegistry validates claim input strictly", async () => {
  await withHome(async (home) => {
    const registry = new RuntimeRegistry(home);
    const invalid: Array<Partial<SdkRuntimeClaimInput>> = [
      { taskId: "nope" },
      { taskId: "../escape" },
      { rootSessionId: "" },
      { canonicalCwd: "relative/repo" },
      { dshHome: "relative-home" },
      { profile: "" },
      { observationEpoch: -1 },
      { observationEpoch: 1.5 },
      { owner: { bridgeInstanceId: "", pid: 10, startedAt } },
      { owner: { bridgeInstanceId: "bridge-a", pid: 0, startedAt } },
      { owner: { bridgeInstanceId: "bridge-a", pid: 10, startedAt: "" } },
      { route: { provider: "", model: "gpt-5" } },
      { title: "" },
    ];
    for (const overrides of invalid) {
      await assert.rejects(
        () => registry.claim(claimInput(home, overrides)),
        isRegistryError("invalid_record"),
        JSON.stringify(overrides),
      );
    }
    assert.deepEqual(await registry.list(), []);
  });
});

test("RuntimeRegistry.configFingerprint is stable for one environment and changes with it", async () => {
  await withHome(async (home) => {
    const base = {
      backend: "sdk" as const,
      dshHome: join(home, "dsh-home"),
      profile: "default",
      route: { provider: "openai", model: "gpt-5", reasoningEffort: "high" },
    };
    const fingerprint = RuntimeRegistry.configFingerprint(base);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(fingerprint, RuntimeRegistry.configFingerprint({ ...base }));
    assert.notEqual(fingerprint, RuntimeRegistry.configFingerprint({ ...base, profile: "work" }));
    assert.notEqual(fingerprint, RuntimeRegistry.configFingerprint({ ...base, dshHome: join(home, "other-home") }));
    assert.notEqual(
      fingerprint,
      RuntimeRegistry.configFingerprint({ ...base, route: { provider: "anthropic", model: "gpt-5", reasoningEffort: "high" } }),
    );
    assert.notEqual(
      fingerprint,
      RuntimeRegistry.configFingerprint({ ...base, route: { provider: "openai", model: "gpt-5-mini", reasoningEffort: "high" } }),
    );
    assert.notEqual(
      fingerprint,
      RuntimeRegistry.configFingerprint({ ...base, route: { provider: "openai", model: "gpt-5", reasoningEffort: "low" } }),
    );
    assert.notEqual(fingerprint, RuntimeRegistry.configFingerprint({ ...base, bin: join(home, "bin", "dsh.exe") }));
  });
});
