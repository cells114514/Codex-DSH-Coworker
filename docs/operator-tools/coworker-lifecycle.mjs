/**
 * Shutdown sequence shared by the acceptance drivers.
 *
 * Order matters: stop accepting work, close the MCP client so the bridge can
 * finish its own shutdown, wait for that process to exit, then stop the sender.
 * A stop that cannot be proven must be reported as unconfirmed, never assumed.
 */
export async function waitForExit(child, timeoutMs = 10_000) {
  if (child === undefined || child === null) return { exited: false, reason: "no-process" };
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return { exited: true, code: child.exitCode, reason: "already-exited" };
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ exited: false, reason: "timeout", code: child.exitCode ?? null });
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exited: true, code: code ?? null, signal: signal ?? null, reason: "exit" });
    });
  });
}

/**
 * Close the MCP client, wait for the bridge to leave, then stop the sender.
 * Returns a report instead of throwing: a stop path must never hide its outcome.
 */
export async function shutdownAll(options) {
  const errors = [];
  let clientClosed = false;
  if (options.client !== undefined) {
    try {
      await options.client.close();
      clientClosed = true;
    } catch (error) {
      errors.push(`client-close: ${String(error?.message ?? error)}`);
    }
  }
  const bridge = options.bridgeChild === undefined ? null : await waitForExit(options.bridgeChild, options.bridgeTimeoutMs ?? 15_000);
  let sender = null;
  if (options.sender !== undefined) {
    try {
      options.sender.kill();
    } catch (error) {
      errors.push(`sender-kill: ${String(error?.message ?? error)}`);
    }
    sender = await waitForExit(options.sender, options.senderTimeoutMs ?? 5_000);
  }
  const confirmed = clientClosed === true && (bridge === null || bridge.exited === true) && (sender === null || sender.exited === true);
  return { clientClosed, bridge, sender, errors, confirmed };
}
