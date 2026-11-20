// Explicit, prompt-free orphan recovery. No automatic retry, deletion, or clean-exit fabrication.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig } from '../../dist/config.js';
import { RuntimeRegistry } from '../../dist/runtime-registry.js';
import { createSdkDshApi } from '../../dist/sdk-dsh-client.js';

const argv = process.argv.slice(2);
const value = (flag) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
const taskId = value('--task');
const home = value('--home');
if (!taskId || !home) throw new Error('Required: --task <exact taskId> --home <SDK home>; default is preview. Add --apply --confirm-no-runtime to restore without sending a prompt.');
const config = loadConfig({ ...process.env, DSH_HOST_PROTOCOL: 'sdk', DSH_HOME: resolve(home),
  ...(value('--bridge-home') ? { DSH_BRIDGE_HOME: resolve(value('--bridge-home')) } : {}),
});
const registry = new RuntimeRegistry(config.homeDir);
const record = await registry.get(taskId);
if (!record) throw new Error('Exact task runtime record is missing.');
if (!argv.includes('--apply')) {
  console.log(JSON.stringify({ taskId, rootSessionId: record.rootSessionId, owner: record.owner,
    cleanShutdown: record.cleanShutdown, updatedAt: record.updatedAt, writes: false,
    note: 'Apply validates owner absence, backs up the record, resumes the exact session, then closes cleanly. It sends no prompt.' }, null, 2));
} else {
  if (!argv.includes('--confirm-no-runtime')) throw new Error('Inspect independent/external work first; --confirm-no-runtime is required.');
  if (process.platform !== 'win32') throw new Error('Process inventory guard is Windows-qualified only.');
  // The SDK home is passed through the child environment, not necessarily argv.
  // Conservatively refuse recovery while ANY separately running DSH CLI runtime exists.
  const script = "@(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -match '[\\\\/]@deepseek-ai[\\\\/]dsh[\\\\/]lib[\\\\/]bin.js' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress";
  const inventory = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
  const pids = inventory ? JSON.parse(inventory) : [];
  if ((Array.isArray(pids) ? pids : [pids]).length) throw new Error('A DSH CLI runtime is still present. Do not terminate it blindly; finish or inspect active tasks before recovery.');
  const api = createSdkDshApi(config, config.sdk);
  try {
    const result = await api.recoverTask(taskId, { ownerInstanceId: record.owner.bridgeInstanceId, updatedAt: record.updatedAt });
    await api.close();
    const final = await registry.get(taskId);
    console.log(JSON.stringify({ ...result, cleanRecoveryExit: final?.cleanShutdown === true,
      note: 'Only this recovery process exited cleanly. The prior unclean record remains in the audit backup. No previous follow-up was resent.' }, null, 2));
    if (!final?.cleanShutdown || !result.observation.complete) process.exitCode = 1;
  } finally { await api.close(); }
}
