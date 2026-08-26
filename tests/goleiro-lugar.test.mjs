// O goleiro não entra em cima de ninguém.
//
// A regra é do servidor (`obstaculoDoGoleiro`), e o motivo dela é histórico:
// antes daqui a caixa era posta em qualquer lugar e um `settle()` EMPURRAVA
// quem estivesse embaixo. Quem defendia ganhava um jeito de reposicionar as
// peças do atacante — e a bola encostada na trave saía do lugar junto.
//
// Testa direto no motor, sem servidor: `posicionarGoleiro` é pura o bastante.

import { createGame, startGame, posicionarGoleiro, declararChute, applyMove, goleiroDe, areaDoGoleiro, obstaculoDoGoleiro } from '../server/game.js';
import { PITCH } from '../server/config.js';

let fails = 0;
const ok = (n, c, i = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (i ? '  -> ' + i : '')); if (!c) fails++; };
const secao = (t) => console.log('\n== ' + t + ' ==');

/** Uma partida em andamento, com A na posse e a fase de goleiro aberta. */
function mesa() {
  const g = createGame({
    slotsA: 1, slotsB: 1,
    config: { buttonsPerTeam: 5, maxTurns: 0, turnTimeoutMs: 0 },
  });
  g.teams.A.players.push('a1');
  g.teams.B.players.push('b1');
  startGame(g);
  // Sai da cobrança de saída de bola: com `reinicio` posto, o jogo recusa
  // declarar chute, e é a declaração que abre a fase de goleiro.
  g.fase = 'jogada';
  g.reinicio = null;
  return g;
}

/** Abre a fase de goleiro com A atacando, e devolve quem defende. */
function faseDeGoleiro(g) {
  g.possession = 'A';
  g.currentPlayerId = 'a1';
  declararChute(g, 'a1');
  return { defensor: g.currentPlayerId, time: 'B' };
}

secao('A caixa não entra em cima da bola');
{
  const g = mesa();
  const bola = g.bodies.find((b) => b.id === 'ball');
  const area = areaDoGoleiro('B');
  // Põe a bola bem no meio da área do goleiro B.
  bola.x = area.xMax - 6;
  bola.y = PITCH.width / 2;
  const { defensor } = faseDeGoleiro(g);

  let erro = null;
  try {
    posicionarGoleiro(g, defensor, { x: bola.x, y: bola.y, anguloDeg: 90 });
  } catch (e) { erro = e; }

  ok('recusa', !!erro, erro ? '' : 'aceitou pôr a caixa em cima da bola');
  ok('com código próprio', erro?.code === 'KEEPER_BLOCKED', String(erro?.code));
  ok('e diz que foi a bola', /bola/.test(erro?.message || ''), erro?.message);
  ok('a bola NÃO foi empurrada',
     bola.x === area.xMax - 6 && bola.y === PITCH.width / 2,
     `bola em (${bola.x}, ${bola.y})`);
}

secao('A caixa não entra em cima de um botão');
{
  const g = mesa();
  const area = areaDoGoleiro('B');
  const atacante = g.bodies.find((b) => b.kind === 'button' && b.team === 'A');
  atacante.x = area.xMax - 8;
  atacante.y = PITCH.width / 2 + 5;
  const antes = { x: atacante.x, y: atacante.y };
  const { defensor } = faseDeGoleiro(g);

  let erro = null;
  try {
    posicionarGoleiro(g, defensor, { x: atacante.x, y: atacante.y, anguloDeg: 90 });
  } catch (e) { erro = e; }

  ok('recusa', erro?.code === 'KEEPER_BLOCKED', String(erro?.code));
  ok('e nomeia o botão', (erro?.message || '').includes(atacante.id), erro?.message);
  ok('o botão NÃO foi empurrado',
     atacante.x === antes.x && atacante.y === antes.y,
     `botão em (${atacante.x}, ${atacante.y})`);
}

secao('A caixa não encosta na trave');
{
  const g = mesa();
  const area = areaDoGoleiro('B');
  const { defensor } = faseDeGoleiro(g);

  // Deitada no eixo do gol, colada na linha e centrada na trave de baixo: a
  // meia-espessura passa por cima do poste, que fica em (200, 45).
  let erro = null;
  try {
    posicionarGoleiro(g, defensor, { x: area.xMax, y: PITCH.goalMin, anguloDeg: 0 });
  } catch (e) { erro = e; }

  ok('recusa', erro?.code === 'KEEPER_BLOCKED', String(erro?.code));
  ok('e diz que foi a trave', /trave/.test(erro?.message || ''), erro?.message);
}

secao('Lugar livre continua valendo');
{
  const g = mesa();
  const area = areaDoGoleiro('B');
  // Tira todo mundo da área do goleiro B, inclusive a bola.
  for (const b of g.bodies) {
    if (b.kind === 'keeper') continue;
    b.x = 60; b.y = 20;
  }
  const { defensor } = faseDeGoleiro(g);

  const alvo = { x: area.xMax - 5, y: PITCH.width / 2, anguloDeg: 90 };
  let erro = null;
  try { posicionarGoleiro(g, defensor, alvo); } catch (e) { erro = e; }

  const k = goleiroDe(g, 'B');
  ok('aceita', !erro, erro?.message);
  ok('e a caixa foi mesmo para lá',
     Math.abs(k.x - alvo.x) < 0.2 && Math.abs(k.y - alvo.y) < 0.2,
     `caixa em (${k.x}, ${k.y})`);
}

secao('A checagem crua concorda com a regra');
{
  const g = mesa();
  const k = goleiroDe(g, 'B');
  const bola = g.bodies.find((b) => b.id === 'ball');
  bola.x = 190; bola.y = 60;

  const emCima = obstaculoDoGoleiro({ x: 190, y: 60, w: k.w, h: k.h, ang: 0 }, g, k.id);
  ok('acha a bola embaixo da caixa', emCima?.kind === 'ball', JSON.stringify(emCima));

  // Longe de tudo: 30 cm ao lado da bola, com todo o resto no outro campo.
  for (const b of g.bodies) { if (b.kind === 'button') { b.x = 40; b.y = 20; } }
  const longe = obstaculoDoGoleiro({ x: 190, y: 30, w: k.w, h: k.h, ang: 0 }, g, k.id);
  ok('e não inventa obstáculo onde não tem', longe === null, JSON.stringify(longe));
}

console.log(fails === 0 ? '\nTUDO OK' : `\n${fails} FALHA(S)`);
process.exitCode = fails ? 1 : 0;
