// Onde a previsão diz que o DISCO para, contra onde ele para de verdade.
//
// `preverLance` responde `parada` e `primeiroContato`, e é com isso que o
// humano mira e que os bots planejam. A régua aqui é a SIMULAÇÃO, não um
// modelo analítico copiado do motor: um espelho de fórmulas apodrece na
// primeira calibração de config.js, e passaria a medir a si mesmo.
//
// Os cenários ficam SEPARADOS de propósito. Um limiar único sobre a mistura
// engole defeito: com três quartos dos tiros no disco redondo (erro ~0,1 cm)
// a média geral fica pequena mesmo com a quina do goleiro errando 20 cm.
//
//   1) DISCO REDONDO   — o caso fácil, limiar apertado. É o piso do modelo.
//   2) CAIXA DO GOLEIRO — retângulo girado, quina inclusive.
//   3) CAVADINHA EM VOO — o disco acerta a bola ANTES de pousar e segue
//                         voando com `cavadaAtrito`, não com `muButton`.
//   4) HONESTIDADE DO CONTATO — `primeiroContato: null` tem que querer dizer
//                         "caminho livre", inclusive depois da beirada desviar.

import { makeBody, simulate, goalPosts } from '../server/physics.js';
import { resolverPalheta, preverLance, palhetaPara } from '../server/palheta.js';
import { PHYS, PITCH, KEEPER } from '../server/config.js';

let fails = 0;
const ok = (n, c, i = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (i ? '  -> ' + i : '')); if (!c) fails++; };
const secao = (t) => console.log('\n== ' + t + ' ==');

const D = (a) => (a * Math.PI) / 180;
const MEIO = { x: PITCH.length / 2, y: PITCH.width / 2 };

const disco = (id, x, y, team = 'A') =>
  makeBody({ id, kind: 'button', team, x, y, r: PHYS.buttonRadius, m: PHYS.buttonMass });
const bola = (x, y) =>
  makeBody({ id: 'ball', kind: 'ball', x, y, r: PHYS.ballRadius, m: PHYS.ballMass });
const goleiro = (x, y, angDeg) => makeBody({
  id: 'BG', kind: 'keeper', team: 'B', forma: 'caixa', x, y,
  w: KEEPER.comprimento, h: KEEPER.espessura, ang: D(angDeg), m: 0, fixed: true,
});

/**
 * Prevê o lance e depois joga o MESMO lance no motor.
 * Devolve o erro da parada do disco em centímetros.
 */
function conferir(atirador, corpos, palheta) {
  const res = resolverPalheta(palheta);
  const todos = [atirador, ...corpos];
  const prev = preverLance(atirador, res, todos);

  const rad = D(res.direcao);
  atirador.vx = Math.cos(rad) * res.velocidade;
  atirador.vy = Math.sin(rad) * res.velocidade;
  atirador.liftBias = res.elevacao;
  atirador.hopUntil = res.duracaoVoo;
  const sim = simulate(todos, goalPosts());

  const tocou = sim.events.filter((e) =>
    e.type === 'contact' && (e.a === atirador.id || e.b === atirador.id));
  return {
    res, prev, sim, tocou,
    erro: Math.hypot(atirador.x - prev.parada.x, atirador.y - prev.parada.y),
    real: { x: atirador.x, y: atirador.y },
  };
}

/** Média, p90 e máximo de uma amostra, para relatar junto do PASS/FAIL. */
function resumo(v) {
  const s = [...v].sort((a, b) => a - b);
  const media = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return {
    n: s.length,
    media,
    p90: s[Math.floor(0.9 * s.length)] ?? 0,
    max: s[s.length - 1] ?? 0,
    texto: `n=${s.length} media=${media.toFixed(2)} p90=${(s[Math.floor(0.9 * s.length)] ?? 0).toFixed(2)} max=${(s[s.length - 1] ?? 0).toFixed(2)} cm`,
  };
}

