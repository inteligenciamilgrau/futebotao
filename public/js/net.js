// Camada de rede do cliente: REST + broker WebSocket.

export class Net extends EventTarget {
  constructor() {
    super();
    this.token = localStorage.getItem('fb_token') || null;
    this.playerId = localStorage.getItem('fb_playerId') || null;
    this.playerName = localStorage.getItem('fb_playerName') || null;
    this.ws = null;
    this.assinados = new Set();
    this.tentativas = 0;
  }

  emit(tipo, detalhe) { this.dispatchEvent(new CustomEvent(tipo, { detail: detalhe })); }

  async api(method, p, body) {
    const res = await fetch(p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await res.text();
    let json;
    try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    if (!res.ok) {
      const e = new Error(json.error || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return json;
  }

  guardaSessao(r) {
    this.token = r.token;
    this.playerId = r.playerId;
    this.playerName = r.name;
    localStorage.setItem('fb_token', r.token);
    localStorage.setItem('fb_playerId', r.playerId);
    localStorage.setItem('fb_playerName', r.name);
  }

  async registrar(name, password) {
    const r = await this.api('POST', '/api/auth/register', { name, password });
    this.guardaSessao(r);
    return r;
  }

  async entrar(name, password) {
    const r = await this.api('POST', '/api/auth/login', { name, password });
    this.guardaSessao(r);
    return r;
  }

  sair() {
    this.api('POST', '/api/auth/logout').catch(() => {});
    this.token = this.playerId = this.playerName = null;
    localStorage.removeItem('fb_token');
    localStorage.removeItem('fb_playerId');
    localStorage.removeItem('fb_playerName');
    try { this.ws?.close(); } catch { /* nada */ }
  }

  me() { return this.api('GET', '/api/me'); }
  listarPartidas() { return this.api('GET', '/api/games'); }
  criarPartida(o) { return this.api('POST', '/api/games', o); }
  entrarPartida(id, team) { return this.api('POST', `/api/games/${id}/join`, { team }); }
  sairPartida(id) { return this.api('POST', `/api/games/${id}/leave`, {}); }
  iniciar(id) { return this.api('POST', `/api/games/${id}/start`, {}); }
  estado(id) { return this.api('GET', `/api/games/${id}/state`); }
  replay(id) { return this.api('GET', `/api/games/${id}/replay?full=1`); }
  declarar(id) { return this.api('POST', `/api/games/${id}/declare`, {}); }
  goleiro(id, dados) { return this.api('POST', `/api/games/${id}/keeper`, dados); }
  cobrar(id, dados) { return this.api('POST', `/api/games/${id}/place`, dados); }
  chamarIA(id, team) { return this.api('POST', `/api/games/${id}/bot`, { team }); }

  /**
   * Transmite como a palheta está posicionada AGORA. Vai pelo WebSocket porque
   * dispara a cada mexida no controle; o REST fica de reserva.
   */
  mirar(gameId, buttonId, palheta) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ op: 'aim', gameId, buttonId, palheta }));
      return Promise.resolve();
    }
    return this.api('POST', `/api/games/${gameId}/aim`, { buttonId, palheta }).catch(() => {});
  }
  jogar(id, mv) { return this.api('POST', `/api/games/${id}/move`, mv); }
  esperarIA(id, team) { return this.api('POST', `/api/games/${id}/aguardar`, { team }); }
  encerrar(id) { return this.api('POST', `/api/games/${id}/encerrar`); }
  cancelarEspera(id, team) { return this.api('DELETE', `/api/games/${id}/aguardar?team=${team}`); }
  regras() { return this.api('GET', '/api/rules'); }
  seguranca() { return this.api('GET', '/api/seguranca'); }

  conectar() {
    if (!this.token) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.tentativas = 0;
      ws.send(JSON.stringify({ op: 'connect', token: this.token }));
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }

      if (m.op === 'connack') {
        this.emit('conectado', m);
        if (this.assinados.size) ws.send(JSON.stringify({ op: 'subscribe', topics: [...this.assinados] }));
        return;
      }
      if (m.op !== 'message') return;

      // Todo tópico que chega passa por aqui, cru. A aba de depuração escuta
      // isto para mostrar o que o servidor publica a cada jogada — sem isso,
      // só dá para investigar abrindo o DevTools.
      this.emit('topico', { topic: m.topic, payload: m.payload, t: Date.now() });

      const t = m.topic;
      if (t.endsWith('/state')) this.emit('estado', m.payload);
      else if (t.endsWith('/aim')) this.emit('mira', m.payload);
      else if (t.endsWith('/keeper')) this.emit('goleiro', m.payload);
      else if (t.endsWith('/place')) this.emit('cobranca', m.payload);
      else if (t.endsWith('/turn')) this.emit('vez', m.payload);
      else if (t.endsWith('/event')) this.emit('evento', m.payload);
      else if (t.endsWith('/chat')) this.emit('chat', m.payload);
      else if (t.endsWith('/lobby')) this.emit('lobby', m.payload);
      else if (t === 'lobby/games') this.emit('partidas', m.payload);
    };

    ws.onclose = () => {
      this.ws = null;
      this.emit('desconectado');
      const espera = Math.min(8000, 800 * 2 ** this.tentativas++);
      setTimeout(() => this.conectar(), espera);
    };
    ws.onerror = () => { /* onclose cuida da reconexão */ };
  }

  assinar(topicos) {
    for (const t of topicos) this.assinados.add(t);
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op: 'subscribe', topics: topicos }));
  }

  desassinar(topicos) {
    for (const t of topicos) this.assinados.delete(t);
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op: 'unsubscribe', topics: topicos }));
  }

  mandarChat(gameId, texto) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ op: 'publish', topic: `game/${gameId}/chat`, payload: { texto } }));
    }
  }
}
