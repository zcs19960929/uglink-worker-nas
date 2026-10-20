import { handleGatewayRequest } from '../../../application/gateway/handle-request';
import { ugreenProxyTransport } from '../../../infrastructure/ugreen/proxy-transport';
import { createDurableSessionClient } from '../../../infrastructure/ugreen/durable-session-client';
import type { GatewayWorkerEnv } from './environment';

const logger = {
  info(event: Record<string, unknown>): void {
    console.log(JSON.stringify(event));
  },
  error(event: Record<string, unknown>): void {
    console.error(JSON.stringify(event));
  }
};

export default {
  async fetch(request: Request, env: GatewayWorkerEnv): Promise<Response> {
    // Resolve the stub only when a session is needed; setup and health endpoints
    // must remain available without performing NAS authentication or RPC.
    let client: ReturnType<typeof createDurableSessionClient> | undefined;
    const connected = () => client ??= createDurableSessionClient(env);
    return handleGatewayRequest(request, {
      serviceMap: env.SERVICE_MAP,
      setupMode: env.SETUP_MODE === 'true'
    }, {
      sessions: {
        get: async (port) => (await connected()).get(port),
        refresh: async (port, previous) => (await connected()).refresh(port, previous),
        invalidate: async (port, previous) => (await connected()).invalidate(port, previous)
      },
      transport: ugreenProxyTransport,
      logger
    });
  }
} satisfies ExportedHandler<GatewayWorkerEnv>;
