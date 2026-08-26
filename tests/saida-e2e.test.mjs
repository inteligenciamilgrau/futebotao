// Formação da saída de bola pela API: os dois times montam a mesa ao mesmo
// tempo, cada um no seu campo, e só quem bate entra no círculo central.
// Precisa do servidor no ar.

const BASE = process.env.BASE || 'http://localhost:3000';
const WSURL = BASE.replace(/^http/, 'ws') + '/ws';
let fails = 0;
const ok = (n, c, i = '') => { console.log((c ? '  PASS ' : '  FAIL ') + n + (i ? '  -> ' + i : '')); if (!c) fails++; };
const secao = (t) => console.log('\n== ' + t + ' ==');

async function api(m, p, { token, body } = {}) {
  const r = await fetch(BASE + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  return { status: r.status, json: j };
}
const sfx = Math.random().toString(36).slice(2, 8);
const reg = async (nome) => (await api('POST', '/api/auth/register', { body: { name: `${nome}-${sfx}`, password: 'saida12345' } })).json;

const bate = await reg('saida-bate');       // time A: bate a saída
const espera = await reg('saida-espera');   // time B: só monta o campo dele

const cria = await api('POST', '/api/games', {
  token: bate.token,
  body: {
    name: `Saída ${sfx}`, slotsA: 1, slotsB: 1,
    config: { buttonsPerTeam: 5, maxTurns: 200, turnTimeoutMs: 600000, touchesPerPossession: 0, maxPossessions: 0 },
  },
});
const GID = cria.json.gameId;
await api('POST', `/api/games/${GID}/join`, { token: bate.token, body: { team: 'A' } });
await api('POST', `/api/games/${GID}/join`, { token: espera.token, body: { team: 'B' } });
await api('POST', `/api/games/${GID}/start`, { token: bate.token });

const estado = (t) => api('GET', `/api/games/${GID}/state`, { token: t }).then((r) => r.json);
const por = (t, body) => api('POST', `/api/games/${GID}/place`, { token: t, body });

/* -------------------------------------------------- */
secao('Os dois times montam ao mesmo tempo');
{
  const a = await estado(bate.token);
  const b = await estado(espera.token);

  ok('quem bate pode arrumar', a.podeCobrar === true && a.yourTurn === true);
  ok('quem espera também', b.podeCobrar === true && b.yourTurn === false, `yourTurn=${b.yourTurn}`);
  ok('a área é a de formação', a.cobranca?.area?.tipo === 'formação', a.cobranca?.area?.tipo);
  ok('o A monta na metade dele', a.cobranca.area.campo.xMax === 100, JSON.stringify(a.cobranca.area.campo));
  ok('o B monta na metade dele', b.cobranca.area.campo.xMin === 100, JSON.stringify(b.cobranca.area.campo));
  ok('só quem bate entra no círculo',
    a.cobranca.area.podeNoCirculo === true && b.cobranca.area.podeNoCirculo === false);
  ok('o limite do círculo é dois', a.cobranca.area.maxNoCirculo === 2, String(a.cobranca.area.maxNoCirculo));
  ok('cada um vê só os botões do seu time',
    a.posicionaveis.every((id) => id[0] === 'A') && b.posicionaveis.every((id) => id[0] === 'B'),
    a.posicionaveis.join(',') + ' | ' + b.posicionaveis.join(','));
  ok('e dá para bater sem arrumar nada', a.podeJogar === true && a.controllable.length > 0);
}

/* -------------------------------------------------- */
secao('Regras da região');
const ws = new WebSocket(WSURL);
const recebidas = [];
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (ev) => recebidas.push(JSON.parse(ev.data));
ws.send(JSON.stringify({ op: 'connect', token: espera.token }));
await new Promise((r) => setTimeout(r, 150));
ws.send(JSON.stringify({ op: 'subscribe', topics: [`game/${GID}/place`] }));
await new Promise((r) => setTimeout(r, 200));

{
  const a = await estado(bate.token);
  const meus = a.posicionaveis;

  // Tira todos os meus do círculo, para contar do zero.
  for (let i = 0; i < meus.length; i++) {
    await por(bate.token, { buttonId: meus[i], x: 30, y: 15 + i * 20 });
  }

  const c1 = await por(bate.token, { buttonId: meus[0], x: 94, y: 56 });
  ok('quem bate entra no círculo', c1.status === 200, c1.json.error || '');
  const c2 = await por(bate.token, { buttonId: meus[1], x: 96, y: 66 });
  ok('e um segundo também', c2.status === 200, c2.json.error || '');
  const c3 = await por(bate.token, { buttonId: meus[2], x: 92, y: 60 });
  ok('o terceiro no círculo é recusado', c3.status === 409 && c3.json.code === 'CIRCLE_LIMIT', c3.json.code);

  const fora = await por(bate.token, { buttonId: meus[2], x: 45, y: 30 });
  ok('fora do círculo, no próprio campo, vale', fora.status === 200, fora.json.error || '');

  const invade = await por(bate.token, { buttonId: meus[2], x: 160, y: 60 });
  ok('passar para o outro campo é recusado', invade.status === 400 && invade.json.code === 'OUT_OF_HALF', invade.json.code);

  const seus = (await estado(espera.token)).posicionaveis;
  const bOk = await por(espera.token, { buttonId: seus[0], x: 150, y: 40 });
  ok('quem espera arruma sem ter a vez', bOk.status === 200, bOk.json.error || '');
  ok('e o servidor diz de que time é', bOk.json.team === 'B' && bOk.json.formacao === true, bOk.json.team);

  const bCirculo = await por(espera.token, { buttonId: seus[1], x: 106, y: 60 });
  ok('quem espera não entra no círculo', bCirculo.status === 409 && bCirculo.json.code === 'CIRCLE_IS_THEIRS', bCirculo.json.code);

  const bInvade = await por(espera.token, { buttonId: seus[1], x: 40, y: 60 });
  ok('nem passa para o outro campo', bInvade.status === 400 && bInvade.json.code === 'OUT_OF_HALF', bInvade.json.code);

  const alheio = await por(espera.token, { buttonId: meus[0], x: 150, y: 60 });
  ok('nem mexe em botão do adversário', alheio.status === 403 && alheio.json.code === 'NOT_YOUR_BUTTON', alheio.json.code);

  await new Promise((r) => setTimeout(r, 250));
  const msg = recebidas.filter((m) => m.topic === `game/${GID}/place`).pop();
  ok('quem assiste acompanha a arrumação', !!msg?.payload?.botao, JSON.stringify(msg?.payload?.botao || null));
}

/* -------------------------------------------------- */
secao('Pronto do adversário não tira a vez');
{
  const r = await por(espera.token, { confirmar: true });
  ok('o B diz que está pronto', r.status === 200 && r.json.confirmado === true, r.json.error || '');
  ok('a fase continua de formação', r.json.fase === 'cobranca', r.json.fase);

  const a = await estado(bate.token);
  ok('a vez segue com quem bate', a.yourTurn === true && a.podeCobrar === true);
  const b = await estado(espera.token);
  ok('o B não arruma mais', b.podeCobrar === false && b.posicionaveis.length === 0);

  const denovo = await por(espera.token, { buttonId: 'B2', x: 150, y: 60 });
  ok('depois de pronto, é recusado', denovo.status === 409 && denovo.json.code === 'ALREADY_READY', denovo.json.code);
}

/* -------------------------------------------------- */
secao('Bater fecha a formação');
{
  const st = await estado(bate.token);
  const bola = st.bodies.find((b) => b.id === 'ball');
  const bt = st.bodies
    .filter((b) => st.controllable.includes(b.id))
    .sort((x, y) => Math.hypot(x.x - bola.x, x.y - bola.y) - Math.hypot(y.x - bola.x, y.y - bola.y))[0];
  const dir = (Math.atan2(bola.y - bt.y, bola.x - bt.x) * 180) / Math.PI;

  const r = await api('POST', `/api/games/${GID}/move`, {
    token: bate.token,
    body: { buttonId: bt.id, palheta: { anguloAro: dir + 180, inclinacao: 45, avanco: 0.35, forca: 0.5 }, turnToken: st.turnToken },
  });
  ok('a jogada é aceita sem confirmar a formação', r.status === 200, r.json.error || '');

  const depois = await estado(bate.token);
  ok('a fase virou jogada', depois.fase === 'jogada', depois.fase);
  ok('e a bola parada acabou', depois.reinicio === null, String(depois.reinicio));
}

ws.close();
console.log(fails === 0 ? '\nTUDO OK\n' : `\n${fails} FALHA(S)\n`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
