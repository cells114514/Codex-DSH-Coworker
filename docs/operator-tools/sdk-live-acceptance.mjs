#!/usr/bin/env node
/**
 * SDK backend live acceptance driver (Windows-first, operator supervised).
 *
 * Every scenario goes through the real MCP bridge (`dist/index.js`) over stdio,
 * exactly like a caller would. Nothing here fakes a model turn: when the
 * provider rejects the credential, the affected scenario is reported BLOCKED and
 * the model-dependent scenarios are not run at all.
 *
 * Usage:
 *   npm run build
 *   node docs/operator-tools/sdk-live-acceptance.mjs --stages L1,L2,L3
 *
 * Options:
 *   --stages L1,L2,...     stages to run (default L1,L2,L3)
 *   --home <dir>           SDK home supplied by the operator (default: a throwaway temp home)
 *   --work <dir>           workspace used for L1 (default: a throwaway temp workspace)
 *   --work-two <dir>       second workspace for L6 (default: a throwaway temp workspace)
 *   --bridge-home <dir>    bridge home (default: under the SDK home)
 *   --time-limit <sec>     overall wall-clock limit (informational; default 900)
 *   --stage-limit <sec>    per-scenario limit (default 240)
 *   --max-model-calls <n>  hard cap on prompts sent to a model (default 6)
 *   --interaction-policy <deny|allow>  answer for runtime approvals/questions (default deny)
 *   --no-cleanup           keep script-owned temp directories
 *   --json-out <path>      also write the machine-readable result there
 *
 * Exit code: 0 only when every requested stage is PASS. BLOCKED, FAIL and
 * NOT_RUN are failures: nothing here upgrades a blocked scenario to a pass.
 */

import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createInterface } from "node:readline";
import { stat } from "node:fs/promises";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PASSTHROUGH_ENV = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];

const TERMINAL_EXECUTIONS = new Set(["turn_completed", "failed", "interrupted", "canceled"]);

function parseArgs(argv) {
  const options = {
    stages: ["L1", "L2", "L3"],
    home: undefined,
    work: undefined,
    workTwo: undefined,
    bridgeHome: undefined,
    timeLimitSec: 900,
    stageLimitSec: 240,
    maxModelCalls: 6,
    provider: undefined,
    model: undefined,
    interactionPolicy: "deny",
    killOwnedRuntime: false,
    cleanup: true,
    jsonOut: undefined,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--stages":
        options.stages = next().toUpperCase().split(",").map((item) => item.trim()).filter(Boolean);
        break;
      case "--home":
        options.home = expandShellPath(next(), "--home");
        break;
      case "--work":
        options.work = expandShellPath(next(), "--work");
        break;
      case "--work-two":
        options.workTwo = expandShellPath(next(), "--work-two");
        break;
      case "--bridge-home":
        options.bridgeHome = expandShellPath(next(), "--bridge-home");
        break;
      case "--time-limit":
        options.timeLimitSec = Number(next());
        break;
      case "--stage-limit":
        options.stageLimitSec = Number(next());
        break;
      case "--max-model-calls":
        options.maxModelCalls = Number(next());
        break;
      case "--provider":
        options.provider = next();
        break;
      case "--model":
        options.model = next();
        break;
      case "--interaction-policy": {
        const policy = next();
        if (policy !== "deny" && policy !== "allow" && policy !== "ask") {
          throw new Error("--interaction-policy must be deny, allow or ask");
        }
        options.interactionPolicy = policy;
        break;
      }
      case "--kill-owned-runtime":
        options.killOwnedRuntime = true;
        break;
      case "--no-cleanup":
        options.cleanup = false;
        break;
      case "--json-out":
        options.jsonOut = expandShellPath(next(), "--json-out");
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  if (!Number.isFinite(options.timeLimitSec) || options.timeLimitSec <= 0) throw new Error("--time-limit must be positive");
  if (!Number.isFinite(options.stageLimitSec) || options.stageLimitSec <= 0) throw new Error("--stage-limit must be positive");
  if (!Number.isInteger(options.maxModelCalls) || options.maxModelCalls < 0) {
    throw new Error("--max-model-calls must be an integer >= 0");
  }
  return options;
}

/**
 * Expand a path value that arrived from a shell that did not expand it.
 *
 * cmd passes `$env:USERPROFILE\...` through literally, PowerShell passes
 * `%USERPROFILE%\...` through literally; both are common copy/paste mistakes, so
 * both forms are expanded here and an unknown variable is refused by name.
 */
function expandShellPath(value, flag) {
  let out = value;
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => {
    const found = process.env[name];
    if (found === undefined) throw new Error(`${flag}: environment variable ${name} is not set`);
    return found;
  });
  out = out.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (match, name) => {
    const found = process.env[name];
    if (found === undefined) throw new Error(`${flag}: environment variable ${name} is not set`);
    return found;
  });
  if (/\$[A-Za-z_][A-Za-z0-9_]*/.test(out)) {
    throw new Error(`${flag}: ${value} looks like an unexpanded shell variable; quote a real path instead`);
  }
  return resolve(out);
}

