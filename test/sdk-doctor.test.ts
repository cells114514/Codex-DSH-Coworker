import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { SDK_BACKEND_CAPABILITIES } from "../src/backend-capabilities.js";
import { loadConfig } from "../src/config.js";
import type { BridgeConfig } from "../src/config.js";
import {
  parseDoctorArgs,
  probeSdkRuntime,
  runDoctor,
  SDK_PROBE_SIDE_EFFECTS,
  type SdkDoctorReport,
  type SdkPackageResolver,
} from "../src/doctor.js";
import type { DshApi } from "../src/dsh-types.js";
import { RuntimeRegistry } from "../src/runtime-registry.js";
import { SdkObservedEventStore } from "../src/sdk-observed-event-store.js";
import type { SdkRuntimeClient, SdkRuntimeClientOptions } from "../src/sdk-runtime-manager.js";

const VALID_TASK_ID = "dsh_0123456789ab";
const INVALID_TASK_ID = "dsh_ffffffffffff";

async function makeTemp(prefix: string): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

function sdkConfig(dshHome: string, bridgeHome: string, extra: NodeJS.ProcessEnv = {}): BridgeConfig {
  return loadConfig({
    DSH_HOST_PROTOCOL: "sdk",
    DSH_HOME: dshHome,
    DSH_BRIDGE_HOME: bridgeHome,
    DSH_BRIDGE_TIME_ZONE: "UTC",
    ...extra,
  });
}

/**
 * A `DshApi` whose Host-only surface fails loudly. The SDK doctor must never
 * reach `hostDescribe`, `sessionList`, or `openMux`: they throw
 * `unsupported_capability` on this backend.
 */
function hostOnlyApi(): { api: DshApi; calls: string[] } {
  const calls: string[] = [];
  const unreachable = (method: string) => async () => {
    calls.push(method);
    throw new Error(`${method} is Host-only and must never be reached on the sdk backend`);
  };
  const api = {
    hostDescribe: unreachable("hostDescribe"),
    sessionList: unreachable("sessionList"),
    openMux: () => {
      calls.push("openMux");
      throw new Error("openMux is Host-only and must never be reached on the sdk backend");
    },
  };
  return { api: api as unknown as DshApi, calls };
}

const resolvablePackages: SdkPackageResolver = async () => ({
  clientPackageResolvable: true,
  clientPackagePath: join(tmpdir(), "sdk-client", "lib", "index.js"),
  clientVersion: "0.2.2-rc.3",
  runtimeResolvable: true,
  runtimeVersion: "0.2.2-rc.3",
  runtimeBin: join(tmpdir(), "dsh-package", "lib", "bin.js"),
});

test("SDK doctor stays static, skips Host-only probes and the CLI probe, and reports the backend contract", async () => {
  const dshHome = await makeTemp("doctor-sdk-home-");
  const bridgeHome = await makeTemp("doctor-sdk-bridge-");
  try {
    const config = sdkConfig(dshHome, bridgeHome);
    const { api, calls } = hostOnlyApi();
    let cliProbeRan = false;
    const report = (await runDoctor(
      config,
      api,
      async () => {
        cliProbeRan = true;
        return "0.1.0-rc.6";
      },
      { resolvePackages: resolvablePackages },
    )) as SdkDoctorReport;

    assert.deepEqual(calls, []);
    assert.equal(cliProbeRan, false, "the SDK branch must not spawn `dsh --version`");
    assert.equal(report.backend, "sdk");
    assert.equal(report.transport, "stdio-jsonrpc");
    assert.deepEqual(report.capabilities, SDK_BACKEND_CAPABILITIES);
    assert.equal(Number.isNaN(Date.parse(report.checkedAt)), false);
    assert.ok(report.lockDiagnostics.locks.length >= 2);
    assert.equal("liveProbe" in report, false, "a static report never embeds a live probe");
    assert.equal(report.ok, true);

    assert.equal(report.config?.dshHome, resolve(dshHome));
    assert.equal(report.config?.profile, "sdk");
    assert.equal(report.config?.bin, null);
    assert.equal(report.config?.maxRuntimes, 2);
    assert.equal(report.config?.idleTimeoutMs, 600_000);
    assert.equal(report.config?.initializeTimeoutMs, 60_000);
    assert.equal(report.config?.shutdownTimeoutMs, 10_000);
    assert.equal("profileWarning" in (report.config ?? {}), false);
    const route = report.config?.route as { source?: string; note?: string };
    assert.equal(route.source, "sdk-default");
    assert.match(route.note ?? "", /no catalog|fallback/);

    assert.equal(report.sdks?.clientPackageResolvable, true);
    assert.equal(report.sdks?.clientVersion, "0.2.2-rc.3");
    assert.equal(report.sdks?.runtimeResolvable, true);
    assert.equal(report.sdks?.runtimeVersion, "0.2.2-rc.3");

    assert.deepEqual(report.binCheck, { configured: false });
    assert.equal(report.homes?.dshHome.exists, true);
    assert.equal(report.homes?.profiles.exists, false);
    assert.equal(report.homes?.sessions.exists, false);
    assert.equal(report.homes?.bridgeHome.exists, true);
    assert.equal(report.homes?.bridgeHome.creatable, true);
    assert.ok((report.homes?.warnings ?? []).some((warning) => /profiles/.test(warning)));
    assert.deepEqual(report.runtimes, []);

    const notes = report.notes.join("\n");
    assert.match(notes, /static/);
    assert.match(notes, /--probe-sdk/);
    assert.match(notes, /[Aa]pprovals/);
    assert.match(notes, /user questions/i);
    assert.match(notes, /no session catalog/);
    assert.match(notes, /unobserved/);

    // No credential, environment dump, or pid is ever serialized.
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('"pid"'), false);
    assert.equal(serialized.includes("DSH_CONNECT"), false);
    assert.equal(serialized.includes("API_KEY"), false);
  } finally {
    await fs.rm(dshHome, { recursive: true, force: true });
    await fs.rm(bridgeHome, { recursive: true, force: true });
  }
});

