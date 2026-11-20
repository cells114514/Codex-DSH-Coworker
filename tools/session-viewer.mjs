/**
 * Read-only viewer for bridge-observed SDK sessions.
 *
 * It reads only the bridge home it was pointed at: tasks, runtimes, observed
 * event logs, coworker bindings and the outbox. There is no write endpoint and no
 * model call. Everything it shows is bridge observation, which may be incomplete;
 * the payload always carries that integrity state instead of claiming a full chat.
 *
 * Usage: node tools/session-viewer.mjs --bridge-home "<dir>" [--port 7317] [--open]
 */
import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const TASK_ID = /^dsh_[a-z0-9]+$/;

function parseArgs(argv) {
  const args = { port: 7317, open: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--bridge-home") args.bridgeHome = String(argv[++index] ?? "").replace(/^"|"$/g, "");
    else if (token === "--port") args.port = Number(String(argv[++index] ?? "0").replace(/"/g, ""));
    else if (token === "--open") args.open = true;
  }
  return args;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function listNames(dir, suffix) {
  try {
    const names = await readdir(dir);
    return suffix === undefined ? names : names.filter((name) => name.endsWith(suffix));
  } catch {
    return [];
  }
}

/** Every path served must stay inside the bridge home. */
function safeJoin(root, ...parts) {
  const target = resolve(root, ...parts);
  const base = resolve(root);
  if (target !== base && !target.startsWith(`${base}${sep}`)) return undefined;
  return target;
}

async function coverageOf(bridgeHome, taskId) {
  const file = safeJoin(bridgeHome, "observed", taskId, "coverage.json");
  if (file === undefined) return undefined;
  return readJson(file);
}

async function readEvents(bridgeHome, taskId, since) {
  const file = safeJoin(bridgeHome, "observed", taskId, "events.jsonl");
  if (file === undefined) return { events: [], nextCursor: 0, integrity: "unknown" };
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { events: [], nextCursor: 0, integrity: "missing" };
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ malformed: true, raw: line.slice(0, 200) });
    }
  }
  const start = Number.isInteger(since) && since > 0 ? since : 0;
  const sliced = events.slice(start);
  return {
    events: sliced,
    items: sliced.map((entry) => toDisplayItem(entry)),
    nextCursor: events.length,
    total: events.length,
  };
}

/** Types that carry no conversation content; hidden unless the caller asks. */
const NOISE_TYPES = new Set([
  "permission/preset",
  "sandbox/mode",
  "approval/policy",
  "request/header",
  "request/context",
  "session/title",
  "step/start",
  "step/end",
  "agent/inbox/spliced",
  "system/message",
]);

function textOf(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (block === null || typeof block !== "object") return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image") return `[图片 ${block.mimeType ?? ""}]`.trim();
      return "";
    })
    .filter((part) => part !== "")
    .join("\n")
    .trim();
}

function summarizeToolArguments(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.slice(0, 300);
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const pick = ["path", "file", "command", "cmd", "query", "pattern", "url", "description"];
    const parts = pick.filter((key) => typeof value[key] === "string").map((key) => `${key}: ${String(value[key]).slice(0, 160)}`);
    if (parts.length > 0) return parts.join(" · ");
    return `参数键: ${keys.slice(0, 6).join(", ")}`;
  }
  return String(value).slice(0, 300);
}

/**
 * Turn one observed envelope into something a person can read: text in, text out,
 * tool calls as name plus a short argument summary. Nothing here pretends to be a
 * complete transcript — the caller still reports coverage separately.
 */