/** Short, non-reversible label for logs: never print a real task/session id. */
function redactId(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const tail = value.replace(/[^a-z0-9]/gi, "").slice(-4);
  return `${value.startsWith("dsh_") ? "task" : "session"}…${tail}`;
}

/**
 * Failure class of a live turn, computed from the runtime's own error code and
 * message. The message is classified, never echoed verbatim into the report.
 */
function classifyFailure(code, message) {
  const text = `${String(code ?? "")} ${String(message ?? "")}`.toLowerCase();
  if (/account_sign_in_required|account_token_invalid|account_token/.test(text)) return "provider_account_sign_in_required";
  if (/\b401\b|auth/.test(text)) return "provider_auth_rejected";
  if (/credential|api key|no api key/.test(text)) return "provider_credential_missing";
  if (/capacity/.test(text)) return "runtime_capacity";
  if (/unsupported/.test(text)) return "unsupported_capability";
  if (/timeout|timed out/.test(text)) return "timeout";
  return "other";
}

/**
 * Terminal turn error from observed events, without prompt or reply text.
 *
 * The coordination ledger digest keeps the turn-end kind as a string and the
 * structured reason under `data.reason`, so both shapes are read here.
 */
function turnError(events) {
  for (const record of [...events].reverse()) {
    const digest = record.digest ?? {};
    const type = digest.eventType ?? record.type;
    if (type !== "turn/end") continue;
    const structured =
      typeof digest.reason === "object" && digest.reason !== null ? digest.reason : digest.data?.reason ?? {};
    const code = structured?.error?.code ?? structured?.kind ?? (typeof digest.reason === "string" ? digest.reason : null);
    const message = typeof structured?.error?.message === "string" ? structured.error.message : "";
    return { code, message: message.slice(0, 200) };
  }
  return null;
}

class Bridge {
  constructor(options) {
    this.options = options;
    this.client = undefined;
    this.transport = undefined;
    this.pid = undefined;
    this.modelCalls = 0;
  }

  childEnv(home, bridgeHome) {
    const env = {};
    for (const key of PASSTHROUGH_ENV) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return {
      ...env,
      DSH_HOST_PROTOCOL: "sdk",
      DSH_HOME: home,
      DSH_BRIDGE_HOME: bridgeHome,
      DSH_SDK_IDLE_TIMEOUT_MS: "0",
      DSH_REQUEST_TIMEOUT_MS: String(this.options.stageLimitSec * 1_000),
      ...(this.options.provider === undefined ? {} : { DSH_SDK_PROVIDER: this.options.provider }),
      ...(this.options.model === undefined ? {} : { DSH_SDK_MODEL: this.options.model }),
    };
  }

  async start({ home, bridgeHome, repo }) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(repo, "dist", "index.js")],
      env: this.childEnv(home, bridgeHome),
      stderr: "pipe",
    });
    const client = new Client({ name: "sdk-live-acceptance", version: "0.0.0" }, { capabilities: {} });
    const began = Date.now();
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
    this.pid = transport.pid;
    return Date.now() - began;
  }

  async call(name, args) {
    const began = Date.now();
    const result = await this.client.callTool({ name, arguments: args });
    const text = result?.content?.find((item) => item.type === "text")?.text ?? "{}";
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { unparsed: true };
    }
    return { ms: Date.now() - began, isError: result.isError === true, body };
  }

  async prompt(name, args) {
    // Hard budget: no retries, no automatic rerun of the suite. Exceeding the
    // budget ends the run rather than quietly spending more model calls.
    if (this.modelCalls >= this.options.maxModelCalls) {
      throw new Error(`model call budget exhausted (--max-model-calls ${this.options.maxModelCalls})`);
    }
    this.modelCalls += 1;
    return this.call(name, args);
  }

  async close() {
    try {
      await this.client?.close();
    } catch {
      // Closing a stdio transport whose child already exited throws; expected.
    }
    this.client = undefined;
  }
}

/** Poll status until a terminal execution, an interaction, or the bound. */
async function waitTerminal(bridge, taskId, boundMs, handleInteractions) {
  const began = Date.now();
  let last = {};
  let firstVisibleOutputMs = null;
  let interruptedSightings = 0;
  while (Date.now() - began < boundMs) {
    const status = await bridge.call("dsh_status", { taskId });
    last = status.body;
    if (firstVisibleOutputMs === null && (last.cursor ?? 0) > 0) firstVisibleOutputMs = Date.now() - began;
    if (Array.isArray(last.pendingInteractions) && last.pendingInteractions.length > 0) {
      await handleInteractions(last);
      continue;
    }
    // `interrupted` can be a momentary derivation while a fresh turn's first
    // events are still arriving, so it needs two consecutive sightings.
    if (last.execution === "interrupted") {
      interruptedSightings += 1;
      if (interruptedSightings >= 2) {
        return { status: last, elapsedMs: Date.now() - began, firstVisibleOutputMs, timedOut: false };
      }
    } else {
      interruptedSightings = 0;
      if (last.execution === "turn_completed" || last.execution === "failed" || last.execution === "canceled") {
        return { status: last, elapsedMs: Date.now() - began, firstVisibleOutputMs, timedOut: false };
      }
    }
    await new Promise((done) => setTimeout(done, 300));
  }
  return { status: last, elapsedMs: Date.now() - began, firstVisibleOutputMs, timedOut: true };
}