test("SDK doctor reports an unresolvable client package instead of throwing", async () => {
  const dshHome = await makeTemp("doctor-sdk-missing-");
  const bridgeHome = await makeTemp("doctor-sdk-missing-bridge-");
  try {
    const config = sdkConfig(dshHome, bridgeHome);
    const report = (await runDoctor(config, hostOnlyApi().api, async () => undefined, {
      resolvePackages: async () => ({
        clientPackageResolvable: false,
        runtimeResolvable: false,
        error: "client package @deepseek-ai/dsh-sdk-client is not resolvable (ERR_MODULE_NOT_FOUND)",
      }),
    })) as SdkDoctorReport;

    assert.equal(report.ok, false);
    assert.equal(report.sdks?.clientPackageResolvable, false);
    assert.match(report.sdks?.error ?? "", /ERR_MODULE_NOT_FOUND/);
    // The rest of the static report is still produced.
    assert.equal(report.config?.profile, "sdk");
    assert.ok(report.lockDiagnostics !== undefined);
  } finally {
    await fs.rm(dshHome, { recursive: true, force: true });
    await fs.rm(bridgeHome, { recursive: true, force: true });
  }
});

test("SDK doctor attributes an invalid runtime record to its task id without aborting the report", async () => {
  const dshHome = await makeTemp("doctor-sdk-registry-home-");
  const bridgeHome = await makeTemp("doctor-sdk-registry-bridge-");
  try {
    const registry = new RuntimeRegistry(bridgeHome);
    await registry.claim({
      taskId: VALID_TASK_ID,
      rootSessionId: "session-root",
      canonicalCwd: bridgeHome,
      dshHome,
      profile: "sdk",
      route: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      configFingerprint: "fingerprint-under-test",
      observationEpoch: 1,
      owner: { bridgeInstanceId: "bridge-under-test", pid: process.pid, startedAt: new Date().toISOString() },
    });
    const store = new SdkObservedEventStore(bridgeHome);
    await store.append(VALID_TASK_ID, [
      {
        sessionId: "session-root",
        seq: 1,
        origin: "root",
        observedAt: new Date().toISOString(),
        event: { type: "turn/start", seq: 1, data: { turn: 1 } },
      },
    ]);
    await fs.writeFile(join(bridgeHome, "runtimes", `${INVALID_TASK_ID}.json`), '{"schemaVersion":99}\n', "utf8");

    const report = (await runDoctor(sdkConfig(dshHome, bridgeHome), hostOnlyApi().api, async () => undefined, {
      resolvePackages: resolvablePackages,
    })) as SdkDoctorReport;

    assert.equal(report.ok, false, "an invalid registry record fails the static verdict");
    assert.equal(report.runtimes?.length, 2);

    const valid = report.runtimes?.find((row) => row.taskId === VALID_TASK_ID);
    assert.ok(valid !== undefined);
    assert.equal("error" in valid, false);
    assert.equal(valid.rootSessionId, "session-root");
    assert.equal(valid.cleanShutdown, false);
    assert.equal(valid.ownerBridgeInstanceId, "bridge-under-test");
    assert.equal(valid.observedEvents, 1);
    assert.equal(Number.isNaN(Date.parse(valid.updatedAt)), false);

    const invalid = report.runtimes?.find((row) => row.taskId === INVALID_TASK_ID);
    assert.ok(invalid !== undefined && "error" in invalid);
    assert.match(invalid.error, /schemaVersion|invalid/i);
    assert.equal(JSON.stringify(report.runtimes).includes('"pid"'), false);
  } finally {
    await fs.rm(dshHome, { recursive: true, force: true });
    await fs.rm(bridgeHome, { recursive: true, force: true });
  }
});

