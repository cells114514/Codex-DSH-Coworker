import assert from "node:assert/strict";
import { test } from "node:test";

import { resolve } from "node:path";

import {
  createCodexInstallPlan,
  parseSetupArgs,
  planSdkSetup,
  renderCodexOperation,
  renderSdkConfigReview,
  sdkMcpEnv,
  verifyCodexMcpConfig,
} from "../src/setup-codex.js";
import { loadConfig } from "../src/config.js";

const DSH_HOME = "/tmp/dsh home";
const bridgeEntry = "/tmp/dsh Agentlink/dist/index.js";
const nodePath = "/usr/local/bin/node";
const configPath = "/tmp/codex/config.toml";

function sdkOperation(
  sdk: Parameters<typeof sdkMcpEnv>[0],
  extra: { preset?: string } = {},
) {
  const plan = createCodexInstallPlan({
    configPath,
    nodePath,
    entryPath: bridgeEntry,
    hostProtocol: "sdk",
    sdk,
    replace: false,
    ...extra,
  });
  const operation = plan.operations[0];
  assert.equal(operation?.kind, "upsert-mcp-server");
  return { plan, operation };
}

test("--backend sdk renders only the sdk variables and no Host, token, or API-key setting", () => {
  const { plan, operation } = sdkOperation({ dshHome: DSH_HOME, profile: "sdk" });

  assert.deepEqual(operation.env, {
    DSH_HOST_PROTOCOL: "sdk",
    DSH_HOME: DSH_HOME,
    DSH_SDK_PROFILE: "sdk",
  });
  assert.equal(operation.envVars, undefined, "the SDK backend never forwards a connect-token variable");

  const rendered = renderCodexOperation(operation);
  assert.match(rendered, /DSH_HOST_PROTOCOL = "sdk"/);
  assert.match(rendered, /DSH_HOME = "\/tmp\/dsh home"/);
  assert.match(rendered, /DSH_SDK_PROFILE = "sdk"/);
  assert.match(rendered, /approval_mode = "prompt"/);
  for (const forbidden of [
    "DSH_HOST_URL",
    "DSH_HOST_MODE",
    "DSH_CONNECT_TOKEN",
    "DSH_CONNECT_ORIGIN",
    "DSH_HOST_VERSION",
    "DSH_BRIDGE_AGENT_PRESET",
    "DSH_BRIDGE_HOME",
    "API_KEY",
    "env_vars",
  ]) {
    assert.equal(rendered.includes(forbidden), false, `the SDK block must not contain ${forbidden}`);
  }

  // The dry-run object is the same information as one reviewable JSON object.
  const review = JSON.parse(
    renderSdkConfigReview({
      serverName: operation.serverName,
      configPath: plan.target.path,
      command: operation.command,
      args: operation.args,
      env: { ...operation.env },
    }),
  ) as { backend: string; env: Record<string, string>; writes: boolean; humanApproval: { mode: string } };
  assert.equal(review.backend, "sdk");
  assert.equal(review.writes, false);
  assert.equal(review.humanApproval.mode, "human-prompt");
  assert.deepEqual(Object.keys(review.env), ["DSH_HOST_PROTOCOL", "DSH_HOME", "DSH_SDK_PROFILE"]);
  assert.equal(JSON.stringify(review).includes("token"), false);
  assert.equal(JSON.stringify(review).includes("API_KEY"), false);
});

