#!/usr/bin/env node

import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CODEX_LEGACY_SERVER_NAMES,
  CODEX_RESTART_HINT,
  CODEX_SERVER_NAME,
  codexIntegration,
  extractBridgeConfig,
  hasBridgeConfig,
  renderCodexOperation,
  renderSdkConfigReview,
  sdkMcpEnv,
  upsertMcpConfig,
  verifyCodexMcpBlock,
} from "./codex-integration.js";
import type { SdkRenderConfig } from "./codex-integration.js";
import {
  installCodexSkill,
  prepareCodexSkillInstall,
  resolveCodexSkillTarget,
} from "./codex-skill-install.js";
import type { InstallPlan, UpsertMcpServerOperation } from "./caller-integration.js";
import { loadConfig, loadSdkConfig } from "./config.js";
import { createDshApi } from "./dsh-api-factory.js";
import { probeDshCliVersion, runDoctor, SDK_ONLY_DOCTOR_API } from "./doctor.js";
import { atomicInstallText, readConfigSnapshot } from "./setup-engine.js";
import type { ConfigSnapshot } from "./setup-engine.js";

const DEFAULT_HOST_URL = "http://127.0.0.1:3080";
const DEFAULT_PRESET = "code";
export type SetupHostMode = "static" | "desktop-auto";
export type SetupBackend = "legacy" | "gateway" | "sdk";

/**
 * SDK variables the installer forwards only when the user supplied them.
 * `DSH_HOME` and `DSH_SDK_PROFILE` are always written; everything here is opt-in.
 */
const OPTIONAL_SDK_ENV_KEYS = [
  "DSH_SDK_BIN",
  "DSH_SDK_PROVIDER",
  "DSH_SDK_MODEL",
  "DSH_SDK_REASONING_EFFORT",
  "DSH_SDK_MAX_RUNTIMES",
  "DSH_SDK_IDLE_TIMEOUT_MS",
  "DSH_SDK_INITIALIZE_TIMEOUT_MS",
  "DSH_SDK_SHUTDOWN_TIMEOUT_MS",
] as const;

export {
  CODEX_LEGACY_SERVER_NAMES as LEGACY_SERVER_NAMES,
  CODEX_SERVER_NAME as SERVER_NAME,
  codexIntegration,
  createCodexInstallPlan,
  defaultCodexConfigPath,
  extractBridgeConfig,
  hasBridgeConfig,
  renderCodexOperation,
  renderMcpConfig,
  renderSdkConfigReview,
  sdkMcpEnv,
  upsertMcpConfig,
  verifyCodexMcpConfig,
} from "./codex-integration.js";
export type { RenderMcpConfigOptions, SdkRenderConfig } from "./codex-integration.js";
export { readConfigSnapshot } from "./setup-engine.js";
export type { ConfigSnapshot } from "./setup-engine.js";
export {
  installCodexSkill,
  prepareCodexSkillInstall,
  resolveCodexSkillTarget,
} from "./codex-skill-install.js";
export type {
  CodexSkillFilePlan,
  CodexSkillInstallPlan,
  CodexSkillInstallResult,
} from "./codex-skill-install.js";

export interface SetupOptions {
  yes: boolean;
  replace: boolean;
  replaceSkill: boolean;
  noSkill: boolean;
  dryRun: boolean;
  skipDoctor: boolean;
  noPreset: boolean;
  desktopAuto: boolean;
  help: boolean;
  host?: string;
  preset?: string;
  configPath?: string;
  skillPath?: string;
  gateway?: boolean;
  /** Present only when the operator passed `--backend`. */
  backend?: SetupBackend;
  /** Present only when the operator passed `--dsh-home`. */
  dshHome?: string;
  /** Present only when the operator passed `--bridge-home`. */
  bridgeHome?: string;
  /** Present only when the operator passed `--sdk-profile`. */
  sdkProfile?: string;
  /** Present only when the operator passed `--sdk-bin`. */
  sdkBin?: string;
}

