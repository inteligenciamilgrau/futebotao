// Palheta pela API: jogada por coordenadas, mira ao vivo e replay.
// Precisa do servidor no ar.

const BASE = process.env.BASE || 'http://localhost:3000';
const WSURL = BASE.replace(/^http/, 'ws') + '/ws';

let fails = 0;
const ok = (n, c, i = '') => { console.log((c ? '  PASS ' : '  FAIL ') + n + (i ? '  -> ' + i : '')); if (!c) fails++; };
const secao = (t) => console.log('\n== ' + t + ' ==');

async function api(method, p, { token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let json; try { json = JSON.parse(t); } catch { json = { raw: t }; }
  return { status: res.status, json };
}

const sufixo = Math.random().toString(36).slice(2, 8);
const reg = async (nome) => (await api('POST', '/api/auth/register', { body: { name: `${nome}-${sufixo}`, password: 'palheta1234' } })).json;

const pA = await reg('pal-a');
const pB = await reg('pal-b');

const cria = await api('POST', '/api/games', {
  token: pA.token,
  body: { name: 'Teste palheta', slotsA: 1, slotsB: 1, config: { buttonsPerTeam: 5, maxPossessions: 30, turnTimeoutMs: 600000 } },
});
const GID = cria.json.gameId;
await api('POST', `/api/games/${GID}/join`, { token: pA.token, body: { team: 'A' } });
await api('POST', `/api/games/${GID}/join`, { token: pB.token, body: { team: 'B' } });
await api('POST', `/api/games/${GID}/start`, { token: pA.token });

/* -------------------------------------------------- */
secao('Mira ao vivo (quem segura a palheta)');

const ws = new WebSocket(WSURL);
const recebidas = [];
const ouvintes = new Set();
const espere = (pred, ms = 5000) => new Promise((res, rej) => {
  const achou = recebidas.find(pred);
  if (achou) return res(achou);
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  const h = (m) => { if (pred(m)) { clearTimeout(t); ouvintes.delete(h); res(m); } };
  ouvintes.add(h);
});
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); recebidas.push(m); for (const h of [...ouvintes]) h(m); };

ws.send(JSON.stringify({ op: 'connect', token: pB.token }));
await espere((m) => m.op === 'connack');
ws.send(JSON.stringify({ op: 'subscribe', topics: [`game/${GID}/aim`] }));
await espere((m) => m.op === 'suback');

const st = (await api('GET', `/api/games/${GID}/state`, { token: pA.token })).json;
const botao = st.controllable[0];

const mira1 = await api('POST', `/api/games/${GID}/aim`, {
  token: pA.token,
  body: { buttonId: botao, palheta: { anguloAro: 180, inclinacao: 45, avanco: 0.35, forca: 0.6 } },
});
ok('aim aceito de quem tem a vez', mira1.status === 200, mira1.json.error || '');
ok('aim diz quem está segurando a palheta', mira1.json.playerName === pA.name, mira1.json.playerName);
ok('apoio a 180° lança o botão para 0°', Math.abs(mira1.json.direcao - 0) < 0.01, mira1.json.direcao + '°');
ok('aim traz o ponto de apoio no aro', typeof mira1.json.apoio?.x === 'number');
ok('aim traz previsão do lance', typeof mira1.json.previsao?.corridaDisco === 'number', mira1.json.previsao?.corridaDisco + ' cm');
ok('aim traz rendimento e aviso', mira1.json.rendimento === 1 && !!mira1.json.aviso, mira1.json.aviso);

const difundida = await espere((m) => m.topic === `game/${GID}/aim` && m.payload.palheta && !m.payload.limpar);
ok('mira é difundida no broker para os espectadores', !!difundida, `${difundida.payload.playerName} segurando`);

// Ajuste seguinte: o observador vê mudar.
recebidas.length = 0;
await api('POST', `/api/games/${GID}/aim`, {
  token: pA.token,
  body: { buttonId: botao, palheta: { anguloAro: 180, inclinacao: 70, avanco: 0.35, forca: 0.8 } },
});
const ajuste = await espere((m) => m.topic === `game/${GID}/aim` && m.payload.palheta);
ok('ajuste da palheta chega ao vivo', ajuste.payload.palheta.inclinacao === 70, 'inclinacao ' + ajuste.payload.palheta.inclinacao);
ok('detecta cavadinha na hora do ajuste', ajuste.payload.cavada === true, ajuste.payload.aviso);

const alheio = await api('POST', `/api/games/${GID}/aim`, {
  token: pB.token,
  body: { buttonId: 'B1', palheta: { anguloAro: 0, inclinacao: 45, avanco: 0.35, forca: 0.5 } },
});
ok('quem não tem a vez não segura a palheta', alheio.status === 403 && alheio.json.code === 'NOT_YOUR_TURN');

/* -------------------------------------------------- */
secao('Jogada por palheta');

