// Adversário de IA embutido no servidor + nomes de partida únicos.
// Precisa do servidor no ar.

const BASE = process.env.BASE || 'http://localhost:3000';
let fails = 0;
const ok = (n, c, i = '') => { console.log((c ? '  PASS ' : '  FAIL ') + n + (i ? '  -> ' + i : '')); if (!c) fails++; };
const secao = (t) => console.log('\n== ' + t + ' ==');
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Ponto seguro para o botão da cobrança: sempre para dentro do campo. */
function pertoDaBola(bola, dist = 4.5) {
  const ang = Math.atan2(60 - bola.y, 100 - bola.x);
  return {
    x: Math.max(3, Math.min(197, bola.x + Math.cos(ang) * dist)),
    y: Math.max(3, Math.min(117, bola.y + Math.sin(ang) * dist)),
  };
}
const sfx = Math.random().toString(36).slice(2, 8);
const eu = (await api('POST', '/api/auth/register', { body: { name: `humano-${sfx}`, password: 'ialocal1234' } })).json;

/* -------------------------------------------------- */
secao('Nome de partida é único');
{
  const base = `Pelada ${sfx}`;
  const a = await api('POST', '/api/games', { token: eu.token, body: { name: base, slotsA: 1, slotsB: 1 } });
  const b = await api('POST', '/api/games', { token: eu.token, body: { name: base, slotsA: 1, slotsB: 1 } });
  const c = await api('POST', '/api/games', { token: eu.token, body: { name: base, slotsA: 1, slotsB: 1 } });

  ok('a primeira fica com o nome pedido', a.json.name === base, a.json.name);
  ok('a segunda vira "01"', b.json.name === `${base} 01`, b.json.name);
  ok('a terceira vira "02"', c.json.name === `${base} 02`, c.json.name);
  ok('não há dois nomes iguais', new Set([a.json.name, b.json.name, c.json.name]).size === 3);

  const vazio = await api('POST', '/api/games', { token: eu.token, body: { slotsA: 1, slotsB: 1 } });
  ok('sem nome, ganha um padrão', typeof vazio.json.name === 'string' && vazio.json.name.length > 0, vazio.json.name);
}

/* -------------------------------------------------- */
secao('Chamar a IA preenche a vaga e começa');

const cria = await api('POST', '/api/games', {
  token: eu.token,
  body: {
    name: `Contra a IA ${sfx}`, slotsA: 1, slotsB: 1,
    config: { buttonsPerTeam: 5, maxTurns: 30, turnTimeoutMs: 0, touchesPerPossession: 0, maxPossessions: 0 },
  },
});
const GID = cria.json.gameId;
await api('POST', `/api/games/${GID}/join`, { token: eu.token, body: { team: 'A' } });

{
  const antes = (await api('GET', `/api/games/${GID}/state`, { token: eu.token })).json;
  ok('partida em lobby com uma vaga', antes.status === 'lobby' && antes.teams.B.players.length === 0);

  const r = await api('POST', `/api/games/${GID}/bot`, { token: eu.token, body: { team: 'B' } });
  ok('a IA entra', r.status === 200 && r.json.bot?.team === 'B', r.json.error || r.json.bot?.name);
  ok('a IA é marcada como bot', r.json.bot?.kind === 'ai', r.json.bot?.kind);
  ok('e traz o modelo dela', !!r.json.bot?.model, r.json.bot?.model);
  ok('com a mesa cheia, a partida começa sozinha', r.json.status === 'running', r.json.status);

  const st = (await api('GET', `/api/games/${GID}/state`, { token: eu.token })).json;
  ok('o time B tem um jogador agora', st.teams.B.players.length === 1);
  ok('o jogador do B aparece com nome', !st.teams.B.players[0].name.startsWith('plr_'), st.teams.B.players[0].name);
}

