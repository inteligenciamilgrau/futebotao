// Cliente de API + broker para bots. Sem dependências (usa fetch/WebSocket do Node 20+).

/**
 * A senha da conta do bot, e o aviso de quando ela PRECISA ser trocada.
 *
 * Ordem: --password, depois BOT_PASSWORD, depois um padrão que está escrito
 * no código-fonte. O padrão serve para você brincar na sua máquina e mais
 * nada — quem tiver o repositório sabe a senha.
 */
export function senhaDeBot({ nome, padrao, arg = null }) {
  if (arg) return String(arg);
  if (process.env.BOT_PASSWORD) return process.env.BOT_PASSWORD;
  avisarSenhaPadrao(nome, padrao);
  return padrao;
}

let jaAvisou = false;

/** Um aviso por processo, difícil de não ver. */
function avisarSenhaPadrao(nome, padrao) {
  if (jaAvisou) return;
  jaAvisou = true;
  const linhas = [
    "",
    "  ┌────────────────────────────────────────────────────────────────────┐",
    "  │  ATENÇÃO: SENHA PADRÃO EM USO                                      │",
    "  └────────────────────────────────────────────────────────────────────┘",
    `  O bot \"${nome}\" entrou com a senha padrão \"${padrao}\", que está`,
    "  escrita no código-fonte deste repositório.",
    "",
    "  TROQUE ANTES DE:",
    "    • deixar o servidor acessível a outras pessoas (ele escuta em",
    "      0.0.0.0, ou seja, TODA a sua rede local já alcança);",
    "    • expor a porta na internet, por túnel ou redirecionamento;",
    "    • publicar este repositório com dados de jogo de verdade.",
    "",
    "  Quem souber a senha entra na conta deste bot e joga por ele.",
    "",
    "  COMO TROCAR (qualquer um dos dois):",
    "    export BOT_PASSWORD='algo bem seu'",
    "    node bot/ai-bot.js --password='algo bem seu' ...",
    "",
  ];
  console.warn(linhas.join("\n"));
}

export class FutebolClient {
  constructor({ base = 'http://localhost:3000', name, password, kind = 'ai', model = null, verbose = true } = {}) {
    this.base = base.replace(/\/$/, '');
    this.name = name;
    this.password = password;
    this.kind = kind;
    this.model = model;
    this.verbose = verbose;
    this.token = null;
    this.playerId = null;
    this.ws = null;
    this.handlers = new Map();     // topicPrefix -> fn
    this.onTurn = null;
    this.onEvent = null;
    this.reconnectMs = 1500;
    this.closing = false;
  }

  log(...a) { if (this.verbose) console.log(...a); }

  /* ---------------- REST ---------------- */

