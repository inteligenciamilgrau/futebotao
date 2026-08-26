// Servidor: REST + estáticos + broker WebSocket.
// node server/index.js   (PORT=3000 por padrão)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVER, PITCH, PHYS, RULES_DEFAULT, KEEPER } from './config.js';
import { handleUpgrade } from './ws.js';
import { broker } from './broker.js';
import {
  registerPlayer, authenticate, issueToken, resolveToken, revokeToken,
  getPlayer, publicPlayer, listPlayers, gameStore, bumpStat, flush,
} from './store.js';
import {
  createGame, joinGame, leaveGame, startGame, applyMove, checkTimeout,
  fullState, briefState, sceneOf, teamOf, controllableButtons, httpErr, isReady,
  replayIndex, replayLance, perfil as perfilDe, registrarAjuste,
  declararChute, posicionarGoleiro, goleiroDe, estadoGoleiro, areaDoGoleiro,
  posicionarBotao,
  reservarVaga, liberarVaga, reservaPublica, vagasLivres, encerrarPartida,
} from './game.js';
import { resolverPalheta, pontoDeApoio, preverLance, PALHETA } from './palheta.js';
import { adicionarBot, passoDosBots, temBot } from './bot-local.js';
import { renderScene } from './render.js';
import { describeGame, resumoEvento } from './describe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

/* ------------------------------------------------------------------ */
/* Utilidades HTTP                                                     */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  // Música de fundo. Sem Range: `serveStatic` manda o arquivo inteiro, o que
  // basta para uma faixa em laço — o <audio> baixa uma vez e repete daí em
  // diante. Quem quiser arrastar a barra de tempo vai precisar de 206.
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};

function send(res, status, body, headers = {}) {
  const h = { 'Access-Control-Allow-Origin': '*', ...headers };
  res.writeHead(status, h);
  res.end(body);
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function readBody(req, limit = 1024 * 256) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpErr(413, 'corpo grande demais');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { throw httpErr(400, 'JSON inválido'); }
}

function bearer(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (req.headers['x-token']) return String(req.headers['x-token']);
  return url.searchParams.get('token');
}

function requirePlayer(req, url) {
  const pid = resolveToken(bearer(req, url));
  if (!pid) throw httpErr(401, 'token ausente ou inválido — faça POST /api/auth/login');
  const p = getPlayer(pid);
  if (!p) throw httpErr(401, 'jogador não existe mais');
  return p;
}

function requireGame(id) {
  const g = gameStore.get(id);
  if (!g) throw httpErr(404, `partida ${id} não encontrada (partidas vivem em memória e somem se o servidor reiniciar)`, { code: 'GAME_NOT_FOUND' });
  return g;
}

/* ------------------------------------------------------------------ */
/* Difusão de eventos                                                  */
/* ------------------------------------------------------------------ */

function turnPayload(game) {
  const b = briefState(game);
  return {
    gameId: game.id,
    status: game.status,
    turnNo: game.turnNo,
    possession: game.possession,
    touchIndex: game.touchIndex,
    touchesPerPossession: game.config.touchesPerPossession,
    currentPlayerId: game.currentPlayerId,
    currentPlayer: perfilDe(game.currentPlayerId),
    fase: game.fase,
    declarado: game.declarado,
    deadline: game.turnDeadline,
    score: [game.teams.A.score, game.teams.B.score],
    ball: b.ball,
  };
}

/** Avisa a mesa inteira e cutuca em privado quem tem a vez. */
function announceTurn(game) {
  broker.publish(`game/${game.id}/turn`, turnPayload(game), { retain: true });

  // A palheta do turno anterior não vale mais: limpa o retido para quem
  // conectar agora não ver a mira de um lance que já aconteceu.
  broker.publish(`game/${game.id}/aim`, {
    gameId: game.id, turnNo: game.turnNo, limpar: true,
    playerId: game.currentPlayerId,
    playerName: game.currentPlayerId ? (getPlayer(game.currentPlayerId)?.name || game.currentPlayerId) : null,
  }, { retain: true });

  if (game.status !== 'running' || !game.currentPlayerId) return;
  const pid = game.currentPlayerId;
  // Payload privado enxuto: é o gatilho que economiza token do bot.
  broker.publishToPlayer(pid, `player/${pid}/turn`, {
    ...turnPayload(game),
    yourTeam: teamOf(game, pid),
    turnToken: game.turnToken,
    controllable: controllableButtons(game, pid),
    acao: game.fase === 'goleiro' ? 'posicionar_goleiro' : game.fase === 'cobranca' ? 'cobrar' : 'jogar',
    ...(game.fase === 'goleiro'
      ? { goleiro: estadoGoleiro(goleiroDe(game, teamOf(game, pid))), area: areaDoGoleiro(teamOf(game, pid)) }
      : {}),
    pull: {
      state: `GET /api/games/${game.id}/state?describe=1&frame=1`,
      move: game.fase === 'goleiro' ? `POST /api/games/${game.id}/keeper`
        : game.fase === 'cobranca' ? `POST /api/games/${game.id}/place`
        : `POST /api/games/${game.id}/move`,
    },
  });
}