const bola = st.bodies.find((b) => b.id === 'ball');
const b0 = st.bodies.find((b) => b.id === botao);
// Aponta o apoio no lado oposto à bola: o botão sai na direção dela.
const dirBola = (Math.atan2(bola.y - b0.y, bola.x - b0.x) * 180) / Math.PI;
const mv = await api('POST', `/api/games/${GID}/move`, {
  token: pA.token,
  body: {
    buttonId: botao,
    palheta: { anguloAro: dirBola + 180, inclinacao: 45, avanco: 0.35, forca: 0.55 },
    turnToken: st.turnToken,
  },
});
ok('jogada por palheta aceita', mv.status === 200, mv.json.error || mv.json.result?.outcome);
ok('resultado registra o modo palheta', mv.json.result?.modo === 'palheta', mv.json.result?.modo);
ok('resultado devolve os dados da palheta', typeof mv.json.result?.palheta?.rendimento === 'number');
ok('o botão realmente alcançou a bola', mv.json.result?.touchedBall === true, mv.json.result?.outcome);

// Quem tem a vez agora pode ter mudado: as regras novas passam a posse por
// vários motivos. Pegamos o dono da vez antes de testar a validação.
async function daVez() {
  const p = (await api('GET', `/api/games/${GID}/state?brief=1`)).json;
  const token = p.currentPlayerId === pA.playerId ? pA.token : pB.token;
  const st = (await api('GET', `/api/games/${GID}/state`, { token })).json;
  return { token, st };
}

{
  const { token, st } = await daVez();
  const semAngulo = await api('POST', `/api/games/${GID}/move`, {
    token, body: { buttonId: st.controllable[0], palheta: { inclinacao: 45, forca: 0.5 } },
  });
  ok('palheta sem anguloAro é recusada', semAngulo.status === 400 && semAngulo.json.code === 'NO_DIRECTION',
     `${semAngulo.status} ${semAngulo.json.code}`);
}

/* -------------------------------------------------- */
secao('Palheta mal posicionada escorrega');

{
  const { token, st: st2 } = await daVez();
  const escorrega = await api('POST', `/api/games/${GID}/move`, {
    token,
    body: { buttonId: st2.controllable[0], palheta: { anguloAro: 0, inclinacao: 12, avanco: 0.35, forca: 1 }, turnToken: st2.turnToken },
  });
  ok('jogada com palheta deitada é aceita mas escorrega', escorrega.status === 200 && escorrega.json.result.palheta.escorregou === true,
     escorrega.json.result?.palheta?.aviso || escorrega.json.error);
  ok('escorregar mata a velocidade', escorrega.json.result.shot.velocidade < 40, escorrega.json.result.shot.velocidade + ' cm/s');
}

/* -------------------------------------------------- */
secao('Replay');

// Joga mais alguns lances para ter o que rever.
for (let i = 0; i < 8; i++) {
  const publico = (await api('GET', `/api/games/${GID}/state?brief=1`)).json;
  if (publico.status !== 'running') break;
  const tok = publico.currentPlayerId === pA.playerId ? pA.token : pB.token;
  const sv = (await api('GET', `/api/games/${GID}/state`, { token: tok })).json;
  if (!sv.yourTurn || !sv.controllable.length) break;
  const bl = sv.bodies.find((b) => b.id === 'ball');
  const bt = sv.bodies.find((b) => b.id === sv.controllable[0]);
  const d = (Math.atan2(bl.y - bt.y, bl.x - bt.x) * 180) / Math.PI;
  await api('POST', `/api/games/${GID}/move`, {
    token: tok,
    body: { buttonId: sv.controllable[0], palheta: { anguloAro: d + 180, inclinacao: 45, avanco: 0.35, forca: 0.6 }, turnToken: sv.turnToken },
  });
}

const idx = await api('GET', `/api/games/${GID}/replay`);
ok('índice do replay responde', idx.status === 200 && idx.json.total > 3, idx.json.total + ' lances');
ok('índice é leve (sem trajetórias)', JSON.stringify(idx.json).length < 6000, JSON.stringify(idx.json).length + ' bytes');
const l0 = idx.json.lances[0];
ok('cada lance traz turno, time, botão e desfecho', !!l0.turnNo && !!l0.team && !!l0.buttonId && !!l0.outcome,
   `t${l0.turnNo} ${l0.team} ${l0.buttonId}`);
ok('índice acompanha o placar lance a lance', typeof l0.scoreA === 'number' && typeof l0.scoreB === 'number');

const lance = await api('GET', `/api/games/${GID}/replay/0`);
ok('lance individual traz os quadros', lance.status === 200 && lance.json.frames.length > 1, lance.json.frames.length + ' quadros');
ok('quadros do replay batem com os ids', lance.json.frames[0].p.length === lance.json.ids.length * 2);
ok('lance guarda a palheta usada', typeof lance.json.palheta?.anguloAro === 'number');

const inexistente = await api('GET', `/api/games/${GID}/replay/9999`);
ok('lance inexistente devolve 404', inexistente.status === 404 && inexistente.json.code === 'NO_SUCH_LANCE');

const cheio = await api('GET', `/api/games/${GID}/replay?full=1`);
ok('full=1 traz todas as trajetórias de uma vez', cheio.json.trajetorias?.length === idx.json.total,
   `${cheio.json.trajetorias?.length} trajetórias, ${(JSON.stringify(cheio.json).length / 1024).toFixed(0)} KB`);

await new Promise((r) => { ws.onclose = r; ws.close(); setTimeout(r, 400); });

console.log(fails === 0 ? '\nTUDO OK\n' : `\n${fails} FALHA(S)\n`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