/** One shared line reader for `--interaction-policy ask`; never used otherwise. */
function askOperator(promptText) {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      rl.close();
      done(value);
    };
    const timer = setTimeout(() => finish(""), 180_000);
    rl.question(promptText, (answer) => {
      clearTimeout(timer);
      finish(answer.trim());
    });
    rl.on("close", () => {
      clearTimeout(timer);
      finish("");
    });
  });
}

/**
 * Answer pending interactions.
 *
 * `deny`  — reject approvals, decline questions (default; never auto-approves).
 * `allow` — allow_once for approvals, placeholder answer for questions.
 * `ask`   — print the request on stderr and wait for the operator; an empty
 *           answer, a non-interactive stdin or the bound falls back to reject,
 *           so a missing human can never turn into an approval.
 */
function interactionHandler(bridge, policy, record) {
  return async (status) => {
    for (const pending of status.pendingInteractions ?? []) {
      // Pending entries are envelopes: { type: "server-request", rpcId, method,
      // payload: { type: "approval/requested" | "question/requested", ... } }.
      const payload = pending.payload ?? pending;
      const requestId = pending.rpcId ?? pending.requestId ?? payload.requestId ?? payload.approvalId;
      if (typeof requestId !== "string") continue;
      const kind = payload.type ?? pending.type;
      const isApproval = kind === "approval/requested" || pending.method === "approval/request";
      if (isApproval) {
        const summary = JSON.stringify({
          tool: payload.toolName ?? null,
          call: payload.callId ?? null,
          reason: typeof payload.reason === "string" ? payload.reason.slice(0, 200) : null,
        }).slice(0, 300);
        let outcome = policy === "allow" ? "allow_once" : "reject";
        let asked = false;
        if (policy === "ask") {
          asked = true;
          process.stderr.write(
            `\n[approval] task=${redactId(status.taskId)} request=${redactId(requestId)}\n${summary}\n` +
              "allowing grants the full escalation above, not one file; rejecting keeps the sandbox as is\n",
          );
          const answer = await askOperator("allow this request? type allow_once or reject [default reject]: ");
          outcome = answer === "allow_once" || answer === "allow" ? "allow_once" : "reject";
        }
        const answered = await bridge.call("dsh_resolve_approval", { taskId: status.taskId, requestId, outcome });
        record.push({ kind: "approval", policy, asked, outcome, accepted: answered.body?.accepted === true });
      } else {
        const questions = Array.isArray(payload.questions) ? payload.questions : [];
        const questionId = String(questions[0]?.id ?? requestId);
        const text = String(questions[0]?.question ?? questions[0]?.prompt ?? questions[0]?.header ?? "").slice(0, 300);
        let custom = "skipped by the acceptance driver";
        let asked = false;
        if (policy === "ask") {
          asked = true;
          process.stderr.write(`\n[question] task=${redactId(status.taskId)} request=${redactId(requestId)}\n${text}\n`);
          const answer = await askOperator("your answer (empty = decline) : ");
          if (answer !== "") custom = answer;
        }
        const answered = await bridge.call("dsh_answer_question", {
          taskId: status.taskId,
          requestId,
          answers: [{ id: questionId, selected: [], custom }],
        });
        record.push({ kind: "question", policy, asked, answeredWith: custom.length, accepted: answered.body?.accepted === true });
      }
    }
    await new Promise((done) => setTimeout(done, 200));
  };
}

/** One-line, secret-free summary of a rejected tool call. */
function summarizeCall(call) {
  const body = call?.body ?? {};
  const code = body?.error?.code ?? body?.code ?? body?.reason ?? body?.unparsed === true ? body?.error?.code ?? "unparsed" : body?.error?.code;
  const status = body?.error?.status ?? body?.status;
  const message = String(body?.error?.message ?? body?.message ?? "").slice(0, 160);
  return [code ?? "unknown", status === undefined ? undefined : `status ${String(status)}`, message === "" ? undefined : message]
    .filter((part) => part !== undefined)
    .join(" | ");
}

function succeeded(terminal) {
  return (
    terminal.status.execution === "turn_completed" &&
    typeof terminal.status.finalMessage === "string" &&
    terminal.status.finalMessage.length > 0 &&
    terminal.status.finalMessageStatus === "available"
  );
}