function announceEvent(game, ev) {
  broker.publish(`game/${game.id}/event`, { gameId: game.id, ...ev, texto: resumoEvento(ev) });
}

/**
 * Palheta ao vivo: quem está segurando e como ela está posicionada AGORA.
 * É o que permite assistir a IA (ou o humano) ajustando antes de apertar.
 */
function resolverAim(game, playerId, buttonId, palheta) {
  if (game.status !== 'running') throw httpErr(409, 'a partida não está em andamento', { code: 'GAME_NOT_RUNNING' });
  if (game.currentPlayerId !== playerId) throw httpErr(403, 'só quem tem a vez segura a palheta', { code: 'NOT_YOUR_TURN' });

  const body = game.bodies.find((b) => b.id === buttonId);
  if (!body) throw httpErr(400, `botão desconhecido: ${buttonId}`, { code: 'UNKNOWN_BUTTON' });
  if (body.team !== game.possession) throw httpErr(403, `${buttonId} não é do time ${game.possession}`, { code: 'NOT_YOUR_BUTTON' });

  const res = resolverPalheta(palheta || {});
  const apoio = pontoDeApoio(body, res.entrada.anguloAro, res.entrada.avanco);
  const previsao = preverLance(body, res, game.bodies);
  const p = getPlayer(playerId);

  return {
    gameId: game.id,
    playerId,
    playerName: p?.name || playerId,
    turnNo: game.turnNo,
    buttonId,
    botao: { x: Math.round(body.x * 10) / 10, y: Math.round(body.y * 10) / 10, r: body.r },
    palheta: res.entrada,
    apoio: { x: Math.round(apoio.x * 100) / 100, y: Math.round(apoio.y * 100) / 100, raio: Math.round(apoio.raio * 100) / 100 },
    direcao: Math.round(res.direcao * 10) / 10,
    desvio: res.desvio,
    rendimento: res.rendimento,
    velocidade: res.velocidade,
    escorregou: res.escorregou,
    cavada: res.cavada,
    duracaoVoo: res.duracaoVoo,
    aviso: res.aviso,
    previsao,
  };
}

function announceAim(payload) {
  const g = gameStore.get(payload.gameId);
  if (g) {
    g.lastAim = payload;               // o frame PNG passa a desenhar essa mira
    registrarAjuste(g, payload);       // e o replay guarda o passo
  }
  broker.publish(`game/${payload.gameId}/aim`, payload, { retain: true });
}

/** Estado completo + trajetória: é o que o cliente 3D usa para animar. */
function announceState(game, extra = {}) {
  broker.publish(`game/${game.id}/state`, {
    ...fullState(game, null),
    ...extra,
  }, { retain: true });
}

/** Avisa o lobby que as vagas mudaram. */
function publicarLobby(game) {
  broker.publish(`game/${game.id}/lobby`, {
    tipo: 'vagas',
    reservas: { A: reservaPublica(game.reservas?.A), B: reservaPublica(game.reservas?.B) },
    vagas: { A: vagasLivres(game, 'A'), B: vagasLivres(game, 'B') },
    pronto: isReady(game),
  });
  announceState(game);
}

/** O endereço por onde o cliente chegou — é o que serve para a IA também. */
function enderecoDe(req) {
  const host = req.headers.host || `localhost:${SERVER.port}`;
  return `http://${host}`;
}

/**
 * Tudo o que uma IA de fora precisa para entrar na vaga guardada. Vem em três
 * formatos porque há três jeitos de usar: o bot pronto do repositório, um
 * agente que fala HTTP na mão, e o convite cru.
 */
function instrucoesDeConvite(game, reserva, base) {
  const time = game.teams[reserva.team].name;
  const prompt = [
    `Jogue Futebotão (futebol de botão) pela API em ${base}, na partida ${game.id} ("${game.name}"), pelo time ${reserva.team} (${time}).`,
    '',
    'Passos:',
    `1. POST ${base}/api/auth/register  {"name":"<seu nome>","password":"<uma senha>","kind":"ai","model":"<seu modelo>"} -> devolve token`,
    `2. POST ${base}/api/games/${game.id}/join  {"team":"${reserva.team}","convite":"${reserva.convite}","autoStart":true}`,
    `3. GET  ${base}/api/rules  para as regras, medidas e física`,
    `4. GET  ${base}/api/games/${game.id}/state?describe=1&frame=1  quando for a sua vez`,
    `5. POST ${base}/api/games/${game.id}/move  {"buttonId","palheta":{"anguloAro","inclinacao","avanco","forca"},"turnToken"}`,
    '',
    'Use o Authorization: Bearer <token> em tudo depois do registro.',
    'Antes de bater, POST /aim mostra a palheta ao vivo e devolve a previsão do lance — use para conferir a mira.',
    'Para economizar: assine o WebSocket em ' + base.replace(/^http/, 'ws') + '/ws e espere o aviso da sua vez.',
  ].join('\n');

  return {
    gameId: game.id,
    partida: game.name,
    team: reserva.team,
    timeNome: time,
    convite: reserva.convite,
    base,
    comando: `node bot/ai-bot.js --game=${game.id} --team=${reserva.team} --convite=${reserva.convite} --base=${base}`,
    comandoHeuristico: `node bot/heuristic-bot.js --game=${game.id} --team=${reserva.team} --convite=${reserva.convite} --base=${base}`,
    prompt,
  };
}

