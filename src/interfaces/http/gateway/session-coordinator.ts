import { DurableObject } from 'cloudflare:workers';
import { createUgreenSessionService } from '../../../infrastructure/ugreen/session-service';
import { createDurableSessionCache } from '../../../infrastructure/persistence/durable-session-cache';
import { ProxyAuthenticationError } from '../../../domain/proxy/errors';
import type { ProxySession } from '../../../domain/proxy/model';
import type { SessionOperation, SessionOperationResult } from '../../../infrastructure/ugreen/durable-session-client';
import type { GatewayWorkerEnv } from './environment';

export class UgreenSessionCoordinator extends DurableObject<GatewayWorkerEnv> {
  private readonly sessions;

  constructor(ctx: DurableObjectState, env: GatewayWorkerEnv) {
    super(ctx, env);
    this.sessions = createUgreenSessionService({
      uglinkId: env.UGLINK_ID, username: env.USERNAME, password: env.PASSWORD,
      sessionNamespace: env.SESSION_NAMESPACE, cache: createDurableSessionCache(ctx.storage)
    });
  }

  async operate(operation: SessionOperation, port: string, previous?: ProxySession): Promise<SessionOperationResult> {
    if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw new Error('Invalid proxy service port');
    }
    try {
      if (operation === 'invalidate') {
        await this.sessions.invalidate(port, previous);
        return { ok: true };
      }
      if (operation !== 'get' && operation !== 'refresh') throw new Error('Invalid proxy session operation');
      const session = operation === 'get'
        ? await this.sessions.get(port) : await this.sessions.refresh(port, previous);
      return { ok: true, session };
    } catch (error) {
      // RPC does not preserve custom Error properties such as apiCode.
      if (error instanceof ProxyAuthenticationError) return { ok: false, issue: error.apiCode };
      throw error;
    }
  }
}