export function toDisplayItem(envelope) {
  if (envelope?.malformed === true) {
    return { kind: "warning", seq: null, title: "无法解析的事件行", text: String(envelope.raw ?? ""), raw: envelope };
  }
  const event = envelope?.event ?? envelope ?? {};
  const type = String(event.type ?? "unknown");
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const seq = typeof event.seq === "number" ? event.seq : envelope?.seq ?? null;
  const at = envelope?.observedAt ?? null;
  const base = { type, seq, at, origin: envelope?.origin ?? null };

  if (type === "user/message") {
    const text = textOf(data.content);
    return { ...base, kind: "user", title: "用户", text: text || "(空消息)" };
  }
  if (type === "assistant/message") {
    const message = data.message ?? {};
    const text = textOf(message.content);
    const model = message.source?.model ?? null;
    const usage = data.usage ?? {};
    const meta = [model, usage.inputTokens !== undefined ? `in ${usage.inputTokens}` : null, usage.outputTokens !== undefined ? `out ${usage.outputTokens}` : null]
      .filter((part) => part !== null && part !== "")
      .join(" · ");
    return { ...base, kind: "assistant", title: "助手", text: text || "(无文本)", meta };
  }
  if (type === "reasoning" || type.includes("reasoning")) {
    const text = typeof data.text === "string" ? data.text : textOf(data.content);
    return { ...base, kind: "reasoning", title: `推理（${text.length} 字）`, text };
  }
  if (type.startsWith("tool/") || type.includes("tool")) {
    const name = String(data.name ?? data.tool ?? data.toolName ?? "工具");
    const result = data.output ?? data.result ?? data.content;
    const args = summarizeToolArguments(data.arguments ?? data.args ?? data.input);
    const text = typeof result === "string" ? result.slice(0, 2000) : result === undefined ? "" : summarizeToolArguments(result);
    return { ...base, kind: "tool", title: `工具 · ${name}`, text: [args, text].filter((part) => part !== "").join("\n\n") || "(无输出)" };
  }
  if (type === "turn/start") {
    return { ...base, kind: "status", title: `第 ${data.turn ?? "?"} 轮开始`, text: "" };
  }
  if (type === "turn/end") {
    const reason = data.reason?.kind ?? data.reason ?? "completed";
    return { ...base, kind: "status", title: `第 ${data.turn ?? "?"} 轮结束 · ${reason}`, text: "" };
  }
  if (type === "agent/inbox/spliced") {
    const inserted = Array.isArray(data.inserted) ? data.inserted : [];
    const text = textOf(inserted.flatMap((item) => (Array.isArray(item?.content) ? item.content : [])));
    return { ...base, kind: "user", title: "用户输入（排队）", text };
  }
  const hidden = NOISE_TYPES.has(type);
  return { ...base, kind: hidden ? "noise" : "other", title: type, text: "", hidden };
}
function notificationState(binding, records) {
  const mine = records.filter((record) => record.taskId === binding?.taskId);
  const byExecution = mine.map((record) => ({
    executionId: record.executionId,
    status: record.status,
    messageId: typeof record.messageId === "string" ? `${record.messageId.slice(0, 8)}…` : null,
    deliveredAt: record.deliveredAt ?? null,
  }));
  const pending = byExecution.some((entry) => entry.status === "pending" || entry.status === "sending");
  const unknown = byExecution.some((entry) => entry.status === "delivery_unknown");
  return { bound: binding !== undefined, threadId: binding?.threadId ?? null, executions: byExecution, pending, deliveryUnknown: unknown };
}

