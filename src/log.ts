/// One JSON object per line, so `docker logs` stays greppable and small.
export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (level === 'info') console.log(line);
  else console.error(line);
}
