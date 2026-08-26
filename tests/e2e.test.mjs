// Teste ponta a ponta contra um servidor já rodando em BASE.
// node tests/e2e.test.mjs
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3000';
const WSURL = BASE.replace(/^http/, 'ws') + '/ws';

let fails = 0;
const ok = (nome, cond, info = '') => {
  console.log((cond ? '  PASS ' : '  FAIL ') + nome + (info ? '  -> ' + info : ''));
  if (!cond) fails++;
};
const secao = (t) => console.log('\n== ' + t + ' ==');

async function api(method, p, { token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  return { status: res.status, json };
}

const sufixo = Math.random().toString(36).slice(2, 8);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------- */
secao('Autenticação');

const regA = await api('POST', '/api/auth/register', { body: { name: 'alice-' + sufixo, password: 'senha1234' } });
ok('registra jogador A', regA.status === 200 && !!regA.json.token, regA.json.playerId);

const regB = await api('POST', '/api/auth/register', { body: { name: 'bruno-' + sufixo, password: 'senha5678', kind: 'ai' } });
ok('registra jogador B (ia)', regB.status === 200 && regB.json.kind === 'ai');

const dup = await api('POST', '/api/auth/register', { body: { name: 'alice-' + sufixo, password: 'outra123' } });
ok('recusa nome duplicado', dup.status === 409, dup.json.error);

const fraca = await api('POST', '/api/auth/register', { body: { name: 'zé-' + sufixo, password: '12' } });
ok('recusa senha curta', fraca.status === 400);

const loginRuim = await api('POST', '/api/auth/login', { body: { name: 'alice-' + sufixo, password: 'errada' } });
ok('recusa senha errada', loginRuim.status === 401);

const loginBom = await api('POST', '/api/auth/login', { body: { name: 'alice-' + sufixo, password: 'senha1234' } });
ok('login com senha certa', loginBom.status === 200 && !!loginBom.json.token);

const semToken = await api('GET', '/api/me');
ok('rota protegida exige token', semToken.status === 401);

const tokA = regA.json.token, tokB = regB.json.token;
const idA = regA.json.playerId, idB = regB.json.playerId;

/* -------------------------------------------------- */
secao('Criação e entrada na partida');

const cria = await api('POST', '/api/games', {
  token: tokA,
  body: {
    name: 'Teste E2E', teamAName: 'Azuis', teamBName: 'Rubros',
    slotsA: 1, slotsB: 1,
    config: { buttonsPerTeam: 5, touchesPerPossession: 3, maxPossessions: 12, turnTimeoutMs: 60000 },
  },
});
ok('cria partida', cria.status === 200 && !!cria.json.gameId, cria.json.gameId);
const GID = cria.json.gameId;

const j1 = await api('POST', `/api/games/${GID}/join`, { token: tokA, body: { team: 'A' } });
ok('A entra no time A', j1.status === 200 && j1.json.team === 'A');

const j2 = await api('POST', `/api/games/${GID}/join`, { token: tokB, body: { team: 'B' } });
ok('B entra no time B', j2.status === 200 && j2.json.team === 'B');
ok('partida fica pronta', j2.json.pronto === true);

const cheio = await api('POST', `/api/games/${GID}/join`, { token: loginBom.json.token, body: { team: 'A' } });
ok('reentrada do mesmo jogador é idempotente', cheio.status === 200 && cheio.json.already === true);

/* -------------------------------------------------- */
secao('WebSocket / broker');

const ws = new WebSocket(WSURL);
const recebidas = [];
const espereMsg = (pred, ms = 5000) => new Promise((res, rej) => {
  const achou = recebidas.find(pred);
  if (achou) return res(achou);
  const t = setTimeout(() => rej(new Error('timeout esperando mensagem')), ms);
  const h = (m) => {
    if (pred(m)) { clearTimeout(t); ouvintes.delete(h); res(m); }
  };
  ouvintes.add(h);
});
const ouvintes = new Set();

await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  recebidas.push(m);
  for (const h of [...ouvintes]) h(m);
};

const hello = await espereMsg((m) => m.op === 'hello');
ok('recebe hello com catálogo de tópicos', !!hello.topicos);

ws.send(JSON.stringify({ op: 'connect', token: tokB }));
const connack = await espereMsg((m) => m.op === 'connack');
ok('connect autentica no broker', connack.ok === true && connack.playerId === idB);