/* ================================================================= */
secao('1) Mirando um DISCO REDONDO');
{
  // O caso mais simples que existe: círculo contra círculo, um ricochete só.
  // Se ESTE piso subir, o problema é do modelo de impulso ou da corrida, e
  // não da forma do alvo — é o controle dos outros dois grupos.
  const erros = [];
  for (let tiro = 0; tiro < 360; tiro += 30) {
    for (const dist of [14, 24, 34]) {
      for (const forca of [0.5, 0.85]) {
        for (const lado of [-1.8, 0, 1.8]) {          // cheio, e de raspão dos dois lados
          const ux = Math.cos(D(tiro)), uy = Math.sin(D(tiro));
          const alvo = disco('B1', MEIO.x + ux * dist - uy * lado, MEIO.y + uy * dist + ux * lado, 'B');
          const r = conferir(disco('A1', MEIO.x, MEIO.y), [alvo],
            { anguloAro: tiro + 180, inclinacao: 45, avanco: 0.35, forca });
          if (r.tocou.length) erros.push(r.erro);
        }
      }
    }
  }
  const s = resumo(erros);
  ok('houve toque em amostra suficiente', s.n > 100, s.n + ' lances com contato');
  ok('erro médio abaixo de 0,3 cm', s.media < 0.3, s.texto);
  ok('nenhum caso passa de 1,5 cm', s.max < 1.5, s.texto);
}

/* ================================================================= */
secao('2) Mirando a CAIXA DO GOLEIRO');
{
  // O contorno de "onde o CENTRO do disco encosta na caixa" é um retângulo de
  // cantos ARREDONDADOS pelo raio do disco. Inflar as duas fatias por `raio`
  // soma um QUADRADO: na quina o teste devolve normal de face (até 45° fora)
  // e antecipa o contato em raio·(√2−1). Estes tiros varrem a caixa inteira,
  // faces e quinas, em quatro orientações.
  const erros = [];
  for (let tiro = 0; tiro < 360; tiro += 20) {
    for (const caixaAng of [0, 45, 90, 135]) {
      for (const forca of [0.55, 1]) {
        for (let lado = -9; lado <= 9; lado += 3) {
          const ux = Math.cos(D(tiro)), uy = Math.sin(D(tiro));
          const gx = MEIO.x, gy = MEIO.y, recuo = 26;
          const ax = gx - ux * recuo - uy * lado;
          const ay = gy - uy * recuo + ux * lado;
          const r = conferir(disco('A1', ax, ay), [goleiro(gx, gy, caixaAng)],
            { anguloAro: tiro + 180, inclinacao: 45, avanco: 0.35, forca });
          if (r.tocou.length) erros.push(r.erro);
        }
      }
    }
  }
  const s = resumo(erros);
  ok('houve toque em amostra suficiente', s.n > 200, s.n + ' lances com contato');
  // Com a quina resolvida como quadrado isto media 4,86 de média e 18,1 de p90.
  ok('erro médio abaixo de 0,8 cm', s.media < 0.8, s.texto);
  ok('p90 abaixo de 1,5 cm', s.p90 < 1.5, s.texto);
  // A cauda que sobra é o PASSO FIXO do motor, não a geometria: repetindo os
  // piores casos com dt quatro vezes menor o erro cai de 9,0 cm para 0,17 cm.
  // Enquanto o integrador for de passo fixo, essa cauda não some.
  ok('nenhum caso passa de 12 cm', s.max < 12, s.texto);
}