  async api(method, p, body) {
    const res = await fetch(this.base + p, {
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
      e.code = json.code || null;
      e.body = json;
      throw e;
    }
    return json;
  }

  /** Registra, ou faz login se o nome já existir. */
  async auth() {
    try {
      const r = await this.api('POST', '/api/auth/register', { name: this.name, password: this.password, kind: this.kind, model: this.model });
      this.token = r.token; this.playerId = r.playerId;
      this.log(`[${this.name}] registrado como ${this.playerId}`);
    } catch (err) {
      if (err.status !== 409) throw err;
      const r = await this.api('POST', '/api/auth/login', { name: this.name, password: this.password });
      this.token = r.token; this.playerId = r.playerId;
      this.log(`[${this.name}] login como ${this.playerId}`);
    }
    return this.playerId;
  }

  listGames() { return this.api('GET', '/api/games'); }
  createGame(opts) { return this.api('POST', '/api/games', opts); }
  join(gameId, team, autoStart = false, convite = null) {
    // `convite` abre uma vaga que foi GUARDADA para uma IA (POST /aguardar).
    return this.api('POST', `/api/games/${gameId}/join`, { team, autoStart, convite });
  }
  start(gameId) { return this.api('POST', `/api/games/${gameId}/start`, {}); }
  move(gameId, move) { return this.api('POST', `/api/games/${gameId}/move`, move); }
  rules() { return this.api('GET', '/api/rules'); }
  declarar(gameId) { return this.api('POST', `/api/games/${gameId}/declare`, {}); }
  goleiro(gameId, dados) { return this.api('POST', `/api/games/${gameId}/keeper`, dados); }
  cobrar(gameId, dados) { return this.api('POST', `/api/games/${gameId}/place`, dados); }

  /** Mostra a palheta para quem está assistindo, antes de bater. */
  mirar(gameId, buttonId, palheta) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ op: 'aim', gameId, buttonId, palheta }));
      return Promise.resolve(null);
    }
    return this.api('POST', `/api/games/${gameId}/aim`, { buttonId, palheta }).catch(() => null);
  }

  /**
   * Transmite a configuração da palheta como uma SEQUÊNCIA de passos, para
   * quem assiste ver o ajuste acontecendo em vez de um estado pronto.
   * Cada item de `etapas` é uma palheta; entre elas interpola `suavizar` quadros.
   */
  async mirarPassoAPasso(gameId, buttonId, etapas, { suavizar = 3, intervalo = 90 } = {}) {
    const lista = etapas.filter(Boolean);
    if (!lista.length) return;
    const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

    await this.mirar(gameId, buttonId, lista[0]);
    await dorme(intervalo);

    for (let i = 1; i < lista.length; i++) {
      const de = lista[i - 1], para = lista[i];
      for (let k = 1; k <= suavizar; k++) {
        const u = k / suavizar;
        await this.mirar(gameId, buttonId, interpolarPalheta(de, para, u));
        await dorme(intervalo);
      }
    }
  }

  /**
   * Puxa estado sob demanda. É AQUI que o bot decide quanto token gastar.
   * @param {object} o { brief, describe, frame, history }
   */
  state(gameId, o = {}) {
    const q = new URLSearchParams();
    if (o.brief) q.set('brief', '1');
    if (o.describe) q.set('describe', '1');
    if (o.frame) q.set('frame', '1');
    if (o.history != null) q.set('history', String(o.history));
    const qs = q.toString();
    return this.api('GET', `/api/games/${gameId}/state${qs ? '?' + qs : ''}`);
  }

  historico(gameId, since = 0) { return this.api('GET', `/api/games/${gameId}/log?since=${since}`); }

  /* ---------------- Broker ---------------- */

  connectWS(topics = []) {
    return new Promise((resolve, reject) => {
      const url = this.base.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(this.token);
      const ws = new WebSocket(url);
      this.ws = ws;
      let pronto = false;

      ws.onopen = () => {
        ws.send(JSON.stringify({ op: 'connect', token: this.token }));
      };

      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }

        if (m.op === 'connack') {
          if (!m.ok) return reject(new Error(m.error));
          if (topics.length) ws.send(JSON.stringify({ op: 'subscribe', topics }));
          if (!pronto) { pronto = true; resolve(this); }
          return;
        }
        if (m.op === 'message') this._dispatch(m);
      };

      ws.onerror = (e) => { if (!pronto) reject(e); };
      ws.onclose = () => {
        this.ws = null;
        if (this.closing) return;
        this.log(`[${this.name}] conexão caiu, reconectando em ${this.reconnectMs}ms`);
        setTimeout(() => this.connectWS(topics).catch(() => {}), this.reconnectMs);
      };
    });
  }

  subscribe(topics) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op: 'subscribe', topics }));
  }

  chat(gameId, texto) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op: 'publish', topic: `game/${gameId}/chat`, payload: { texto } }));
  }

  on(prefixo, fn) { this.handlers.set(prefixo, fn); return this; }

  /**
   * Registra o tratador da vez com duas garantias que um bot sério precisa:
   *
   * 1. Se um aviso chegar enquanto o anterior ainda está sendo processado, ele
   *    NÃO é descartado: reexecuta ao terminar. Com as regras novas o jogador
   *    mantém a vez depois de uma jogada limpa, então o segundo aviso chega
   *    logo em seguida — descartá-lo trava o bot até estourar o tempo.
   * 2. Uma sondagem periódica de reserva. Notificação é o caminho rápido, mas
   *    depender só dela significa perder o turno se uma mensagem se perder.
   */
  tratarVez(gameId, fn, { sondagemMs = 4000 } = {}) {
    let ocupado = false;
    let pendente = false;

    const rodar = async (payload) => {
      if (ocupado) { pendente = true; return; }
      ocupado = true;
      try {
        await fn(payload);
      } catch (e) {
        console.error('  erro no turno:', e.message);
      } finally {
        ocupado = false;
        if (pendente) { pendente = false; setTimeout(() => rodar(payload), 40); }
      }
    };

    this.onTurn = rodar;

    // Rede de segurança: se for a nossa vez e ninguém nos avisou, joga assim mesmo.
    this._sondagem = setInterval(async () => {
      if (ocupado || this.closing) return;
      try {
        const st = await this.state(gameId, { brief: true });
        if (st.status !== 'running') return;
        if (st.currentPlayerId === this.playerId) rodar(st);
      } catch { /* servidor fora do ar: a próxima sondagem tenta de novo */ }
    }, sondagemMs);

    return this;
  }

  _dispatch(m) {
    for (const [pre, fn] of this.handlers) {
      if (m.topic.startsWith(pre) || m.topic.includes(pre)) {
        try { fn(m.payload, m); } catch (e) { console.error('handler:', e.message); }
      }
    }
    if (m.topic.startsWith('player/') && m.topic.endsWith('/turn') && this.onTurn) this.onTurn(m.payload);
    if (m.topic.endsWith('/event') && this.onEvent) this.onEvent(m.payload);
  }

  close() {
    this.closing = true;
    clearInterval(this._sondagem);
    try { this.ws?.close(); } catch { /* nada */ }
  }
}