/* ------------------------------------------------------------------ */
/* Rotas REST                                                          */
/* ------------------------------------------------------------------ */

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler });
};

/**
 * O que este servidor tem de arriscado, em português, para quem está jogando.
 *
 * Isto existe para ninguém ser pego desprevenido: o padrão é escutar em
 * 0.0.0.0, ou seja, a rede local inteira alcança o jogo — e as contas dos bots
 * de exemplo têm senha escrita no código. Nada disso é problema numa mesa
 * entre amigos; vira problema quando a porta sai de casa.
 */
function avisosDeSeguranca() {
  const avisos = [];
  const soLocal = SERVER.host === '127.0.0.1' || SERVER.host === 'localhost' || SERVER.host === '::1';

  if (!soLocal) {
    avisos.push({
      nivel: 'atencao',
      titulo: 'Este servidor está aberto para a sua rede',
      texto: `Ele escuta em ${SERVER.host}:${SERVER.port}. Quem estiver na mesma rede pode abrir o jogo, `
        + 'criar jogador e entrar nas partidas. Para deixar só nesta máquina, suba com HOST=127.0.0.1.',
    });
  }

  if (!process.env.BOT_PASSWORD) {
    avisos.push({
      nivel: 'atencao',
      titulo: 'Os bots de exemplo usam senha padrão',
      texto: 'bot/ai-bot.js e bot/heuristic-bot.js entram com uma senha que está no código-fonte. '
        + 'Quem a conhece joga pela conta deles. Defina BOT_PASSWORD antes de abrir o servidor para outras pessoas.',
    });
  }

  return avisos;
}

route('GET', '/api/seguranca', async () => ({ avisos: avisosDeSeguranca() }));

route('GET', '/api/health', async () => ({
  ok: true,
  uptime: Math.round(process.uptime()),
  partidas: gameStore.size(),
  broker: broker.stats(),
}));

route('GET', '/api/rules', async () => ({
  pitch: PITCH,
  physics: {
    buttonRadius: PHYS.buttonRadius, ballRadius: PHYS.ballRadius,
    maxShotSpeed: PHYS.maxShotSpeed, minShotSpeed: PHYS.minShotSpeed,
    muButton: PHYS.muButton, muBall: PHYS.muBall,
    restitutionBody: PHYS.restitutionBody,
    // Altura: a bola voa e passa por cima de quem for mais baixo que ela.
    gravity: PHYS.gravity, liftMax: PHYS.liftMax, ballBounce: PHYS.ballBounce,
    alturaBotao: PHYS.alturaBotao,
    // O goleiro NÃO é um disco: é um retângulo fixo.
    goleiro: { forma: 'caixa', comprimento: KEEPER.comprimento, espessura: KEEPER.espessura, altura: KEEPER.altura },
    // Traves: círculos fixos nos cantos da boca do gol. Elas afetam o jogo.
    traves: { raio: 1.3, em: [[0, PITCH.goalMin], [0, PITCH.goalMax], [PITCH.length, PITCH.goalMin], [PITCH.length, PITCH.goalMax]] },
  },
  defaults: RULES_DEFAULT,
  notas: [
    'O campo tem LINHAS ABERTAS: não há tabelas. A bola cruza a linha e SAI (lateral, escanteio, tiro de meta).',
    'Os BOTÕES podem sair do campo: eles jogam também na faixa de mesa em volta (margemFora), e só param na beirada dela, sem quicar. É assim que se cobra uma lateral de trás da linha e se busca bola colada na risca sem empurrá-la para fora.',
    'A jogada só vale se o botão movido encostar na bola em algum momento.',
    'Encostar num botão adversário antes da bola é falta e entrega a posse.',
    'A bola parar tendo tocado por último num botão adversário também entrega a posse.',
    'Não há limite de toques por padrão: quem está com a posse joga até errar.',
    'Gol quando o CENTRO da bola cruza a linha dentro da abertura, e abaixo do travessão.',
    'O gol só conta se o atacante declarou o chute antes (POST /declare).',
    'Na SAÍDA DE BOLA os dois times montam a mesa ao mesmo tempo: cada um arruma os próprios botões dentro do seu campo, e só o time que vai bater pode adiantar até 2 botões para dentro do círculo central. Arrumar é opcional — quem bater fecha a fase.',
    'Cada declaração vale por UM chute: declarou, bateu e não fez gol, a declaração acaba. Para chutar a gol de novo, declare de novo — a caixa do goleiro fica onde está, e o defensor decide se a move.',
    'Em BOLA PARADA não se declara: nem na saída de bola (o primeiro toque da partida e o de depois de cada gol), nem em lateral, escanteio ou tiro de meta. Dê o primeiro toque e declare na jogada seguinte.',
    'Ao declarar, a palheta que você tinha montada fica guardada e volta igualzinha quando o defensor terminar de posicionar o goleiro.',
    'As traves são corpos reais: com bola de raio 1.15 e trave de 1.3, o centro da bola não passa a menos de 2.45 cm do centro do poste.',
  ],
}));