// Tópico privado alheio deve ser negado.
ws.send(JSON.stringify({ op: 'subscribe', id: 1, topics: [`player/${idA}/turn`, `player/${idB}/turn`, `game/${GID}/#`] }));
const suback = await espereMsg((m) => m.op === 'suback');
ok('nega assinatura de tópico privado alheio', suback.negados.includes(`player/${idA}/turn`), JSON.stringify(suback.negados));
ok('aceita o próprio tópico privado', suback.aceitos.includes(`player/${idB}/turn`));
ok('aceita curinga da partida', suback.aceitos.includes(`game/${GID}/#`));

ws.send(JSON.stringify({ op: 'ping', id: 2 }));
ok('responde ping', !!(await espereMsg((m) => m.op === 'pong')));

// Cliente não pode forjar estado.
ws.send(JSON.stringify({ op: 'publish', topic: `game/${GID}/state`, payload: { falso: true } }));
const erroPub = await espereMsg((m) => m.op === 'error' && m.ref === 'publish');
ok('bloqueia publicação em tópico de estado', !!erroPub, erroPub.error);

/* -------------------------------------------------- */
secao('Início e turnos');

recebidas.length = 0;
const start = await api('POST', `/api/games/${GID}/start`, { token: tokA });
ok('inicia a partida', start.status === 200 && start.json.status === 'running');
ok('primeiro turno é do time A', start.json.possession === 'A' && start.json.currentPlayerId === idA);

const evStart = await espereMsg((m) => m.topic === `game/${GID}/event` && m.payload.type === 'start');
ok('broker anuncia início', !!evStart);
const turnoMsg = await espereMsg((m) => m.topic === `game/${GID}/turn`);
ok('broker anuncia de quem é a vez', turnoMsg.payload.currentPlayerId === idA);

/* -------------------------------------------------- */
secao('Regras da jogada');

const naoEhSuaVez = await api('POST', `/api/games/${GID}/move`, {
  token: tokB, body: { buttonId: 'B1', targetX: 100, targetY: 60, power: 0.5 },
});
ok('recusa jogada fora da vez', naoEhSuaVez.status === 403, naoEhSuaVez.json.error);

const botaoAlheio = await api('POST', `/api/games/${GID}/move`, {
  token: tokA, body: { buttonId: 'B1', targetX: 100, targetY: 60, power: 0.5 },
});
ok('recusa mover botão do adversário', botaoAlheio.status === 403);

const goleiro = await api('POST', `/api/games/${GID}/move`, {
  token: tokA, body: { buttonId: 'AG', targetX: 100, targetY: 60, power: 0.5 },
});
ok('recusa mover goleiro automático', goleiro.status === 400, goleiro.json.error);

const tokenVelho = await api('POST', `/api/games/${GID}/move`, {
  token: tokA, body: { buttonId: 'A1', targetX: 100, targetY: 60, power: 0.5, turnToken: 'trn_zzzzzzzzzz' },
});
ok('recusa turnToken vencido', tokenVelho.status === 409, tokenVelho.json.error);

const semDirecao = await api('POST', `/api/games/${GID}/move`, {
  token: tokA, body: { buttonId: 'A1', power: 0.5 },
});
ok('exige direção na jogada', semDirecao.status === 400);

/* -------------------------------------------------- */
secao('Jogada válida e trajetória');

const estadoAntes = await api('GET', `/api/games/${GID}/state?describe=1`, { token: tokA });
ok('estado traz turnToken para quem tem a vez', !!estadoAntes.json.turnToken);
ok('estado traz descrição textual', typeof estadoAntes.json.description === 'string' && estadoAntes.json.description.includes('SEUS BOTÕES'));
ok('descrição marca que é a sua vez', estadoAntes.json.description.includes('É A SUA VEZ'));
ok('lista botões controláveis', estadoAntes.json.controllable.length === 5, JSON.stringify(estadoAntes.json.controllable));

const bola = estadoAntes.json.ball;
const mov1 = await api('POST', `/api/games/${GID}/move`, {
  token: tokA,
  body: { buttonId: estadoAntes.json.controllable[0], targetX: bola.x, targetY: bola.y, power: 0.55, turnToken: estadoAntes.json.turnToken },
});
ok('aceita jogada válida', mov1.status === 200, mov1.json.error || mov1.json.result?.outcome);
ok('devolve trajetória para animar', Array.isArray(mov1.json.trajectory?.frames) && mov1.json.trajectory.frames.length > 2,
   (mov1.json.trajectory?.frames?.length ?? 0) + ' frames');
