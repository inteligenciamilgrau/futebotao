// A bola sobe: palheta em pé levanta e dá para fazer gol por cima da caixa.
import { makeBody, simulate, goalPosts } from '../server/physics.js';
import { resolverPalheta } from '../server/palheta.js';
import { PITCH, PHYS, KEEPER } from '../server/config.js';

let fails = 0;
const ok = (n, c, i = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (i ? '  -> ' + i : '')); if (!c) fails++; };
const secao = (t) => console.log('\n== ' + t + ' ==');

const bola = (x, y) => makeBody({ id: 'ball', kind: 'ball', x, y, r: PHYS.ballRadius, m: PHYS.ballMass });
const caixa = (x, y, ang = Math.PI / 2) => makeBody({
  id: 'BG', kind: 'keeper', team: 'B', forma: 'caixa', x, y,
  w: KEEPER.comprimento, h: KEEPER.espessura, ang, m: 0, fixed: true,
});

/** Lança um botão contra a bola com uma palheta dada. */
function bater(bx, by, alvoX, alvoY, palheta, estaticos = goalPosts()) {
  const b = makeBody({ id: 'A1', kind: 'button', team: 'A', x: bx, y: by, r: PHYS.buttonRadius, m: PHYS.buttonMass });
  const dir = (Math.atan2(alvoY - by, alvoX - bx) * 180) / Math.PI;
  const res = resolverPalheta({ ...palheta, anguloAro: dir + 180 });
  b.vx = res.vx; b.vy = res.vy;
  b.hopUntil = res.duracaoVoo;
  b.liftBias = res.elevacao;
  return { b, res };
}

secao('Palheta deitada mantém a bola no chão');
{
  const bl = bola(100, 60);
  const { b } = bater(93, 60, 200, 60, { inclinacao: 45, avanco: 0.35, forca: 0.9 });
  const r = simulate([b, bl], goalPosts());
  const alturaMax = Math.max(...r.frames.map((f) => f.z));
  ok('bola praticamente não sobe', alturaMax < 0.5, 'máx ' + alturaMax.toFixed(2) + ' cm');
  ok('quadros carregam a altura', r.frames.every((f) => typeof f.z === 'number'));
}

secao('Palheta em pé levanta a bola');
{
  const bl = bola(100, 60);
  const { b } = bater(93, 60, 200, 60, { inclinacao: 66, avanco: 0.35, forca: 1.0 });
  const r = simulate([b, bl], goalPosts());
  const alturaMax = Math.max(...r.frames.map((f) => f.z));
  ok('bola sobe de verdade', alturaMax > 3, 'máx ' + alturaMax.toFixed(1) + ' cm');
  ok('bola passa por cima de uma caixa de ' + KEEPER.altura + ' cm', alturaMax > KEEPER.altura,
    alturaMax.toFixed(1) + ' cm');
  ok('a bola volta ao chão no fim', r.frames[r.frames.length - 1].z < 1.5,
    r.frames[r.frames.length - 1].z + ' cm');
  ok('registrou o quique', r.events.some((e) => e.type === 'quique'));
}

secao('Gol por cima da caixa do goleiro');
{
  // Caixa atravessada bem no meio da boca: por baixo é impossível.
  // O voo da bola dura ~30 cm, então a chapelada tem que sair de PERTO —
  // de longe ela já desceu antes de chegar na caixa. Isso é a regra do jogo,
  // não um detalhe do teste: chapelar exige a distância certa.
  const bl = bola(PITCH.length - 22, 60);

  const rasteiro = bater(PITCH.length - 29, 60, PITCH.length + 40, 60, { inclinacao: 45, avanco: 0.35, forca: 1.0 });
  const r1 = simulate([rasteiro.b, bl], [...goalPosts(), caixa(PITCH.length - 6, 60)]);
  ok('rasteiro no meio bate na caixa', !r1.goal, JSON.stringify(r1.goal));

  const bl2 = bola(PITCH.length - 22, 60);
  const alto = bater(PITCH.length - 29, 60, PITCH.length + 40, 60, { inclinacao: 66, avanco: 0.35, forca: 1.0 });
  const r2 = simulate([alto.b, bl2], [...goalPosts(), caixa(PITCH.length - 6, 60)]);
  ok('por cima da caixa é GOL', !!r2.goal, JSON.stringify(r2.goal));
  ok('o gol foi com a bola no alto', (r2.goal?.z ?? 0) > KEEPER.altura, (r2.goal?.z ?? 0) + ' cm');
}

secao('Travessão: alto demais não vale');
{
  const bl = bola(PITCH.length - 18, 60);
  // Bem perto do gol e com elevação máxima: sai por cima do travessão.
  const { b, res } = bater(PITCH.length - 25, 60, PITCH.length + 40, 60, { inclinacao: 72, avanco: 0.35, forca: 1.0 });
  const r = simulate([b, bl], goalPosts());
  const alturaNaLinha = r.frames.find((f) => f.p[2] >= PITCH.length - 1)?.z ?? 0;
  if (alturaNaLinha >= PITCH.alturaTravessao) {
    ok('acima do travessão não é gol', !r.goal, JSON.stringify(r.goal));
    ok('vira linha de fundo', r.fora?.linha === 'fundo' && r.fora?.porCima === true, JSON.stringify(r.fora));
  } else {
    ok('cenário produziu bola abaixo do travessão (gol vale)', !!r.goal,
      `altura na linha ${alturaNaLinha} cm, elevacao ${res.elevacao}`);
  }
}

secao('Bola alta passa por cima dos botões');
{
  const barreira = makeBody({ id: 'B1', kind: 'button', team: 'B', x: 120, y: 60, r: PHYS.buttonRadius, m: PHYS.buttonMass });
  const bl = bola(100, 60);
  const { b } = bater(93, 60, 200, 60, { inclinacao: 66, avanco: 0.35, forca: 1.0 });
  const r = simulate([b, bl, barreira], goalPosts());
  const tocouBarreira = r.contacts.some((c) =>
    (c.a === 'ball' && c.b === 'B1') || (c.b === 'ball' && c.a === 'B1'));
  ok('bola alta não esbarra no botão baixo', !tocouBarreira, 'contatos: ' + r.contacts.length);
  ok('e passou do ponto dele', bl.x > 125, 'x=' + bl.x.toFixed(1));
}

secao('Determinismo com a bola no ar');
{
  const roda = () => {
    const bl = bola(100, 58);
    const { b } = bater(92, 57, 190, 64, { inclinacao: 63, avanco: 0.35, forca: 0.85 });
    simulate([b, bl], goalPosts());
    return `${bl.x.toFixed(4)},${bl.y.toFixed(4)},${bl.z.toFixed(4)}`;
  };
  ok('mesma entrada, mesma saída', roda() === roda());
}

console.log(fails === 0 ? '\nTUDO OK' : `\n${fails} FALHA(S)`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
