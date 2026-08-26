// Declaração de chute e posicionamento do goleiro pela API + broker.
// Precisa do servidor no ar.

const BASE = process.env.BASE || 'http://localhost:3000';
const WSURL = BASE.replace(/^http/, 'ws') + '/ws';

let fails = 0;
const ok = (n, c, i = '') => { console.log((c ? '  PASS ' : '  FAIL ') + n + (i ? '  -> ' + i : '')); if (!c) fails++; };
const secao = (t) => console.log('\n== ' + t + ' ==');

async function api(method, p, { token, body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  return { status: r.status, json: j };
}

const sfx = Math.random().toString(36).slice(2, 8);
const reg = async (n) => (await api('POST', '/api/auth/register', { body: { name: `${n}-${sfx}`, password: 'goleiro1234' } })).json;

const atac = await reg('gk-atacante');
const def = await reg('gk-defensor');

const cria = await api('POST', '/api/games', {
  token: atac.token,
  body: { name: 'Teste goleiro', slotsA: 1, slotsB: 1, config: { buttonsPerTeam: 5, maxTurns: 200, turnTimeoutMs: 600000 } },
});
const GID = cria.json.gameId;
await api('POST', `/api/games/${GID}/join`, { token: atac.token, body: { team: 'A' } });
await api('POST', `/api/games/${GID}/join`, { token: def.token, body: { team: 'B' } });
await api('POST', `/api/games/${GID}/start`, { token: atac.token });

/**
 * Dá o primeiro toque da partida. Em bola parada (saída de bola, lateral) não
 * se declara chute a gol — então o teste precisa pôr a bola para rolar antes.
 * Repete enquanto a posse não estiver com o atacante e livre para declarar.
 */
async function porABolaParaRolar() {
  for (let i = 0; i < 24; i++) {
    const meu = (await api('GET', `/api/games/${GID}/state`, { token: atac.token })).json;
    if (meu.podeDeclarar) return true;
    const dono = meu.currentPlayerId === atac.playerId ? atac : def;
    const st = (await api('GET', `/api/games/${GID}/state`, { token: dono.token })).json;
    if (st.status !== 'running') return false;

    // A bola pode ter saído no caminho: cobra e segue.
    if (st.podeCobrar) {
      // Formação da saída de bola: a mesa padrão já serve.
      if (st.cobranca?.area?.campo) {
        await api('POST', `/api/games/${GID}/place`, { token: dono.token, body: { confirmar: true } });
        continue;
      }
      const bl = st.bodies.find((b) => b.id === 'ball');
      const ang = Math.atan2(60 - bl.y, 100 - bl.x);
      await api('POST', `/api/games/${GID}/place`, {
        token: dono.token,
        body: {
          buttonId: st.posicionaveis[0],
          x: Math.max(3, Math.min(197, bl.x + Math.cos(ang) * 4.5)),
          y: Math.max(3, Math.min(117, bl.y + Math.sin(ang) * 4.5)),
        },
      });
      await api('POST', `/api/games/${GID}/place`, { token: dono.token, body: { confirmar: true } });
      continue;
    }
    if (!st.podeJogar || !st.controllable?.length) return false;

    const bola = st.bodies.find((b) => b.id === 'ball');
    const perto = st.controllable
      .map((id) => st.bodies.find((b) => b.id === id))
      .sort((a, b) => Math.hypot(a.x - bola.x, a.y - bola.y) - Math.hypot(b.x - bola.x, b.y - bola.y))[0];
    const dir = (Math.atan2(bola.y - perto.y, bola.x - perto.x) * 180) / Math.PI;
    await api('POST', `/api/games/${GID}/move`, {
      token: dono.token,
      body: { buttonId: perto.id, palheta: { anguloAro: dir + 180, inclinacao: 45, avanco: 0.35, forca: 0.45 }, turnToken: st.turnToken },
    });
  }
  return false;
}

/* -------------------------------------------------- */
secao('Estado expõe as caixas e as áreas');
{
  const st = (await api('GET', `/api/games/${GID}/state`, { token: atac.token })).json;
  ok('fase começa arrumando a saída de bola', st.fase === 'cobranca' && st.cobrancaOpcional === true, st.fase);
  ok('estado traz os dois goleiros', !!st.goleiros?.A && !!st.goleiros?.B);
  ok('goleiro é retangular', st.goleiros.B.w > st.goleiros.B.h, `${st.goleiros.B.w} x ${st.goleiros.B.h}`);
  ok('estado traz a área de cada goleiro', !!st.areaGoleiro?.A && !!st.areaGoleiro?.B);
  ok('na saída de bola NÃO dá para declarar', st.podeDeclarar === false, String(st.podeDeclarar));
  ok('e o estado diz por quê', st.reinicio === 'saída de bola', String(st.reinicio));
  ok('atacante não posiciona goleiro', st.podePosicionarGoleiro === false);
  ok('o goleiro não está entre os botões controláveis', !st.controllable.includes('AG'), st.controllable.join(','));
  const caixa = st.bodies.find((b) => b.id === 'BG');
  ok('bodies marca a forma da caixa', caixa?.forma === 'caixa' && typeof caixa.anguloDeg === 'number',
    JSON.stringify(caixa));
}

/* -------------------------------------------------- */
secao('Broker acompanha o posicionamento');

// Palheta característica do atacante, para reconhecê-la de volta.
const MIRA = { buttonId: null, palheta: { anguloAro: 143, inclinacao: 58, avanco: 0.73, forca: 0.81 } };

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
ws.send(JSON.stringify({ op: 'connect', token: atac.token }));
await espere((m) => m.op === 'connack');
ws.send(JSON.stringify({ op: 'subscribe', topics: [`game/${GID}/keeper`, `game/${GID}/event`, `game/${GID}/turn`, `game/${GID}/aim`] }));
await espere((m) => m.op === 'suback');

/* -------------------------------------------------- */
secao('Declarar chute');
{
  const naParada = await api('POST', `/api/games/${GID}/declare`, { token: atac.token });
  ok('em bola parada a API recusa', naParada.status === 409 && naParada.json.code === 'CANNOT_DECLARE_ON_RESTART',
    naParada.json.code + ' ' + naParada.status);

  ok('a bola rolou e a posse ficou com o atacante', await porABolaParaRolar());

  // Monta uma palheta bem característica ANTES de declarar: é ela que tem de
  // voltar quando o defensor terminar de pôr o goleiro.
  const st = (await api('GET', `/api/games/${GID}/state`, { token: atac.token })).json;
  MIRA.buttonId = st.controllable[0];
  const a = await api('POST', `/api/games/${GID}/aim`, {
    token: atac.token, body: { buttonId: MIRA.buttonId, palheta: MIRA.palheta },
  });
  ok('a mira foi aceita antes de declarar', a.status === 200, a.json.error || '');

  const semVez = await api('POST', `/api/games/${GID}/declare`, { token: def.token });
  ok('quem não tem a vez não declara', semVez.status === 403 && semVez.json.code === 'NOT_YOUR_TURN');

  recebidas.length = 0;
  const d = await api('POST', `/api/games/${GID}/declare`, { token: atac.token });
  ok('declarar é aceito', d.status === 200, d.json.error || '');
  ok('a fase vira goleiro', d.json.fase === 'goleiro', d.json.fase);
  ok('a vez passa para o defensor', d.json.defensor === def.playerId);

  const ev = await espere((m) => m.topic === `game/${GID}/event` && m.payload.type === 'declara');
  ok('broker anuncia a declaração', !!ev, ev.payload.texto);

  const kmsg = await espere((m) => m.topic === `game/${GID}/keeper`);
  ok('broker abre o canal do goleiro', kmsg.payload.fase === 'goleiro' && !!kmsg.payload.area,
    JSON.stringify(kmsg.payload.area));

  const dupla = await api('POST', `/api/games/${GID}/declare`, { token: atac.token });
  ok('não dá para declarar duas vezes', dupla.status === 403 || dupla.status === 409, dupla.json.code);
}

/* -------------------------------------------------- */
secao('Posicionar a caixa');
{
  const stDef = (await api('GET', `/api/games/${GID}/state?describe=1`, { token: def.token })).json;
  ok('defensor vê que é com ele', stDef.podePosicionarGoleiro === true);
  ok('defensor não pode jogar agora', stDef.podeJogar === false);
  ok('defensor não tem botões controláveis', stDef.controllable.length === 0);
  ok('descrição avisa da fase', /POSICIONAR O GOLEIRO/.test(stDef.description || ''), '');

  const area = stDef.areaGoleiro.B;

  const forA = await api('POST', `/api/games/${GID}/keeper`, {
    token: def.token, body: { x: 100, y: 60 },
  });
  ok('fora da área é recusado', forA.status === 400 && forA.json.code === 'KEEPER_OUT_OF_AREA', forA.json.error);

  const alheio = await api('POST', `/api/games/${GID}/keeper`, {
    token: atac.token, body: { x: area.xMin + 5, y: 60 },
  });
  ok('atacante não posiciona o goleiro', alheio.status === 403 && alheio.json.code === 'NOT_YOUR_TURN');

  recebidas.length = 0;
  const mover = await api('POST', `/api/games/${GID}/keeper`, {
    token: def.token, body: { x: area.xMax - 5, y: 52, anguloDeg: 70 },
  });
  ok('mover é aceito', mover.status === 200 && mover.json.confirmado === false, mover.json.error || '');
  ok('devolve onde a caixa ficou', Math.abs(mover.json.goleiro.y - 52) < 0.01 && Math.abs(mover.json.goleiro.anguloDeg - 70) < 0.01,
    JSON.stringify(mover.json.goleiro));

  const aoVivo = await espere((m) => m.topic === `game/${GID}/keeper` && m.payload.goleiro?.anguloDeg === 70);
  ok('o ajuste é difundido ao vivo', !!aoVivo, `${aoVivo.payload.playerName} posicionando`);

  // Segundo ajuste: quem assiste vê mudar de novo.
  recebidas.length = 0;
  await api('POST', `/api/games/${GID}/keeper`, { token: def.token, body: { y: 66, anguloDeg: 95 } });
  const seg = await espere((m) => m.topic === `game/${GID}/keeper` && m.payload.goleiro?.anguloDeg === 95);
  ok('segundo ajuste também chega', Math.abs(seg.payload.goleiro.y - 66) < 0.01, JSON.stringify(seg.payload.goleiro));

  const conf = await api('POST', `/api/games/${GID}/keeper`, { token: def.token, body: { confirmar: true } });
  ok('confirmar devolve a vez', conf.status === 200 && conf.json.confirmado === true && conf.json.fase === 'jogada');
  ok('a vez volta para o atacante', conf.json.currentPlayerId === atac.playerId);
}

/* -------------------------------------------------- */
secao('A palheta volta como estava antes de declarar');
{
  const volta = recebidas.filter((m) => m.topic === `game/${GID}/aim` && m.payload?.restaurada).pop();
  ok('o servidor republica a mira guardada', !!volta, 'nenhuma mensagem de mira restaurada');
  if (volta) {
    ok('com a palheta idêntica',
      JSON.stringify(volta.payload.palheta) === JSON.stringify(MIRA.palheta),
      JSON.stringify(volta.payload.palheta));
    ok('e com o mesmo botão', volta.payload.buttonId === MIRA.buttonId,
      `${volta.payload.buttonId} != ${MIRA.buttonId}`);
    ok('endereçada a quem declarou', volta.payload.playerId === atac.playerId);
  }
}

secao('Depois de confirmar');
{
  const st = (await api('GET', `/api/games/${GID}/state`, { token: atac.token })).json;
  ok('atacante volta a poder jogar', st.podeJogar === true && st.fase === 'jogada');
  ok('a declaração continua de pé', st.declarado === true);
  ok('não dá para declarar de novo', st.podeDeclarar === false);
  ok('a caixa ficou onde o defensor pôs', Math.abs(st.goleiros.B.y - 66) < 0.01, JSON.stringify(st.goleiros.B));

  const fora = await api('POST', `/api/games/${GID}/keeper`, { token: def.token, body: { x: 190, y: 60 } });
  ok('fora da fase, posicionar é recusado', fora.status === 403 || fora.status === 409, fora.json.code);
}

/* -------------------------------------------------- */
secao('Resumo da partida conta os lances');
{
  const lista = (await api('GET', '/api/games')).json;
  const g = lista.games.find((x) => x.gameId === GID);
  ok('a lista traz o número de lances', typeof g?.lances === 'number', String(g?.lances));
  ok('a lista traz o relógio em turnos', typeof g?.config?.maxTurns === 'number', String(g?.config?.maxTurns));
  const st = (await api('GET', `/api/games/${GID}/state?brief=1`)).json;
  ok('o estado breve também traz os lances', typeof st.lances === 'number', String(st.lances));
}

await new Promise((r) => { ws.onclose = r; ws.close(); setTimeout(r, 400); });

console.log(fails === 0 ? '\nTUDO OK\n' : `\n${fails} FALHA(S)\n`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