test("--backend sdk forwards only the optional variables the operator supplied, in a stable order", () => {
  const { operation } = sdkOperation({
    dshHome: DSH_HOME,
    profile: "sdk-work",
    bin: "/opt/dsh cli/bin module.js",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
    maxRuntimes: 3,
    idleTimeoutMs: 0,
    initializeTimeoutMs: 1_000,
    shutdownTimeoutMs: 2_000,
  });

  assert.deepEqual(Object.keys(operation.env), [
    "DSH_HOST_PROTOCOL",
    "DSH_HOME",
    "DSH_SDK_PROFILE",
    "DSH_SDK_BIN",
    "DSH_SDK_PROVIDER",
    "DSH_SDK_MODEL",
    "DSH_SDK_REASONING_EFFORT",
    "DSH_SDK_MAX_RUNTIMES",
    "DSH_SDK_IDLE_TIMEOUT_MS",
    "DSH_SDK_INITIALIZE_TIMEOUT_MS",
    "DSH_SDK_SHUTDOWN_TIMEOUT_MS",
  ]);
  assert.equal(operation.env.DSH_SDK_BIN, "/opt/dsh cli/bin module.js");
  assert.equal(operation.env.DSH_SDK_PROVIDER, "deepseek-official");
  assert.equal(operation.env.DSH_SDK_MODEL, "deepseek-v4-flash");
  assert.equal(operation.env.DSH_SDK_MAX_RUNTIMES, "3");
  assert.equal(operation.env.DSH_SDK_IDLE_TIMEOUT_MS, "0");
  assert.equal(operation.env.DSH_SDK_INITIALIZE_TIMEOUT_MS, "1000");
  assert.equal(operation.env.DSH_SDK_SHUTDOWN_TIMEOUT_MS, "2000");

  assert.throws(
    () => createCodexInstallPlan({
      configPath,
      nodePath,
      entryPath: bridgeEntry,
      hostProtocol: "sdk",
      sdk: { dshHome: DSH_HOME, profile: "sdk", provider: "deepseek-official" } as never,
      replace: false,
    }),
    /DSH_SDK_PROVIDER and DSH_SDK_MODEL must be provided together/,
  );
});

test("the sdk backend rejects an explicit agent preset instead of silently dropping it", () => {
  assert.throws(
    () => parseSetupArgs(["--backend", "sdk", "--preset", "code"], {}),
    /cannot select an agent preset.*--no-preset/s,
  );
  assert.throws(
    () => createCodexInstallPlan({
      configPath,
      nodePath,
      entryPath: bridgeEntry,
      hostProtocol: "sdk",
      sdk: { dshHome: DSH_HOME, profile: "sdk" },
      preset: "code",
      replace: false,
    }),
    /cannot honor an agent preset/,
  );

  // Omitting the preset (or opting out explicitly) is accepted.
  assert.equal(parseSetupArgs(["--backend", "sdk"], {}).backend, "sdk");
  assert.equal(parseSetupArgs(["--backend", "sdk", "--no-preset"], {}).noPreset, true);
  assert.equal(parseSetupArgs(["--backend", "sdk", "--preset", "-"], {}).backend, "sdk");
});

test("--backend gateway keeps today's output byte for byte and gains no sdk variable", () => {
  const legacy = createCodexInstallPlan({
    configPath,
    nodePath,
    entryPath: bridgeEntry,
    hostUrl: "http://127.0.0.1:3080",
    dshVersion: "0.1.0-rc.6",
    preset: "code",
    replace: false,
  });
  assert.deepEqual(legacy.operations[0]?.env, {
    DSH_HOST_URL: "http://127.0.0.1:3080",
    DSH_HOST_VERSION: "0.1.0-rc.6",
    DSH_BRIDGE_AGENT_PRESET: "code",
  });

  const gateway = createCodexInstallPlan({
    configPath,
    nodePath,
    entryPath: bridgeEntry,
    hostProtocol: "gateway",
    hostMode: "desktop-auto",
    dshVersion: "0.1.0-rc.6",
    preset: "code",
    replace: false,
  });
  const operation = gateway.operations[0];
  assert.deepEqual(operation?.env, {
    DSH_HOST_PROTOCOL: "gateway",
    DSH_HOST_MODE: "desktop-auto",
    DSH_HOST_VERSION: "0.1.0-rc.6",
    DSH_BRIDGE_AGENT_PRESET: "code",
  });
  assert.deepEqual(operation?.envVars, ["DSH_CONNECT_TOKEN", "DSH_CONNECT_ORIGIN"]);
  const rendered = renderCodexOperation(operation!);
  assert.equal(verifyCodexMcpConfig(rendered, operation!), true);
  assert.equal(rendered.includes("DSH_HOST_PROTOCOL = \"sdk\""), false);
  assert.equal(rendered.includes("DSH_SDK_"), false);
  assert.equal(rendered.includes("DSH_BRIDGE_HOME"), false);
});