/* ----------------------------------------------------------------- */
{
  // Um par dirigido, para a falha apontar o dedo: mesma caixa, mesmo disco,
  // um tiro na FACE e um tiro na QUINA. Sem isto a regressão da quina volta
  // diluída na média do grupo acima.
  const gx = MEIO.x, gy = MEIO.y;
  const hh = KEEPER.espessura / 2;

  // Os dois tiros correm no MESMO rumo (+x) contra a MESMA caixa deitada.
  // Só muda a altura da linha de tiro:
  //   folga -h/2 -> passa pelo meio da face comprida: contorno reto, normal +x.
  //   folga  1,0 -> a linha do CENTRO do disco corre acima da face, mas ainda
  //                 dentro do raio: quem encosta é a ponta, e o contorno ali
  //                 é o ARCO da quina. O quadrado inflado põe o contato 1,1 cm
  //                 cedo demais e devolve a normal da face, dezenas de graus
  //                 fora — medido, 17 cm de erro na parada só nesta linha.
  //
  // Não adianta raspar mais fino que isto: com 2,0 cm de folga o toque fica
  // tão de raspão que o PASSO do motor (dt = 1/600, 0,28 cm por passo a 170
  // cm/s) responde por 2,3 cm sozinho — o mesmo tiro com dt/4 dá 0,03 cm. É
  // limite do integrador, não da geometria da previsão.
  const tiro = (folga) => conferir(disco('A1', gx - 30, gy + hh + folga),
    [goleiro(gx, gy, 0)], { anguloAro: 180, inclinacao: 45, avanco: 0.35, forca: 0.8 });

  const naFace = tiro(-hh);
  const naQuina = tiro(1.0);

  ok('os dois tiros batem mesmo na caixa', naFace.tocou.length > 0 && naQuina.tocou.length > 0,
    `face ${naFace.tocou.length}, quina ${naQuina.tocou.length}`);
  ok('tiro na FACE: erro abaixo de 0,5 cm', naFace.erro < 0.5,
    `${naFace.erro.toFixed(2)} cm — previu (${naFace.prev.parada.x}, ${naFace.prev.parada.y})`);
  ok('tiro na QUINA: erro abaixo de 1 cm', naQuina.erro < 1,
    `${naQuina.erro.toFixed(2)} cm — previu (${naQuina.prev.parada.x}, ${naQuina.prev.parada.y})`
    + `, real (${naQuina.real.x.toFixed(1)}, ${naQuina.real.y.toFixed(1)})`);
  // O contato também sai do lugar: no quadrado ele é anunciado raio·(√2−1)
  // antes na diagonal, e é isso que contamina `dist` e a pancada na bola.
  ok('a QUINA não antecipa o contato', naQuina.prev.primeiroContato?.dist > naFace.prev.primeiroContato?.dist,
    `face ${naFace.prev.primeiroContato?.dist} cm, quina ${naQuina.prev.primeiroContato?.dist} cm`);

  // Encostado na DIAGONAL da quina sem tocar nela: o disco está dentro do
  // quadrado inflado (raio em cada eixo) e fora do contorno de verdade. Pelo
  // quadrado isso é contato imediato; pelo arco não é contato nenhum. Aqui ele
  // ainda atira para o lado OPOSTO, e mesmo assim a previsão anunciava
  // `{BG, dist: 0}` e parava o disco no lugar — 50 cm de erro.
  const folga = PHYS.buttonRadius * 0.85;              // > raio na diagonal, < raio por eixo
  const encostado = conferir(disco('A1', gx + KEEPER.comprimento / 2 + folga, gy + hh + folga),
    [goleiro(gx, gy, 0)], { anguloAro: 45 + 180, inclinacao: 45, avanco: 0.35, forca: 0.7 });
  ok('quina na diagonal: o motor não vê contato', encostado.tocou.length === 0,
    encostado.tocou.map((e) => e.a + '/' + e.b).join(','));
  ok('e a previsão também não inventa um', encostado.prev.primeiroContato === null,
    JSON.stringify(encostado.prev.primeiroContato));
  ok('a parada continua certa (1 cm)', encostado.erro < 1,
    `${encostado.erro.toFixed(2)} cm — previu (${encostado.prev.parada.x}, ${encostado.prev.parada.y})`);
}