route('POST', '/api/auth/register', async (ctx) => {
  const { name, password, kind, model } = ctx.body;
  const p = registerPlayer({ name, password, kind, model });
  return { ...p, token: issueToken(p.playerId) };
});

route('POST', '/api/auth/login', async (ctx) => {
  const { playerId, name, password } = ctx.body;
  const p = authenticate({ playerId, name, password });
  return { ...publicPlayer(p), token: issueToken(p.id) };
});

route('POST', '/api/auth/logout', async (ctx) => {
  revokeToken(bearer(ctx.req, ctx.url));
  return { ok: true };
});

route('GET', '/api/me', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const partidas = gameStore.all()
    .filter((g) => teamOf(g, p.id))
    .map((g) => ({ gameId: g.id, name: g.name, team: teamOf(g, p.id), status: g.status, yourTurn: g.currentPlayerId === p.id }));
  return { ...publicPlayer(p), partidas };
});

route('GET', '/api/players', async () => ({ players: listPlayers() }));

route('GET', '/api/games', async (ctx) => ({
  // Com token, cada partida vem sabendo se VOCÊ já está nela — assim o lobby
  // mostra "voltar para a partida" em vez de oferecer um time que não dá.
  games: gameStore.all().map((g) => {
    const eu = resolveToken(bearer(ctx.req, ctx.url));
    const meuTime = eu ? teamOf(g, eu) : null;
    // Uma vaga guardada para uma IA não aparece como livre no lobby.
    const vagasDe = (t) => vagasLivres(g, t);
    return {
      gameId: g.id, name: g.name, status: g.status,
      seuTime: meuTime,
      temBot: temBot(g),
      teams: {
        A: { name: g.teams.A.name, ocupadas: g.teams.A.players.length, slots: g.teams.A.slots, vagas: vagasDe('A'), esperandoIA: !!g.reservas?.A },
        B: { name: g.teams.B.name, ocupadas: g.teams.B.players.length, slots: g.teams.B.slots, vagas: vagasDe('B'), esperandoIA: !!g.reservas?.B },
      },
      score: [g.teams.A.score, g.teams.B.score],
      turnNo: g.turnNo,
      lances: g.replay.length,        // quantas jogadas já foram resolvidas
      fase: g.fase,
      config: {
        buttonsPerTeam: g.config.buttonsPerTeam,
        touchesPerPossession: g.config.touchesPerPossession,
        maxTurns: g.config.maxTurns,
        maxPossessions: g.config.maxPossessions,
        turnTimeoutMs: g.config.turnTimeoutMs,
      },
    };
  }),
}));

/**
 * Duas partidas com o mesmo nome são indistinguíveis no lobby e na aba do
 * navegador. Se o nome já existe, numera: "Pelada", "Pelada 01", "Pelada 02".
 */
function nomeUnicoDePartida(desejado) {
  const base = String(desejado || 'Partida').trim().slice(0, 40) || 'Partida';
  const usados = new Set(gameStore.all().map((g) => g.name.toLowerCase()));
  if (!usados.has(base.toLowerCase())) return base;

  for (let n = 1; n <= 99; n++) {
    const tentativa = `${base} ${String(n).padStart(2, '0')}`;
    if (!usados.has(tentativa.toLowerCase())) return tentativa;
  }
  // Passou de 99 homônimas: cai para um sufixo que não colide.
  return `${base} ${newId('n', 4).split('_')[1]}`;
}

route('POST', '/api/games', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const g = createGame({ ...ctx.body, name: nomeUnicoDePartida(ctx.body.name), ownerId: p.id });
  gameStore.put(g);
  announceState(g);
  broker.publish('lobby/games', { tipo: 'criada', gameId: g.id, name: g.name, por: p.id });
  return { gameId: g.id, ...fullState(g, p.id) };
});

route('GET', '/api/games/:id', async (ctx) => {
  const g = requireGame(ctx.params.id);
  const pid = resolveToken(bearer(ctx.req, ctx.url));
  return fullState(g, pid);
});

route('DELETE', '/api/games/:id', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const g = requireGame(ctx.params.id);
  if (g.ownerId && g.ownerId !== p.id) throw httpErr(403, 'só quem criou pode remover a partida');
  gameStore.delete(g.id);
  broker.clearRetained(`game/${g.id}/`);
  broker.publish('lobby/games', { tipo: 'removida', gameId: g.id });
  return { ok: true };
});

route('POST', '/api/games/:id/join', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const g = requireGame(ctx.params.id);
  const { team, already, convidado } = joinGame(g, p.id, ctx.body.team, ctx.body.convite || null);
  broker.publish(`game/${g.id}/lobby`, { tipo: 'entrou', playerId: p.id, name: p.name, team, pronto: isReady(g) });
  announceState(g);
  if (ctx.body.autoStart && isReady(g) && g.status === 'lobby') {
    startGame(g);
    announceEvent(g, { type: 'start', turnNo: g.turnNo });
    announceState(g);
    announceTurn(g);
  }
  return { gameId: g.id, team, already, convidado, pronto: isReady(g), status: g.status, ...fullState(g, p.id) };
});

