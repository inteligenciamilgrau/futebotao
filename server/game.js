// Estado da partida, formações, sistema de turnos e regras.
// Servidor é autoritativo: o cliente só desenha o que sai daqui.

import { PITCH, PHYS, RULES_DEFAULT, KEEPER } from './config.js';
import { makeBody, simulate, settle, goalPosts, contatoCirculoCaixa } from './physics.js';
import { newId } from './util.js';
import { resolverPalheta, palhetaPara, pontoDeApoio } from './palheta.js';
import { getPlayer } from './store.js';

/* ------------------------------------------------------------------ */
/* Formações                                                           */
/* ------------------------------------------------------------------ */

/** Distribui n botões de linha na metade defensiva do time. */
function formation(team, n) {
  const mirror = team === 'B';
  const nDef = Math.max(1, Math.round(n * 0.4));
  const nMid = n <= 2 ? 0 : Math.max(1, Math.round(n * 0.32));
  const nAtk = Math.max(0, n - nDef - nMid);

  const linhas = [
    { count: nDef, depth: 0.17 },
    { count: nMid, depth: 0.31 },
    { count: nAtk, depth: 0.44 },
  ].filter((l) => l.count > 0);

  const out = [];
  for (const linha of linhas) {
    const x = PITCH.length * linha.depth;
    // A faixa cresce com o número de jogadores e fica CENTRADA. Espalhar sempre
    // de ponta a ponta deixaria o corredor central vazio numa linha de dois.
    const faixa = Math.min(PITCH.width - 24, 30 * linha.count - 20);
    for (let i = 0; i < linha.count; i++) {
      const y = linha.count === 1
        ? PITCH.width / 2
        : PITCH.width / 2 - faixa / 2 + (faixa * i) / (linha.count - 1);
      out.push({ x: mirror ? PITCH.length - x : x, y });
    }
  }
  return out;
}

function buildBodies(cfg) {
  const bodies = [];
  for (const team of ['A', 'B']) {
    const gx = team === 'A' ? 5 : PITCH.length - 5;
    // Caixa de fósforo: atravessada na frente do gol, na posição padrão.
    bodies.push(makeBody({
      id: team + 'G', label: team + 'G', kind: 'keeper', team, forma: 'caixa',
      x: gx, y: PITCH.width / 2,
      w: KEEPER.comprimento, h: KEEPER.espessura,
      ang: Math.PI / 2,          // em pé, cobrindo a boca do gol
      m: 0, fixed: true,
    }));
    formation(team, cfg.buttonsPerTeam).forEach((p, i) => {
      bodies.push(makeBody({
        id: team + (i + 1), label: team + (i + 1), kind: 'button', team,
        x: p.x, y: p.y, r: PHYS.buttonRadius, m: PHYS.buttonMass,
      }));
    });
  }
  bodies.push(makeBody({
    id: 'ball', label: 'ball', kind: 'ball', team: null,
    x: PITCH.length / 2, y: PITCH.width / 2, r: PHYS.ballRadius, m: PHYS.ballMass,
  }));
  return bodies;
}

/** Guarda um ajuste de palheta do turno corrente (para rever depois). */
export function registrarAjuste(game, payload) {
  if (!game.aimHistory) game.aimHistory = [];
  const ultimo = game.aimHistory[game.aimHistory.length - 1];
  const igual = ultimo && ultimo.buttonId === payload.buttonId
    && ultimo.palheta.anguloAro === payload.palheta.anguloAro
    && ultimo.palheta.inclinacao === payload.palheta.inclinacao
    && ultimo.palheta.avanco === payload.palheta.avanco
    && ultimo.palheta.forca === payload.palheta.forca;
  if (igual) return;                       // nada mudou, não vira passo

  game.aimHistory.push({
    t: Date.now(),
    playerId: payload.playerId,
    playerName: payload.playerName,
    buttonId: payload.buttonId,
    botao: payload.botao,
    palheta: payload.palheta,
    apoio: payload.apoio,
    direcao: payload.direcao,
    rendimento: payload.rendimento,
    velocidade: payload.velocidade,
    escorregou: payload.escorregou,
    cavada: payload.cavada,
    aviso: payload.aviso,
    previsao: payload.previsao,
  });
  // Um ajuste muito longo não interessa: guardamos os últimos.
  if (game.aimHistory.length > 60) game.aimHistory.shift();
}

/**
 * Prazo de um turno. **0 quer dizer SEM LIMITE**, não prazo zero — devolver
 * Date.now() aqui faria o turno estourar no mesmo instante em que começa.
 * `checkTimeout` já ignora prazo nulo.
 */
function prazo(ms) {
  return ms > 0 ? Date.now() + ms : null;
}

/** PRNG semeado na partida: parece aleatório, mas é reproduzível. */
function rng(game) {
  game.rngState = (game.rngState + 0x6d2b79f5) | 0;
  let t = game.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Recoloca tudo para a saída de bola do time `kicking`. */
function kickoff(game, kicking) {
  game.bodies = buildBodies(game.config);
  const ball = game.bodies.find((b) => b.kind === 'ball');
  ball.x = PITCH.length / 2;
  ball.y = PITCH.width / 2;

  // Ninguém recoloca os botões no milímetro. Sem esse desvio, dois bots
  // determinísticos jogariam a mesma sequência de lances até o fim do jogo.
  const j = game.config.kickoffJitter || 0;
  if (j > 0) {
    for (const b of game.bodies) {
      if (b.kind !== 'button') continue;
      b.x += (rng(game) * 2 - 1) * j;
      b.y += (rng(game) * 2 - 1) * j;
    }
  }

  // O time defensor sai do círculo central.
  const defending = kicking === 'A' ? 'B' : 'A';
  for (const b of game.bodies) {
    if (b.team !== defending || b.kind === 'keeper') continue;
    const d = Math.hypot(b.x - ball.x, b.y - ball.y);
    const minD = PITCH.centerCircle + b.r + 1;
    if (d < minD) {
      const ang = d < 0.01 ? (defending === 'A' ? Math.PI : 0) : Math.atan2(b.y - ball.y, b.x - ball.x);
      b.x = ball.x + Math.cos(ang) * minD;
      b.y = ball.y + Math.sin(ang) * minD;
    }
  }

  // Quem bate a saída fica encostado atrás da bola.
  const kicker = game.bodies.find((b) => b.team === kicking && b.kind === 'button');
  if (kicker) {
    kicker.x = ball.x + (kicking === 'A' ? -1 : 1) * (ball.r + kicker.r + 1.5);
    kicker.y = ball.y;
  }

  settle(game.bodies, goalPosts());
  clampAll(game.bodies);
  // Saída de bola é bola parada: não se declara chute a gol nela.
  game.reinicio = 'saída de bola';
}

function clampAll(bodies) {
  for (const b of bodies) {
    if (b.kind === 'ball' || b.forma === 'caixa') continue;
    // O botão anda pela mesa inteira: o campo mais a faixa de fora. Quem para
    // na linha é a bola, não ele.
    const m = PITCH.margemFora;
    b.x = Math.min(PITCH.length + m - b.r, Math.max(-m + b.r, b.x));
    b.y = Math.min(PITCH.width + m - b.r, Math.max(-m + b.r, b.y));
  }
}

/** A área onde o goleiro daquele time pode ser posto. */
export function areaDoGoleiro(team) {
  return team === 'A'
    ? { xMin: 2, xMax: PITCH.areaLength, yMin: PITCH.areaMin, yMax: PITCH.areaMax }
    : { xMin: PITCH.length - PITCH.areaLength, xMax: PITCH.length - 2, yMin: PITCH.areaMin, yMax: PITCH.areaMax };
}

export function goleiroDe(game, team) {
  return game.bodies.find((b) => b.kind === 'keeper' && b.team === team);
}

/**
 * O que está no caminho de pôr a caixa do goleiro ali — ou `null` se o lugar
 * está livre.
 *
 * A área do goleiro é a mesma área onde a bola morre e onde os atacantes se
 * amontoam, então "está dentro da área" não basta como regra. Antes daqui o
 * código chamava `settle()` depois de mover a caixa: a caixa entrava por cima
 * de um botão e o motor EMPURRAVA O BOTÃO para fora. Quem defendia ganhava um
 * jeito de reposicionar as peças do atacante só arrastando o goleiro por
 * cima delas — e a bola, encostada na trave, saía do lugar junto.
 *
 * A geometria é a mesma do motor (`contatoCirculoCaixa`), importada em vez de
 * reescrita: duas fórmulas de contato divergindo em silêncio é o defeito que
 * mais custa caro aqui.
 *
 * @param {{x,y,w,h,ang}} caixa a posição PRETENDIDA, ainda não aplicada
 * @returns {{id:string, kind:string}|null}
 */
export function obstaculoDoGoleiro(caixa, game, ignorarId) {
  // Uma folga de meio milímetro: encostar é permitido, invadir não. Sem ela o
  // arredondamento de 0,1 cm das coordenadas transforma um encoste exato em
  // recusa intermitente.
  const FOLGA = 0.05;

  const candidatos = [
    ...game.bodies.filter((b) => b.id !== ignorarId && b.kind !== 'keeper'),
    ...goalPosts(),
  ];

  for (const c of candidatos) {
    if (!Number.isFinite(c.r)) continue;                 // só corpos redondos
    const t = contatoCirculoCaixa({ x: c.x, y: c.y, r: c.r - FOLGA }, caixa);
    if (t && t.prof > 0) return { id: c.id, kind: c.kind };
  }
  return null;
}

/** Como chamar cada estorvo na mensagem de erro, já com a preposição. */
function nomeDoEstorvo(o) {
  if (o.kind === 'ball') return 'da bola';
  if (o.kind === 'post') return 'da trave';
  return `do botão ${o.id}`;
}

/** Recoloca a caixa na posição padrão: atravessada na frente do gol. */
function goleiroPadrao(game, team) {
  const k = goleiroDe(game, team);
  if (!k) return;
  k.x = team === 'A' ? 5 : PITCH.length - 5;
  k.y = PITCH.width / 2;
  k.ang = Math.PI / 2;
}

/* ------------------------------------------------------------------ */
/* Criação e entrada de jogadores                                      */
/* ------------------------------------------------------------------ */

/** Vagas por time: no mínimo 1, no máximo 6 (o que o formulário oferece). */
function vagasValidas(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(6, Math.max(1, v)) : 1;
}

/** Nome de time: sempre texto, sempre curto. */
function nomeDeTime(nome, padrao) {
  const limpo = String(nome ?? '').trim().slice(0, 20);
  return limpo || padrao;
}

export function createGame(opts = {}) {
  const config = { ...RULES_DEFAULT, ...(opts.config || {}) };
  config.buttonsPerTeam = Math.max(1, Math.min(11, config.buttonsPerTeam | 0));
  config.touchesPerPossession = Math.max(0, Math.min(10, config.touchesPerPossession | 0));
  config.maxPossessions = Math.max(0, Math.min(400, config.maxPossessions | 0));
  config.maxTurns = Math.max(0, Math.min(2000, config.maxTurns | 0));
  // Prazos: 0 = sem limite. Qualquer valor positivo tem um mínimo praticável.
  const prazoValido = (v, minimo) => {
    const n = Number(v) | 0;
    return n <= 0 ? 0 : Math.max(minimo, Math.min(24 * 60 * 60 * 1000, n));
  };
  config.turnTimeoutMs = prazoValido(config.turnTimeoutMs, 5000);
  config.tempoGoleiroMs = prazoValido(config.tempoGoleiroMs, 5000);
  config.tempoCobrancaMs = prazoValido(config.tempoCobrancaMs, 5000);

  const game = {
    id: newId('gm'),
    name: opts.name || 'Partida',
    createdAt: Date.now(),
    status: 'lobby',                 // lobby | running | finished
    config,
    teams: {
      // Vagas presas entre 1 e 6, como o formulário oferece. Sem teto, um
      // slotsA: 1000000 criava uma partida que nunca fica pronta e trava a
      // mesa para sempre.
      A: { name: nomeDeTime(opts.teamAName, 'Time A'), slots: vagasValidas(opts.slotsA), players: [], score: 0, rotationBase: 0 },
      B: { name: nomeDeTime(opts.teamBName, 'Time B'), slots: vagasValidas(opts.slotsB), players: [], score: 0, rotationBase: 0 },
    },
    bodies: buildBodies(config),
    possession: 'A',
    touchIndex: 0,
    turnNo: 0,
    possessionsPlayed: 0,
    // 'jogada' = o atacante joga; 'goleiro' = o defensor posiciona a caixa.
    fase: 'jogada',
    declarado: false,
    declaradoPor: null,
    // Vagas guardadas para uma IA de fora entrar. Veja reservarVaga.
    reservas: { A: null, B: null },
    cobranca: null,
    reinicio: null,
    miraGuardada: null,
    currentPlayerId: null,
    turnToken: null,
    turnDeadline: null,
    lastShot: null,
    lastResolution: null,
    log: [],
    replay: [],
    // Cada ajuste de palheta do turno atual, para o replay mostrar a configuração.
    aimHistory: [],
    seq: 0,
    ownerId: opts.ownerId || null,
    // Semente derivada do id da partida: mesma partida -> mesma sequência.
    seed: opts.seed ?? [...newId('s')].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7),
    rngState: 0,
  };
  game.rngState = game.seed;
  settle(game.bodies, goalPosts());
  return game;
}

