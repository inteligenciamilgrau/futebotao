// Esperar uma IA de fora: a vaga fica guardada e só quem tem o convite entra.
// Precisa do servidor no ar.

const BASE = process.env.BASE || 'http://localhost:3000';
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
const sfx = Math.random().toString(36).slice(2, 7);
const reg = async (nome) => (await api('POST', '/api/auth/register', { body: { name: `${nome}-${sfx}`, password: 'convite123' } })).json;

const dono = await reg('cv-dono');
const intruso = await reg('cv-intruso');
const ia = await reg('cv-ia');

const cria = await api('POST', '/api/games', {
  token: dono.token,
  body: { name: `Convite ${sfx}`, slotsA: 1, slotsB: 1 },
});
const GID = cria.json.gameId;
await api('POST', `/api/games/${GID}/join`, { token: dono.token, body: { team: 'A' } });

/* -------------------------------------------------- */
secao('Guardar a vaga');
let convite = null;
{
  const r = await api('POST', `/api/games/${GID}/aguardar`, { token: dono.token, body: { team: 'B' } });
  ok('a espera é aceita', r.status === 200, r.json.error || '');
  convite = r.json.convite;
  ok('vem um convite', typeof convite === 'string' && convite.startsWith('cvt_'), convite);
  ok('vem o comando pronto', /ai-bot\.js .*--convite=/.test(r.json.comando || ''), r.json.comando);
  ok('e o texto para colar num agente',
    (r.json.prompt || '').includes(GID) && r.json.prompt.includes(convite),
    (r.json.prompt || '').slice(0, 60));

  const st = (await api('GET', `/api/games/${GID}/state`, { token: dono.token })).json;
  ok('o estado mostra a espera', st.reservas?.B?.esperando === true, JSON.stringify(st.reservas));
  ok('mas não vaza o convite', !JSON.stringify(st.reservas).includes(convite));

  const lista = (await api('GET', '/api/games', { token: dono.token })).json.games.find((x) => x.gameId === GID);
  ok('o lobby não mostra a vaga como livre', lista.teams.B.vagas === 0, String(lista.teams.B.vagas));
  ok('e diz que está esperando uma IA', lista.teams.B.esperandoIA === true);
}

/* -------------------------------------------------- */
secao('A vaga fica guardada mesmo');
{
  const r = await api('POST', `/api/games/${GID}/join`, { token: intruso.token, body: { team: 'B' } });
  ok('quem não tem convite é recusado', r.status === 409 && r.json.code === 'SLOT_RESERVED', r.json.code);

  const auto = await api('POST', `/api/games/${GID}/join`, { token: intruso.token, body: {} });
  ok('nem entrando no automático', auto.status === 409, `${auto.status} ${auto.json.code || ''}`);

  const dobrada = await api('POST', `/api/games/${GID}/aguardar`, { token: dono.token, body: { team: 'B' } });
  ok('não dá para esperar duas vezes', dobrada.status === 409 && dobrada.json.code === 'ALREADY_RESERVED', dobrada.json.code);
}

/* -------------------------------------------------- */
secao('A IA entra com o convite');
{
  const r = await api('POST', `/api/games/${GID}/join`, {
    token: ia.token, body: { team: 'B', convite, autoStart: true },
  });
  ok('entrou', r.status === 200 && r.json.team === 'B', r.json.error || '');
  ok('o servidor sabe que foi pelo convite', r.json.convidado === true);
  ok('com a mesa cheia, a partida começa', r.json.status === 'running', r.json.status);

  const st = (await api('GET', `/api/games/${GID}/state`, { token: dono.token })).json;
  ok('a espera acabou', !st.reservas?.B, JSON.stringify(st.reservas));

  const denovo = await api('POST', `/api/games/${GID}/join`, { token: intruso.token, body: { team: 'B', convite } });
  ok('o convite não serve duas vezes', denovo.status === 409, `${denovo.status} ${denovo.json.code || ''}`);
}

/* -------------------------------------------------- */
secao('Cancelar a espera devolve a vaga');
{
  const g2 = (await api('POST', '/api/games', { token: dono.token, body: { name: `Cancela ${sfx}`, slotsA: 1, slotsB: 1 } })).json;
  await api('POST', `/api/games/${g2.gameId}/join`, { token: dono.token, body: { team: 'A' } });
  await api('POST', `/api/games/${g2.gameId}/aguardar`, { token: dono.token, body: { team: 'B' } });

  const alheio = await api('DELETE', `/api/games/${g2.gameId}/aguardar?team=B`, { token: intruso.token });
  ok('quem não pediu não cancela', alheio.status === 403 && alheio.json.code === 'NOT_YOURS', alheio.json.code);

  const c = await api('DELETE', `/api/games/${g2.gameId}/aguardar?team=B`, { token: dono.token });
  ok('quem pediu cancela', c.status === 200 && c.json.liberada === true, c.json.error || '');

  const entrou = await api('POST', `/api/games/${g2.gameId}/join`, { token: intruso.token, body: { team: 'B' } });
  ok('e aí qualquer um entra', entrou.status === 200 && entrou.json.team === 'B', entrou.json.error || '');

  const vazio = await api('DELETE', `/api/games/${g2.gameId}/aguardar?team=B`, { token: dono.token });
  ok('cancelar o que não existe devolve 404', vazio.status === 404 && vazio.json.code === 'NO_RESERVATION', vazio.json.code);
}

