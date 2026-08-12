// Shared HTTP helpers for board latency benchmarks.
// Uses a deterministic keep-alive client so endpoint samples measure server
// work, not per-request TCP/connect or undici pool timer noise on Windows.
import http from 'node:http';
import { performance } from 'node:perf_hooks';

export function createKeepAliveClient({ host = '127.0.0.1', port }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const request = (path, { method = 'GET' } = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      path,
      method,
      agent,
      headers: { Connection: 'keep-alive', Accept: '*/*' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  const timedGet = async (path) => {
    const t0 = performance.now();
    const res = await request(path);
    return { ms: performance.now() - t0, res };
  };
  const warm = async (paths, rounds = 5) => {
    for (let i = 0; i < rounds; i++) {
      for (const path of paths) await request(path);
    }
  };
  const close = () => agent.destroy();
  return { request, timedGet, warm, close };
}

// Poll without setTimeout quantization (Windows 15ms timer buckets inflate p95).
export async function pollBoardReady({ host = '127.0.0.1', port, deadlineMs = 8000 }) {
  const path = '/api/meta';
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline) {
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.get({ host, port, path, timeout: 250 }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      if (res.status === 200) {
        const payload = JSON.parse(res.body.toString('utf8'));
        if (payload?.service === 'plan-ledger-board') return true;
      }
    } catch { /* server not listening yet */ }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}