export function joinGame(game, playerId, teamPref, convite = null) {
  if (game.status === 'finished') throw httpErr(409, 'partida encerrada', { code: 'GAME_FINISHED' });
  for (const t of ['A', 'B']) {
    if (game.teams[t].players.includes(playerId)) return { team: t, already: true };
  }
  let team = teamPref;
  if (team !== 'A' && team !== 'B') {
    // Auto: o time com mais vagas. Uma vaga guardada para uma IA não conta
    // como livre — a não ser para quem chega com o convite dela.
    const daPara = (t) => game.teams[t].slots - game.teams[t].players.length
      - (game.reservas?.[t] && game.reservas[t].convite !== convite ? 1 : 0);
    team = daPara('A') >= daPara('B') ? 'A' : 'B';
  }
  const T = game.teams[team];
  if (T.players.length >= T.slots) throw httpErr(409, `time ${team} está cheio (${T.slots} vaga(s))`, { code: 'TEAM_FULL' });

  // Vaga guardada para uma IA: entra quem traz o convite.
  const reserva = game.reservas?.[team];
  if (reserva && T.slots - T.players.length <= 1) {
    if (convite !== reserva.convite) {
      throw httpErr(409,
        `o time ${team} está guardando a vaga para uma IA; é preciso o convite para entrar`,
        { code: 'SLOT_RESERVED' });
    }
    game.reservas[team] = null;
  }

  T.players.push(playerId);
  pushLog(game, { type: 'join', team, playerId, convidado: !!reserva });
  return { team, already: false, convidado: !!reserva };
}

/**
 * Guarda uma vaga para uma IA de fora — uma LLM, um subagente, qualquer coisa
 * que fale a API.
 *
 * Sem isso não dá para "esperar" um adversário assim: o tempo entre pedir a uma
 * LLM que jogue e ela de fato entrar é justamente quando alguém do lobby ocupa
 * a vaga. A reserva vem com um convite — quem apresenta o convite entra, os
 * outros veem a mesa cheia.
 */
export function reservarVaga(game, playerId, team, { nota = null } = {}) {
  if (game.status === 'finished') throw httpErr(409, 'partida encerrada', { code: 'GAME_FINISHED' });
  if (!game.reservas) game.reservas = { A: null, B: null };

  if (team !== 'A' && team !== 'B') {
    team = vagasLivres(game, 'A') >= vagasLivres(game, 'B') ? 'A' : 'B';
  }
  if (game.reservas[team]) {
    throw httpErr(409, `o time ${team} já está esperando uma IA`,
      { code: 'ALREADY_RESERVED', reserva: reservaPublica(game.reservas[team]) });
  }
  if (vagasLivres(game, team) <= 0) {
    throw httpErr(409, `time ${team} está cheio`, { code: 'TEAM_FULL' });
  }

  const reserva = { team, convite: newId('cvt', 16), por: playerId, criadaEm: Date.now(), nota };
  game.reservas[team] = reserva;
  pushLog(game, { type: 'reserva', team, playerId });
  return reserva;
}

/** Desfaz a reserva. Só quem pediu a espera (ou o dono da partida) pode. */
export function liberarVaga(game, playerId, team) {
  const r = game.reservas?.[team];
  if (!r) throw httpErr(404, `o time ${team} não está esperando ninguém`, { code: 'NO_RESERVATION' });
  if (r.por !== playerId && game.ownerId !== playerId) {
    throw httpErr(403, 'quem cancela a espera é quem a pediu', { code: 'NOT_YOURS' });
  }
  game.reservas[team] = null;
  pushLog(game, { type: 'reservaCancelada', team, playerId });
  return { team, liberada: true };
}

/** A reserva SEM o convite: é o que pode ir para o lobby de todo mundo. */
export function reservaPublica(r) {
  if (!r) return null;
  return { team: r.team, esperando: true, desde: r.criadaEm, nota: r.nota || null };
}

/** Vagas de fato livres no time — uma reserva ocupa uma. */
export function vagasLivres(game, team) {
  const T = game.teams[team];
  return Math.max(0, T.slots - T.players.length - (game.reservas?.[team] ? 1 : 0));
}

export function leaveGame(game, playerId) {
  for (const t of ['A', 'B']) {
    const i = game.teams[t].players.indexOf(playerId);
    if (i >= 0) {
      game.teams[t].players.splice(i, 1);
      pushLog(game, { type: 'leave', team: t, playerId });
      if (game.status === 'running' && game.currentPlayerId === playerId) advanceTurn(game, true);
      return t;
    }
  }
  return null;
}

export function isReady(game) {
  return game.teams.A.players.length === game.teams.A.slots
      && game.teams.B.players.length === game.teams.B.slots;
}

export function startGame(game) {
  if (game.status === 'running') return game;
  if (game.teams.A.players.length === 0 || game.teams.B.players.length === 0)
    throw httpErr(409, 'cada time precisa de pelo menos um jogador', { code: 'NOT_ENOUGH_PLAYERS' });
  game.status = 'running';
  game.replay = [];
  game.possession = 'A';
  game.touchIndex = 0;
  game.turnNo = 0;
  game.possessionsPlayed = 0;
  game.fase = 'jogada';
  game.declarado = false;
  game.declaradoPor = null;
  kickoff(game, 'A');
  goleiroPadrao(game, 'A');
  goleiroPadrao(game, 'B');
  pushLog(game, { type: 'start' });
  beginTurn(game);
  abrirSaida(game);
  return game;
}

/* ------------------------------------------------------------------ */
/* Turnos                                                              */
/* ------------------------------------------------------------------ */