test("SDK doctor checks a DSH_SDK_BIN module path that contains spaces as a file, not a command", async () => {
  const dshHome = await makeTemp("doctor-sdk-bin-home-");
  const bridgeHome = await makeTemp("doctor-sdk-bin-bridge-");
  try {
    const spacedDirectory = join(dshHome, "dsh cli path");
    await fs.mkdir(spacedDirectory, { recursive: true });
    const binPath = join(spacedDirectory, "bin module.js");
    await fs.writeFile(binPath, "export {};\n", "utf8");
    const missingPath = join(spacedDirectory, "absent cli module.js");

    const present = (await runDoctor(
      sdkConfig(dshHome, bridgeHome, { DSH_SDK_BIN: binPath }),
      hostOnlyApi().api,
      async () => undefined,
      { resolvePackages: resolvablePackages },
    )) as SdkDoctorReport;
    assert.deepEqual(present.binCheck, { configured: true, path: resolve(binPath), exists: true, isFile: true });
    assert.equal(present.config?.bin, resolve(binPath));

    const absent = (await runDoctor(
      sdkConfig(dshHome, bridgeHome, { DSH_SDK_BIN: missingPath }),
      hostOnlyApi().api,
      async () => undefined,
      { resolvePackages: resolvablePackages },
    )) as SdkDoctorReport;
    assert.deepEqual(absent.binCheck, { configured: true, path: resolve(missingPath), exists: false, isFile: false });
  } finally {
    await fs.rm(dshHome, { recursive: true, force: true });
    await fs.rm(bridgeHome, { recursive: true, force: true });
  }
});