route('POST', '/api/games/:id/leave', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const g = requireGame(ctx.params.id);
  const team = leaveGame(g, p.id);
  broker.publish(`game/${g.id}/lobby`, { tipo: 'saiu', playerId: p.id, team });
  announceState(g);
  if (g.status === 'running') announceTurn(g);
  return { ok: true, team };
});

route('POST', '/api/games/:id/start', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const g = requireGame(ctx.params.id);
  if (g.ownerId && g.ownerId !== p.id && !teamOf(g, p.id))
    throw httpErr(403, 'só quem criou ou quem joga pode iniciar');
  startGame(g);
  for (const t of ['A', 'B']) for (const pid of g.teams[t].players) bumpStat(pid, 'games');
  announceEvent(g, { type: 'start', turnNo: g.turnNo });
  announceState(g);
  announceTurn(g);
  return fullState(g, p.id);
});

route('GET', '/api/games/:id/state', async (ctx) => {
  const g = requireGame(ctx.params.id);
  const pid = resolveToken(bearer(ctx.req, ctx.url));
  const q = ctx.url.searchParams;
  const out = q.get('brief') === '1' ? briefState(g) : fullState(g, pid);

  if (q.get('describe') === '1') {
    out.description = describeGame(g, pid, { historico: Number(q.get('history') || 6) });
  }
  if (q.get('frame') === '1') {
    const png = renderScene(sceneOf(g, pid, q.get('message') || null));
    out.frame = {
      mediaType: 'image/png',
      encoding: 'base64',
      data: png.toString('base64'),
      bytes: png.length,
      eixos: 'origem no canto inferior esquerdo; x cresce para a direita, y para cima',
    };
  }
  return out;
});

route('GET', '/api/games/:id/frame.png', async (ctx) => {
  const g = requireGame(ctx.params.id);
  const pid = resolveToken(bearer(ctx.req, ctx.url));
  const png = renderScene(sceneOf(g, pid, ctx.url.searchParams.get('message')));
  return { __raw: png, __type: 'image/png' };
});

/**
 * Guarda uma vaga para uma IA de fora (uma LLM, um subagente) e devolve tudo
 * o que ela precisa para entrar: o convite, o comando pronto e um texto que dá
 * para colar direto num agente.
 */
/**
 * Acaba a partida agora, com o placar como está. Os bots param sozinhos: o
 * relógio deles só age em partida em andamento.
 */
route('POST', '/api/games/:id/encerrar', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const g = requireGame(ctx.params.id);
  const result = encerrarPartida(g, p.id, p.name);

  announceEvent(g, { type: 'finish', turnNo: g.turnNo, ...result });
  announceState(g);
  announceTurn(g);
  return { ok: true, status: g.status, result };
});

route('POST', '/api/games/:id/aguardar', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const g = requireGame(ctx.params.id);
  const r = reservarVaga(g, p.id, ctx.body?.team, { nota: ctx.body?.nota });

  publicarLobby(g);
  announceEvent(g, { type: 'reserva', turnNo: g.turnNo, team: r.team, playerId: p.id });

  const base = enderecoDe(ctx.req);
  return {
    ok: true,
    ...instrucoesDeConvite(g, r, base),
  };
});

/** Cancela a espera e devolve a vaga ao lobby. */
route('DELETE', '/api/games/:id/aguardar', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const g = requireGame(ctx.params.id);
  const team = ctx.url.searchParams.get('team') || ctx.body?.team;
  const r = liberarVaga(g, p.id, team);
  publicarLobby(g);
  return { ok: true, ...r };
});

route('POST', '/api/games/:id/bot', async (ctx) => {
  requirePlayer(ctx.req, ctx.url);
  const g = requireGame(ctx.params.id);
  if (g.status === 'finished') throw httpErr(409, 'partida encerrada', { code: 'GAME_FINISHED' });

  const bot = adicionarBot(g, ctx.body.team, { nome: ctx.body.nome });
  broker.publish(`game/${g.id}/lobby`, { tipo: 'entrou', playerId: bot.playerId, name: bot.name, team: bot.team, bot: true, pronto: isReady(g) });
  announceState(g);
  broker.publish('lobby/games', { tipo: 'bot', gameId: g.id });

  // Com a mesa completa, começa sozinho: o jogador clicou para JOGAR.
  if (ctx.body.autoStart !== false && isReady(g) && g.status === 'lobby') {
    startGame(g);
    announceEvent(g, { type: 'start', turnNo: g.turnNo });
    announceState(g);
    announceTurn(g);
  }
  return { ok: true, bot, status: g.status, ...fullState(g, null) };
});

route('POST', '/api/games/:id/declare', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const g = requireGame(ctx.params.id);
  const r = declararChute(g, p.id);

  announceEvent(g, { type: 'declara', turnNo: g.turnNo, team: g.possession, playerId: p.id });
  announceState(g);
  announceTurn(g);
  broker.publish(`game/${g.id}/keeper`, {
    gameId: g.id, fase: 'goleiro',
    defensor: perfilDe(r.defensor),
    atacante: perfilDe(p.id),
    goleiro: estadoGoleiro(goleiroDe(g, g.possession === 'A' ? 'B' : 'A')),
    area: areaDoGoleiro(g.possession === 'A' ? 'B' : 'A'),
    deadline: r.deadline,
  }, { retain: true });

  return { ok: true, ...r, state: briefState(g) };
});

