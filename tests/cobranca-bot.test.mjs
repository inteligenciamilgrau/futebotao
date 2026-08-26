// A cobrança de lateral não pode virar um laço.
//
// A bola descansa EM CIMA da risca. O botão sai na reta botão -> bola, então um
// botão do lado de dentro empurra a bola para fora e a lateral se repete — para
// sempre, entre duas IAs. Foi o que aconteceu: o código prendia o botão dentro
// do campo, sobra da época em que botão não podia sair.
//
// Este teste joga a lateral de verdade, com a heurística decidindo, e confere
// que a bola volta para dentro.

import { jogadaDeCobranca, configurarFisica } from '../bot/heuristic-bot.js';
import { createGame, startGame, applyMove, fullState, posicionarBotao } from '../server/game.js';
import { PITCH, PHYS } from '../server/config.js';

let fails = 0;
const ok = (n, c, i = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (i ? '  -> ' + i : '')); if (!c) fails++; };
const secao = (t) => console.log('\n== ' + t + ' ==');

configurarFisica({ pitch: PITCH, physics: PHYS });

const bola = (g) => g.bodies.find((b) => b.kind === 'ball');
const pega = (g, id) => g.bodies.find((b) => b.id === id);

function novaPartida() {
  const g = createGame({ slotsA: 1, slotsB: 1, config: { buttonsPerTeam: 5, turnTimeoutMs: 0, maxTurns: 0 } });
  g.teams.A.players.push('a1');
  g.teams.B.players.push('b1');
  startGame(g);
  g.fase = 'jogada';                 // pula a formação da saída
  g.cobranca = null;
  g.reinicio = null;
  return g;
}

/* -------------------------------------------------- */
secao('O botão da cobrança fica FORA do campo');
{
  for (const [nome, bx, by] of [
    ['lateral de baixo', 100, 0],
    ['lateral de cima', 100, PITCH.width],
    ['escanteio', PITCH.length, 0],
  ]) {
    const g = novaPartida();
    const bl = bola(g);
    bl.x = bx; bl.y = by;
    g.fase = 'cobranca';
    g.cobranca = { tipo: 'lateral', botao: null, botoes: [], maxBotoes: 1, opcional: false };

    const st = fullState(g, g.currentPlayerId);
    const escolha = jogadaDeCobranca({ ...st, pitch: { margemFora: PITCH.margemFora } });
    ok(`${nome}: a heurística escolhe um botão`, !!escolha, JSON.stringify(escolha));
    if (!escolha) continue;

    const foraDoCampo = escolha.x < 0 || escolha.x > PITCH.length
                     || escolha.y < 0 || escolha.y > PITCH.width;
    ok(`${nome}: e o põe fora das linhas`, foraDoCampo, `(${escolha.x}, ${escolha.y})`);

    // A bola sai na reta botão -> bola. Ela tem que apontar para DENTRO.
    const dx = bx - escolha.x, dy = by - escolha.y;
    const n = Math.hypot(dx, dy) || 1;
    const destino = { x: bx + (dx / n) * 30, y: by + (dy / n) * 30 };
    const paraDentro = destino.x > 0 && destino.x < PITCH.length
                    && destino.y > 0 && destino.y < PITCH.width;
    ok(`${nome}: e a bola vai para dentro`, paraDentro, `(${destino.x.toFixed(0)}, ${destino.y.toFixed(0)})`);
  }
}

/* -------------------------------------------------- */
secao('E a cobrança de verdade tira a bola da linha');
{
  const g = novaPartida();
  const bl = bola(g);
  bl.x = 100; bl.y = 0;
  g.fase = 'cobranca';
  g.cobranca = { tipo: 'lateral', botao: null, botoes: [], maxBotoes: 1, opcional: false };
  g.possession = 'A';
  g.currentPlayerId = 'a1';

  const st = fullState(g, 'a1');
  const escolha = jogadaDeCobranca({ ...st, pitch: { margemFora: PITCH.margemFora } });
  posicionarBotao(g, 'a1', escolha);
  posicionarBotao(g, 'a1', { confirmar: true });

  const b = pega(g, escolha.buttonId);
  const dir = (Math.atan2(bl.y - b.y, bl.x - b.x) * 180) / Math.PI;
  const r = applyMove(g, 'a1', {
    buttonId: escolha.buttonId,
    palheta: { anguloAro: dir + 180, inclinacao: 45, avanco: 0.35, forca: 0.5 },
  });

  ok('o lance foi aceito', !!r.result, r.result?.outcome);
  ok('a bola NÃO saiu de novo', !r.result.reposicao,
    r.result.reposicao ? `saiu: ${r.result.reposicao.tipo}` : 'ficou em jogo');

  const depois = bola(g);
  ok('e ela está dentro do campo', depois.y > 0 && depois.y < PITCH.width && depois.x > 0 && depois.x < PITCH.length,
    `(${depois.x.toFixed(1)}, ${depois.y.toFixed(1)})`);
}

console.log(fails === 0 ? '\nTUDO OK' : `\n${fails} FALHA(S)`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