test("SDK doctor reports absent DSH home subdirectories as warnings and never creates the bridge home", async () => {
  const parent = await makeTemp("doctor-sdk-homes-");
  const dshHome = join(parent, "dsh home");
  const bridgeHome = join(parent, "bridge home", "nested");
  try {
    const report = (await runDoctor(sdkConfig(dshHome, bridgeHome), hostOnlyApi().api, async () => undefined, {
      resolvePackages: resolvablePackages,
    })) as SdkDoctorReport;

    assert.equal(report.ok, true, "absent profiles/sessions are warnings, not failures");
    assert.equal(report.homes?.dshHome.exists, false);
    assert.equal(report.homes?.bridgeHome.exists, false);
    assert.equal(report.homes?.bridgeHome.creatable, true);
    assert.ok((report.homes?.warnings ?? []).every((warning) => typeof warning === "string"));
    assert.ok((report.homes?.warnings ?? []).some((warning) => /DSH_HOME/.test(warning)));
    await assert.rejects(() => fs.stat(bridgeHome), { code: "ENOENT" });
    await assert.rejects(() => fs.stat(dshHome), { code: "ENOENT" });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

interface FakeClientBehaviour {
  initializeError?: Error;
  hangInitialize?: boolean;
  serverInfo?: { name: string; version: string };
}

function fakeClient(_options: SdkRuntimeClientOptions, behaviour: FakeClientBehaviour = {}): SdkRuntimeClient {
  return {
    start() {},
    onRequest() {},
    async initialize() {
      if (behaviour.hangInitialize === true) return new Promise(() => undefined);
      if (behaviour.initializeError !== undefined) throw behaviour.initializeError;
      return { serverInfo: behaviour.serverInfo ?? { name: "deepseek-harness-sdk-runtime", version: "0.2.2-rc.3" } };
    },
    async prompt() {
      throw new Error("the doctor probe must never send a prompt");
    },
    async resumeSession() {
      throw new Error("the doctor probe must never resume a session");
    },
    async getWorkingDirectory() {
      return process.cwd();
    },
    subscribe() {
      return { next: () => new Promise(() => undefined), tryNext: () => undefined, close() {} };
    },
    async request() {
      throw new Error("the doctor probe must never issue extra requests");
    },
    async close() {},
  };
}

test("live probe performs exactly one bounded initialize handshake and reports fixed side effects", async () => {
  const dshHome = await makeTemp("doctor-sdk-probe-");
  const bridgeHome = await makeTemp("doctor-sdk-probe-bridge-");
  try {
    const config = sdkConfig(dshHome, bridgeHome);
    const calls: string[] = [];
    const result = await probeSdkRuntime(config, {
      clientFactory: (options) => {
        const client = fakeClient(options);
        const requested = client.initialize;
        client.initialize = async (params) => {
          calls.push("initialize");
          return requested(params);
        };
        client.prompt = async () => {
          calls.push("prompt");
          throw new Error("prompt must not be sent");
        };
        client.resumeSession = async () => {
          calls.push("resumeSession");
        };
        return client;
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["initialize"], "the probe resumes no session and sends no prompt");
    assert.deepEqual(result.serverInfo, { name: "deepseek-harness-sdk-runtime", version: "0.2.2-rc.3" });
    assert.deepEqual(result.sideEffects, [...SDK_PROBE_SIDE_EFFECTS]);
    assert.equal(Number.isInteger(result.elapsedMs), true);
    assert.ok(result.elapsedMs >= 0);
    assert.equal("error" in result, false);
  } finally {
    await fs.rm(dshHome, { recursive: true, force: true });
    await fs.rm(bridgeHome, { recursive: true, force: true });
  }
});

test("live probe reports a bounded failure when the runtime cannot initialize", async () => {
  const dshHome = await makeTemp("doctor-sdk-probe-fail-");
  const bridgeHome = await makeTemp("doctor-sdk-probe-fail-bridge-");
  try {
    const config = sdkConfig(dshHome, bridgeHome);
    const result = await probeSdkRuntime(config, {
      clientFactory: (options) =>
        fakeClient(options, {
          initializeError: new Error("spawn dsh ENOENT\nsecond line that must never be forwarded"),
        }),
    });

    assert.equal(result.ok, false);
    assert.ok(result.error !== undefined);
    assert.match(result.error.message, /initialize handshake/);
    assert.equal(result.error.message.includes("second line that must never be forwarded"), false);
    assert.equal(result.error.message.includes("\n"), false);
    assert.ok(result.error.message.length <= 400);
    assert.deepEqual(result.sideEffects, [...SDK_PROBE_SIDE_EFFECTS]);
  } finally {
    await fs.rm(dshHome, { recursive: true, force: true });
    await fs.rm(bridgeHome, { recursive: true, force: true });
  }
});

test("live probe enforces its own bound instead of waiting forever", async () => {
  const dshHome = await makeTemp("doctor-sdk-probe-hang-");
  const bridgeHome = await makeTemp("doctor-sdk-probe-hang-bridge-");
  try {
    const config = sdkConfig(dshHome, bridgeHome);
    const result = await probeSdkRuntime(config, {
      clientFactory: (options) => fakeClient(options, { hangInitialize: true }),
      timeoutMs: 150,
    });

    assert.equal(result.ok, false);
    assert.match(result.error?.message ?? "", /exceeded its 150 ms bound/);
  } finally {
    await fs.rm(dshHome, { recursive: true, force: true });
    await fs.rm(bridgeHome, { recursive: true, force: true });
  }
});

test("SDK doctor CLI options keep --probe-sdk opt-in and --json a no-op", () => {
  assert.deepEqual(parseDoctorArgs([]), { json: false, live: false, probeSdk: false, help: false });
  assert.deepEqual(parseDoctorArgs(["--json"]), { json: true, live: false, probeSdk: false, help: false });
  assert.deepEqual(parseDoctorArgs(["--probe-sdk"]), { json: false, live: true, probeSdk: true, help: false });
  assert.deepEqual(parseDoctorArgs(["--live"]), { json: false, live: true, probeSdk: false, help: false });
  assert.deepEqual(parseDoctorArgs(["--help"]), { json: false, live: false, probeSdk: false, help: true });
  assert.throws(() => parseDoctorArgs(["--plan"]), /unknown option/);
});