test("Host-only flags and connect-token environment settings conflict with --backend sdk", () => {
  for (const argv of [
    ["--backend", "sdk", "--host-url", "http://127.0.0.1:3080"],
    ["--backend", "sdk", "--host", "http://127.0.0.1:3080"],
    ["--backend", "sdk", "--desktop-auto"],
  ]) {
    assert.throws(() => parseSetupArgs(argv, {}), /cannot be combined with --backend sdk/, argv.join(" "));
  }
  // `--gateway` names a different backend outright, which is reported even earlier.
  assert.throws(
    () => parseSetupArgs(["--backend", "sdk", "--gateway"], {}),
    /cannot select different backends/,
  );
  assert.throws(
    () => parseSetupArgs(["--backend", "sdk"], { DSH_CONNECT_ORIGIN: "http://127.0.0.1:45678" }),
    /DSH_CONNECT_ORIGIN\/DSH_CONNECT_TOKEN_ENV/,
  );
  assert.throws(
    () => parseSetupArgs(["--backend", "sdk"], { DSH_CONNECT_TOKEN_ENV: "DSH_CONNECT_TOKEN" }),
    /DSH_CONNECT_ORIGIN\/DSH_CONNECT_TOKEN_ENV/,
  );
  assert.throws(() => parseSetupArgs(["--gateway", "--backend", "legacy"], {}), /cannot select different backends/);
  assert.throws(() => parseSetupArgs(["--dsh-home", DSH_HOME], {}), /SDK backend setting/);
  assert.throws(
    () => parseSetupArgs(["--host", "http://127.0.0.1:3080", "--sdk-bin", "/opt/bin.js"], {}),
    /SDK backend setting/,
  );
  // `--backend gateway` restates `--gateway`, so it keeps the same Host requirement.
  assert.throws(() => parseSetupArgs(["--backend", "gateway"], {}), /requires --desktop-auto or --host/);

  // Equivalent spellings stay compatible.
  assert.equal(parseSetupArgs(["--backend", "gateway", "--host", "http://127.0.0.1:3080"], {}).backend, "gateway");
  assert.equal(parseSetupArgs(["--backend", "gateway", "--desktop-auto"], {}).backend, "gateway");
  assert.equal(parseSetupArgs(["--gateway", "--desktop-auto"], {}).gateway, true);
});

