import type { ProxySessionService } from '../../application/gateway/ports';
import type { ProxySession } from '../../domain/proxy/model';
import { ProxyAuthenticationError, type ProxyAuthenticationIssue } from '../../domain/proxy/errors';

export type SessionOperation = 'get' | 'refresh' | 'invalidate';
export type SessionOperationResult =
  | { ok: true; session?: ProxySession }
  | { ok: false; issue: ProxyAuthenticationIssue };

export interface SessionCoordinatorClient {
  operate(operation: SessionOperation, port: string, previous?: ProxySession): Promise<SessionOperationResult>;
}

export interface SessionCoordinatorNamespace {
  getByName(name: string): SessionCoordinatorClient;
}

export async function createDurableSessionClient(env: {
  UGLINK_SESSIONS: SessionCoordinatorNamespace;
  SESSION_NAMESPACE: string;
  UGLINK_ID: string;
  USERNAME: string;
  PASSWORD: string;
}): Promise<ProxySessionService> {
  // Rotate the coordinator when credentials change, without putting secrets in
  // object names or reusing a session/cooldown from the previous credentials.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify([env.UGLINK_ID, env.USERNAME, env.PASSWORD])
  ));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const stub = env.UGLINK_SESSIONS.getByName(`${env.SESSION_NAMESPACE}:${fingerprint}`);
  async function invoke(operation: SessionOperation, port: string, previous?: ProxySession): Promise<ProxySession | undefined> {
    const result = await stub.operate(operation, port, previous);
    if (!result.ok) throw new ProxyAuthenticationError(result.issue);
    return result.session;
  }
  async function session(operation: 'get' | 'refresh', port: string, previous?: ProxySession): Promise<ProxySession> {
    const result = await invoke(operation, port, previous);
    if (!result) throw new Error('Session coordinator returned no proxy session');
    return result;
  }
  return {
    get: (port) => session('get', port),
    refresh: (port, previous) => session('refresh', port, previous),
    async invalidate(port, previous) { await invoke('invalidate', port, previous); }
  };
}
