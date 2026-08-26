// Servidor WebSocket mínimo (RFC 6455), sem dependências externas.
// Só o necessário: handshake, frames texto/binário, fragmentação, ping/pong e close.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

export class WSConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.fragOp = null;
    this.fragChunks = [];
    this.fragLen = 0;
    this.maxMessage = 4 * 1024 * 1024;
    this.isAlive = true;
    this.lastError = null;

    // Em Node, um 'error' emitido SEM ouvinte derruba o processo inteiro.
    // Um cliente que some (ECONNRESET) é rotina, não motivo para cair o
    // servidor de todas as partidas — então garantimos um ouvinte sempre.
    this.on('error', () => {});

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._closed());
    socket.on('error', (err) => {
      this.lastError = err;
      this.emit('error', err);
      this._closed();
    });
    socket.setNoDelay(true);
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

    // Teto no buffer de entrada. O tamanho declarado do quadro já era
    // conferido, e os fragmentos também — mas nada impedia um cliente de
    // despejar bytes sem NUNCA fechar um quadro, e aí este buffer crescia
    // até a memória acabar. Um quadro legítimo cabe no máximo em
    // maxMessage + cabeçalho.
    if (this.buf.length > this.maxMessage + 1024) {
      this.close(1009, 'mensagem grande demais');
      this.buf = Buffer.alloc(0);
      return;
    }
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
      if (!this.open) break;
    }
  }

  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off); off += 8;
      if (big > BigInt(this.maxMessage)) { this.close(1009, 'mensagem grande demais'); return null; }
      len = Number(big);
    }

    let maskKey = null;
    if (masked) {
      if (b.length < off + 4) return null;
      maskKey = b.subarray(off, off + 4); off += 4;
    }

    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];

    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === OP.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      this._sendRaw(OP.CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
      this.socket.end();
      this.emit('closing', code);
      this._closed();
      return;
    }
    if (opcode === OP.PING) { this._sendRaw(OP.PONG, payload); return; }
    if (opcode === OP.PONG) { this.isAlive = true; this.emit('pong'); return; }

    if (opcode === OP.CONT) {
      if (this.fragOp === null) return;              // continuação órfã: ignora
      this.fragChunks.push(payload);
      this.fragLen += payload.length;
    } else {
      if (!fin) { this.fragOp = opcode; this.fragChunks = [payload]; this.fragLen = payload.length; return; }
      this._deliver(opcode, payload);
      return;
    }

    if (this.fragLen > this.maxMessage) { this.close(1009, 'mensagem grande demais'); return; }
    if (fin) {
      const full = Buffer.concat(this.fragChunks, this.fragLen);
      const op = this.fragOp;
      this.fragOp = null; this.fragChunks = []; this.fragLen = 0;
      this._deliver(op, full);
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP.TEXT) this.emit('message', payload.toString('utf8'), false);
    else if (opcode === OP.BIN) this.emit('message', payload, true);
  }

  _sendRaw(opcode, payload) {
    if (!this.open || this.socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;       // FIN + opcode (servidor nunca mascara)
    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch {
      return false;
    }
  }

  send(data) {
    if (typeof data === 'string') return this._sendRaw(OP.TEXT, Buffer.from(data, 'utf8'));
    if (Buffer.isBuffer(data)) return this._sendRaw(OP.BIN, data);
    return this._sendRaw(OP.TEXT, Buffer.from(JSON.stringify(data), 'utf8'));
  }

  sendJSON(obj) {
    return this._sendRaw(OP.TEXT, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  ping() {
    this.isAlive = false;
    return this._sendRaw(OP.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(reason, 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this._sendRaw(OP.CLOSE, p);
    this.open = false;
    try { this.socket.end(); } catch { /* já fechado */ }
    this.emit('close');
  }
}

/**
 * Liga o upgrade HTTP -> WebSocket. Chame de dentro de server.on('upgrade').
 * @returns {WSConnection|null}
 */
export function handleUpgrade(req, socket, head, { path = null } = {}) {
  const key = req.headers['sec-websocket-key'];
  const ver = req.headers['sec-websocket-version'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();

  if (upgrade !== 'websocket' || !key || ver !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  if (path) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return null;
    }
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );

  const conn = new WSConnection(socket, req);
  if (head && head.length) conn._onData(head);
  return conn;
}
