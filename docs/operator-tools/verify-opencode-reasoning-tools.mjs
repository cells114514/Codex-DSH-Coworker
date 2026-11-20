/**
 * Stub-level check of the OpenCode Go route configuration: does the configured
 * `thinkingFormat: deepseek` surface `reasoning_content`, and does the tool-call
 * loop work end to end through this route?
 *
 * This uses a local OpenAI-compatible stub instead of the real endpoint, so it
 * says nothing about Go's own behavior — it only proves the DSH/pi-ai wiring on
 * this profile handles those wire shapes.
 */
import { createServer } from "node:http";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";

const root = await mkdtemp(join(tmpdir(), "opencode-stub-"));
const target = join(root, "tool-target.txt");
await writeFile(target, "TOOL-FILE-CONTENT\n", "utf8");

const requests = [];
function push(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}
function base(extra) {
  return {
    id: "stub",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "deepseek-v4.1-flash",
    ...extra,
  };
}

const server = createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ count: requests.length, requests }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    const hasToolResult = (parsed.messages ?? []).some((message) => message.role === "tool");
    requests.push({
      index: requests.length + 1,
      hasToolResult,
      messageRoles: (parsed.messages ?? []).map((message) => message.role),
      reasoningEchoed: JSON.stringify(parsed.messages ?? []).includes("reasoning_content"),
      session: req.headers["x-opencode-session"] ?? null,
      model: parsed.model,
    });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    if (!hasToolResult) {
      // Round 1: reasoning content, then a tool call for `read`.
      push(res, base({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "checking the file first" }, finish_reason: null }] }));
      push(res, base({ choices: [{ index: 0, delta: { content: "Reading the file." }, finish_reason: null }] }));
      push(res, base({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_stub_1",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ file_path: target }) },
            }],
          },
          finish_reason: null,
        }],
      }));
      push(res, base({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    } else {
      // Round 2: final assistant text after the tool result.
      push(res, base({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
      push(res, base({ choices: [{ index: 0, delta: { content: "STUB-TOOL-OK" }, finish_reason: null }] }));
      push(res, base({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } }));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const overlay = join(root, "overlay.yml");
await mkdir(root, { recursive: true });
await writeFile(
  overlay,
  `- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        displayName: OpenCode Go (stub)
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1
        apiKeyEnv: OPENCODE_GO_API_KEY
        compat:
          thinkingFormat: deepseek
        models:
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash (stub)
`,
  "utf8",
);

const client = new HarnessClient({
  dshHome: process.env.DSH_HOME,
  profile: "sdk",
  patches: [overlay],
  initializeTimeoutMs: 60_000,
  shutdownTimeoutMs: 5_000,
});

const sessionId = "99999999-8888-4777-8666-555555555555";
const events = [];

try {
  client.start();
  await client.initialize({ cwd: root, provider: "opencode-go", model: "deepseek-v4.1-flash" });
  const sub = client.subscribeSessionTree(sessionId);
  const messageId = await client.prompt(sessionId, [
    { type: "text", text: "Read tool-target.txt and tell me what it contains." },
  ]);

  const deadline = Date.now() + 60_000;
  let finalText = "";
  while (Date.now() < deadline) {
    const next = await Promise.race([
      sub.next().then((value) => ({ value })).catch((error) => ({ error: String(error?.message ?? error) })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(0, deadline - Date.now()))),
    ]);
    if (next.timeout || next.error) break;
    const { method, params } = next.value;
    const event = params?.event;
    if (method === "session.event" && event !== undefined) {
      events.push({ type: event.type, keys: event.data !== null && typeof event.data === "object" ? Object.keys(event.data) : [] });
      if (event.type === "assistant/message") {
        const content = event.data?.message?.content ?? [];
        finalText = content.filter((block) => block?.type === "text").map((block) => block.text).join("");
      }
      if (event.type === "turn/end") break;
    }
  }
  sub.close();

  const captured = await (await fetch(`http://127.0.0.1:${port}/`)).json();
  const fileText = await readFile(target, "utf8");
  console.log(
    JSON.stringify(
      {
        phase: "stub-turn",
        messageIdPrefix: typeof messageId === "string" ? `${messageId.slice(0, 8)}…` : messageId,
        finalText,
        fileReadToolRan: captured.requests.length >= 2 && captured.requests[1].hasToolResult === true,
        requests: captured.requests,
        reasoningParsedIntoChunks: events.some((event) => JSON.stringify(event).toLowerCase().includes("reason")),
        reasoningEchoedBackToProvider: captured.requests.some((request) => request.reasoningEchoed === true),
        eventTypes: [...new Set(events.map((event) => event.type))],
        toolTargetUnchanged: fileText === "TOOL-FILE-CONTENT\n",
      },
      null,
      2,
    ),
  );
} finally {
  await client.close().catch(() => undefined);
  server.close();
}
