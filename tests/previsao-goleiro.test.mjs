// A previsão do /aim tem que enxergar a MESMA coisa que a física.
//
// Dois erros moravam aqui, e os dois faziam a previsão condenar chutes que o
// motor deixava passar:
//   1. o goleiro era testado pelo raio ENVOLVENTE (8.31 para uma caixa de
//      16 x 4.5), o que o alargava ~6 cm de cada lado;
//   2. a altura da bola era ignorada, então a cavadinha por cima da caixa
//      (5 cm) nunca era aprovada — e quem joga pela API não tinha como
//      descobrir que ela funcionava.
//
// O teste compara previsão e simulação nos dois casos.

import { makeBody, simulate, goalPosts } from '../server/physics.js';
import { resolverPalheta, preverLance } from '../server/palheta.js';
import { PHYS, KEEPER, PITCH } from '../server/config.js';

let fails = 0;
const ok = (n, c, i = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (i ? '  -> ' + i : '')); if (!c) fails++; };
const secao = (t) => console.log('\n== ' + t + ' ==');

/** Goleiro do time B, na frente do gol em x=200. */
function goleiro({ x = PITCH.length - 8, y = PITCH.width / 2, anguloDeg = 90 } = {}) {
  return makeBody({
    id: 'BG', kind: 'keeper', team: 'B', forma: 'caixa',
    x, y, w: KEEPER.comprimento, h: KEEPER.espessura,
    ang: (anguloDeg * Math.PI) / 180, m: 0, fixed: true,
  });
}

/**
 * Monta o lance, prevê e simula. O botão fica atrás da bola, na direção do
 * chute, para o toque ser cheio.
 */
function lance({ bola, palheta, corpos = [], distancia = 6 }) {
  const res = resolverPalheta(palheta);
  const rad = (res.direcao * Math.PI) / 180;
  const b = makeBody({
    id: 'A1', kind: 'button', team: 'A',
    x: bola.x - Math.cos(rad) * distancia,
    y: bola.y - Math.sin(rad) * distancia,
    r: PHYS.buttonRadius, m: PHYS.buttonMass,
  });
  const bl = makeBody({ id: 'ball', kind: 'ball', x: bola.x, y: bola.y, r: PHYS.ballRadius, m: PHYS.ballMass });

  const todos = [b, bl, ...corpos];
  const previsao = preverLance(b, res, todos);

  b.vx = Math.cos(rad) * res.velocidade;
  b.vy = Math.sin(rad) * res.velocidade;
  b.liftBias = res.elevacao;
  b.hopUntil = res.duracaoVoo;
  const sim = simulate(todos, goalPosts());

  const bateuNoGoleiro = sim.events.some((e) =>
    e.type === 'contact' && ((e.a === 'BG' && e.b === 'ball') || (e.b === 'BG' && e.a === 'ball')));
  return { res, previsao, sim, bateuNoGoleiro };
}

/* -------------------------------------------------- */
secao('O goleiro é testado como CAIXA, não como círculo');
{
  const gk = goleiro({ x: 192, y: 60, anguloDeg: 90 });
  // De pé, a caixa ocupa y de 52 a 68 e x de 189.75 a 194.25.
  // Um rasteiro passando em y=48 passa LONGE dela.
  const r = lance({
    bola: { x: 150, y: 48 },
    palheta: { anguloAro: 180, inclinacao: 45, avanco: 0.35, forca: 0.85 },
    corpos: [gk],
  });
  ok('a simulação deixa passar', r.bateuNoGoleiro === false, r.sim.events.filter((e) => e.type === 'contact').map((e) => e.a + '/' + e.b).join(','));
  ok('e a previsão concorda', r.previsao.bola?.bateEm !== 'BG', String(r.previsao.bola?.bateEm));

  // Agora um rasteiro em cheio na caixa: os dois têm que ver o bloqueio.
  const r2 = lance({
    bola: { x: 150, y: 60 },
    palheta: { anguloAro: 180, inclinacao: 45, avanco: 0.35, forca: 0.85 },
    corpos: [goleiro({ x: 192, y: 60, anguloDeg: 90 })],
  });
  ok('rasteiro no meio bate mesmo', r2.bateuNoGoleiro === true);
  ok('e a previsão avisa', r2.previsao.bola?.bateEm === 'BG', String(r2.previsao.bola?.bateEm));
}

/* -------------------------------------------------- */
secao('A largura prevista é a da caixa, não a do raio envolvente');
{
  // A caixa de pé tem meia-espessura 2.25 em x; o raio envolvente é 8.31.
  // Uma bola passando a 5 cm do centro da caixa, no eixo curto, passa limpo —
  // mas seria condenada por um teste de círculo.
  const gk = goleiro({ x: 192, y: 60, anguloDeg: 0 });   // deitada: 16 cm em x, 4.5 em y
  const r = lance({
    bola: { x: 150, y: 65 },                              // 5 cm acima do centro
    palheta: { anguloAro: 180, inclinacao: 45, avanco: 0.35, forca: 0.85 },
    corpos: [gk],
  });
  ok('a simulação deixa passar (fora da faixa de 4.5 cm)', r.bateuNoGoleiro === false);
  ok('e a previsão também', r.previsao.bola?.bateEm !== 'BG', String(r.previsao.bola?.bateEm));
}