/* ================================================================= */
secao('3) CAVADINHA que acerta a bola EM VOO');
{
  // Enquanto `hopUntil` não vence, o motor cobra `cavadaAtrito` (0,03) do
  // disco; no chão são `muButton` (0,16), 5,3x mais. Se a perna DEPOIS do
  // toque na bola for freada com o atrito do feltro enquanto o disco ainda
  // está no ar, a parada prevista sai curta — e sai mais curta quanto mais
  // voo restava, ou seja LONGE do pouso, não perto dele.
  const erros = [];
  let comVoo = 0;
  for (let tiro = 0; tiro < 360; tiro += 30) {
    for (const forca of [0.6, 0.8, 1]) {
      for (let dist = 8; dist <= 44; dist += 6) {
        const ux = Math.cos(D(tiro)), uy = Math.sin(D(tiro));
        const pal = { anguloAro: tiro + 180, inclinacao: 70, avanco: 0.3, forca };
        const res = resolverPalheta(pal);
        if (!res.cavada) continue;
        const r = conferir(disco('A1', MEIO.x, MEIO.y),
          [bola(MEIO.x + ux * dist, MEIO.y + uy * dist)], pal);
        // Só interessa o toque que acontece com o disco ainda NO AR.
        const toque = r.tocou[0];
        if (!toque || toque.t >= res.duracaoVoo) continue;
        comVoo++;
        erros.push(r.erro);
      }
    }
  }
  const s = resumo(erros);
  ok('houve cavadinha acertando em voo', comVoo > 40, comVoo + ' lances');
  // Sem passar o voo que resta para a perna do ricochete: media 6,20 / max 16,5.
  ok('erro médio abaixo de 0,3 cm', s.media < 0.3, s.texto);
  ok('nenhum caso passa de 2 cm', s.max < 2, s.texto);
}

/* ================================================================= */
secao('4) `primeiroContato: null` quer dizer caminho livre');
{
  // A beirada da mesa desvia o disco: a perna nova aponta para outro lado e
  // precisa ser varrida de novo. Sem isso a previsão dizia "não bate em
  // ninguém" e o motor registrava o contato — e o planejamento comia a mentira.
  const alto = PITCH.width + PITCH.margemFora - PHYS.buttonRadius;
  const atirador = disco('A1', PITCH.length * 0.6, PITCH.width * 0.92);
  const parado = disco('B1', PITCH.length * 0.85, alto, 'B');
  const r = conferir(atirador, [parado], palhetaPara(35, PHYS.maxShotSpeed * 0.97));

  ok('o motor registra o contato depois do desvio', r.tocou.length > 0,
    r.sim.events.filter((e) => e.type === 'contact').map((e) => e.a + '/' + e.b).join(',') || '(nenhum)');
  ok('a previsão desvia pela beirada', r.prev.paraNaBeirada === true);
  ok('e ela NÃO diz caminho livre', r.prev.primeiroContato?.id === 'B1',
    JSON.stringify(r.prev.primeiroContato));
  ok('a parada prevista bate (1 cm)', r.erro < 1,
    `previu (${r.prev.parada.x}, ${r.prev.parada.y}), real (${r.real.x.toFixed(1)}, ${r.real.y.toFixed(1)})`);

  // O outro lado da moeda: quem está longe demais para ser alcançado não é
  // contato nenhum. `alcancaBola` mentia junto quando a bola caía dentro do
  // alcance em linha reta mas o disco parava antes.
  const fraco = conferir(disco('A1', PITCH.length * 0.2, MEIO.y),
    [bola(PITCH.length * 0.9, MEIO.y)],
    { anguloAro: 180, inclinacao: 45, avanco: 0.35, forca: 0.2 });
  ok('longe demais: contato null e sem previsão de bola',
    fraco.prev.primeiroContato === null && fraco.prev.alcancaBola === false,
    JSON.stringify(fraco.prev.primeiroContato));
}

/* ================================================================= */
secao('Determinismo: prever duas vezes dá a mesma coisa');
{
  const monta = () => {
    const a = disco('A1', 60, 50);
    const alvos = [disco('B1', 96, 62, 'B'), goleiro(150, 60, 30), bola(120, 55)];
    return { a, alvos };
  };
  const p1 = (() => { const { a, alvos } = monta(); return preverLance(a, resolverPalheta({ anguloAro: 200, inclinacao: 62, avanco: 0.4, forca: 0.9 }), [a, ...alvos]); })();
  const p2 = (() => { const { a, alvos } = monta(); return preverLance(a, resolverPalheta({ anguloAro: 200, inclinacao: 62, avanco: 0.4, forca: 0.9 }), [a, ...alvos]); })();
  ok('mesma entrada, mesma saída', JSON.stringify(p1) === JSON.stringify(p2));
}

console.log(fails === 0 ? '\nTUDO OK' : `\n${fails} FALHA(S)`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
