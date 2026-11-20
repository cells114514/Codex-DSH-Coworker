import type { BridgeConfig } from "./config.js";
import { DshClient } from "./dsh-client.js";
import type { DshApi } from "./dsh-types.js";
import { GatewayConnection } from "./gateway-connection.js";
import { GatewayDshClient } from "./gateway-dsh-client.js";
import { createHostEndpointResolver } from "./host-endpoint.js";
import { createSdkDshApi } from "./sdk-dsh-client.js";

/**
 * Construction is inert.
 *
 * The backend branch is decided before any endpoint resolver is built, so the
 * SDK backend never parses a Host URL, never reads or exchanges a connect
 * token, and never triggers Desktop discovery. The SDK branch also starts no
 * subprocess here: a runtime is spawned lazily by the first prompt of a task.
 */
export function createDshApi(config: BridgeConfig, env: NodeJS.ProcessEnv = process.env): DshApi {
  if (config.hostProtocol === "sdk") {
    if (config.sdk === undefined) {
      throw new Error("internal error: the sdk backend was selected without sdk configuration");
    }
    return createSdkDshApi(config, config.sdk);
  }
  const endpoint = createHostEndpointResolver(config);
  if (config.hostProtocol !== "gateway") return new DshClient(endpoint, config.requestTimeoutMs);
  const tokenEnv = config.connectTokenEnv ?? "DSH_CONNECT_TOKEN";
  return new GatewayDshClient(new GatewayConnection({ endpoint, timeoutMs: config.requestTimeoutMs,
    ...(config.connectTokenOrigin === undefined ? {} : { connectTokenOrigin: config.connectTokenOrigin }),
    getConnectToken: () => env[tokenEnv] }), config.requestTimeoutMs);
}