/* -------------------------------------------------- */
secao('A IA joga sozinha quando é a vez dela');
{
  // Eu jogo até a posse virar para a IA.
  let virou = false;
  for (let i = 0; i < 12; i++) {
    const st = (await api('GET', `/api/games/${GID}/state`, { token: eu.token })).json;
    if (st.status !== 'running') break;
    if (st.possession === 'B') { virou = true; break; }
    if (!st.yourTurn) { await dorme(400); continue; }

    if (st.podeCobrar) {
      // Formação da saída de bola: a mesa padrão já serve.
      if (st.cobranca?.area?.campo) {
        await api('POST', `/api/games/${GID}/place`, { token: eu.token, body: { confirmar: true } });
        continue;
      }
      const bola = st.bodies.find((b) => b.id === 'ball');
      await api('POST', `/api/games/${GID}/place`, { token: eu.token, body: { buttonId: st.posicionaveis[0], ...pertoDaBola(bola) } });
      await api('POST', `/api/games/${GID}/place`, { token: eu.token, body: { confirmar: true } });
      continue;
    }
    if (st.podePosicionarGoleiro) {
      await api('POST', `/api/games/${GID}/keeper`, { token: eu.token, body: { confirmar: true } });
      continue;
    }
    if (!st.controllable.length) break;
    // Toque qualquer: mais cedo ou mais tarde a posse vira.
    const bola = st.bodies.find((b) => b.id === 'ball');
    const bot = st.bodies.find((b) => b.id === st.controllable[0]);
    const dir = (Math.atan2(bola.y - bot.y, bola.x - bot.x) * 180) / Math.PI;
    await api('POST', `/api/games/${GID}/move`, {
      token: eu.token,
      body: { buttonId: st.controllable[0], palheta: { anguloAro: dir + 180, inclinacao: 45, avanco: 0.35, forca: 0.55 }, turnToken: st.turnToken },
    });
  }
  ok('a posse chegou na IA', virou, 'se falhou, a partida acabou antes');

  if (virou) {
    // A IA age sozinha: nenhum cliente externo está jogando por ela.
    const antes = (await api('GET', `/api/games/${GID}/state?brief=1`)).json;
    let agiu = false;
    for (let i = 0; i < 20; i++) {
      await dorme(500);
      const agora = (await api('GET', `/api/games/${GID}/state?brief=1`)).json;
      if (agora.turnNo > antes.turnNo || agora.status !== 'running') { agiu = true; break; }
    }
    ok('a IA jogou sem ninguém empurrar', agiu, `turno ${antes.turnNo} -> ?`);

    const log = (await api('GET', `/api/games/${GID}/log?since=0`)).json;
    const lancesDoB = log.eventos.filter((e) => e.team === 'B').length;
    ok('há lances registrados do time da IA', lancesDoB > 0, lancesDoB + ' eventos');
  }
}

/* -------------------------------------------------- */
secao('A lista do lobby sabe que há bot');
{
  const l = (await api('GET', '/api/games', { token: eu.token })).json.games.find((g) => g.gameId === GID);
  ok('partida marcada com temBot', l?.temBot === true, String(l?.temBot));
  ok('e sem vaga nos dois times', l.teams.A.vagas === 0 && l.teams.B.vagas === 0);
}

/* -------------------------------------------------- */
secao('Criar sem entrar e assistir IA contra IA');
{
  // Ninguém é obrigado a jogar a partida que cria: dá para montar a mesa,
  // encher os dois lados de IA e ficar só olhando.
  const c = await api('POST', '/api/games', {
    token: eu.token,
    body: {
      name: `Arquibancada ${sfx}`, slotsA: 1, slotsB: 1,
      config: { buttonsPerTeam: 5, maxTurns: 40, turnTimeoutMs: 0, touchesPerPossession: 0, maxPossessions: 0 },
    },
  });
  const VID = c.json.gameId;

  const antes = (await api('GET', `/api/games/${VID}/state`, { token: eu.token })).json;
  ok('quem criou não entrou em time nenhum', antes.yourTeam === null, String(antes.yourTeam));
  ok('e não tem vez nenhuma', antes.yourTurn === false && antes.podeJogar === false);
  ok('a partida fica no lobby', antes.status === 'lobby', antes.status);

  const a1 = await api('POST', `/api/games/${VID}/bot`, { token: eu.token, body: { team: 'A' } });
  ok('a IA entra no A', a1.status === 200 && a1.json.bot?.team === 'A', a1.json.error || '');
  ok('com meia mesa, ainda não começou', a1.json.status === 'lobby', a1.json.status);

  const b1 = await api('POST', `/api/games/${VID}/bot`, { token: eu.token, body: { team: 'B' } });
  ok('a IA entra no B', b1.status === 200 && b1.json.bot?.team === 'B', b1.json.error || '');
  ok('mesa cheia, a partida começa sozinha', b1.json.status === 'running', b1.json.status);

  // E anda sem ninguém empurrar: quem criou só assiste.
  const t0 = (await api('GET', `/api/games/${VID}/state?brief=1`)).json.turnNo;
  let andou = false;
  for (let i = 0; i < 20; i++) {
    await dorme(500);
    const agora = (await api('GET', `/api/games/${VID}/state?brief=1`)).json;
    if (agora.turnNo > t0 || agora.status !== 'running') { andou = true; break; }
  }
  ok('as duas IAs jogam sozinhas', andou, `turno ${t0} -> ?`);

  const meu = (await api('GET', `/api/games/${VID}/state`, { token: eu.token })).json;
  ok('e quem assiste continua sem time', meu.yourTeam === null && meu.controllable.length === 0);
}

/* -------------------------------------------------- */
secao('Recusas');
{
  const cheio = await api('POST', `/api/games/${GID}/bot`, { token: eu.token, body: { team: 'B' } });
  ok('não dá para pôr IA em time cheio', cheio.status === 409 && cheio.json.code === 'TEAM_FULL', cheio.json.error);

  const semToken = await api('POST', `/api/games/${GID}/bot`, { body: { team: 'A' } });
  ok('exige autenticação', semToken.status === 401);

  const semPartida = await api('POST', '/api/games/gm_naoexiste/bot', { token: eu.token, body: {} });
  ok('partida inexistente devolve GAME_NOT_FOUND', semPartida.status === 404 && semPartida.json.code === 'GAME_NOT_FOUND',
    semPartida.json.code);
}

console.log(fails === 0 ? '\nTUDO OK\n' : `\n${fails} FALHA(S)\n`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