export async function run(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  const repo = resolve(process.cwd());
  const startedAt = new Date();
  const owned = [];
  const stages = [];
  const record = (id, verdict, detail) => {
    stages.push({ id, verdict, ...detail });
  };
  let bridge;
  let exitCode = 1;

  let secondTaskId;
  const home = options.home ?? (await ownedDir("sdk-accept-home-", owned));
  const bridgeHome = options.bridgeHome ?? join(home, "codex-bridge-sdk");
  const work = options.work ?? (await ownedDir("sdk-accept-work-", owned));
  const workTwo =
    options.workTwo ??
    (options.stages.includes("L6") || options.stages.includes("L7")
      ? await ownedDir("sdk-accept-work2-", owned)
      : undefined);
  // Each stage that delegates its own task needs its own workspace: the first
  // task holds a workspace claim, so reusing it fails before any prompt.
  const workL4 = options.stages.includes("L4") ? await ownedDir("sdk-accept-l4-", owned) : undefined;
  const workL5 = options.stages.includes("L5") ? await ownedDir("sdk-accept-l5-", owned) : undefined;

  try {
    await mkdir(home, { recursive: true });
    await mkdir(work, { recursive: true });
    if (workTwo !== undefined) await mkdir(workTwo, { recursive: true });
    if (workL4 !== undefined) await mkdir(workL4, { recursive: true });
    if (workL5 !== undefined) await mkdir(workL5, { recursive: true });

    bridge = new Bridge(options);
    const connectMs = await bridge.start({ home, bridgeHome, repo });
    const host = await bridge.call("dsh_host_status", {});
    if (host.body.backend !== "sdk") {
      record("L0", "FAIL", { evidence: "live", reason: `backend is ${String(host.body.backend)} instead of sdk` });
      return 1;
    }

    // ---------------- L1 ----------------
    const l1Began = Date.now();
    const delegated = await bridge.prompt("dsh_delegate", {
      prompt: "Reply with exactly this single line and nothing else: SDK-LIVE-OK",
      cwd: work,
    });
    const taskId = typeof delegated.body.taskId === "string" ? delegated.body.taskId : undefined;
    const sessionId = typeof delegated.body.rootSessionId === "string" ? delegated.body.rootSessionId : undefined;
    const interactions = [];
    const terminal = taskId === undefined
      ? { status: {}, elapsedMs: 0, firstVisibleOutputMs: null, timedOut: true }
      : await waitTerminal(bridge, taskId, options.stageLimitSec * 1_000, interactionHandler(bridge, options.interactionPolicy, interactions));
    const tail = taskId === undefined ? { body: { events: [] } } : await bridge.call("dsh_tail", { taskId, maxEvents: 200 });
    const failure = turnError(tail.body.events ?? []);
    const l1Detail = {
      evidence: "live",
      elapsedMs: Date.now() - l1Began,
      timing: {
        // Cold path: spawning the runtime, the initialize handshake, and the
        // prompt receipt are one measured span here; this is not a model time.
        mcpConnectMs: connectMs,
        delegateTotalMs: delegated.ms,
        // First status poll that observed any ledger cursor growth. A lower
        // bound, not a true first-token latency.
        firstObservedEventMs: terminal.firstVisibleOutputMs,
        taskTerminalMs: terminal.elapsedMs,
      },
      execution: terminal.status.execution ?? null,
      finalMessageStatus: terminal.status.finalMessageStatus ?? null,
      finalMessageLength: typeof terminal.status.finalMessage === "string" ? terminal.status.finalMessage.length : 0,
      runtimeState: terminal.status.runtime?.state ?? null,
      observationComplete: terminal.status.observation?.complete ?? null,
      timedOut: terminal.timedOut,
      turnErrorCode: failure?.code ?? null,
      task: redactId(taskId),
      session: redactId(sessionId),
    };
    if (succeeded(terminal)) {
      record("L1", "PASS", l1Detail);
    } else if (failure !== null) {
      const failureClass = classifyFailure(failure.code, failure.message);
      record("L1", failureClass.startsWith("provider_") ? "BLOCKED" : "FAIL", {
        ...l1Detail,
        failureClass,
        failureMessageClassified: failure.message.length > 0,
      });
    } else {
      record("L1", "FAIL", { ...l1Detail, reason: "no terminal state within the stage bound" });
    }

    const l1Verdict = stages.find((item) => item.id === "L1")?.verdict;
    if (l1Verdict !== "PASS") {
      for (const id of ["L2", "L3", "L4", "L5", "L6", "L7"]) {
        if (options.stages.includes(id)) {
          record(id, "BLOCKED", {
            evidence: "live",
            reason: `L1 did not produce a successful assistant reply (${String(l1Verdict)}); model-dependent scenarios were not attempted`,
          });
        }
      }
      return 1;
    }
    if (taskId === undefined || sessionId === undefined) return 1;

    // ---------------- L2 ----------------
    if (options.stages.includes("L2")) {
      const marker = `MARK${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const remember = await bridge.prompt("dsh_followup", {
        taskId,
        prompt: `Remember this token for the rest of this session: ${marker}. Acknowledge with one short sentence.`,
        mode: "queue",
      });
      const rememberTurn = await waitTerminal(bridge, taskId, options.stageLimitSec * 1_000, interactionHandler(bridge, options.interactionPolicy, interactions));
      const recall = await bridge.prompt("dsh_followup", {
        taskId,
        prompt: "Without repeating the token, state whether you still remember the token I asked you to remember.",
        mode: "queue",
      });
      const recallTurn = await waitTerminal(bridge, taskId, options.stageLimitSec * 1_000, interactionHandler(bridge, options.interactionPolicy, interactions));
      const status = await bridge.call("dsh_status", { taskId });
      const sameSession = status.body.rootSessionId === sessionId;
      const ok =
        rememberTurn.status.execution === "turn_completed" &&
        recallTurn.status.execution === "turn_completed" &&
        typeof recallTurn.status.finalMessage === "string" &&
        recallTurn.status.finalMessage.length > 0 &&
        sameSession;
      record("L2", ok ? "PASS" : "FAIL", {
        evidence: "live",
        sameSession,
        rememberReceiptMs: remember.ms,
        recallReceiptMs: recall.ms,
        recallFirstObservedEventMs: recallTurn.firstVisibleOutputMs,
        recallTerminalMs: recallTurn.elapsedMs,
        markerRedacted: redactId(marker),
        recallFinalLength: typeof recallTurn.status.finalMessage === "string" ? recallTurn.status.finalMessage.length : 0,
      });
    }

    // ---------------- L3 ----------------
    if (options.stages.includes("L3")) {
      const shutdownBegan = Date.now();
      await bridge.close();
      const shutdownMs = Date.now() - shutdownBegan;
      const runtimeRecords = await readdir(join(bridgeHome, "runtimes")).catch(() => []);
      bridge = new Bridge(options);
      const reconnectMs = await bridge.start({ home, bridgeHome, repo });
      const resumed = await bridge.prompt("dsh_followup", {
        taskId,
        prompt: "Reply with one short sentence confirming we are continuing the same session.",
        mode: "queue",
      });
      const terminalAfterResume = await waitTerminal(bridge, taskId, options.stageLimitSec * 1_000, interactionHandler(bridge, options.interactionPolicy, interactions));
      const status = await bridge.call("dsh_status", { taskId });
      const ok =
        runtimeRecords.length >= 1 &&
        terminalAfterResume.status.execution === "turn_completed" &&
        status.body.rootSessionId === sessionId &&
        (status.body.observation?.complete ?? false) === true;
      record("L3", ok ? "PASS" : "FAIL", {
        evidence: "live",
        cleanShutdownMs: shutdownMs,
        reconnectMs,
        resumeReceiptMs: resumed.ms,
        resumeTerminalMs: terminalAfterResume.elapsedMs,
        runtimeRecords: runtimeRecords.length,
        observationComplete: status.body.observation?.complete ?? null,
        execution: terminalAfterResume.status.execution ?? null,
      });
    }

    // ---------------- L4 / L5 ----------------
    if (options.stages.includes("L4")) {
      const asked = [];
      const handler = interactionHandler(bridge, options.interactionPolicy, asked);
      const began = Date.now();
      const delegatedQuestion = await bridge.prompt("dsh_delegate", {
        prompt:
          "Use the ask_user_question tool exactly once to ask me which single colour I prefer, offering exactly these options: red, blue, green. Wait for my answer, then reply with one short sentence naming my choice.",
        cwd: workL4 ?? work,
      });
      const questionTask = typeof delegatedQuestion.body.taskId === "string" ? delegatedQuestion.body.taskId : undefined;
      const questionDelegateError = questionTask === undefined ? summarizeCall(delegated) : undefined;
      const questionTerminal = questionTask === undefined
        ? { status: {}, elapsedMs: 0, timedOut: true }
        : await waitTerminal(bridge, questionTask, options.stageLimitSec * 1_000, handler);
      const questionSeen = asked.filter((item) => item.kind === "question");
      const questionAnswered = questionSeen.some((item) => item.answeredWith > 0 && item.accepted === true);
      const questionOk = questionSeen.length > 0 && questionTerminal.status.execution === "turn_completed";
      record("L4", questionOk ? "PASS" : questionSeen.length > 0 ? "FAIL" : "NOT_RUN", {
        evidence: "live",
        elapsedMs: Date.now() - began,
        policy: options.interactionPolicy,
        questions: questionSeen.length,
        operatorAnswered: questionAnswered,
        execution: questionTerminal.status.execution ?? null,
        answerLength: typeof questionTerminal.status.finalMessage === "string" ? questionTerminal.status.finalMessage.length : 0,
        task: redactId(questionTask),
        delegateError: questionDelegateError,
        reason:
          questionDelegateError !== undefined
            ? `dsh_delegate was rejected before a turn started (${questionDelegateError}); nothing was retried`
            : questionSeen.length === 0
              ? "the model did not call ask_user_question in this turn; the driver does not re-prompt to force it"
              : undefined,
      });
    }

    if (options.stages.includes("L5")) {
      const approvals = [];
      const handler = interactionHandler(bridge, options.interactionPolicy, approvals);
      const began = Date.now();
      // `workspace-write` auto-allows anything inside the workspace, so the
      // trigger has to be an out-of-workspace write: that is what raises a
      // sandbox-escalation approval.
      const approvalTarget = join(tmpdir(), `sdk-l5-approval-${Date.now().toString(36)}.txt`);
      const delegatedApproval = await bridge.prompt("dsh_delegate", {
        prompt:
          `Use the pwsh tool to write the exact text APPROVAL-OK into this one file: ${approvalTarget}\n` +
          "Use exactly that path and no other. Then reply with one short sentence saying whether the write succeeded.",
        cwd: workL5 ?? work,
      });
      const approvalTask = typeof delegatedApproval.body.taskId === "string" ? delegatedApproval.body.taskId : undefined;
      const approvalDelegateError = approvalTask === undefined ? summarizeCall(delegatedApproval) : undefined;
      const approvalTerminal = approvalTask === undefined
        ? { status: {}, elapsedMs: 0, timedOut: true }
        : await waitTerminal(bridge, approvalTask, options.stageLimitSec * 1_000, handler);
      // The decision has to be observable in the filesystem: an allowed approval
      // writes the target, a rejected one leaves it absent.
      const targetWritten = await stat(approvalTarget).then(() => true).catch(() => false);
      await rm(approvalTarget, { force: true }).catch(() => undefined);
      const approvalSeen = approvals.filter((item) => item.kind === "approval");
      const allowed = approvalSeen.some((item) => item.outcome === "allow_once" && item.accepted === true);
      const approvalOk = approvalSeen.length > 0 && allowed === targetWritten;
      record("L5", approvalOk ? "PASS" : "NOT_RUN", {
        evidence: "live",
        elapsedMs: Date.now() - began,
        policy: options.interactionPolicy,
        approvals: approvalSeen.length,
        allowed,
        targetWritten,
        decisionConsistent: allowed === targetWritten,
        execution: approvalTerminal.status.execution ?? null,
        task: redactId(approvalTask),
        targetIsOutsideWorkspace: true,
        delegateError: approvalDelegateError,
        reason:
          approvalDelegateError !== undefined
            ? `dsh_delegate was rejected before a turn started (${approvalDelegateError}); nothing was retried`
            : approvalSeen.length === 0
              ? "the runtime auto-approved this command under its current sandbox policy, so no approval round trip occurred"
              : undefined,
      });
    }

    // ---------------- L6 ----------------
    if (options.stages.includes("L6")) {
      if (workTwo === undefined) {
        record("L6", "NOT_RUN", { evidence: "live", reason: "no second workspace was provided or created" });
      } else {
        const second = await bridge.prompt("dsh_delegate", {
          prompt: "Reply with exactly this single line and nothing else: SDK-TWO-OK",
          cwd: workTwo,
        });
        secondTaskId = typeof second.body.taskId === "string" ? second.body.taskId : undefined;
        const secondTerminal = secondTaskId === undefined
          ? { status: {}, elapsedMs: 0 }
          : await waitTerminal(bridge, secondTaskId, options.stageLimitSec * 1_000, interactionHandler(bridge, options.interactionPolicy, interactions));
        const firstStatus = await bridge.call("dsh_status", { taskId });
        const secondStatus = secondTaskId === undefined ? { body: {} } : await bridge.call("dsh_status", { taskId: secondTaskId });
        const firstTail = await bridge.call("dsh_tail", { taskId, maxEvents: 400 });
        const secondTail = secondTaskId === undefined ? { body: { events: [] } } : await bridge.call("dsh_tail", { taskId: secondTaskId, maxEvents: 400 });
        const firstBlob = JSON.stringify(firstTail.body.events ?? []);
        const secondBlob = JSON.stringify(secondTail.body.events ?? []);
        const hostStatus = await bridge.call("dsh_host_status", {});
        const runtimes = Array.isArray(hostStatus.body.sdk?.runtimes) ? hostStatus.body.sdk.runtimes : [];
        const distinctSessions = firstStatus.body.rootSessionId !== undefined && firstStatus.body.rootSessionId !== secondStatus.body.rootSessionId;
        const distinctTasks = secondTaskId !== undefined && secondTaskId !== taskId;
        const twoRuntimes = runtimes.length === 2;
        const bothTerminal = secondTerminal.status.execution === "turn_completed";
        const noCrossTalk = !firstBlob.includes("SDK-TWO-OK") && !secondBlob.includes("SDK-LIVE-OK");
        const ok = distinctTasks && distinctSessions && twoRuntimes && bothTerminal && noCrossTalk;
        record("L6", ok ? "PASS" : "FAIL", {
          evidence: "live",
          tasks: [redactId(taskId), redactId(secondTaskId)],
          distinctTasks,
          distinctSessions,
          activeRuntimes: runtimes.length,
          capacity: hostStatus.body.sdk?.maxRuntimes ?? null,
          bothTerminal,
          noCrossTalk,
          runtimeStates: runtimes.map((runtime) => runtime.state ?? null),
        });
      }
    }

    // ---------------- L7 ----------------
    if (options.stages.includes("L7")) {
      if (process.platform !== "win32") {
        record("L7", "NOT_RUN", { evidence: "live", reason: "the supervised kill helper is implemented for Windows only" });
      } else if (options.killOwnedRuntime !== true) {
        record("L7", "NOT_RUN", {
          evidence: "live",
          reason: "requires --kill-owned-runtime, because L7 stops one bridge-owned runtime process on purpose",
        });
      } else {
        if (secondTaskId === undefined) {
          // L7 needs a second live task so isolation is observable; create one
          // when L6 did not run in this invocation.
          if (workTwo === undefined) {
            record("L7", "NOT_RUN", { evidence: "live", reason: "no second workspace is available for the isolation task" });
          } else {
            const seeded = await bridge.prompt("dsh_delegate", {
              prompt: "Reply with exactly this single line and nothing else: SDK-TWO-OK",
              cwd: workTwo,
            });
            secondTaskId = typeof seeded.body.taskId === "string" ? seeded.body.taskId : undefined;
            if (secondTaskId !== undefined) {
              await waitTerminal(bridge, secondTaskId, options.stageLimitSec * 1_000, interactionHandler(bridge, options.interactionPolicy, interactions));
            }
          }
        }
        if (secondTaskId === undefined) {
          record("L7", "NOT_RUN", { evidence: "live", reason: "the isolation task could not be created" });
        } else {
        const childrenBefore = await listChildProcesses(bridge.pid);
        // The runtime serving the first task was created before the second task
        // existed, so it is the older of the two bridge-owned children.
        const candidates = childrenBefore
          .filter((child) => typeof child.commandLine === "string" && child.commandLine.includes("bin.js"))
          .sort((left, right) => String(left.creationDate).localeCompare(String(right.creationDate)));
        if (candidates.length !== 2) {
          const diagnostic = await describeProcessTree(bridge.pid);
          record("L7", "NOT_RUN", {
            evidence: "live",
            reason: `expected exactly two bridge-owned runtime children, found ${candidates.length}`,
            bridgePidType: typeof bridge.pid,
            bridgePidRedacted: typeof bridge.pid === "number" ? `pid…${String(bridge.pid).slice(-3)}` : null,
            diagnostic,
          });
        } else {
          const victim = candidates[0];
          // Only a bridge-owned child may be stopped: verify parent linkage.
          const victimOwned = childrenBefore.some((child) => child.processId === victim.processId);
          const survivorTask = secondTaskId;
          const killed = victimOwned && (await killProcess(victim.processId));
          // Give the bridge a bounded window to notice the transport loss; the
          // verdict still requires a degradation, not just a delay.
          let statusA = { body: {} };
          for (let attempt = 0; attempt < 20; attempt += 1) {
            statusA = await bridge.call("dsh_status", { taskId });
            const state = statusA.body.runtime?.state;
            const degradedNow =
              statusA.body.execution === "interrupted" ||
              statusA.body.execution === "failed" ||
              (statusA.body.observation?.complete ?? true) === false ||
              state === "crashed" ||
              state === "closed";
            if (degradedNow) break;
            await new Promise((done) => setTimeout(done, 500));
          }
          const refused = await bridge.call("dsh_followup", {
            taskId,
            prompt: "This follow-up must not be accepted.",
            mode: "queue",
          });
          const statusB = await bridge.call("dsh_status", { taskId: survivorTask });
          const followupB = await bridge.prompt("dsh_followup", {
            taskId: survivorTask,
            prompt: "Reply with one short sentence confirming you are still usable.",
            mode: "queue",
          });
          const terminalB = await waitTerminal(bridge, survivorTask, options.stageLimitSec * 1_000, interactionHandler(bridge, options.interactionPolicy, interactions));
          const degraded =
            statusA.body.execution === "interrupted" ||
            statusA.body.execution === "failed" ||
            (statusA.body.observation?.complete ?? true) === false ||
            statusA.body.runtime?.state === "crashed" ||
            statusA.body.runtime?.state === "closed";
          const followupBlocked = refused.isError === true || refused.body?.accepted === false || refused.body?.error !== undefined;
          const survivorOk =
            terminalB.status.execution === "turn_completed" &&
            typeof terminalB.status.finalMessage === "string" &&
            terminalB.status.finalMessage.length > 0;
          record("L7", killed && degraded && followupBlocked && survivorOk ? "PASS" : "FAIL", {
            evidence: "live",
            killedPidRedacted: typeof victim.processId === "number" ? `pid…${String(victim.processId).slice(-3)}` : null,
            killedOwnedChild: true,
            victimTask: redactId(taskId),
            survivorTask: redactId(survivorTask),
            victimExecution: statusA.body.execution ?? null,
            victimObservationComplete: statusA.body.observation?.complete ?? null,
            victimRuntimeState: statusA.body.runtime?.state ?? null,
            followupBlocked,
            followupReceipt: followupB.ms,
            survivorExecution: terminalB.status.execution ?? null,
            survivorReplyLength: typeof terminalB.status.finalMessage === "string" ? terminalB.status.finalMessage.length : 0,
          });
        }
        }
      }
    }

    return 0;
  } catch (error) {
    record("DRIVER", "FAIL", { evidence: "live", reason: String(error?.message ?? error).slice(0, 300) });
    return 1;
  } finally {
    try {
      await bridge?.close();
    } catch {
      // ignore
    }
    if (options.cleanup) {
      for (const dir of owned) {
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
      }
    }
    const report = {
      tool: "sdk-live-acceptance",
      date: startedAt.toISOString(),
      platform: process.platform,
      node: process.version,
      sdkHome: options.home === undefined ? "script-owned-throwaway" : "operator-supplied",
      bridgeHome: options.bridgeHome === undefined ? "default-under-sdk-home" : "operator-supplied",
      modelCalls: bridge?.modelCalls ?? 0,
      maxModelCalls: options.maxModelCalls,
      interactionPolicy: options.interactionPolicy,
      route: {
        provider: options.provider ?? "runtime-default",
        model: options.model ?? "runtime-default",
      },
      stages,
      verdict: stages.length > 0 && stages.every((item) => item.verdict === "PASS") ? "PASS" : "FAIL",
      note: "BLOCKED, FAIL and NOT_RUN all count as a failed acceptance; only PASS is a pass.",
    };
    const text = JSON.stringify(report, null, 2);
    process.stdout.write(`${text}\n`);
    if (options.jsonOut !== undefined) {
      await writeFile(options.jsonOut, `${text}\n`, "utf8").catch(() => undefined);
    }
    exitCode = report.verdict === "PASS" ? 0 : 1;
    process.exitCode = exitCode;
  }
}

/**
 * Bridge-owned child processes. Enumerated once and filtered client-side by
 * parent pid, so the result does not depend on a CIM query spelling, and never
 * matched by image name.
 */
async function listChildProcesses(parentPid) {
  if (typeof parentPid !== "number" || process.platform !== "win32") return [];
  const { execFile } = await import("node:child_process");
  const stdout = await new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress"],
      { windowsHide: true, maxBuffer: 1 << 24 },
      (error, out) => resolve(error ? "" : String(out)),
    );
  });
  const text = stdout.trim();
  if (text === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const all = Array.isArray(parsed) ? parsed : [parsed];
  return all
    .filter((entry) => Number(entry.ParentProcessId) === parentPid)
    .map((entry) => ({
      processId: Number(entry.ProcessId),
      creationDate: String(entry.CreationDate ?? ""),
      commandLine: String(entry.CommandLine ?? ""),
    }));
}

/** Structured, secret-free view of what the process query sees for a bridge pid. */
async function describeProcessTree(parentPid) {
  if (process.platform !== "win32") return { platform: process.platform };
  const { execFile } = await import("node:child_process");
  const stdout = await new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
      { windowsHide: true, maxBuffer: 1 << 24 },
      (error, out) => resolve(error ? `ERROR:${String(error.message).slice(0, 120)}` : String(out)),
    );
  });
  if (stdout.startsWith("ERROR:")) return { queryError: stdout };
  let all = [];
  try {
    const parsed = JSON.parse(stdout);
    all = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return { parseError: true, bytes: stdout.length };
  }
  const mine = all.filter((entry) => entry.ParentProcessId === parentPid);
  return {
    totalProcesses: all.length,
    childCount: mine.length,
    children: mine.map((entry) => ({
      pid: entry.ProcessId,
      hasBinJs: String(entry.CommandLine ?? "").includes("bin.js"),
      cmdHead: String(entry.CommandLine ?? "").slice(0, 80),
    })),
  };
}

/** Stop one process id the driver owns; refuses non-positive input. */
async function killProcess(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

async function ownedDir(prefix, owned) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  owned.push(dir);
  return dir;
}

const HELP_TEXT = `SDK backend live acceptance driver.

  npm run build
  node docs/operator-tools/sdk-live-acceptance.mjs [options]

  --stages L1,L2,...   scenarios to run (default L1,L2,L3)
  --home <dir>         SDK home to use; omit it to use a script-owned throwaway home
  --work <dir>         workspace for L1
  --work-two <dir>     second workspace for L6
  --bridge-home <dir>  bridge home (default: <home>/codex-bridge-sdk)
  --stage-limit <sec>  per-scenario bound (default 240)
  --max-model-calls n  model call budget (default 6)
  --provider <id>      DSH_SDK_PROVIDER for the runtime (default: runtime default)
  --model <id>         DSH_SDK_MODEL for the runtime (default: runtime default)
  --interaction-policy deny|allow|ask
                       approvals: reject (deny), allow_once (allow), or operator
                       input on stderr (ask; empty/closed/180s => reject).
                       NOTE: allow_once grants the whole escalation the runtime
                       asked for (often danger-full-access), not a fine-grained
                       permission on the named file
  --kill-owned-runtime  let L7 stop one runtime child of the bridge this run
                       started (parent pid verified; never by image name)
  --no-cleanup         keep script-owned temp directories
  --json-out <path>    write the report there as well

Nothing is printed that contains a prompt, a full reply, a credential, or a real
task/session id. Exit code 0 only when every requested stage is PASS.`;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await run(process.argv.slice(2));
  process.exit(code);
}