route('POST', '/api/games/:id/keeper', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const g = requireGame(ctx.params.id);
  const r = posicionarGoleiro(g, p.id, ctx.body);

  // Cada mexida é difundida, como a palheta: dá para ver a caixa se ajeitando.
  broker.publish(`game/${g.id}/keeper`, {
    gameId: g.id, fase: r.fase,
    playerId: p.id, playerName: p.name,
    goleiro: r.goleiro,
    area: areaDoGoleiro(r.goleiro.team),
    confirmado: r.confirmado,
  }, { retain: true });

  if (r.confirmado) {
    // A vez volta para quem declarou — e a palheta volta como ele a deixou.
    if (r.miraGuardada) announceAim({ ...r.miraGuardada, restaurada: true });
    announceEvent(g, { type: 'goleiro', turnNo: g.turnNo, team: r.goleiro.team, playerId: p.id });
    announceState(g);
    announceTurn(g);
  }
  return { ok: true, ...r };
});

route('POST', '/api/games/:id/place', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const g = requireGame(ctx.params.id);
  const r = posicionarBotao(g, p.id, ctx.body);
  const body = g.bodies.find((b) => b.id === r.botao);

  const arredonda = (b) => ({ id: b.id, x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10 });
  broker.publish(`game/${g.id}/place`, {
    gameId: g.id, fase: r.fase, tipo: r.tipo,
    playerId: p.id, playerName: p.name,
    team: r.team || null,
    formacao: !!r.formacao,
    prontos: r.prontos || null,
    botao: body ? arredonda(body) : null,
    // Na formação da saída, quem assiste vê a mesa inteira se arrumando.
    botoes: (r.botoes || []).map((id) => g.bodies.find((b) => b.id === id)).filter(Boolean).map(arredonda),
    area: r.area || null,
    bola: briefState(g).ball,
    raio: r.raio ?? g.config.raioCobranca,
    confirmado: r.confirmado,
  }, { retain: true });

  // O "pronto" do time que NÃO bate não mexe na vez de ninguém: só avisa.
  const fechouAFase = r.confirmado && r.fase === 'jogada';
  if (r.confirmado) {
    announceEvent(g, {
      type: r.formacao && !fechouAFase ? 'formacao' : 'cobranca',
      turnNo: g.turnNo, team: r.team || g.possession, playerId: p.id,
      tipo: r.tipo, botao: r.botao,
    });
    announceState(g);
    if (fechouAFase) announceTurn(g);
  } else {
    // Arrumação em curso: a mesa mudou de verdade, e quem assiste (e quem está
    // mirando) precisa saber — a previsão do lance depende de onde tudo está.
    announceState(g);
  }
  return { ok: true, ...r };
});

route('POST', '/api/games/:id/aim', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const g = requireGame(ctx.params.id);
  const payload = resolverAim(g, p.id, ctx.body.buttonId, ctx.body.palheta);
  announceAim(payload);
  return payload;
});

route('GET', '/api/games/:id/replay', async (ctx) => {
  const g = requireGame(ctx.params.id);
  const idx = replayIndex(g);
  // ?full=1 traz as trajetórias junto, para o navegador rever sem N requisições.
  if (ctx.url.searchParams.get('full') === '1') {
    return { ...idx, trajetorias: g.replay.map((l) => ({ n: l.n, ids: l.ids, fps: l.fps, frames: l.frames, voos: l.voos, ajustes: l.ajustes })) };
  }
  return idx;
});

route('GET', '/api/games/:id/replay/:n', async (ctx) => {
  const g = requireGame(ctx.params.id);
  return replayLance(g, Number(ctx.params.n));
});

route('GET', '/api/games/:id/log', async (ctx) => {
  const g = requireGame(ctx.params.id);
  const since = Number(ctx.url.searchParams.get('since') || 0);
  const eventos = g.log.filter((e) => e.seq > since);
  return { gameId: g.id, seq: g.seq, eventos: eventos.map((e) => ({ ...e, texto: resumoEvento(e) })) };
});

route('POST', '/api/games/:id/move', async (ctx) => {
  const p = requirePlayer(ctx.req, ctx.url);
  const g = requireGame(ctx.params.id);

  const { result, trajectory } = applyMove(g, p.id, ctx.body);

  bumpStat(p.id, 'shots');
  if (result.goal && !result.goal.ownGoal) bumpStat(p.id, 'goals');
  if (result.foul) bumpStat(p.id, 'fouls');

  // Ordem importa: evento -> estado (com trajetória) -> aviso de vez.
  if (result.goal) {
    announceEvent(g, {
      type: 'goal', turnNo: result.turnNo, team: result.goal.team, playerId: p.id,
      buttonId: result.buttonId, ownGoal: result.goal.ownGoal,
      scoreA: g.teams.A.score, scoreB: g.teams.B.score,
    });
  } else if (result.foul) {
    announceEvent(g, { type: 'foul', turnNo: result.turnNo, team: result.team, playerId: p.id, buttonId: result.buttonId, on: result.foulOn });
  }

  announceState(g, { trajectory, lastMove: result });

  if (g.status === 'finished') {
    announceEvent(g, { type: 'finish', turnNo: g.turnNo, ...g.result });
    broker.publish(`game/${g.id}/turn`, { gameId: g.id, status: 'finished', result: g.result }, { retain: true });
  } else {
    announceTurn(g);
  }

  return { ok: true, result, trajectory, state: briefState(g) };
});