function valueAfter(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseBackend(value: string): SetupBackend {
  if (value === "legacy" || value === "gateway" || value === "sdk") return value;
  throw new Error(`--backend must be legacy, gateway, or sdk, received ${JSON.stringify(value)}`);
}

export function parseSetupArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SetupOptions {
  const options: SetupOptions = {
    yes: false,
    replace: false,
    replaceSkill: false,
    noSkill: false,
    dryRun: false,
    skipDoctor: false,
    noPreset: false,
    desktopAuto: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--yes" || argument === "-y") options.yes = true;
    else if (argument === "--replace") options.replace = true;
    else if (argument === "--replace-skill") options.replaceSkill = true;
    else if (argument === "--no-skill") options.noSkill = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--skip-doctor") options.skipDoctor = true;
    else if (argument === "--no-preset") options.noPreset = true;
    else if (argument === "--desktop-auto") options.desktopAuto = true;
    else if (argument === "--gateway") options.gateway = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--backend") {
      options.backend = parseBackend(valueAfter(argv, index, argument));
      index += 1;
    } else if (argument?.startsWith("--backend=")) options.backend = parseBackend(argument.slice("--backend=".length));
    else if (argument === "--host" || argument === "--host-url") {
      options.host = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--host=")) options.host = argument.slice("--host=".length);
    else if (argument?.startsWith("--host-url=")) options.host = argument.slice("--host-url=".length);
    else if (argument === "--preset") {
      options.preset = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--preset=")) options.preset = argument.slice("--preset=".length);
    else if (argument === "--config") {
      options.configPath = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--config=")) options.configPath = argument.slice("--config=".length);
    else if (argument === "--skill-path") {
      options.skillPath = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--skill-path=")) options.skillPath = argument.slice("--skill-path=".length);
    else if (argument === "--dsh-home") {
      options.dshHome = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--dsh-home=")) options.dshHome = argument.slice("--dsh-home=".length);
    else if (argument === "--bridge-home") {
      options.bridgeHome = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--bridge-home=")) options.bridgeHome = argument.slice("--bridge-home=".length);
    else if (argument === "--sdk-profile") {
      options.sdkProfile = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--sdk-profile=")) options.sdkProfile = argument.slice("--sdk-profile=".length);
    else if (argument === "--sdk-bin") {
      options.sdkBin = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument?.startsWith("--sdk-bin=")) options.sdkBin = argument.slice("--sdk-bin=".length);
    else throw new Error(`unknown option: ${argument}`);
  }

  const backend = options.backend ?? (options.gateway === true ? "gateway" : undefined);

  if (options.noPreset && options.preset !== undefined) {
    throw new Error("--preset and --no-preset cannot be used together");
  }
  if (options.gateway && options.backend !== undefined && options.backend !== "gateway") {
    throw new Error("--gateway and --backend cannot select different backends: use one of them");
  }
  // `--backend gateway` names the same opt-in backend as `--gateway`, so it keeps
  // the same requirement: an explicit Host origin or explicit Desktop discovery.
  if (backend === "gateway" && !options.desktopAuto && options.host === undefined) {
    throw new Error(
      `${options.gateway === true ? "--gateway" : "--backend gateway"} requires --desktop-auto or --host`,
    );
  }
  if (options.desktopAuto && options.host !== undefined) {
    throw new Error("--desktop-auto and --host cannot be used together");
  }
  if (options.noSkill && options.replaceSkill) {
    throw new Error("--replace-skill and --no-skill cannot be used together");
  }
  if (options.noSkill && options.skillPath !== undefined) {
    throw new Error("--skill-path and --no-skill cannot be used together");
  }

  if (backend === "sdk") {
    for (const [flag, present] of [
      ["--host/--host-url", options.host !== undefined],
      ["--desktop-auto", options.desktopAuto],
      ["--gateway", options.gateway === true],
    ] as const) {
      if (present) {
        throw new Error(
          `${flag} configures a DSH Host and cannot be combined with --backend sdk; the SDK backend uses no Host URL, Desktop discovery, or connect token`,
        );
      }
    }
    if (env.DSH_CONNECT_ORIGIN !== undefined || env.DSH_CONNECT_TOKEN_ENV !== undefined) {
      throw new Error(
        "DSH_CONNECT_ORIGIN/DSH_CONNECT_TOKEN_ENV configure the Gateway connect token and cannot be combined with --backend sdk; unset them for this installation",
      );
    }
    if (normalizePreset(options.preset) !== undefined) {
      throw new Error(
        "the SDK backend cannot select an agent preset because the runtime profile fixes composition; rerun with --no-preset (or omit --preset)",
      );
    }
  } else {
    for (const [flag, value] of [
      ["--dsh-home", options.dshHome],
      ["--sdk-profile", options.sdkProfile],
      ["--sdk-bin", options.sdkBin],
      ["--bridge-home", options.bridgeHome],
    ] as const) {
      if (value !== undefined) {
        throw new Error(`${flag} is an SDK backend setting; add --backend sdk or remove it`);
      }
    }
  }
  return options;
}

export interface InstallMcpConfigResult {
  changed: boolean;
  backupPath?: string;
}

export async function installMcpConfigFile(
  path: string,
  bridgeBlock: string,
  replace: boolean,
  expected?: ConfigSnapshot,
): Promise<InstallMcpConfigResult> {
  const snapshot = expected ?? (await readConfigSnapshot(path));
  if (verifyCodexMcpBlock(snapshot.content, bridgeBlock)) return { changed: false };

  const updated = upsertMcpConfig(snapshot.content, bridgeBlock, replace);
  const result = await atomicInstallText({
    path,
    content: updated,
    expected: snapshot,
    backupLabel: "dsh-agentlink",
    tempLabel: "dsh-agentlink",
    verify: (content) => verifyCodexMcpBlock(content, bridgeBlock),
  });
  return result;
}

function firstCodexOperation(plan: InstallPlan): UpsertMcpServerOperation {
  const operation = plan.operations[0];
  if (operation?.kind !== "upsert-mcp-server") throw new Error("Codex install plan is missing an MCP server operation");
  return operation;
}

export async function installCodexPlan(plan: InstallPlan, expected?: ConfigSnapshot): Promise<InstallMcpConfigResult> {
  const operation = firstCodexOperation(plan);
  const bridgeBlock = renderCodexOperation(operation);
  const snapshot = expected ?? (await readConfigSnapshot(plan.target.path));
  if (codexIntegration.verifyInstalled(snapshot.content, operation)) return { changed: false };

  const updated = upsertMcpConfig(snapshot.content, bridgeBlock, operation.replace);
  const result = await atomicInstallText({
    path: plan.target.path,
    content: updated,
    expected: snapshot,
    backupLabel: "dsh-agentlink",
    tempLabel: "dsh-agentlink",
    verify: (content) => codexIntegration.verifyInstalled(content, operation),
  });
  return result;
}

function normalizeHostUrl(raw: string): string {
  return loadConfig({ DSH_HOST_URL: raw, DSH_BRIDGE_TIME_ZONE: "UTC" }).hostUrl;
}

function normalizePreset(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === "" || value === "-") return undefined;
  if (/\r|\n|\0/.test(value)) throw new Error("preset must be a single line");
  return value;
}

export function validateDshCliSetupPrerequisite(
  hostMode: SetupHostMode,
  dshVersion: string | undefined,
): string | undefined {
  if (hostMode === "static" && dshVersion === undefined) {
    throw new Error("DSH CLI was not found. Install DSH and make sure `dsh --version` works before setup.");
  }
  return dshVersion;
}

export function validateDesktopAutoPlatform(hostMode: SetupHostMode, platform: NodeJS.Platform,
  hostProtocol: "legacy" | "gateway" = "legacy"): void {
  if (hostMode === "desktop-auto" && platform !== "win32" && !(platform === "darwin" && hostProtocol === "gateway")) {
    throw new Error(hostProtocol === "gateway" ? "official Gateway --desktop-auto is supported only on Windows or macOS"
      : "legacy --desktop-auto is supported only on Windows with DSH Desktop");
  }
}

async function askWithDefault(question: string, fallback: string): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question(`${question} [${fallback}]: `)).trim();
    return answer === "" ? fallback : answer;
  } finally {
    prompt.close();
  }
}

export function requireExplicitBridgeReplacement(existing: string, replace: boolean): void {
  if (hasBridgeConfig(existing) && !replace) {
    throw new Error(
      `${CODEX_SERVER_NAME} or legacy ${CODEX_LEGACY_SERVER_NAMES.join(", ")} already exists; inspect it and rerun with --replace to update it`,
    );
  }
}

/**
 * Translate only the operator's explicit SDK choices into the exact environment
 * an SDK-backend MCP server receives.
 *
 * The values are validated by the same loader the bridge uses, so a malformed
 * number or a half-supplied provider/model fails here instead of at runtime, and
 * nothing the operator did not pass is invented.
 */
export function planSdkSetup(
  options: Pick<SetupOptions, "dshHome" | "bridgeHome" | "sdkProfile" | "sdkBin">,
  env: NodeJS.ProcessEnv = process.env,
): SdkRenderConfig {
  const configuredHome = options.dshHome?.trim() || env.DSH_HOME?.trim();
  const dshHome = resolve(
    configuredHome === undefined || configuredHome === "" ? join(homedir(), ".dsh") : configuredHome,
  );
  const supplied: NodeJS.ProcessEnv = {};
  for (const key of OPTIONAL_SDK_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value.trim() !== "") supplied[key] = value;
  }
  const parsed = loadSdkConfig(supplied, dshHome);
  const profile = options.sdkProfile?.trim() || parsed.profile;
  const bin = options.sdkBin === undefined ? parsed.bin : resolve(options.sdkBin);
  const configuredBridgeHome = options.bridgeHome?.trim() || env.DSH_BRIDGE_HOME?.trim();
  return {
    dshHome,
    profile,
    ...(bin === undefined ? {} : { bin }),
    ...(supplied.DSH_SDK_PROVIDER === undefined ? {} : { provider: parsed.provider!, model: parsed.model! }),
    ...(parsed.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.reasoningEffort }),
    ...(supplied.DSH_SDK_MAX_RUNTIMES === undefined ? {} : { maxRuntimes: parsed.maxRuntimes }),
    ...(supplied.DSH_SDK_IDLE_TIMEOUT_MS === undefined ? {} : { idleTimeoutMs: parsed.idleTimeoutMs }),
    ...(supplied.DSH_SDK_INITIALIZE_TIMEOUT_MS === undefined
      ? {}
      : { initializeTimeoutMs: parsed.initializeTimeoutMs }),
    ...(supplied.DSH_SDK_SHUTDOWN_TIMEOUT_MS === undefined ? {} : { shutdownTimeoutMs: parsed.shutdownTimeoutMs }),
    ...(configuredBridgeHome === undefined || configuredBridgeHome === ""
      ? {}
      : { bridgeHome: resolve(configuredBridgeHome) }),
  };
}

function printHelp(): void {
  console.log(`dsh-Agentlink Codex setup

Usage:
  npm run setup
  npm run setup -- --yes
  npm run setup -- --backend sdk --yes --no-preset

Options:
  --backend <name>   legacy (default), gateway, or sdk
  --host <url>       DSH Web Host origin (default: ${DEFAULT_HOST_URL}); --host-url is an alias
  --desktop-auto     Discover an owned Desktop listener (official Gateway: Windows/macOS)
  --gateway          Opt in to official authenticated Gateway (requires --desktop-auto or --host)
  --preset <name>    DSH agent preset (default: ${DEFAULT_PRESET}); not available with --backend sdk
  --no-preset        Follow DSH's own default preset
  --dsh-home <dir>   SDK backend: DSH home (default: $DSH_HOME or ~/.dsh)
  --sdk-profile <n>  SDK backend: runtime profile (default: sdk)
  --sdk-bin <path>   SDK backend: dsh CLI module path (DSH_SDK_BIN), never a shell command
  --bridge-home <d>  Override the bridge home; without it each backend uses its own default
  --replace          Replace an existing ${CODEX_SERVER_NAME} configuration
  --replace-skill    Replace conflicting Codex skill files after reviewing them
  --no-skill         Skip repository-scoped Codex skill installation
  --skill-path <dir> Install the Codex skill into an explicit directory
  --config <path>    Write a specific Codex config file
  --dry-run          Print the generated block without writing (JSON for --backend sdk)
  --skip-doctor      Skip the read-only DSH Host check
  --yes, -y          Use defaults without interactive questions
  --help, -h         Show this help

The SDK backend needs no DSH Desktop or Gateway launcher and never receives a
Host URL, connect token, or model API key.`);
}

async function main(): Promise<void> {
  const options = parseSetupArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.yes && !stdin.isTTY) {
    throw new Error("interactive input is unavailable; rerun with --yes and explicit flags if needed");
  }

  const majorNodeVersion = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (majorNodeVersion < 22) throw new Error(`Node.js 22 or newer is required; detected ${process.versions.node}`);

  const backend: SetupBackend = options.backend ?? (options.gateway === true ? "gateway" : "legacy");
  const hostMode: SetupHostMode = options.desktopAuto ? "desktop-auto" : "static";
  if (backend !== "sdk") {
    validateDesktopAutoPlatform(hostMode, process.platform, backend === "gateway" ? "gateway" : "legacy");
  }
  // The SDK backend needs no `dsh --version` probe: its runtime comes from the
  // pinned client package, not from a locally installed CLI on PATH.
  const dshVersion =
    backend === "sdk"
      ? undefined
      : validateDshCliSetupPrerequisite(
          backend === "gateway" ? "desktop-auto" : hostMode,
          await probeDshCliVersion(),
        );
  let hostUrl: string | undefined;
  if (backend !== "sdk" && hostMode === "static") {
    const rawHost =
      options.host ?? (options.yes ? DEFAULT_HOST_URL : await askWithDefault("DSH Web Host", DEFAULT_HOST_URL));
    hostUrl = normalizeHostUrl(rawHost);
  }
  const rawPreset =
    backend === "sdk" || options.noPreset
      ? undefined
      : options.preset ??
        (options.yes ? DEFAULT_PRESET : await askWithDefault("DSH agent preset (`-` uses DSH default)", DEFAULT_PRESET));
  const preset = normalizePreset(rawPreset);
  const sdkPlan = backend === "sdk" ? planSdkSetup(options, process.env) : undefined;
  const configPath = resolve(options.configPath ?? codexIntegration.defaultConfigPath({ cwd: process.cwd(), env: process.env }));
  const entryPath = await realpath(fileURLToPath(new URL("./index.js", import.meta.url)));

  const createPlan = (replace: boolean): InstallPlan => {
    const common = {
      configPath,
      entryPath,
      nodePath: process.execPath,
      replace,
      ...(dshVersion === undefined ? {} : { dshVersion }),
      ...(preset === undefined ? {} : { preset }),
    };
    if (sdkPlan !== undefined) {
      return codexIntegration.createInstallPlan({ ...common, hostProtocol: "sdk", sdk: sdkPlan });
    }
    const hostFields = hostMode === "desktop-auto" ? { hostMode } : { hostUrl: hostUrl as string };
    return codexIntegration.createInstallPlan({
      ...common,
      ...(backend === "gateway" ? { hostProtocol: "gateway" as const } : {}),
      ...hostFields,
    });
  };

  let plan = createPlan(options.replace);
  let operation = firstCodexOperation(plan);
  let bridgeBlock = renderCodexOperation(operation);

  const snapshot = await readConfigSnapshot(configPath);
  const existing = snapshot.content;
  const replace = options.replace;
  if (operation.replace !== replace) {
    plan = createPlan(replace);
    operation = firstCodexOperation(plan);
    bridgeBlock = renderCodexOperation(operation);
  }

  const mcpAlreadyCurrent = codexIntegration.verifyInstalled(existing, operation);
  if (!mcpAlreadyCurrent) requireExplicitBridgeReplacement(existing, replace);
  const mcpContent = mcpAlreadyCurrent ? undefined : upsertMcpConfig(existing, bridgeBlock, replace);
  const skillPlan = options.noSkill
    ? undefined
    : await prepareCodexSkillInstall(resolveCodexSkillTarget(process.cwd(), options.skillPath), options.replaceSkill);

  if (options.dryRun) {
    if (sdkPlan !== undefined) {
      // Reviewable, redacted, and written nowhere: one JSON object with a stable key order.
      console.log(
        renderSdkConfigReview({
          serverName: operation.serverName,
          configPath: plan.target.path,
          command: operation.command,
          args: operation.args,
          env: { ...operation.env },
          warnings: [
            "dry run: no file was written; rerun without --dry-run after reviewing this object",
            ...plan.warnings,
          ],
        }),
      );
      return;
    }
    if (mcpContent === undefined) console.log(`# ${CODEX_SERVER_NAME} already matches ${plan.target.path}`);
    else console.log(`# Would update ${plan.target.path}\n\n${bridgeBlock}`);
    if (skillPlan === undefined) {
      console.log("# Codex skill installation is disabled (--no-skill)");
    } else {
      console.log(
        `# Would ${skillPlan.changed ? "install/update" : "keep"} Codex skill at ${skillPlan.targetPath}`,
      );
    }
    return;
  }

  if (mcpContent === undefined && (skillPlan === undefined || !skillPlan.changed)) {
    console.log(`${CODEX_SERVER_NAME} already matches this setup. No changes made.`);
    return;
  }

  let skillInstallation: Awaited<ReturnType<typeof installCodexSkill>> | undefined;
  if (skillPlan !== undefined) skillInstallation = await installCodexSkill(skillPlan);

  let installation: InstallMcpConfigResult;
  try {
    installation =
      mcpContent === undefined ? { changed: false } : await installCodexPlan(plan, snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (skillInstallation?.changed) {
      throw new Error(`Codex skill was installed, but MCP configuration failed: ${message}. Rerun setup after reviewing the config.`);
    }
    throw error;
  }

  if (installation.changed) console.log(`Configured ${CODEX_SERVER_NAME} in ${configPath}`);
  else console.log(`${CODEX_SERVER_NAME} already matches ${configPath}`);
  if (installation.backupPath !== undefined) console.log(`Backup: ${installation.backupPath}`);
  if (skillPlan === undefined) {
    console.log("Codex skill: skipped (--no-skill)");
  } else if (skillInstallation?.changed) {
    console.log(`Codex skill: installed at ${skillInstallation.targetPath}`);
    for (const backupPath of skillInstallation.backupPaths) console.log(`Codex skill backup: ${backupPath}`);
  } else {
    console.log(`Codex skill: already current at ${skillPlan.targetPath}`);
  }
  if (sdkPlan === undefined) {
    console.log(`DSH CLI: ${dshVersion ?? "not found (Desktop Host capability probe only)"}`);
    console.log(`DSH Host: ${hostMode === "desktop-auto" ? "DSH Desktop automatic loopback discovery" : hostUrl}`);
    console.log(`DSH agent preset (composition; not sandbox): ${preset ?? "Host default"}`);
  } else {
    console.log("DSH CLI: not required (the SDK runtime is loaded through @deepseek-ai/dsh-sdk-client)");
    console.log(
      "DSH backend: sdk (stdio JSON-RPC; no Desktop or Gateway launcher, one runtime per root task, closed by the bridge)",
    );
    console.log("DSH agent preset: not applicable (the SDK backend cannot select a preset)");
  }
  console.log("Approval policy: prompt (allow_once remains human-gated)");

  if (!options.skipDoctor) {
    if (sdkPlan === undefined) {
      const config = loadConfig({
        ...(backend === "gateway" ? { DSH_HOST_PROTOCOL: "gateway" } : {}),
        ...(hostMode === "desktop-auto" ? { DSH_HOST_MODE: hostMode } : { DSH_HOST_URL: hostUrl }),
        ...(dshVersion === undefined ? {} : { DSH_HOST_VERSION: dshVersion }),
        DSH_BRIDGE_TIME_ZONE: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(preset === undefined ? {} : { DSH_BRIDGE_AGENT_PRESET: preset }),
      });
      const report = await runDoctor(
        config,
        createDshApi(config),
        async () => dshVersion,
      );
      if (report.ok && "compatibility" in report) console.log(`Host check: ${report.compatibility}`);
      else if (backend === "gateway") {
        console.log("Host check: intentionally not probed; /connect creates an API Peer and requires separately authorized live validation");
      } else if (hostMode === "desktop-auto") {
        console.log("Host check: not connected; start DSH Desktop yourself and rerun `npm run doctor`");
      } else {
        console.log(
          `Host check: not connected; start it with ${"startCommand" in report ? report.startCommand : "the doctor start command"}`,
        );
      }
    } else {
      // Static only: no runtime is spawned, no prompt is sent, no session is resumed.
      const config = loadConfig(sdkMcpEnv(sdkPlan));
      const report = await runDoctor(config, SDK_ONLY_DOCTOR_API, async () => undefined);
      console.log(
        report.ok
          ? "SDK check: configuration, client package, and runtime records look usable"
          : "SDK check: problems found; run `DSH_HOST_PROTOCOL=sdk npm run doctor -- --probe-sdk` for one bounded live handshake",
      );
    }
  }

  console.log(CODEX_RESTART_HINT);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
