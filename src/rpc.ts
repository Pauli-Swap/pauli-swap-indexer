/// JSON-RPC over HTTP, batched. The node answers one batch POST in about the
/// time of a single call, so callers hand over lists of calls.

type Call = { method: string; params: unknown[] };
type Reply = { id: number; result?: unknown; error?: { code: number; message: string } };

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

const MAX_BATCH = 60;
const TIMEOUT_MS = 60_000;

export class Rpc {
  calls = 0;

  constructor(readonly url: string) {}

  private async post(body: unknown): Promise<unknown> {
    this.calls++;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new RpcError(`RPC HTTP ${res.status}`);
    return res.json();
  }

  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const reply = (await this.post({ jsonrpc: '2.0', id: 1, method, params })) as Reply;
    if (reply.error) throw new RpcError(`${method}: ${reply.error.message}`, reply.error.code);
    return reply.result as T;
  }

  /// Results in call order; a failed entry is an RpcError in its slot, so one
  /// bad call does not sink the batch.
  async batch<T = any>(calls: Call[]): Promise<(T | RpcError)[]> {
    const out: (T | RpcError)[] = [];
    for (let i = 0; i < calls.length; i += MAX_BATCH) {
      const chunk = calls.slice(i, i + MAX_BATCH);
      const replies = (await this.post(chunk.map((c, id) => ({ jsonrpc: '2.0', id, ...c })))) as Reply[];
      if (!Array.isArray(replies)) throw new RpcError('RPC returned a non-batch response');
      const byId = new Map(replies.map((r) => [Number(r.id), r]));
      chunk.forEach((c, id) => {
        const r = byId.get(id);
        out.push(!r ? new RpcError(`${c.method}: no response`) : r.error ? new RpcError(`${c.method}: ${r.error.message}`, r.error.code) : (r.result as T));
      });
    }
    return out;
  }

  /// Like batch, but throws on the first failure.
  async batchStrict<T = any>(calls: Call[]): Promise<T[]> {
    const results = await this.batch<T>(calls);
    for (const r of results) if (r instanceof RpcError) throw r;
    return results as T[];
  }
}

export const hexNum = (n: number) => '0x' + n.toString(16);