test("the SDK bridge home default differs from the gateway one and is never forced or repointed", () => {
  const sdkDefault = loadConfig({ DSH_HOST_PROTOCOL: "sdk", DSH_HOME: DSH_HOME, DSH_BRIDGE_TIME_ZONE: "UTC" });
  const gatewayDefault = loadConfig({ DSH_HOST_PROTOCOL: "gateway", DSH_HOME: DSH_HOME, DSH_BRIDGE_TIME_ZONE: "UTC" });
  assert.equal(sdkDefault.homeDir, resolve(DSH_HOME, "codex-bridge-sdk"));
  assert.equal(gatewayDefault.homeDir, resolve(DSH_HOME, "codex-bridge"));
  assert.notEqual(sdkDefault.homeDir, gatewayDefault.homeDir);

  // An explicit bridge home is honored by both backends and never rewritten.
  for (const protocol of ["sdk", "gateway"] as const) {
    const explicit = loadConfig({
      DSH_HOST_PROTOCOL: protocol,
      DSH_HOME: DSH_HOME,
      DSH_BRIDGE_HOME: "/tmp/bridge explicit",
      DSH_BRIDGE_TIME_ZONE: "UTC",
    });
    assert.equal(explicit.homeDir, resolve("/tmp/bridge explicit"));
  }

  // The installer writes DSH_BRIDGE_HOME only when the operator passed one.
  const untouched = sdkOperation({ dshHome: DSH_HOME, profile: "sdk" });
  assert.equal("DSH_BRIDGE_HOME" in untouched.operation.env, false);

  const explicitSdk = sdkOperation({ dshHome: DSH_HOME, profile: "sdk", bridgeHome: "/tmp/bridge explicit" });
  assert.equal(explicitSdk.operation.env.DSH_BRIDGE_HOME, "/tmp/bridge explicit");

  // A gateway installation never has its bridge home repointed by this installer.
  const gateway = createCodexInstallPlan({
    configPath,
    nodePath,
    entryPath: bridgeEntry,
    hostProtocol: "gateway",
    hostMode: "desktop-auto",
    replace: false,
  });
  assert.equal("DSH_BRIDGE_HOME" in (gateway.operations[0]?.env ?? {}), false);
});

test("planSdkSetup forwards explicit SDK settings and validates them with the bridge loader", () => {
  const minimal = planSdkSetup({}, { DSH_HOME: DSH_HOME });
  assert.deepEqual(minimal, { dshHome: resolve(DSH_HOME), profile: "sdk" });

  const full = planSdkSetup(
    { dshHome: "/tmp/dsh alt", sdkProfile: "sdk-work", sdkBin: "/opt/dsh cli/bin module.js", bridgeHome: "/tmp/bridge explicit" },
    {
      DSH_HOME: DSH_HOME,
      DSH_SDK_PROVIDER: "deepseek-official",
      DSH_SDK_MODEL: "deepseek-v4-flash",
      DSH_SDK_MAX_RUNTIMES: "4",
    },
  );
  assert.equal(full.dshHome, resolve("/tmp/dsh alt"));
  assert.equal(full.profile, "sdk-work");
  assert.equal(full.bin, resolve("/opt/dsh cli/bin module.js"));
  assert.equal(full.provider, "deepseek-official");
  assert.equal(full.model, "deepseek-v4-flash");
  assert.equal(full.maxRuntimes, 4);
  assert.equal(full.bridgeHome, resolve("/tmp/bridge explicit"));
  assert.equal("reasoningEffort" in full, false);
  assert.equal("idleTimeoutMs" in full, false);
  assert.equal("initializeTimeoutMs" in full, false);
  assert.equal("shutdownTimeoutMs" in full, false);

  assert.deepEqual(sdkMcpEnv(full), {
    DSH_HOST_PROTOCOL: "sdk",
    DSH_HOME: resolve("/tmp/dsh alt"),
    DSH_SDK_PROFILE: "sdk-work",
    DSH_SDK_BIN: resolve("/opt/dsh cli/bin module.js"),
    DSH_SDK_PROVIDER: "deepseek-official",
    DSH_SDK_MODEL: "deepseek-v4-flash",
    DSH_SDK_MAX_RUNTIMES: "4",
    DSH_BRIDGE_HOME: resolve("/tmp/bridge explicit"),
  });

  // The same loader the bridge uses rejects half-configured settings at install time.
  assert.throws(
    () => planSdkSetup({}, { DSH_HOME: DSH_HOME, DSH_SDK_PROVIDER: "deepseek-official" }),
    /set together or omitted together/,
  );
  assert.throws(
    () => planSdkSetup({}, { DSH_HOME: DSH_HOME, DSH_SDK_REASONING_EFFORT: "high" }),
    /requires DSH_SDK_PROVIDER/,
  );
  assert.throws(
    () => planSdkSetup({}, { DSH_HOME: DSH_HOME, DSH_SDK_MAX_RUNTIMES: "many" }),
    /positive integer/,
  );
});