function playerOnTurn(game) {
  const T = game.teams[game.possession];
  if (T.players.length === 0) return null;
  const i = (T.rotationBase + game.touchIndex) % T.players.length;
  return T.players[i];
}

function beginTurn(game) {
  game.turnNo += 1;
  game.aimHistory = [];
  game.currentPlayerId = playerOnTurn(game);
  game.turnToken = newId('trn');
  game.turnDeadline = prazo(game.config.turnTimeoutMs);
  return game.turnToken;
}

/** Passa a posse para o outro time e começa novo turno. */
function flipPossession(game, motivo) {
  game.teams[game.possession].rotationBase += 1;
  game.possession = game.possession === 'A' ? 'B' : 'A';
  game.touchIndex = 0;
  game.possessionsPlayed += 1;
  game.declarado = false;
  game.declaradoPor = null;
  if (game.config.maxPossessions > 0 && game.possessionsPlayed >= game.config.maxPossessions) {
    finishGame(game, motivo);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Reposições depois de a bola sair                                    */
/* ------------------------------------------------------------------ */

/**
 * A bola cruzou uma linha. Recoloca de acordo com onde saiu e com quem vai
 * cobrar. O time que cobra é sempre o adversário de quem acabou de jogar.
 * @returns {{tipo, x, y}} descrição da reposição
 */
function reporBolaFora(game, fora, quemCobra) {
  const ball = game.bodies.find((b) => b.kind === 'ball');
  const margem = 3;
  let rep;

  if (fora.linha === 'lateral') {
    // Em cima da linha, como na mesa de verdade: a bola fica na risca e o
    // botão vem de fora para trazê-la de volta ao jogo.
    rep = {
      tipo: 'lateral',
      x: Math.max(margem, Math.min(PITCH.length - margem, fora.x)),
      y: fora.lado === 'cima' ? PITCH.width : 0,
    };
  } else if (quemCobra === fora.gol) {
    // Quem cobra é quem defende aquela linha: tiro de meta.
    rep = {
      tipo: 'tiro de meta',
      x: fora.gol === 'A' ? PITCH.areaLength * 0.4 : PITCH.length - PITCH.areaLength * 0.4,
      y: PITCH.width / 2,
    };
  } else {
    // Saiu pela linha de fundo do adversário de quem cobra: escanteio.
    // Escanteio: a bola no canto, em cima das duas linhas.
    rep = {
      tipo: 'escanteio',
      x: fora.gol === 'A' ? 0 : PITCH.length,
      y: fora.y > PITCH.width / 2 ? PITCH.width : 0,
    };
  }

  ball.x = rep.x;
  ball.y = rep.y;
  ball.vx = 0; ball.vy = 0;

  // Abre espaço: ninguém pode estar em cima da bola na reposição.
  afastarDaBola(game, quemCobra === 'A' ? 'B' : 'A', 10);
  settle(game.bodies, goalPosts(), 30);
  clampAll(game.bodies);
  return rep;
}

/** Empurra os botões de `team` para fora de um raio ao redor da bola. */
function afastarDaBola(game, team, raio) {
  const ball = game.bodies.find((b) => b.kind === 'ball');
  for (const b of game.bodies) {
    if (b.team !== team || b.kind !== 'button') continue;
    const d = Math.hypot(b.x - ball.x, b.y - ball.y);
    if (d >= raio) continue;
    const ang = d < 0.01 ? 0 : Math.atan2(b.y - ball.y, b.x - ball.x);
    b.x = ball.x + Math.cos(ang) * raio;
    b.y = ball.y + Math.sin(ang) * raio;
  }
}

/* ------------------------------------------------------------------ */
/* Cobrança: posicionar um botão antes de repor a bola em jogo         */
/* ------------------------------------------------------------------ */

/**
 * Abre a fase de cobrança: quem recebe a bola escolhe UM botão e o coloca
 * onde quiser perto da bola, e só depois joga. Vale para lateral, escanteio
 * e tiro de meta — sem isso a bola cairia no canto longe de todo mundo e o
 * time perderia a posse na jogada seguinte por não alcançá-la.
 */
function abrirCobranca(game, tipo, { centro = null, raio = null, maxBotoes = 1, opcional = false, prazoMs = null } = {}) {
  game.fase = 'cobranca';
  // Lateral, escanteio e tiro de meta também são bola parada.
  game.reinicio = tipo;
  game.cobranca = { tipo, botao: null, botoes: [], maxBotoes, centro, raio, opcional, confirmado: false };
  game.turnToken = newId('trn');
  // Cobrança obrigatória tem relógio próprio; a saída de bola, que é opcional,
  // usa o prazo normal da jogada — arrumar os botões faz parte da vez.
  game.turnDeadline = prazo(prazoMs ?? game.config.tempoCobrancaMs);
  game.aimHistory = [];
}

export function raioCobranca(game) {
  return game.config.raioCobranca;
}

/**
 * Saída de bola: a hora de montar a mesa.
 *
 * Os DOIS times arrumam ao mesmo tempo, cada um no seu campo. Quem bate a
 * saída pode adiantar até dois botões para dentro do círculo central; o
 * adversário fica todo do lado dele, fora do círculo. Ninguém é obrigado a
 * mexer: a formação padrão já é válida, e quem bater fecha a fase.
 */
function abrirSaida(game) {
  abrirCobranca(game, 'saída de bola', {
    centro: { x: PITCH.length / 2, y: PITCH.width / 2 },
    raio: PITCH.centerCircle,
    maxBotoes: PITCH.length,           // sem cota: a região é que manda
    prazoMs: game.config.turnTimeoutMs,
    opcional: true,
  });
  game.cobranca.formacao = true;
  game.cobranca.maxNoCirculo = 2;
  game.cobranca.prontos = { A: false, B: false };
}

/** Quantos botões do time já estão dentro do círculo central. */
function noCirculo(game, team, ignorar = null) {
  const cx = PITCH.length / 2, cy = PITCH.width / 2;
  return game.bodies.filter((b) =>
    b.kind === 'button' && b.team === team && b.id !== ignorar
    && Math.hypot(b.x - cx, b.y - cy) <= PITCH.centerCircle).length;
}

/**
 * A região onde um time pode arrumar os botões na saída de bola: o próprio
 * campo, mais o círculo central para quem vai bater.
 */
export function regiaoDeFormacao(game, team) {
  const L = PITCH.length, W = PITCH.width;
  const bate = team === game.possession;
  return {
    tipo: 'formação',
    campo: team === 'A'
      ? { xMin: 0, xMax: L / 2, yMin: 0, yMax: W }
      : { xMin: L / 2, xMax: L, yMin: 0, yMax: W },
    circulo: { x: L / 2, y: W / 2, raio: PITCH.centerCircle },
    // Só quem bate entra no círculo, e no máximo dois.
    podeNoCirculo: bate,
    maxNoCirculo: bate ? (game.cobranca?.maxNoCirculo ?? 2) : 0,
    usadosNoCirculo: noCirculo(game, team),
    bate,
  };
}

/** Confere o ponto pedido contra a região daquele time. Lança se não couber. */
function validarFormacao(game, team, body, nx, ny) {
  const r = regiaoDeFormacao(game, team);
  const dentroDoCirculo = Math.hypot(nx - r.circulo.x, ny - r.circulo.y) <= r.circulo.raio;

  if (dentroDoCirculo) {
    if (!r.podeNoCirculo) {
      throw httpErr(409,
        'só o time que bate a saída entra no círculo central; o seu time fica fora dele',
        { code: 'CIRCLE_IS_THEIRS', regiao: r });
    }
    if (noCirculo(game, team, body.id) >= r.maxNoCirculo) {
      throw httpErr(409,
        `no máximo ${r.maxNoCirculo} botões dentro do círculo central`,
        { code: 'CIRCLE_LIMIT', regiao: r });
    }
    return;                                   // no círculo, meio campo não vale
  }

  const c = r.campo;
  if (nx < c.xMin || nx > c.xMax || ny < c.yMin || ny > c.yMax) {
    throw httpErr(400,
      `na saída de bola cada time fica no seu campo: x entre ${c.xMin} e ${c.xMax}`,
      { code: 'OUT_OF_HALF', regiao: r });
  }
}

/**
 * Onde os botões desta cobrança podem ficar: um círculo, ou em volta da bola.
 * A saída de bola usa o círculo central; lateral e afins usam a bola.
 */
export function areaDaCobranca(game, team = null) {
  const c = game.cobranca;
  if (c?.formacao) {
    return { ...regiaoDeFormacao(game, team || game.possession), maxBotoes: Infinity };
  }
  if (c?.centro) {
    return { tipo: 'círculo central', x: c.centro.x, y: c.centro.y, raio: c.raio, maxBotoes: c.maxBotoes || 1 };
  }
  const ball = game.bodies.find((b) => b.kind === 'ball');
  return { tipo: 'perto da bola', x: ball.x, y: ball.y, raio: raioCobranca(game), maxBotoes: c?.maxBotoes || 1 };
}

/**
 * Move um botão do time que vai cobrar. Pode ser chamado várias vezes
 * (cada uma é difundida); `confirmar` fecha e devolve a vez para jogar.
 */
export function posicionarBotao(game, playerId, { buttonId, x, y, confirmar } = {}) {
  exigirEmAndamento(game);
  if (game.fase !== 'cobranca') throw httpErr(409, 'não há cobrança para posicionar', { code: 'NOT_PLACEMENT_PHASE' });

  // Na formação da saída de bola os dois times arrumam ao mesmo tempo, cada um
  // no seu campo. Nas outras cobranças, só quem cobra mexe.
  const formacao = !!game.cobranca.formacao;
  const meuTime = teamOf(game, playerId);
  if (formacao) {
    if (!meuTime) throw httpErr(403, 'você não está jogando esta partida', { code: 'NOT_IN_GAME' });
    if (game.cobranca.prontos?.[meuTime]) {
      throw httpErr(409, 'você já disse que está pronto', { code: 'ALREADY_READY' });
    }
  } else if (game.currentPlayerId !== playerId) {
    throw httpErr(403, 'quem cobra é o outro jogador', { code: 'NOT_YOUR_TURN', currentPlayerId: game.currentPlayerId });
  }

  const area = areaDaCobranca(game, formacao ? meuTime : null);
  const raio = area.raio;
  if (!game.cobranca.botoes) game.cobranca.botoes = [];

  if (buttonId != null || Number.isFinite(x) || Number.isFinite(y)) {
    const id = buttonId ?? game.cobranca.botao;
    const body = game.bodies.find((b) => b.id === id);
    if (!body) throw httpErr(400, `botão desconhecido: ${id}`, { code: 'UNKNOWN_BUTTON' });
    const dono = formacao ? meuTime : game.possession;
    if (body.team !== dono) throw httpErr(403, `${id} não é do time ${dono}`, { code: 'NOT_YOUR_BUTTON' });
    if (body.kind !== 'button') throw httpErr(400, 'o goleiro é uma caixa: escolha um botão de linha', { code: 'KEEPER_IS_BOX' });

    const jaTem = game.cobranca.botoes.includes(body.id);

    // Formação: vale o próprio campo (e o círculo, para quem bate).
    if (formacao) {
      const nx0 = Number.isFinite(x) ? x : body.x;
      const ny0 = Number.isFinite(y) ? y : body.y;
      validarFormacao(game, meuTime, body, nx0, ny0);
    }

    // Já tem o máximo de botões arrumados e este é mais um? Recusa.
    if (!formacao && !jaTem && game.cobranca.botoes.length >= area.maxBotoes) {
      throw httpErr(409,
        `nesta cobrança você posiciona no máximo ${area.maxBotoes} bot${area.maxBotoes > 1 ? 'ões' : 'ão'} (${game.cobranca.botoes.join(', ')})`,
        { code: 'PLACEMENT_LIMIT', maxBotoes: area.maxBotoes, botoes: [...game.cobranca.botoes] });
    }

    const nx = Number.isFinite(x) ? x : body.x;
    const ny = Number.isFinite(y) ? y : body.y;
    if (!formacao) {
      const d = Math.hypot(nx - area.x, ny - area.y);
      if (d > raio) {
        throw httpErr(400,
          `o botão tem que ficar a até ${raio} cm do centro da área (${area.tipo}); você pediu ${Math.round(d)} cm`,
          { code: 'PLACEMENT_TOO_FAR', raio, area: { tipo: area.tipo, x: area.x, y: area.y, raio } });
      }
    }
    // O botão pode ficar fora das linhas: o limite é a MESA, não o campo. Na
    // formação da saída quem manda é a região do time, já conferida acima.
    const m = formacao ? 0 : PITCH.margemFora;
    if (nx < body.r - m || nx > PITCH.length - body.r + m
        || ny < body.r - m || ny > PITCH.width - body.r + m) {
      throw httpErr(400,
        m > 0 ? `o botão tem que ficar na mesa: até ${m} cm para fora das linhas` : 'o botão tem que ficar dentro do campo',
        { code: 'PLACEMENT_OUT_OF_PITCH', margemFora: m });
    }

    body.x = nx;
    body.y = ny;
    // Fora das linhas? Então ele tem licença para estar aí até entrar.
    body.foraDoCampo = nx < body.r || nx > PITCH.length - body.r
      || ny < body.r || ny > PITCH.width - body.r;   // só informativo, para o estado
    game.cobranca.botao = body.id;
    if (!jaTem) game.cobranca.botoes.push(body.id);
    // Na formação os DOIS times mexem na mesma estrutura. Sem guardar por
    // time, o log de quem confirmava saía com o botão do adversário — "time A
    // posicionou B2".
    if (formacao) {
      if (!game.cobranca.ultimoPorTime) game.cobranca.ultimoPorTime = {};
      game.cobranca.ultimoPorTime[meuTime] = body.id;
    }
    settle(game.bodies, goalPosts(), 25);
    clampAll(game.bodies);
  }

  if (!confirmar) {
    return {
      fase: 'cobranca', tipo: game.cobranca.tipo, opcional: !!game.cobranca.opcional,
      formacao, team: formacao ? meuTime : game.possession,
      botao: game.cobranca.botao, botoes: [...game.cobranca.botoes],
      confirmado: false, raio,
      area: formacao ? areaDaCobranca(game, meuTime) : area,
    };
  }

  // Formação: cada time diz que está pronto. Só quem bate encerra a fase —
  // o adversário terminar não pode tirar a vez de ninguém.
  if (formacao) {
    game.cobranca.prontos[meuTime] = true;
    pushLog(game, { type: 'formacao', team: meuTime, playerId });
    if (meuTime !== game.possession) {
      return {
        fase: 'cobranca', formacao: true, team: meuTime, confirmado: true,
        prontos: { ...game.cobranca.prontos },
        area: areaDaCobranca(game, meuTime),
      };
    }
  }
  if (!game.cobranca.botao && !game.cobranca.opcional) {
    throw httpErr(400, 'escolha e posicione um botão antes de confirmar', { code: 'NO_PLACEMENT' });
  }

  game.fase = 'jogada';
  game.cobranca.confirmado = true;
  game.turnToken = newId('trn');
  game.turnDeadline = prazo(game.config.turnTimeoutMs);
  game.aimHistory = [];
  const meuBotao = formacao
    ? (game.cobranca.ultimoPorTime?.[meuTime] || null)
    : game.cobranca.botao;
  pushLog(game, { type: 'cobranca', team: formacao ? meuTime : game.possession, playerId, tipo: game.cobranca.tipo, botao: meuBotao });

  return {
    fase: 'jogada', confirmado: true,
    tipo: game.cobranca.tipo,
    formacao,
    team: formacao ? meuTime : game.possession,
    prontos: game.cobranca.prontos ? { ...game.cobranca.prontos } : null,
    botao: game.cobranca.botao,
    botoes: [...game.cobranca.botoes],
    currentPlayerId: game.currentPlayerId,
    turnToken: game.turnToken,
    deadline: game.turnDeadline,
  };
}

/* ------------------------------------------------------------------ */
/* Declaração de chute e posicionamento do goleiro                     */
/* ------------------------------------------------------------------ */

/** Qual jogador do time defensor posiciona a caixa. */
function defensorDaVez(game) {
  const t = game.possession === 'A' ? 'B' : 'A';
  const T = game.teams[t];
  if (!T.players.length) return null;
  return T.players[T.rotationBase % T.players.length];
}

/**
 * O atacante anuncia que vai chutar a gol. A vez passa para o defensor
 * posicionar a caixa; depois volta para o atacante bater.
 */
export function declararChute(game, playerId) {
  exigirEmAndamento(game);
  if (game.fase === 'cobranca') {
    throw httpErr(409, 'a bola está parada para cobrança: dê o primeiro toque e declare na jogada seguinte',
      { code: 'CANNOT_DECLARE_ON_RESTART', reinicio: game.reinicio || 'cobrança' });
  }
  if (game.fase !== 'jogada') throw httpErr(409, 'o goleiro já está sendo posicionado', { code: 'ALREADY_DECLARED' });
  if (game.currentPlayerId !== playerId) throw httpErr(403, 'não é a sua vez', { code: 'NOT_YOUR_TURN', currentPlayerId: game.currentPlayerId });
  if (game.declarado) throw httpErr(409, 'você já declarou o chute deste lance', { code: 'ALREADY_DECLARED' });
  if (game.reinicio) {
    throw httpErr(409,
      `não dá para declarar chute a gol na cobrança (${game.reinicio}): dê o primeiro toque e declare na jogada seguinte`,
      { code: 'CANNOT_DECLARE_ON_RESTART', reinicio: game.reinicio });
  }

  const defensor = defensorDaVez(game);
  if (!defensor) throw httpErr(409, 'o time adversário não tem jogador para posicionar o goleiro', { code: 'NO_DEFENDER' });

  // Guarda a mira que o jogador já tinha montado. Ele posiciona, VÊ que dá gol,
  // e só então declara — seria cruel perder o ajuste bem nessa hora. A palheta
  // volta inteira quando o defensor terminar de pôr o goleiro.
  game.miraGuardada = (game.lastAim && game.lastAim.playerId === playerId)
    ? { ...game.lastAim, palheta: { ...game.lastAim.palheta }, restaurada: true }
    : null;

  game.declarado = true;
  game.declaradoPor = playerId;
  game.fase = 'goleiro';
  game.currentPlayerId = defensor;
  game.turnToken = newId('trn');
  game.turnDeadline = prazo(game.config.tempoGoleiroMs);
  game.aimHistory = [];

  pushLog(game, { type: 'declara', team: game.possession, playerId });
  return { fase: game.fase, defensor, turnToken: game.turnToken, deadline: game.turnDeadline };
}

/**
 * O defensor move a caixa dentro da própria área. Pode chamar quantas vezes
 * quiser (cada chamada é difundida ao vivo); `confirmar` devolve a vez.
 */
export function posicionarGoleiro(game, playerId, { x, y, anguloDeg, confirmar } = {}) {
  exigirEmAndamento(game);
  if (game.fase !== 'goleiro') throw httpErr(409, 'ninguém declarou chute: não há goleiro a posicionar', { code: 'NOT_KEEPER_PHASE' });
  if (game.currentPlayerId !== playerId) throw httpErr(403, 'quem posiciona o goleiro é o time defensor', { code: 'NOT_YOUR_TURN', currentPlayerId: game.currentPlayerId });

  const team = game.possession === 'A' ? 'B' : 'A';
  const k = goleiroDe(game, team);
  if (!k) throw httpErr(500, 'goleiro não encontrado');
  const area = areaDoGoleiro(team);

  if (Number.isFinite(x) || Number.isFinite(y) || Number.isFinite(anguloDeg)) {
    const nx = Number.isFinite(x) ? x : k.x;
    const ny = Number.isFinite(y) ? y : k.y;
    if (nx < area.xMin || nx > area.xMax || ny < area.yMin || ny > area.yMax) {
      throw httpErr(400,
        `o goleiro tem que ficar dentro da área: x entre ${area.xMin} e ${area.xMax}, y entre ${area.yMin} e ${area.yMax}`,
        { code: 'KEEPER_OUT_OF_AREA', area });
    }

    const nAng = Number.isFinite(anguloDeg) ? (anguloDeg * Math.PI) / 180 : k.ang;
    const estorvo = obstaculoDoGoleiro({ x: nx, y: ny, w: k.w, h: k.h, ang: nAng }, game, k.id);
    if (estorvo) {
      throw httpErr(400,
        `o goleiro não cabe aí: a caixa fica por cima ${nomeDoEstorvo(estorvo)}`,
        { code: 'KEEPER_BLOCKED', obstaculo: estorvo });
    }

    k.x = nx;
    k.y = ny;
    k.ang = nAng;
    // O `settle` FICA, mesmo com a checagem acima recusando invasão.
    //
    // Ele não está aqui por causa do goleiro: ele separa o que já estava
    // sobreposto na mesa desde o lance anterior. Tirei-o uma vez achando que
    // tinha virado código morto e as faltas foram de 2,2% para 9,8% dos
    // lances — botões encostados no início do lance viram contato imediato, e
    // contato com adversário antes da bola é falta.
    settle(game.bodies, goalPosts(), 20);
    clampAll(game.bodies);
  }

  if (!confirmar) {
    return { fase: 'goleiro', goleiro: estadoGoleiro(k), confirmado: false };
  }

  game.fase = 'jogada';
  game.currentPlayerId = game.declaradoPor;
  game.turnToken = newId('trn');
  game.turnDeadline = prazo(game.config.turnTimeoutMs);
  game.aimHistory = [];
  // Devolve ao atacante exatamente a palheta com que ele declarou.
  if (game.miraGuardada) game.lastAim = game.miraGuardada;
  pushLog(game, { type: 'goleiro', team, playerId, x: Math.round(k.x), y: Math.round(k.y) });

  return {
    fase: 'jogada', confirmado: true,
    goleiro: estadoGoleiro(k),
    currentPlayerId: game.currentPlayerId,
    turnToken: game.turnToken,
    deadline: game.turnDeadline,
    // Para o atacante recuperar a palheta que ele tinha antes de declarar.
    miraGuardada: game.miraGuardada || null,
  };
}

export function estadoGoleiro(k) {
  return {
    id: k.id, team: k.team,
    x: Math.round(k.x * 10) / 10,
    y: Math.round(k.y * 10) / 10,
    anguloDeg: Math.round(((k.ang * 180) / Math.PI) * 10) / 10,
    w: k.w, h: k.h,
  };
}

function finishGame(game, motivo = 'fim do tempo') {
  game.status = 'finished';
  game.currentPlayerId = null;
  game.turnToken = null;
  game.turnDeadline = null;
  const { A, B } = game.teams;
  game.result = {
    scoreA: A.score, scoreB: B.score,
    winner: A.score === B.score ? null : (A.score > B.score ? 'A' : 'B'),
    reason: motivo,
  };
  pushLog(game, { type: 'finish', ...game.result });
}

/**
 * Alguém apertou "encerrar". A partida acaba com o placar como está.
 *
 * Quem pode: um jogador da mesa ou quem criou a partida. O resto do jogo já
 * sabe lidar com uma partida encerrada — os bots param sozinhos, porque o
 * relógio deles só age em partida `running`.
 */
export function encerrarPartida(game, playerId, nome = null) {
  if (game.status === 'finished') {
    throw httpErr(409, 'a partida já está encerrada', { code: 'GAME_FINISHED', result: game.result });
  }
  const meu = teamOf(game, playerId);
  if (!meu && game.ownerId !== playerId) {
    throw httpErr(403, 'só quem está jogando (ou quem criou a partida) pode encerrá-la', { code: 'NOT_IN_GAME' });
  }
  finishGame(game, `encerrada por ${nome || playerId}`);
  pushLog(game, { type: 'encerrada', playerId, team: meu || null });
  return game.result;
}

/** Timeout de jogada: perde a posse. */
export function advanceTurn(game, silencioso = false) {
  if (game.status !== 'running') return null;

  // Estourou o prazo da saída de bola: arrumar era opcional e o prazo é o da
  // jogada, então isso é um timeout comum — fecha a fase e perde a vez.
  if (game.fase === 'cobranca' && game.cobranca?.opcional) {
    game.fase = 'jogada';
    game.cobranca.confirmado = true;
  }

  // Estourou o prazo da cobrança: escolhe o botão mais perto e segue.
  if (game.fase === 'cobranca') {
    if (!game.cobranca.botao) {
      const ball = game.bodies.find((b) => b.kind === 'ball');
      const meus = game.bodies.filter((b) => b.team === game.possession && b.kind === 'button');
      const perto = meus.sort((a, b) => Math.hypot(a.x - ball.x, a.y - ball.y) - Math.hypot(b.x - ball.x, b.y - ball.y))[0];
      if (perto) {
        const ang = Math.atan2(perto.y - ball.y, perto.x - ball.x);
        perto.x = ball.x + Math.cos(ang) * (ball.r + perto.r + 1.2);
        perto.y = ball.y + Math.sin(ang) * (ball.r + perto.r + 1.2);
        settle(game.bodies, goalPosts(), 20);
        clampAll(game.bodies);
        game.cobranca.botao = perto.id;
        if (!game.cobranca.botoes) game.cobranca.botoes = [];
        if (!game.cobranca.botoes.includes(perto.id)) game.cobranca.botoes.push(perto.id);
      }
    }
    game.fase = 'jogada';
    game.turnToken = newId('trn');
    game.turnDeadline = prazo(game.config.turnTimeoutMs);
    game.aimHistory = [];
    if (!silencioso) pushLog(game, { type: 'cobrancaAuto', team: game.possession, botao: game.cobranca.botao });
    return { type: 'cobrancaAuto', team: game.possession };
  }

  // Estourou o prazo do goleiro: aceita onde está e devolve a vez ao atacante.
  if (game.fase === 'goleiro') {
    const team = game.possession === 'A' ? 'B' : 'A';
    game.fase = 'jogada';
    game.currentPlayerId = game.declaradoPor;
    game.turnToken = newId('trn');
    game.turnDeadline = prazo(game.config.turnTimeoutMs);
    game.aimHistory = [];
    if (!silencioso) pushLog(game, { type: 'goleiroAuto', team });
    return { type: 'goleiroAuto', team };
  }

  const perdedor = game.possession;
  if (!silencioso) pushLog(game, { type: 'timeout', team: perdedor, playerId: game.currentPlayerId });
  if (flipPossession(game, 'timeout')) beginTurn(game);
  return { type: 'timeout', team: perdedor };
}

export function checkTimeout(game) {
  if (game.status !== 'running' || !game.turnDeadline) return null;
  if (Date.now() < game.turnDeadline) return null;
  return advanceTurn(game);
}

/* ------------------------------------------------------------------ */
/* Jogada                                                              */
/* ------------------------------------------------------------------ */

/**
 * A partida está rolando? Se acabou, o erro DIZ que acabou, com o placar e o
 * motivo — "partida não está em andamento" deixava quem mandou o comando sem
 * saber se tinha errado a chamada ou se o jogo tinha terminado.
 */
function exigirEmAndamento(game) {
  if (game.status === 'running') return;
  if (game.status === 'finished') {
    const r = game.result || {};
    const placar = `${r.scoreA ?? 0} x ${r.scoreB ?? 0}`;
    throw httpErr(409,
      `a partida acabou (${r.reason || 'fim'}) — placar final ${placar}. Não dá mais para jogar nela.`,
      { code: 'GAME_FINISHED', result: game.result || null });
  }
  throw httpErr(409, 'a partida ainda não começou', { code: 'GAME_NOT_STARTED', status: game.status });
}

function httpErr(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status;
  Object.assign(e, extra);
  return e;
}

function pushLog(game, ev) {
  game.seq += 1;
  const entry = { seq: game.seq, ts: Date.now(), turnNo: game.turnNo, ...ev };
  game.log.push(entry);
  if (game.log.length > 400) game.log.splice(0, game.log.length - 400);
  return entry;
}

/**
 * Toda jogada passa pela palheta. O modo simples (targetX/targetY + power) só
 * calcula a palheta ideal para aquela direção e força, então os dois caminhos
 * usam exatamente a mesma física.
 */
function resolverJogada(move, body) {
  const p = move.palheta;
  if (p && (Number.isFinite(p.anguloAro) || Number.isFinite(p.inclinacao) || Number.isFinite(p.avanco) || Number.isFinite(p.forca))) {
    if (!Number.isFinite(p.anguloAro)) {
      throw httpErr(400, 'palheta.anguloAro é obrigatório (graus, onde a palheta encosta no aro)', { code: 'NO_DIRECTION' });
    }
    return { modo: 'palheta', resolucao: resolverPalheta(p) };
  }

  // Modo simples: direção + força, a palheta ideal sai por dedução.
  let ang;
  if (Number.isFinite(move.vx) && Number.isFinite(move.vy)) {
    const sp = Math.min(PHYS.maxShotSpeed, Math.hypot(move.vx, move.vy));
    const dir = (Math.atan2(move.vy, move.vx) * 180) / Math.PI;
    return { modo: 'simples', resolucao: resolverPalheta(palhetaPara(dir, sp)) };
  }
  if (Number.isFinite(move.targetX) && Number.isFinite(move.targetY)) {
    ang = Math.atan2(move.targetY - body.y, move.targetX - body.x);
  } else if (Number.isFinite(move.angleDeg)) {
    ang = (move.angleDeg * Math.PI) / 180;
  } else {
    throw httpErr(400, 'informe palheta{anguloAro,inclinacao,avanco,forca}, ou targetX/targetY, angleDeg, vx/vy', { code: 'NO_DIRECTION' });
  }

  const power = Math.max(0.05, Math.min(1, Number.isFinite(move.power) ? move.power : 0.7));
  const speed = PHYS.minShotSpeed + power * (PHYS.maxShotSpeed - PHYS.minShotSpeed);
  return { modo: 'simples', resolucao: resolverPalheta(palhetaPara((ang * 180) / Math.PI, speed)) };
}

/**
 * Executa uma jogada. Devolve o resultado com trajetória para animação.
 */
export function applyMove(game, playerId, move) {
  exigirEmAndamento(game);
  if (game.currentPlayerId !== playerId) {
    throw httpErr(403, 'não é a sua vez', { code: 'NOT_YOUR_TURN', currentPlayerId: game.currentPlayerId });
  }
  if (move.turnToken && move.turnToken !== game.turnToken) {
    throw httpErr(409, 'turnToken vencido — você está agindo sobre um estado antigo', { code: 'STALE_TURN_TOKEN', turnToken: game.turnToken });
  }

  const time = game.possession;
  const body = game.bodies.find((b) => b.id === move.buttonId);
  if (!body) throw httpErr(400, `botão desconhecido: ${move.buttonId}`, { code: 'UNKNOWN_BUTTON' });
  if (body.team !== time) throw httpErr(403, `${move.buttonId} não é do time ${time}`, { code: 'NOT_YOUR_BUTTON' });
  if (body.kind === 'keeper')
    throw httpErr(400, 'o goleiro é uma caixa fixa: escolha um botão de linha', { code: 'KEEPER_IS_BOX' });
  if (game.fase === 'goleiro')
    throw httpErr(409, 'o goleiro ainda está sendo posicionado', { code: 'NOT_KEEPER_PHASE' });
  if (game.fase === 'cobranca') {
    // Na saída de bola arrumar é opcional: quem bater direto fecha a fase.
    if (!game.cobranca?.opcional) {
      throw httpErr(409, `posicione um botão para cobrar o ${game.cobranca?.tipo} antes de jogar`, { code: 'NOT_PLACEMENT_PHASE' });
    }
    game.fase = 'jogada';
    game.cobranca.confirmado = true;
  }

  const antes = game.bodies.map((b) => ({ id: b.id, x: b.x, y: b.y }));
  // O turno vira lá embaixo e zera o histórico, então copiamos agora.
  const ajustes = (game.aimHistory || []).filter((a) => a.buttonId === move.buttonId);
  const origem = { x: body.x, y: body.y };
  const { modo, resolucao } = resolverJogada(move, body);
  body.vx = resolucao.vx;
  body.vy = resolucao.vy;
  body.hopUntil = resolucao.duracaoVoo;
  body.liftBias = resolucao.elevacao;      // o quanto este toque levanta a bola
  const apoio = pontoDeApoio(body, resolucao.entrada.anguloAro, resolucao.entrada.avanco);

  const sim = simulate(game.bodies, goalPosts());
  clampAll(game.bodies);

  /* ---- análise dos contatos ---- */
  const outroTime = time === 'A' ? 'B' : 'A';
  let tocouBola = false;
  let primeiroAdversario = null;

  for (const c of sim.contacts) {
    const envolveTirador = c.a === body.id || c.b === body.id;
    if (!envolveTirador) continue;
    const outro = c.a === body.id ? { id: c.b, kind: c.bKind, team: c.bTeam } : { id: c.a, kind: c.aKind, team: c.aTeam };
    if (outro.kind === 'ball') { tocouBola = true; break; }
    if (outro.team === outroTime && !primeiroAdversario) primeiroAdversario = outro.id;
  }
  // Encostou na bola em qualquer momento, mesmo depois de caramboladas.
  if (!tocouBola) {
    tocouBola = sim.contacts.some((c) =>
      (c.a === body.id && c.bKind === 'ball') || (c.b === body.id && c.aKind === 'ball'));
  }

  const falta = game.config.foulOnOpponentFirst && !!primeiroAdversario && !tocouBola;

  /* ---- desfecho ---- */
  const resultado = {
    turnNo: game.turnNo,
    playerId,
    team: time,
    buttonId: body.id,
    from: origem,
    modo,
    palheta: {
      ...resolucao.entrada,
      apoio: { x: Math.round(apoio.x * 100) / 100, y: Math.round(apoio.y * 100) / 100 },
      direcao: Math.round(resolucao.direcao * 10) / 10,
      desvio: resolucao.desvio,
      rendimento: resolucao.rendimento,
      escorregou: resolucao.escorregou,
      cavada: resolucao.cavada,
      duracaoVoo: resolucao.duracaoVoo,
      elevacao: resolucao.elevacao,
      alturaPrevista: resolucao.alturaPrevista,
      aviso: resolucao.aviso,
    },
    shot: { vx: Math.round(resolucao.vx), vy: Math.round(resolucao.vy), velocidade: resolucao.velocidade, angleDeg: Math.round(resolucao.direcao) },
    seconds: sim.seconds,
    touchedBall: tocouBola,
    foul: falta,
    foulOn: primeiroAdversario,
    declarado: game.declarado,
    ultimoToqueBola: sim.ultimoToqueBola
      ? { id: sim.ultimoToqueBola.id, team: sim.ultimoToqueBola.team, kind: sim.ultimoToqueBola.kind }
      : null,
    fora: sim.fora ? { linha: sim.fora.linha, gol: sim.fora.gol ?? null, lado: sim.fora.lado ?? null } : null,
    reposicao: null,
    goal: null,
    goalAnulado: null,
    possessionChanged: false,
    motivo: null,
    outcome: '',
  };

  game.lastShot = { from: origem, to: { x: body.x, y: body.y } };
  // A bola voltou a rolar: a partir da PRÓXIMA jogada já dá para declarar.
  game.reinicio = null;

  /* ---- desfecho ----
   * A vez SÓ passa quando: falta, o botão não encostou na bola, a bola saiu,
   * ou a bola parou tendo tocado por último num botão adversário. Fora isso,
   * quem está com a posse segue jogando.
   */
  const ultimo = sim.ultimoToqueBola;
  const ultimoFoiAdversario = !!ultimo && ultimo.team === outroTime;

  // O gol só conta se foi declarado (senão, declarar seria só desvantagem).
  // Gol contra SEMPRE conta para o adversário: ninguém declara que vai marcar
  // no próprio gol, então a exigência de declaração só vale para o gol que
  // você está tentando fazer.
  const golContra = !!sim.goal && sim.goal.team !== time;
  const golValido = !!sim.goal && !falta
    && (golContra || !game.config.golExigeDeclaracao || game.declarado);

  if (golValido) {
    const marcou = sim.goal.team;
    game.teams[marcou].score += 1;
    resultado.goal = { team: marcou, byPlayer: playerId, ownGoal: marcou !== time };
    resultado.outcome = marcou === time ? 'GOL!' : 'GOL CONTRA!';
    resultado.motivo = 'gol';
    pushLog(game, { type: 'goal', team: marcou, playerId, buttonId: body.id, ownGoal: marcou !== time, scoreA: game.teams.A.score, scoreB: game.teams.B.score });

    const proximo = marcou === 'A' ? 'B' : 'A';
    game.possessionsPlayed += 1;
    game.teams[game.possession].rotationBase += 1;
    game.possession = proximo;
    game.touchIndex = 0;
    game.declarado = false;
    game.declaradoPor = null;
    resultado.possessionChanged = true;
    kickoff(game, proximo);
    resultado.abreSaida = true;
    goleiroPadrao(game, 'A'); goleiroPadrao(game, 'B');
    if (game.config.maxPossessions > 0 && game.possessionsPlayed >= game.config.maxPossessions) finishGame(game, 'fim do tempo');
  } else {
    // Nenhum gol válido. Vê se alguma condição tira a posse.
    let motivo = null;

    if (falta) motivo = 'falta';
    else if (game.config.requireBallContact && !tocouBola) motivo = 'sem_contato';
    else if (sim.goal) motivo = 'gol_nao_declarado';
    else if (sim.fora) motivo = 'bola_fora';
    else if (game.config.perdeNoUltimoToque && ultimoFoiAdversario) motivo = 'ultimo_toque';
    else if (game.config.touchesPerPossession > 0 && game.touchIndex + 1 >= game.config.touchesPerPossession) motivo = 'toques_esgotados';

    if (sim.goal && !golValido) {
      resultado.goalAnulado = { team: sim.goal.team, razao: falta ? 'falta' : 'chute não declarado' };
    }

    if (!motivo) {
      // Segue jogando: a jogada foi limpa.
      game.touchIndex += 1;
      resultado.outcome = `segue com o time ${time} (toque ${game.touchIndex})`;
      pushLog(game, { type: 'touch', team: time, playerId, buttonId: body.id, touchIndex: game.touchIndex });

      // Chute declarado que não virou gol: a declaração acaba aqui, mesmo com
      // a posse seguindo. Para chutar a gol de novo é preciso declarar de novo,
      // e o defensor ganha uma nova chance de mexer na caixa.
      //
      // A caixa NÃO volta ao lugar padrão: ela fica exatamente onde estava. O
      // defensor pode muito bem querer deixá-la ali — e mandá-la de volta ao
      // centro seria decidir por ele.
      if (game.declarado) {
        game.declarado = false;
        game.declaradoPor = null;
        resultado.declaracaoConsumida = true;
        resultado.outcome += ' — a declaração foi usada: para chutar a gol, declare de novo';
        pushLog(game, { type: 'declaracaoConsumida', team: time, playerId });
      }
    } else {
      resultado.motivo = motivo;
      resultado.possessionChanged = true;
      const quemCobra = outroTime;

      // Recolocação da bola conforme o motivo.
      if (sim.goal) {
        // Gol anulado: sai tiro de meta para quem defendia aquele gol.
        const golDe = sim.goal.team === 'A' ? 'B' : 'A';   // em que gol a bola entrou
        resultado.reposicao = reporBolaFora(game, { linha: 'fundo', gol: golDe, x: 0, y: PITCH.width / 2 }, quemCobra);
        resultado.outcome = falta
          ? `gol anulado — falta em ${primeiroAdversario}`
          : 'gol anulado: o chute não foi declarado';
        pushLog(game, { type: 'goalAnulado', team: time, playerId, razao: resultado.goalAnulado.razao });
      } else if (sim.fora) {
        resultado.reposicao = reporBolaFora(game, sim.fora, quemCobra);
        resultado.outcome = `bola fora — ${resultado.reposicao.tipo} para o time ${quemCobra}`;
        resultado.abreCobranca = resultado.reposicao.tipo;
        pushLog(game, { type: 'fora', team: time, playerId, tipo: resultado.reposicao.tipo, para: quemCobra });
      } else if (motivo === 'falta') {
        resultado.outcome = `falta: encostou em ${primeiroAdversario} antes da bola`;
        pushLog(game, { type: 'foul', team: time, playerId, buttonId: body.id, on: primeiroAdversario });
      } else if (motivo === 'sem_contato') {
        resultado.outcome = 'jogada perdida: o botão não alcançou a bola';
        pushLog(game, { type: 'miss', team: time, playerId, buttonId: body.id });
      } else if (motivo === 'ultimo_toque') {
        resultado.outcome = `a bola tocou por último em ${ultimo.id} (time ${outroTime}) — a posse passa`;
        pushLog(game, { type: 'ultimoToque', team: time, playerId, em: ultimo.id });
      } else {
        resultado.outcome = 'toques esgotados, a posse passa';
      }

      game.declarado = false;
      game.declaradoPor = null;
      goleiroPadrao(game, 'A'); goleiroPadrao(game, 'B');
      flipPossession(game, motivo);
    }
  }

  // Relógio da partida: total de jogadas.
  if (game.status === 'running' && game.config.maxTurns > 0 && game.turnNo >= game.config.maxTurns) {
    finishGame(game, 'fim do tempo');
  }

  if (game.status === 'running') {
    beginTurn(game);
    // Bola reposta: antes de jogar, quem cobra posiciona botão.
    if (resultado.abreSaida) abrirSaida(game);
    else if (resultado.abreCobranca) abrirCobranca(game, resultado.abreCobranca);
  }

  resultado.nextTurn = {
    turnNo: game.turnNo,
    possession: game.possession,
    touchIndex: game.touchIndex,
    playerId: game.currentPlayerId,
    turnToken: game.turnToken,
    deadline: game.turnDeadline,
  };

  const trajetoria = {
    ids: game.bodies.map((b) => b.id),
    fps: Math.round(1 / (PHYS.dt * PHYS.frameEvery)),
    frames: sim.frames,
    voos: sim.voos,
    events: sim.events.filter((e) => e.type !== 'contact' || e.speed > 12),
  };

  game.lastResolution = { ...resultado, before: antes };
  gravarNoReplay(game, resultado, trajetoria, ajustes);
  return { result: resultado, trajectory: trajetoria };
}

/* ------------------------------------------------------------------ */
/* Replay                                                              */
/* ------------------------------------------------------------------ */

const REPLAY_MAX_LANCES = 400;
const REPLAY_SUBAMOSTRA = 3;      // 60 fps -> 20 fps, suficiente para rever

/** Guarda o lance para poder rever a partida depois, quadro a quadro. */
function gravarNoReplay(game, resultado, trajetoria, ajustes = []) {
  // Subamostra os keyframes: o replay não precisa da mesma taxa da animação ao vivo.
  const frames = trajetoria.frames.filter((_, i) =>
    i % REPLAY_SUBAMOSTRA === 0 || i === trajetoria.frames.length - 1);

  game.replay.push({
    n: game.replay.length,
    turnNo: resultado.turnNo,
    playerId: resultado.playerId,
    team: resultado.team,
    buttonId: resultado.buttonId,
    palheta: resultado.palheta,
    outcome: resultado.outcome,
    touchedBall: resultado.touchedBall,
    foul: resultado.foul,
    goal: resultado.goal,
    scoreA: game.teams.A.score,
    scoreB: game.teams.B.score,
    seconds: resultado.seconds,
    // Os passos da configuração da palheta, terminando SEMPRE na que foi jogada.
    ajustes: passosDeAjuste(ajustes, resultado),
    ids: trajetoria.ids,
    fps: Math.round(trajetoria.fps / REPLAY_SUBAMOSTRA),
    frames,
    voos: trajetoria.voos,
  });

  if (game.replay.length > REPLAY_MAX_LANCES) game.replay.shift();
}

/** Índice leve: dá para montar a linha do tempo sem baixar as trajetórias. */
/**
 * Normaliza os ajustes e garante que o último passo é exatamente a palheta
 * que foi jogada — mesmo que o jogador não tenha transmitido mira nenhuma.
 */
function passosDeAjuste(ajustes, resultado) {
  const p = resultado.palheta;
  const nome = perfil(resultado.playerId)?.name || resultado.playerId;
  const final = {
    playerId: resultado.playerId,
    playerName: nome,
    buttonId: resultado.buttonId,
    botao: { x: resultado.from.x, y: resultado.from.y },
    palheta: { anguloAro: p.anguloAro, inclinacao: p.inclinacao, avanco: p.avanco, forca: p.forca },
    apoio: p.apoio,
    direcao: p.direcao,
    rendimento: p.rendimento,
    escorregou: p.escorregou,
    cavada: p.cavada,
    aviso: p.aviso,
    definitivo: true,
  };

  const passos = ajustes.map((a) => ({
    playerId: a.playerId,
    playerName: a.playerName || nome,
    buttonId: a.buttonId,
    botao: a.botao,
    palheta: a.palheta,
    apoio: a.apoio,
    direcao: a.direcao,
    rendimento: a.rendimento,
    escorregou: a.escorregou,
    cavada: a.cavada,
    aviso: a.aviso,
    previsao: a.previsao,
    definitivo: false,
  }));

  const ultimo = passos[passos.length - 1];
  const mesmo = ultimo
    && ultimo.palheta.anguloAro === final.palheta.anguloAro
    && ultimo.palheta.inclinacao === final.palheta.inclinacao
    && ultimo.palheta.avanco === final.palheta.avanco
    && ultimo.palheta.forca === final.palheta.forca;
  if (mesmo) { ultimo.definitivo = true; return passos; }
  passos.push(final);
  return passos;
}

export function replayIndex(game) {
  return {
    gameId: game.id,
    name: game.name,
    status: game.status,
    teams: { A: game.teams.A.name, B: game.teams.B.name },
    placarFinal: [game.teams.A.score, game.teams.B.score],
    result: game.result || null,
    total: game.replay.length,
    lances: game.replay.map((l) => ({
      n: l.n,
      turnNo: l.turnNo,
      playerId: l.playerId,
      team: l.team,
      buttonId: l.buttonId,
      outcome: l.outcome,
      goal: l.goal,
      foul: l.foul,
      cavada: l.palheta?.cavada || false,
      escorregou: l.palheta?.escorregou || false,
      scoreA: l.scoreA,
      scoreB: l.scoreB,
      seconds: l.seconds,
      quadros: l.frames.length,
      ajustes: l.ajustes?.length || 0,
    })),
  };
}

export function replayLance(game, n) {
  const l = game.replay[n];
  if (!l) throw httpErr(404, `lance ${n} não existe (a partida tem ${game.replay.length})`, { code: 'NO_SUCH_LANCE' });
  return l;
}

/* ------------------------------------------------------------------ */
/* Projeções de estado                                                 */
/* ------------------------------------------------------------------ */

export function controllableButtons(game, playerId) {
  if (game.status !== 'running' || game.currentPlayerId !== playerId) return [];
  // Na saída de bola arrumar é opcional, então os botões seguem jogáveis.
  if (game.fase !== 'jogada' && !(game.fase === 'cobranca' && game.cobranca?.opcional)) return [];
  return game.bodies
    .filter((b) => b.team === game.possession && b.kind === 'button')
    .map((b) => b.id);
}

export function teamOf(game, playerId) {
  if (game.teams.A.players.includes(playerId)) return 'A';
  if (game.teams.B.players.includes(playerId)) return 'B';
  return null;
}

/** Estado leve: cabe em poucas dezenas de tokens. */
export function briefState(game) {
  return {
    gameId: game.id,
    status: game.status,
    scoreA: game.teams.A.score,
    scoreB: game.teams.B.score,
    turnNo: game.turnNo,
    possession: game.possession,
    touchIndex: game.touchIndex,
    touchesPerPossession: game.config.touchesPerPossession,
    possessionsPlayed: game.possessionsPlayed,
    maxPossessions: game.config.maxPossessions,
    maxTurns: game.config.maxTurns,
    lances: game.replay.length,
    currentPlayerId: game.currentPlayerId,
    currentPlayer: perfil(game.currentPlayerId),
    fase: game.fase,
    declarado: game.declarado,
    turnDeadline: game.turnDeadline,
    // Prazo em segundos: assim o cliente não precisa confiar no relógio dele
    // estar sincronizado com o do servidor. null = sem prazo.
    segundosRestantes: game.turnDeadline
      ? Math.max(0, Math.round((game.turnDeadline - Date.now()) / 1000))
      : null,
    ball: roundPt(game.bodies.find((b) => b.kind === 'ball')),
  };
}

const roundPt = (b) => (b ? { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10 } : null);

/** Ficha pública de um jogador. Sem isso a interface só mostra o id cru. */
export function perfil(playerId) {
  if (!playerId) return null;
  const p = getPlayer(playerId);
  if (!p) return { playerId, name: playerId, kind: 'human', model: null };
  return { playerId, name: p.name, kind: p.kind, model: p.model || null };
}

/** Nome para exibir: o do jogador, com o modelo quando é uma IA. */
export function nomeDe(playerId) {
  const f = perfil(playerId);
  return f ? f.name : '—';
}

export function fullState(game, viewerId = null) {
  return {
    ...briefState(game),
    name: game.name,
    config: game.config,
    pitch: {
      length: PITCH.length, width: PITCH.width,
      goalWidth: PITCH.goalWidth, goalMin: PITCH.goalMin, goalMax: PITCH.goalMax,
      goalDepth: PITCH.goalDepth, alturaTravessao: PITCH.alturaTravessao,
      areaLength: PITCH.areaLength, areaMin: PITCH.areaMin, areaMax: PITCH.areaMax,
      centerCircle: PITCH.centerCircle,
      // A faixa de mesa fora das linhas, onde os BOTÕES também jogam. Ela
      // faltava aqui, e quem desenhava a partir do estado (o cliente 3D)
      // acabava prendendo o botão na linha sem que o servidor pedisse isso.
      margemFora: PITCH.margemFora,
      note: 'x=0 é o gol do time A; x=200 é o gol do time B; y cresce para cima. Os botões podem sair até margemFora além das linhas; a bola, não.',
    },
    teams: {
      A: { name: game.teams.A.name, slots: game.teams.A.slots, players: game.teams.A.players.map(perfil), score: game.teams.A.score, attacks: '+x' },
      B: { name: game.teams.B.name, slots: game.teams.B.slots, players: game.teams.B.players.map(perfil), score: game.teams.B.score, attacks: '-x' },
    },
    bodies: game.bodies.map((b) => ({
      id: b.id, kind: b.kind, team: b.team,
      x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, r: b.r,
      ...(b.forma === 'caixa'
        ? { forma: 'caixa', w: b.w, h: b.h, anguloDeg: Math.round((b.ang * 180) / Math.PI) }
        : {}),
    })),
    turnToken: viewerId && viewerId === game.currentPlayerId ? game.turnToken : undefined,
    goleiros: {
      A: estadoGoleiro(goleiroDe(game, 'A')),
      B: estadoGoleiro(goleiroDe(game, 'B')),
    },
    // As traves são corpos de verdade e mudam o jogo (bola na trave não é gol),
    // então precisam aparecer para quem joga pela API.
    traves: goalPosts().map((t) => ({
      id: t.id, kind: 'post', gol: t.id.includes('_A_') ? 'A' : 'B',
      x: t.x, y: t.y, r: t.r,
    })),
    areaGoleiro: { A: areaDoGoleiro('A'), B: areaDoGoleiro('B') },
    yourTeam: viewerId ? teamOf(game, viewerId) : null,
    yourTurn: viewerId ? game.currentPlayerId === viewerId : false,
    // O que este jogador pode fazer agora.
    podeJogar: viewerId
      ? (game.currentPlayerId === viewerId
         && (game.fase === 'jogada' || (game.fase === 'cobranca' && !!game.cobranca?.opcional)))
      : false,
    podeDeclarar: viewerId
      ? (game.currentPlayerId === viewerId && game.fase === 'jogada' && !game.declarado && !game.reinicio)
      : false,
    // Por que não dá para declarar agora, se for o caso.
    reinicio: game.reinicio || null,
    // Quem criou a partida pode encerrá-la mesmo sem estar jogando.
    souDono: viewerId ? game.ownerId === viewerId : false,
    // Vagas guardadas para uma IA de fora (sem o convite, que é secreto).
    reservas: { A: reservaPublica(game.reservas?.A), B: reservaPublica(game.reservas?.B) },
    podePosicionarGoleiro: viewerId ? (game.currentPlayerId === viewerId && game.fase === 'goleiro') : false,
    // Na formação da saída de bola os DOIS times arrumam ao mesmo tempo.
    podeCobrar: viewerId
      ? (game.fase === 'cobranca'
         && (game.cobranca?.formacao
             ? !!teamOf(game, viewerId) && !game.cobranca.prontos?.[teamOf(game, viewerId)]
             : game.currentPlayerId === viewerId))
      : false,
    // Saída de bola: dá para arrumar os botões E bater sem arrumar nada.
    cobrancaOpcional: game.fase === 'cobranca' ? !!game.cobranca?.opcional : false,
    formacao: game.fase === 'cobranca' && game.cobranca?.formacao
      ? { prontos: { ...game.cobranca.prontos }, maxNoCirculo: game.cobranca.maxNoCirculo }
      : null,
    cobranca: game.fase === 'cobranca'
      ? {
          tipo: game.cobranca?.tipo,
          botao: game.cobranca?.botao,
          botoes: [...(game.cobranca?.botoes || [])],
          // A área depende de quem está olhando: cada time tem o campo dele.
          area: areaDaCobranca(game, viewerId ? teamOf(game, viewerId) : null),
          raio: areaDaCobranca(game).raio ?? null,
        }
      : null,
    // Na cobrança, estes são os botões que podem ser POSICIONADOS. Na formação
    // da saída, cada um arruma os do próprio time.
    posicionaveis: (() => {
      if (!viewerId || game.fase !== 'cobranca') return [];
      const meu = teamOf(game, viewerId);
      if (game.cobranca?.formacao) {
        if (!meu || game.cobranca.prontos?.[meu]) return [];
        return game.bodies.filter((b) => b.team === meu && b.kind === 'button').map((b) => b.id);
      }
      if (game.currentPlayerId !== viewerId) return [];
      return game.bodies.filter((b) => b.team === game.possession && b.kind === 'button').map((b) => b.id);
    })(),
    controllable: viewerId ? controllableButtons(game, viewerId) : [],
    lastResolution: game.lastResolution
      ? { ...game.lastResolution, before: undefined }
      : null,
    result: game.result || null,
  };
}

export function sceneOf(game, viewerId = null, message = null, aim = undefined) {
  // Se ninguém passar, usa a última mira transmitida — desde que seja deste turno.
  const mira = aim !== undefined ? aim
    : (game.lastAim && game.lastAim.turnNo === game.turnNo ? game.lastAim : null);
  return {
    bodies: game.bodies.map((b) => ({
      id: b.id, label: b.label, kind: b.kind, team: b.team,
      x: b.x, y: b.y, z: b.z || 0, r: b.r,
      forma: b.forma, w: b.w, h: b.h, ang: b.ang,
    })),
    scoreA: game.teams.A.score,
    scoreB: game.teams.B.score,
    teamAName: game.teams.A.name,
    teamBName: game.teams.B.name,
    possession: game.status === 'running' ? game.possession : null,
    turnNo: game.turnNo,
    touchIndex: game.status === 'running' ? game.touchIndex : null,
    touchesPerPossession: game.config.touchesPerPossession,
    fase: game.fase,
    declarado: game.declarado,
    phase: game.status === 'finished' ? 'fim de jogo' : game.status === 'lobby' ? 'aguardando jogadores' : null,
    activeButtons: viewerId ? controllableButtons(game, viewerId) : [],
    lastShot: game.lastShot,
    palheta: mira && mira.palheta ? mira : null,
    message,
  };
}

export { httpErr, pushLog, kickoff, formation, goleiroPadrao };