/* ---------------- Geometria útil para qualquer bot ---------------- */

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Interpola duas palhetas. O ângulo vai pelo caminho curto do círculo. */
export function interpolarPalheta(de, para, u) {
  let d = ((para.anguloAro - de.anguloAro) % 360 + 540) % 360 - 180;
  return {
    anguloAro: ((de.anguloAro + d * u) % 360 + 360) % 360,
    inclinacao: de.inclinacao + (para.inclinacao - de.inclinacao) * u,
    avanco: de.avanco + (para.avanco - de.avanco) * u,
    forca: de.forca + (para.forca - de.forca) * u,
  };
}

/**
 * A caixa do goleiro cabe aí sem invadir ninguém?
 *
 * O servidor RECUSA pôr o goleiro por cima da bola, de um botão ou da trave
 * (`obstaculoDoGoleiro`, em server/game.js). Sem esta conta o bot mandava a
 * posição, tomava 400 e a partida dele parava ali. É a mesma geometria: o
 * ponto do retângulo mais próximo do centro do círculo, em coordenadas da
 * caixa.
 *
 * @param {{x,y,w,h,ang?,anguloDeg?}} caixa a posição PRETENDIDA
 * @param {Array<{x,y,r,id}>} corpos o que já está na mesa
 * @returns {boolean}
 */
export function caixaLivre(caixa, corpos) {
  const ang = caixa.ang ?? ((caixa.anguloDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(-ang), sin = Math.sin(-ang);
  const hw = caixa.w / 2, hh = caixa.h / 2;

  for (const c of corpos) {
    if (!Number.isFinite(c.r)) continue;
    const dx = c.x - caixa.x, dy = c.y - caixa.y;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    // Centro dentro do retângulo já é invasão, não importa o raio.
    if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) return false;
    const fx = Math.max(Math.abs(lx) - hw, 0);
    const fy = Math.max(Math.abs(ly) - hh, 0);
    if (Math.hypot(fx, fy) < c.r) return false;
  }
  return true;
}

/**
 * Distância do segmento a um retângulo orientado (o goleiro caixa).
 * O `r` da caixa é só o raio envolvente (8,31 cm) — usá-lo faria quase toda
 * linha parecer bloqueada e esconderia a fresta ao lado do goleiro.
 */
function distSegmentoCaixa(from, to, caixa) {
  const ang = caixa.ang ?? ((caixa.anguloDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(-ang), sin = Math.sin(-ang);
  const local = (px, py) => {
    const dx = px - caixa.x, dy = py - caixa.y;
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  };
  const a = local(from.x, from.y), b = local(to.x, to.y);
  const hw = caixa.w / 2, hh = caixa.h / 2;
  const aoRet = (p) => Math.hypot(Math.max(Math.abs(p.x) - hw, 0), Math.max(Math.abs(p.y) - hh, 0));

  const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
  let menor = Infinity;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const d = aoRet({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    if (d < menor) menor = d;
    if (menor === 0) break;
  }
  return menor;
}

/** O que atravessa o caminho reto de `from` a `to`. */
export function blockers(from, to, bodies, ignore = [], rm = 2.4) {
  const out = [];
  const dx = to.x - from.x, dy = to.y - from.y;
  const len2 = dx * dx + dy * dy;
  for (const b of bodies) {
    if (ignore.includes(b.id)) continue;
    if (b.forma === 'caixa' && b.w && b.h) {
      if (distSegmentoCaixa(from, to, b) < rm - 0.3) out.push(b.id);
      continue;
    }
    let t = len2 === 0 ? 0 : ((b.x - from.x) * dx + (b.y - from.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(b.x - (from.x + t * dx), b.y - (from.y + t * dy));
    if (d < b.r + rm - 0.3) out.push(b.id);
  }
  return out;
}

/** Ponto atrás da bola na direção do alvo — onde o botão precisa acertar. */
export function pontoDeAtaque(bola, alvo, recuo) {
  const a = Math.atan2(alvo.y - bola.y, alvo.x - bola.x);
  return { x: bola.x - Math.cos(a) * recuo, y: bola.y - Math.sin(a) * recuo };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v === undefined ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true) : v;
    } else out._.push(a);
  }
  return out;
}