ok('trajetória tem ids alinhados com os pares x,y',
   mov1.json.trajectory.frames[0].p.length === mov1.json.trajectory.ids.length * 2);
ok('registra se tocou na bola', typeof mov1.json.result.touchedBall === 'boolean', 'tocou=' + mov1.json.result.touchedBall);

const msgEstado = await espereMsg((m) => m.topic === `game/${GID}/state` && m.payload.trajectory);
ok('broker publica estado com trajetória', !!msgEstado);

/* -------------------------------------------------- */
secao('Alternância de turno');

const depois = await api('GET', `/api/games/${GID}/state`, { token: tokA });
const r1 = mov1.json.result;

// Regra nova: a posse só passa se houver motivo. Sem motivo, segue jogando.
ok('posse muda exatamente quando há motivo',
   r1.possessionChanged === (r1.motivo !== null),
   `motivo=${r1.motivo} mudou=${r1.possessionChanged}`);
ok('o estado bate com o resultado',
   (depois.json.possession === 'A') === !r1.possessionChanged,
   `posse=${depois.json.possession} outcome=${r1.outcome}`);
ok('turno avançou', depois.json.turnNo === estadoAntes.json.turnNo + 1);

// Joga até a posse virar por algum motivo (sem limite de toques agora).
let estado = depois.json;
let voltas = 0;
while (estado.possession === 'A' && estado.status === 'running' && voltas < 25) {
  const st = await api('GET', `/api/games/${GID}/state`, { token: tokA });
  estado = st.json;
  if (estado.possession !== 'A' || estado.status !== 'running') break;
  const b = estado.bodies.find((x) => x.id === 'ball');
  await api('POST', `/api/games/${GID}/move`, {
    token: tokA, body: { buttonId: estado.controllable[0], targetX: b.x, targetY: b.y, power: 0.5, turnToken: estado.turnToken },
  });
  voltas++;
}
const aposEsgotar = (await api('GET', `/api/games/${GID}/state`, { token: tokB })).json;
ok('a posse acaba virando para B', aposEsgotar.possession === 'B' || aposEsgotar.status === 'finished',
   `posse=${aposEsgotar.possession} turno=${aposEsgotar.turnNo} (${voltas} jogadas)`);
ok('B agora enxerga seus próprios botões controláveis', aposEsgotar.status !== 'running' || aposEsgotar.controllable.every((id) => id.startsWith('B')),
   JSON.stringify(aposEsgotar.controllable));

const avisoPrivado = recebidas.find((m) => m.topic === `player/${idB}/turn`);
ok('B recebe aviso privado quando chega a vez dele', !!avisoPrivado, avisoPrivado ? 'turnToken presente: ' + !!avisoPrivado.payload.turnToken : '');
ok('aviso privado é enxuto (< 800 bytes)', !avisoPrivado || JSON.stringify(avisoPrivado).length < 800,
   avisoPrivado ? JSON.stringify(avisoPrivado).length + ' bytes' : '');

/* -------------------------------------------------- */
secao('Frame PNG');

const comFrame = await api('GET', `/api/games/${GID}/state?frame=1&describe=1`, { token: tokB });
ok('estado entrega frame base64', !!comFrame.json.frame?.data, (comFrame.json.frame?.bytes / 1024).toFixed(1) + ' KB');
const png = Buffer.from(comFrame.json.frame.data, 'base64');
ok('frame é PNG válido', png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
fs.writeFileSync('tests/frame-e2e.png', png);

const raw = await fetch(`${BASE}/api/games/${GID}/frame.png?token=${tokB}`);
ok('endpoint frame.png responde imagem', raw.headers.get('content-type') === 'image/png');

/* -------------------------------------------------- */
secao('Consulta sob demanda (economia de token)');

const breve = await api('GET', `/api/games/${GID}/state?brief=1`, { token: tokB });
const completo = await api('GET', `/api/games/${GID}/state`, { token: tokB });
const tamBreve = JSON.stringify(breve.json).length;
const tamCompleto = JSON.stringify(completo.json).length;
ok('modo brief é bem menor que o completo', tamBreve < tamCompleto / 2, `${tamBreve} vs ${tamCompleto} bytes`);

await new Promise((r) => { ws.onclose = r; ws.close(); setTimeout(r, 500); });

console.log(fails === 0 ? '\nTUDO OK\n' : `\n${fails} FALHA(S)\n`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
