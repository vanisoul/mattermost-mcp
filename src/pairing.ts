import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { MattermostApi, SessionStore, normalizeServerUrl } from './session.js';

export const PAIRING_TTL_MS = 5 * 60_000;
const MAX_BODY_BYTES = 8192;
export type PairingTicket = { version: 1; serverUrl: string; port: number; nonce: string; expiresAt: string };
type State = 'waiting' | 'verifying' | 'saving' | 'authenticated' | 'failed' | 'expired' | 'cancelled';
type Round = { ticket: PairingTicket; server: Server; state: State; timer?: NodeJS.Timeout; attempt?: Promise<void> };

export function encodeTicket(ticket: PairingTicket): string {
  return Buffer.from(JSON.stringify(ticket)).toString('base64url');
}

export function decodeTicket(code: string): PairingTicket {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(code)) throw new Error();
    const ticket = JSON.parse(Buffer.from(code, 'base64url').toString()) as PairingTicket;
    if (ticket.version !== 1 || typeof ticket.serverUrl !== 'string' || normalizeServerUrl(ticket.serverUrl) !== ticket.serverUrl
      || !Number.isInteger(ticket.port) || ticket.port < 1024 || ticket.port > 65535
      || typeof ticket.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket.nonce)
      || typeof ticket.expiresAt !== 'string' || !Number.isFinite(Date.parse(ticket.expiresAt))) throw new Error();
    if (Date.parse(ticket.expiresAt) <= Date.now()) throw new Error();
    return ticket;
  } catch { throw new Error('配對碼無效或已逾時，請重新執行 mattermost_login。'); }
}

function reply(response: ServerResponse, status: number, data: object) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', Connection: 'close',
  });
  response.end(JSON.stringify(data));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 短期 loopback 接收端；一組 nonce 只允許一次憑證驗證嘗試。 */
export class PairingService {
  private current?: Round;
  private starting?: Promise<PairingTicket>;

  constructor(private api: MattermostApi, private store: SessionStore, private ttlMs = PAIRING_TTL_MS) {}

  async start(): Promise<PairingTicket> {
    if (this.starting) return this.starting;
    if (this.current && ['waiting', 'verifying', 'saving'].includes(this.current.state)) return this.current.ticket;
    this.starting = this.open();
    try { return await this.starting; }
    finally { this.starting = undefined; }
  }

  private async open(): Promise<PairingTicket> {
    await this.stop();
    const server = createServer({ headersTimeout: 5000, requestTimeout: 10_000, maxHeaderSize: 4096 });
    server.maxConnections = 16;
    server.setTimeout(15_000, (socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('無法建立登入接收端。');
    const round: Round = {
      server, state: 'waiting', ticket: {
        version: 1, serverUrl: this.api.serverUrl, port: address.port,
        nonce: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
      },
    };
    this.current = round;
    server.on('request', (request, response) => {
      void this.handle(round, request, response).catch(() => {
        reply(response, 400, { error: '登入交接失敗。' });
      });
    });
    round.timer = setTimeout(() => this.finish(round, 'expired', true), this.ttlMs);
    round.timer.unref();
    return round.ticket;
  }

  private finish(round: Round, state: State, force = false) {
    round.state = state;
    clearTimeout(round.timer);
    round.server.close();
    if (force) round.server.closeAllConnections();
  }

  private async handle(round: Round, request: IncomingMessage, response: ServerResponse) {
    // 僅接受本機 CLI；不提供 CORS，不接受瀏覽器跨來源要求或 DNS rebinding Host。
    if (request.headers.origin !== undefined || !/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? '')) {
      return reply(response, 403, { error: '拒絕此來源。' });
    }
    const received = request.headers['x-mattermost-pairing-nonce'];
    const expected = Buffer.from(round.ticket.nonce);
    const actual = typeof received === 'string' ? Buffer.from(received) : Buffer.alloc(0);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(response, 403, { error: '配對驗證失敗。' });
    if (Date.now() >= Date.parse(round.ticket.expiresAt) || !['waiting', 'verifying', 'saving'].includes(round.state)) {
      return reply(response, 410, { error: '配對已失效。' });
    }
    if (request.method === 'GET' && request.url === '/pairing') {
      return reply(response, 200, { serverUrl: round.ticket.serverUrl, expiresAt: round.ticket.expiresAt });
    }
    if (request.method !== 'POST' || request.url !== '/callback') return reply(response, 404, { error: '找不到接收端。' });
    if (round.state !== 'waiting') return reply(response, 409, { error: '配對處理中。' });
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') return reply(response, 415, { error: '必須使用 JSON。' });
    if (Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return reply(response, 413, { error: '資料過大。' });
    round.state = 'verifying'; // 先鎖住，阻擋同一 nonce 並行匯入。
    round.attempt = this.accept(round, request, response);
    await round.attempt;
  }

  private async accept(round: Round, request: IncomingMessage, response: ServerResponse) {
    try {
      let data: { serverUrl?: unknown; token?: unknown };
      try {
        data = JSON.parse(await readBody(request));
        if (!data || data.serverUrl !== this.api.serverUrl || typeof data.token !== 'string'
          || !data.token || data.token.length > 4096 || /[\r\n]/.test(data.token)) throw new Error();
      } catch {
        reply(response, 400, { error: '登入資料無效或站台不符，請重新配對。' });
        this.finish(round, 'failed');
        return;
      }
      const user = await this.api.verify(data.token as string);
      if (round.state !== 'verifying' || Date.now() >= Date.parse(round.ticket.expiresAt)) {
        reply(response, 410, { error: '配對已失效。' });
        return;
      }
      // 驗證在期限內完成後才開始不可分割的磁碟提交；取消會等待提交完成。
      clearTimeout(round.timer);
      round.state = 'saving';
      await this.store.save(data.token as string);
      reply(response, 200, { authenticated: true, user });
      this.finish(round, 'authenticated');
    } catch {
      if (round.state !== 'expired' && round.state !== 'cancelled') {
        reply(response, 401, { error: 'Token 驗證或保存失敗，請重新配對。' });
        this.finish(round, 'failed');
      }
    }
  }

  async stop(): Promise<void> {
    const round = this.current;
    if (!round) return;
    if (['waiting', 'verifying', 'saving'].includes(round.state)) this.finish(round, 'cancelled', true);
    await round.attempt;
  }

  get status(): { state: State | 'idle'; expiresAt?: string } {
    return this.current ? { state: this.current.state, expiresAt: this.current.ticket.expiresAt } : { state: 'idle' };
  }
}