/* ------------------------------------------------------------------ */
/* Servidor                                                            */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(publicDir, path.normalize(rel).replace(/^([/\\])+/, ''));
  // Com separador no fim de propósito: `startsWith(publicDir)` sozinho deixaria
  // passar um diretório IRMÃO cujo nome começa igual (…/public-privado).
  if (file !== publicDir && !file.startsWith(publicDir + path.sep)) return send(res, 403, 'Proibido');
  fs.readFile(file, (err, data) => {
    if (err) {
      return send(res, 404, 'Não encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Token',
      'Access-Control-Max-Age': '86400',
    });
  }

  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.rx.exec(url.pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await r.handler({ req, res, url, params, body });
      if (out && out.__raw) return send(res, 200, out.__raw, { 'Content-Type': out.__type, 'Cache-Control': 'no-store' });
      return sendJSON(res, 200, out);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[erro]', err);
      // Tudo o que o erro carrega vai junto: `httpErr` põe ali o contexto que
      // ajuda quem chamou a se corrigir (a área válida, o placar final, de quem
      // é a vez). Uma lista fixa de campos obrigava a lembrar de estender ela a
      // cada erro novo — e o contexto sumia calado.
      const { status: _s, code: _c, ...contexto } = err;
      return sendJSON(res, status, {
        error: err.message,
        status,
        code: err.code || (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST'),
        ...contexto,
      });
    }
  }
  return sendJSON(res, 404, { error: `rota não encontrada: ${req.method} ${url.pathname}` });
});

/* ---------------- WebSocket / broker ---------------- */

// Socket meia-boca no handshake HTTP: descarta a conexão, não o servidor.
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  socket.destroy();
});

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => { /* tratado na WSConnection; aqui só evita o throw */ });
  const conn = handleUpgrade(req, socket, head, { path: '/ws' });
  if (!conn) return;

  const session = broker.attach(conn);
  conn.on('error', (err) => {
    if (err?.code !== 'ECONNRESET') console.warn('[ws]', session.id, err?.code || err?.message);
  });
  const url = new URL(req.url, 'http://localhost');

  // Autenticação por query string também funciona (facilita o navegador).
  const qtok = url.searchParams.get('token');
  if (qtok) {
    const pid = resolveToken(qtok);
    if (pid) { session.playerId = pid; session.name = getPlayer(pid)?.name || null; }
  }

  conn.sendJSON({
    op: 'hello',
    clientId: session.id,
    playerId: session.playerId,
    serverTime: Date.now(),
    topicos: {
      'game/{id}/state': 'estado completo + trajetória da última jogada (pesado)',
      'game/{id}/turn': 'de quem é a vez (leve)',
      'game/{id}/event': 'gol, falta, timeout, início, fim (leve)',
      'game/{id}/chat': 'mensagens dos jogadores',
      'game/{id}/lobby': 'entradas e saídas',
      'player/{seu_id}/turn': 'privado: é a sua vez (leve) — assine só isto para economizar token',
      'lobby/games': 'partidas criadas e removidas',
    },
  });

  conn.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return conn.sendJSON({ op: 'error', error: 'JSON inválido' }); }
    try { handleWsOp(session, conn, msg); } catch (err) {
      conn.sendJSON({ op: 'error', error: err.message, ref: msg.op });
    }
  });
});