/* -------------------------------------------------- */
secao('Bola por cima da caixa: previsão e física concordam');
{
  // A bola sobe DURANTE o voo: para um chute de inclinação 65 e força 1 ela
  // fica acima dos 5 cm da caixa entre ~9 e ~22 cm do ponto do toque. O teste
  // fica no meio dessa janela, longe das bordas.
  const alto = { anguloAro: 180, inclinacao: 65, avanco: 0.3, forca: 1 };
  const rasteiro = { anguloAro: 180, inclinacao: 45, avanco: 0.35, forca: 1 };
  const bola = { x: 177, y: 60 };                     // 15 cm da caixa

  const cR = lance({ bola, palheta: rasteiro, corpos: [goleiro({ x: 192, y: 60, anguloDeg: 90 })] });
  ok('o rasteiro bate no goleiro', cR.bateuNoGoleiro === true);
  ok('a previsão do rasteiro avisa', cR.previsao.bola?.bateEm === 'BG', String(cR.previsao.bola?.bateEm));

  const cA = lance({ bola, palheta: alto, corpos: [goleiro({ x: 192, y: 60, anguloDeg: 90 })] });
  ok('a bola alta passa por cima', cA.bateuNoGoleiro === false,
    'sobe até ' + cA.res.alturaPrevista + ' cm, a caixa tem ' + KEEPER.altura);
  ok('e a previsão NÃO condena o chute', cA.previsao.bola?.bateEm !== 'BG', String(cA.previsao.bola?.bateEm));
}

/* -------------------------------------------------- */
secao('Colado no goleiro a bola ainda não subiu — e a previsão sabe');
{
  // A 3 cm do toque a bola mal saiu do chão: o balão não salva ninguém aqui.
  const r = lance({
    bola: { x: 187, y: 60 },
    palheta: { anguloAro: 180, inclinacao: 65, avanco: 0.3, forca: 1 },
    corpos: [goleiro({ x: 192, y: 60, anguloDeg: 90 })],
  });
  ok('de pertinho a bola bate mesmo assim', r.bateuNoGoleiro === true,
    'contatos: ' + r.sim.events.filter((e) => e.type === 'contact').map((e) => e.a + '/' + e.b).join(','));
  ok('e a previsão avisa', r.previsao.bola?.bateEm === 'BG', String(r.previsao.bola?.bateEm));
}

/* -------------------------------------------------- */
secao('A janela de voo é a mesma nos dois');
{
  // Varre distâncias e confere que previsão e simulação concordam em cada uma.
  const alto = { anguloAro: 180, inclinacao: 65, avanco: 0.3, forca: 1 };
  let divergencias = 0;
  const linhas = [];
  for (let d = 4; d <= 30; d += 2) {
    const r = lance({
      bola: { x: 192 - d, y: 60 },
      palheta: alto,
      corpos: [goleiro({ x: 192, y: 60, anguloDeg: 90 })],
    });
    const preveBloqueio = r.previsao.bola?.bateEm === 'BG';
    if (preveBloqueio !== r.bateuNoGoleiro) {
      divergencias++;
      linhas.push(`${d}cm: previsão=${preveBloqueio} real=${r.bateuNoGoleiro}`);
    }
  }
  // Uma divergência de uma casa nas bordas da janela é o erro do modelo; mais
  // que isso quer dizer que a previsão está enxergando outra física.
  ok('previsão e física concordam em quase toda a varredura', divergencias <= 1,
    divergencias + ' divergências: ' + linhas.join(' | '));
}
/* -------------------------------------------------- */
secao('A previsão descreve o PULO, e ele bate com a física');
{
  const rasteiro = lance({
    bola: { x: 100, y: 60 },
    palheta: { anguloAro: 180, inclinacao: 45, avanco: 0.35, forca: 1 },
  });
  ok('chute rasteiro não tem voo', rasteiro.previsao.bola?.voo === null,
    JSON.stringify(rasteiro.previsao.bola?.voo));

  const alto = lance({
    bola: { x: 100, y: 60 },
    palheta: { anguloAro: 180, inclinacao: 65, avanco: 0.3, forca: 1 },
  });
  const v = alto.previsao.bola?.voo;
  ok('chute alto tem voo', !!v, JSON.stringify(v && { alturaMax: v.alturaMax, ondeMax: v.ondeMax }));

  if (v) {
    ok('o perfil tem pontos para desenhar', v.pontos.length > 8, v.pontos.length + ' pontos');
    ok('começa no chão', v.pontos[0][1] === 0, String(v.pontos[0][1]));
    ok('sobe e desce', v.alturaMax > 0 && v.ondeMax > 0 && v.ondeMax < v.pontos[v.pontos.length - 1][0],
      `pico ${v.alturaMax}cm a ${v.ondeMax}cm`);

    // A prova de verdade: comparar com a altura que a bola realmente atinge.
    const real = Math.max(...alto.sim.frames.map((f) => f.z ?? 0));
    const erro = Math.abs(real - v.alturaMax);
    ok('o pico previsto bate com o simulado (1 cm)', erro < 1,
      `previsto ${v.alturaMax}cm, real ${real.toFixed(1)}cm`);
  }
}

console.log(fails === 0 ? '\nTUDO OK' : `\n${fails} FALHA(S)`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
