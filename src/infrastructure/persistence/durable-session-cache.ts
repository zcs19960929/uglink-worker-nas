import type { SessionCache } from '../ugreen/session-service';

interface CacheEntry { value: string; expiresAt?: number }

export function createDurableSessionCache(storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>): SessionCache {
  return {
    async get(key) {
      const entry = await storage.get<CacheEntry>(key);
      if (!entry) return null;
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        await storage.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, options) {
      await storage.put(key, {
        value,
        ...(options?.expirationTtl !== undefined
          ? { expiresAt: Date.now() + options.expirationTtl * 1000 } : {})
      } satisfies CacheEntry);
    },
    async delete(key) { await storage.delete(key); }
  };
}