function handleWsOp(session, conn, msg) {
  switch (msg.op) {
    case 'connect': {
      const pid = resolveToken(msg.token);
      if (!pid) return conn.sendJSON({ op: 'connack', ok: false, error: 'token inválido' });
      session.playerId = pid;
      session.name = getPlayer(pid)?.name || null;
      // Assinaturas privadas negadas antes agora podem valer.
      return conn.sendJSON({ op: 'connack', ok: true, playerId: pid, name: session.name });
    }

    case 'subscribe': {
      const topics = Array.isArray(msg.topics) ? msg.topics : [msg.topic].filter(Boolean);
      const { aceitos, negados } = broker.subscribe(session, topics);
      return conn.sendJSON({ op: 'suback', aceitos, negados, id: msg.id });
    }

    case 'unsubscribe': {
      const topics = Array.isArray(msg.topics) ? msg.topics : [msg.topic].filter(Boolean);
      return conn.sendJSON({ op: 'unsuback', assinaturas: broker.unsubscribe(session, topics), id: msg.id });
    }

    case 'publish': {
      // Clientes só podem falar no chat. Estado é sempre do servidor.
      if (!/^game\/[^/]+\/chat$/.test(String(msg.topic || '')))
        return conn.sendJSON({ op: 'error', error: 'clientes só publicam em game/{id}/chat', ref: 'publish' });
      if (!session.playerId) return conn.sendJSON({ op: 'error', error: 'faça connect antes de publicar' });
      broker.publish(msg.topic, { playerId: session.playerId, name: session.name, texto: String(msg.payload?.texto ?? msg.payload ?? '').slice(0, 400) });
      return conn.sendJSON({ op: 'puback', id: msg.id });
    }

    // Conveniência: puxar estado sem sair para o REST.
    case 'state': {
      const g = gameStore.get(msg.gameId);
      if (!g) return conn.sendJSON({ op: 'state', error: 'partida não encontrada', id: msg.id });
      const pid = session.playerId;
      const out = msg.brief ? briefState(g) : fullState(g, pid);
      if (msg.describe) out.description = describeGame(g, pid, { historico: msg.history ?? 6 });
      if (msg.frame) {
        const png = renderScene(sceneOf(g, pid, msg.message || null));
        out.frame = { mediaType: 'image/png', encoding: 'base64', data: png.toString('base64'), bytes: png.length };
      }
      return conn.sendJSON({ op: 'state', id: msg.id, state: out });
    }

    // Palheta ao vivo: quem tem a vez transmite como está posicionando.
    // Todo mundo que assina game/{id}/aim vê o ajuste acontecendo.
    case 'aim': {
      const g = gameStore.get(msg.gameId);
      if (!g) return conn.sendJSON({ op: 'error', error: 'partida não encontrada', ref: 'aim', id: msg.id });
      if (!session.playerId) return conn.sendJSON({ op: 'error', error: 'faça connect antes', ref: 'aim' });
      try {
        const payload = resolverAim(g, session.playerId, msg.buttonId, msg.palheta);
        announceAim(payload);
        return conn.sendJSON({ op: 'aimack', id: msg.id, ...payload });
      } catch (err) {
        return conn.sendJSON({ op: 'error', error: err.message, code: err.code, ref: 'aim', id: msg.id });
      }
    }

    case 'ping':
      return conn.sendJSON({ op: 'pong', ts: Date.now(), id: msg.id });

    default:
      return conn.sendJSON({ op: 'error', error: `op desconhecida: ${msg.op}` });
  }
}

/* ---------------- relógio dos turnos ---------------- */

// Avisos que o bot local usa para difundir o que está fazendo. Ele chama o
// motor direto, sem passar pela rede, então a difusão fica por nossa conta.
const avisosDoBot = {
  para: (game) => ({
    aim: (playerId, buttonId, palheta) => {
      try { announceAim(resolverAim(game, playerId, buttonId, palheta)); } catch { /* o turno virou */ }
    },
    mudou: () => announceState(game),
    jogou: ({ tipo, resultado }) => {
      if (resultado) {
        const r = resultado.result;
        if (r.goal) {
          announceEvent(game, {
            type: 'goal', turnNo: r.turnNo, team: r.goal.team, playerId: r.playerId,
            buttonId: r.buttonId, ownGoal: r.goal.ownGoal,
            scoreA: game.teams.A.score, scoreB: game.teams.B.score,
          });
        } else if (r.foul) {
          announceEvent(game, { type: 'foul', turnNo: r.turnNo, team: r.team, playerId: r.playerId, buttonId: r.buttonId, on: r.foulOn });
        }
        announceState(game, { trajectory: resultado.trajectory, lastMove: r });
      } else {
        announceState(game);
      }
      if (tipo === 'declarou') announceEvent(game, { type: 'declara', turnNo: game.turnNo, team: game.possession, playerId: game.declaradoPor });
      if (game.status === 'finished') announceEvent(game, { type: 'finish', turnNo: game.turnNo, ...game.result });
      else announceTurn(game);
    },
  }),
};

setInterval(() => {
  passoDosBots(gameStore.all(), avisosDoBot);
  for (const g of gameStore.all()) {
    if (g.status !== 'running') continue;
    const r = checkTimeout(g);
    if (r) {
      announceEvent(g, { type: 'timeout', turnNo: g.turnNo, team: r.team });
      announceState(g);
      if (g.status === 'finished') announceEvent(g, { type: 'finish', turnNo: g.turnNo, ...g.result });
      else announceTurn(g);
    }
  }
}, 1000).unref?.();

// Keepalive das conexões.
setInterval(() => {
  for (const s of broker.clients.values()) {
    if (!s.conn.open) continue;
    if (!s.conn.isAlive) { s.conn.close(1001, 'sem resposta'); continue; }
    s.conn.ping();
  }
}, 30000).unref?.();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { flush(); } catch {} process.exit(0); });
}

server.listen(SERVER.port, SERVER.host, () => {
  console.log(`\n  ⚽ Futebotão`);
  console.log(`  http://localhost:${SERVER.port}`);
  console.log(`  WebSocket: ws://localhost:${SERVER.port}/ws`);

  for (const a of avisosDeSeguranca()) {
    console.log(`\n  ⚠  ${a.titulo}`);
    console.log(`     ${a.texto}`);
  }
  console.log(`  API: http://localhost:${SERVER.port}/api/rules\n`);
});

export { server };
