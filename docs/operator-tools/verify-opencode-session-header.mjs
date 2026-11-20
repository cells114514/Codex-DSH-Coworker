/**
 * Verify the OpenCode Go session header contract without spending real requests:
 * a local OpenAI-compatible stub records the headers pi-ai sends, and the real
 * profile is used except for one overlay that points the route at the stub.
 */
import { createServer } from "node:http";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";

const requests = [];

function sse(res, chunks) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ captured: requests }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    requests.push({ url: req.url, headers: req.headers, bodyBytes: body.length });
    // One assistant turn: role, a short token, stop.
    sse(res, [
      {
        id: "stub-1",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "deepseek-v4.1-flash",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      },
      {
        id: "stub-1",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "deepseek-v4.1-flash",
        choices: [{ index: 0, delta: { content: "stub-ack" }, finish_reason: null }],
      },
      {
        id: "stub-1",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "deepseek-v4.1-flash",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      },
    ]);
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const root = await mkdtemp(join(tmpdir(), "opencode-header-"));
const overlay = join(root, "stub-overlay.yml");
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

const home = process.env.DSH_HOME;
const client = new HarnessClient({
  dshHome: home,
  profile: "sdk",
  patches: [overlay],
  initializeTimeoutMs: 60_000,
  shutdownTimeoutMs: 5_000,
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  client.start();
  const initialized = await client.initialize({
    cwd: root,
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
  });
  console.log(JSON.stringify({ phase: "initialize", ok: true, serverInfo: initialized.serverInfo }));

  const sessionA = "11111111-2222-4333-8444-555555555555";
  const sessionB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const subA = client.subscribeSessionTree(sessionA);
  const subB = client.subscribeSessionTree(sessionB);

  const idA = await client.prompt(sessionA, [{ type: "text", text: "first stub turn" }]);
  const idA2 = await client.prompt(sessionA, [{ type: "text", text: "second stub turn, same session" }]);
  const idB = await client.prompt(sessionB, [{ type: "text", text: "stub turn, other session" }]);
  await wait(2_500);
  subA.close();
  subB.close();

  const response = await fetch(`http://127.0.0.1:${port}/captured`);
  const { captured } = await response.json();
  const headerName = "x-opencode-session";
  const values = captured.map((entry) => ({
    path: entry.url,
    session: entry.headers[headerName] ?? null,
    hasKey: typeof entry.headers.authorization === "string" && entry.headers.authorization.startsWith("Bearer "),
    host: entry.headers.host,
  }));

  const forA = values.filter((entry) => entry.session === sessionA).length;
  const forB = values.filter((entry) => entry.session === sessionB).length;
  const distinct = new Set(values.map((entry) => entry.session));
  console.log(
    JSON.stringify(
      {
        phase: "headers",
        messageIds: [idA, idA2, idB].map((id) => (typeof id === "string" ? `${id.slice(0, 8)}…` : id)),
        totalRequests: captured.length,
        headerPresentOnAll: values.every((entry) => entry.session !== null),
        requestsForSessionA: forA,
        requestsForSessionB: forB,
        distinctSessionValues: distinct.size,
        sessionARepeatedStable: forA >= 2 && values.filter((entry) => entry.session === sessionA).length === forA,
        bearerAuthPresent: values.every((entry) => entry.hasKey),
        paths: [...new Set(values.map((entry) => entry.path))],
      },
      null,
      2,
    ),
  );
} finally {
  await client.close().catch(() => undefined);
  server.close();
}