async function buildTaskList(bridgeHome) {
  const names = await listNames(safeJoin(bridgeHome, "tasks") ?? bridgeHome, ".json");
  const records = [];
  for (const name of names) {
    const taskId = name.replace(/\.json$/, "");
    if (!TASK_ID.test(taskId)) continue;
    const task = await readJson(safeJoin(bridgeHome, "tasks", name) ?? "");
    const runtime = await readJson(safeJoin(bridgeHome, "runtimes", name) ?? "");
    const binding = await readJson(safeJoin(bridgeHome, "coworker", name) ?? "");
    const outbox = [];
    for (const outboxName of await listNames(safeJoin(bridgeHome, "coworker-outbox") ?? bridgeHome, ".json")) {
      const record = await readJson(safeJoin(bridgeHome, "coworker-outbox", outboxName) ?? "");
      if (record !== undefined) outbox.push(record);
    }
    const coverage = await coverageOf(bridgeHome, taskId);
    records.push({
      taskId,
      sessionId: task?.sessionId ?? runtime?.rootSessionId ?? null,
      cwd: runtime?.canonicalCwd ?? null,
      cleanShutdown: runtime?.cleanShutdown ?? null,
      runtimePid: runtime?.diagnostic?.runtimePid ?? null,
      observedEvents: coverage?.observedCount ?? null,
      integrity: {
        coverageComplete: coverage?.complete ?? null,
        note: coverage?.complete === false ? "存在观察缺口，事件历史可能缺少恢复前内容" : null,
      },
      notification: notificationState(binding === undefined ? undefined : { ...binding, taskId }, outbox),
    });
  }
  records.sort((left, right) => left.taskId.localeCompare(right.taskId));
  return records;
}

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>SDK 会话记录（只读）</title>
<style>
 :root{--fg:#17202a;--muted:#6b7280;--line:#e5e7eb;--bg:#f6f7f9}
 body{font:14px/1.6 system-ui,"Segoe UI",sans-serif;margin:0;color:var(--fg);background:var(--bg)}
 header{padding:10px 16px;background:#111827;color:#fff;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
 header label{font-size:12px;color:#cbd5e1;display:flex;gap:4px;align-items:center}
 main{display:grid;grid-template-columns:330px 1fr;height:calc(100vh - 46px)}
 aside{border-right:1px solid var(--line);overflow:auto;background:#fff}
 section{overflow:auto;padding:16px 20px}
 .task{padding:8px 12px;border-bottom:1px solid #f2f4f6;cursor:pointer;font-size:13px}
 .task:hover{background:#f3f7ff}.task.sel{background:#e8f0ff}
 .muted{color:var(--muted)}.badge{display:inline-block;padding:0 6px;border-radius:8px;font-size:11px;margin:2px 4px 0 0}
 .ok{background:#e7f7ec;color:#166534}.warn{background:#fff4e5;color:#92400e}.bad{background:#fde8e8;color:#991b1b}
 .row{display:flex;margin:10px 0}
 .row.user{justify-content:flex-end}
 .bubble{max-width:min(760px,86%);padding:8px 12px;border-radius:10px;background:#fff;border:1px solid var(--line);white-space:pre-wrap;word-break:break-word}
 .row.user .bubble{background:#e6f0ff;border-color:#c7dbff}
 .bubble .who{font-size:11px;color:var(--muted);margin-bottom:2px}
 details{max-width:min(760px,86%);background:#fff;border:1px solid var(--line);border-radius:10px;padding:6px 10px;margin:8px 0}
 details summary{cursor:pointer;font-size:12px;color:#374151}
 details pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Consolas,monospace}
 .status{margin:12px 0 4px;font-size:12px;color:var(--muted);border-top:1px dashed var(--line);padding-top:6px}
 .noise{font-size:12px;color:#9ca3af;margin:2px 0}
 .warnbox{background:#fff8e6;border:1px solid #f1d08a;color:#92400e;padding:8px 12px;border-radius:8px;margin-bottom:10px;font-size:12px}
</style>
<header>
  <strong>SDK 会话记录</strong><span class="muted">只读 · 桥接观察记录，可能不完整</span>
  <span id="count" class="muted"></span>
  <label><input type="checkbox" id="showNoise"> 显示技术事件</label>
  <label><input type="checkbox" id="showRaw"> 显示原始 JSON</label>
</header>
<main><aside id="list"></aside><section id="detail"><p class="muted">选择左侧任务。</p></section></main>
<script>
let tasks=[], current=null, items=[], rawItems=[], lastData=null;
const esc=(s)=>String(s??'').replace(/[&<>]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const noiseOn=()=>document.getElementById('showNoise').checked;
const rawOn=()=>document.getElementById('showRaw').checked;
async function load(){
  const r=await fetch('/api/tasks'); tasks=await r.json();
  document.getElementById('count').textContent=tasks.length+' 个任务';
  document.getElementById('list').innerHTML=tasks.map((t,i)=>
    '<div class="task" data-i="'+i+'"><div><strong>'+esc(t.taskId)+'</strong></div>'+
    '<div class="muted">'+esc(t.cwd||'—')+'</div><div>'+badges(t)+'</div></div>').join('');
  document.querySelectorAll('.task').forEach((el)=>el.onclick=()=>select(el.dataset.i));
}
function badges(t){
  const n=t.notification||{}, i=t.integrity||{}; let out='';
  out+='<span class="badge '+(n.bound?'ok':'warn')+'">'+(n.bound?'已绑定':'未绑定')+'</span>';
  if(n.pending) out+='<span class="badge warn">待发送</span>';
  if(n.deliveryUnknown) out+='<span class="badge bad">投递不确定</span>';
  if(n.executions&&n.executions.length) out+='<span class="badge ok">已通知 '+n.executions.filter(e=>e.status==='acknowledged').length+'</span>';
  if(i.coverageComplete===false) out+='<span class="badge bad">观察缺口</span>';
  return out;
}
async function select(i){
  document.querySelectorAll('.task').forEach((el)=>el.classList.toggle('sel',el.dataset.i===String(i)));
  current=tasks[i];
  await fetchRender();
}
async function fetchRender(){
  const r=await fetch('/api/task/'+encodeURIComponent(current.taskId)+'/events?since=0');
  const data=await r.json(); lastData=data; items=data.items||[]; rawItems=data.events||[];
  render(data);
}
function render(data){
  const t=current;
  const gap=(data.integrity&&data.integrity.coverageComplete===false)
    ? '<div class="warnbox">该任务存在观察缺口：恢复前的历史可能缺失，这里不是完整聊天记录。</div>' : '';
  const head='<h3 style="margin:0 0 6px">'+esc(t.taskId)+'</h3><p class="muted" style="margin:0 0 12px">'+
    'session '+esc(t.sessionId||'—')+' · cwd '+esc(t.cwd||'—')+'<br>'+
    '通知 '+(t.notification.bound?('已绑定 '+esc(t.notification.threadId)):'未绑定')+
    (((t.notification.executions||[]).length)?(' · '+t.notification.executions.map(e=>esc(e.executionId)+':'+esc(e.status)).join(', ')):'')+'</p>';
  const body=items.map((item,idx)=>renderItem(item,idx)).filter((html)=>html!=='').join('') || '<p class="muted">没有可显示的对话内容。</p>';
  document.getElementById('detail').innerHTML=head+gap+body;
}
function renderItem(item,idx){
  const raw=rawOn()?('<details><summary>原始 JSON #'+idx+'</summary><pre>'+esc(JSON.stringify(rawItems[idx],null,1))+'</pre></details>'):'';
  if(item.kind==='noise'||item.hidden){
    return noiseOn()?('<div class="noise">'+esc(item.type)+' · seq '+esc(item.seq)+'</div>'):'';
  }
  if(item.kind==='status') return '<div class="status">'+esc(item.title)+'</div>'+raw;
  if(item.kind==='warning') return '<div class="warnbox">'+esc(item.title)+'</div>';
  if(item.kind==='user') return '<div class="row user"><div class="bubble"><div class="who">用户</div>'+esc(item.text)+'</div></div>'+raw;
  if(item.kind==='assistant') return '<div class="row"><div class="bubble"><div class="who">助手'+(item.meta?(' · '+esc(item.meta)):'')+'</div>'+esc(item.text)+'</div></div>'+raw;
  if(item.kind==='reasoning') return '<details><summary>'+esc(item.title)+'</summary><pre>'+esc(item.text)+'</pre></details>'+raw;
  if(item.kind==='tool') return '<details><summary>'+esc(item.title)+'</summary><pre>'+esc(item.text)+'</pre></details>'+raw;
  if(!item.text) return noiseOn()?('<div class="noise">'+esc(item.title)+' · seq '+esc(item.seq)+'</div>'):'';
  return '<div class="row"><div class="bubble"><div class="who">'+esc(item.title)+'</div>'+esc(item.text)+'</div></div>'+raw;
}
document.getElementById('showNoise').onchange=()=>{ if(current) render(lastData); };
document.getElementById('showRaw').onchange=()=>{ if(current) render(lastData); };
load();
</script></html>`;

export function createViewerServer(options) {
  const bridgeHome = resolve(options.bridgeHome);
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status, body, type = "application/json; charset=utf-8") => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (request.method !== "GET") return send(405, { error: "read-only viewer" });
    if (url.pathname === "/") return send(200, PAGE, "text/html; charset=utf-8");
    if (url.pathname === "/api/tasks") {
      try {
        return send(200, await buildTaskList(bridgeHome));
      } catch (error) {
        return send(500, { error: String(error?.message ?? error) });
      }
    }
    const match = /^\/api\/task\/([^/]+)\/events$/.exec(url.pathname);
    if (match !== null) {
      const taskId = decodeURIComponent(match[1]);
      if (!TASK_ID.test(taskId)) return send(400, { error: "invalid task id" });
      const since = Number(url.searchParams.get("since") ?? "0");
      const coverage = await coverageOf(bridgeHome, taskId);
      const events = await readEvents(bridgeHome, taskId, since);
      return send(200, {
        taskId,
        events: events.events,
        items: events.items ?? [],
        nextCursor: events.nextCursor,
        total: events.total ?? 0,
        integrity: {
          coverageComplete: coverage?.complete ?? null,
          lastObservedRootSeq: coverage?.lastObservedRootSeq ?? null,
          note: coverage?.complete === false ? "存在观察缺口，事件历史可能缺少恢复前内容" : null,
        },
      });
    }
    return send(404, { error: "not found" });
  });
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const bridgeHome = args.bridgeHome ?? process.env.DSH_BRIDGE_HOME;
  if (bridgeHome === undefined) {
    console.error("--bridge-home or DSH_BRIDGE_HOME is required");
    process.exit(2);
  }
  await stat(bridgeHome).catch(() => {
    console.error(`bridge home not found: ${bridgeHome}`);
    process.exit(2);
  });
  const server = createViewerServer({ bridgeHome });
  server.listen(args.port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${args.port}/`;
    console.log(url);
    if (args.open) exec(`start "" "${url}"`);
  });
}