/* -------------------------------------------------- */
secao('Uma LLM em cada time');
{
  const g3 = (await api('POST', '/api/games', { token: dono.token, body: { name: `Duelo ${sfx}`, slotsA: 1, slotsB: 1 } })).json;

  const rA = await api('POST', `/api/games/${g3.gameId}/aguardar`, { token: dono.token, body: { team: 'A' } });
  ok('guarda a vaga do azul', rA.status === 200 && rA.json.team === 'A', rA.json.error || '');

  const rB = await api('POST', `/api/games/${g3.gameId}/aguardar`, { token: dono.token, body: { team: 'B' } });
  ok('e a do vermelho também', rB.status === 200 && rB.json.team === 'B', rB.json.error || '');
  ok('cada uma com o seu convite', rA.json.convite !== rB.json.convite);

  const st = (await api('GET', `/api/games/${g3.gameId}/state`, { token: dono.token })).json;
  ok('o estado mostra as duas esperas',
    st.reservas?.A?.esperando === true && st.reservas?.B?.esperando === true,
    JSON.stringify(st.reservas));

  const lista = (await api('GET', '/api/games', { token: dono.token })).json.games.find((x) => x.gameId === g3.gameId);
  ok('a mesa aparece sem vaga nenhuma', lista.teams.A.vagas === 0 && lista.teams.B.vagas === 0);

  // Cada IA entra com o convite do SEU time.
  const ia2 = await reg('cv-ia2');
  const eA = await api('POST', `/api/games/${g3.gameId}/join`, { token: ia.token, body: { team: 'A', convite: rA.json.convite } });
  ok('a primeira IA entra no azul', eA.status === 200 && eA.json.team === 'A', eA.json.error || '');

  const trocado = await api('POST', `/api/games/${g3.gameId}/join`, { token: ia2.token, body: { team: 'B', convite: rA.json.convite } });
  ok('o convite de um time não serve no outro', trocado.status === 409 && trocado.json.code === 'SLOT_RESERVED', trocado.json.code);

  const eB = await api('POST', `/api/games/${g3.gameId}/join`, { token: ia2.token, body: { team: 'B', convite: rB.json.convite, autoStart: true } });
  ok('a segunda IA entra no vermelho', eB.status === 200 && eB.json.team === 'B', eB.json.error || '');
  ok('e a partida começa', eB.json.status === 'running', eB.json.status);
}

/* -------------------------------------------------- */
secao('Encerrar a partida');
{
  const g4 = (await api('POST', '/api/games', { token: dono.token, body: { name: `Encerra ${sfx}`, slotsA: 1, slotsB: 1 } })).json;
  const G4 = g4.gameId;
  await api('POST', `/api/games/${G4}/join`, { token: dono.token, body: { team: 'A' } });
  await api('POST', `/api/games/${G4}/join`, { token: intruso.token, body: { team: 'B' } });
  await api('POST', `/api/games/${G4}/start`, { token: dono.token });

  const st = (await api('GET', `/api/games/${G4}/state`, { token: dono.token })).json;
  ok('a partida está rolando', st.status === 'running', st.status);
  ok('quem criou sabe que é o dono', st.souDono === true);

  const deFora = await reg('cv-fora');
  const alheio = await api('POST', `/api/games/${G4}/encerrar`, { token: deFora.token });
  ok('quem não joga nem criou não encerra', alheio.status === 403 && alheio.json.code === 'NOT_IN_GAME', alheio.json.code);

  const r = await api('POST', `/api/games/${G4}/encerrar`, { token: intruso.token });
  ok('um jogador da mesa encerra', r.status === 200 && r.json.status === 'finished', r.json.error || '');
  ok('e o motivo diz quem foi', /encerrada por /.test(r.json.result?.reason || ''), r.json.result?.reason);

  // Qualquer comando depois disso tem que EXPLICAR que a partida acabou.
  const jogada = await api('POST', `/api/games/${G4}/move`, {
    token: dono.token,
    body: { buttonId: 'A1', palheta: { anguloAro: 0, inclinacao: 45, avanco: 0.35, forca: 0.5 } },
  });
  ok('jogar depois do fim é recusado', jogada.status === 409 && jogada.json.code === 'GAME_FINISHED', jogada.json.code);
  ok('e o erro diz que a partida acabou', /acabou/.test(jogada.json.error || ''), jogada.json.error);
  ok('com o placar final junto', !!jogada.json.result, JSON.stringify(jogada.json.result || null));

  const declara = await api('POST', `/api/games/${G4}/declare`, { token: dono.token });
  ok('declarar também', declara.status === 409 && declara.json.code === 'GAME_FINISHED', declara.json.code);

  const denovo = await api('POST', `/api/games/${G4}/encerrar`, { token: dono.token });
  ok('encerrar duas vezes é recusado', denovo.status === 409 && denovo.json.code === 'GAME_FINISHED', denovo.json.code);
}

console.log(fails === 0 ? '\nTUDO OK\n' : `\n${fails} FALHA(S)\n`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
