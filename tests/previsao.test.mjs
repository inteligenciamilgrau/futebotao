// A mira (`preverLance`) precisa bater com a simulação de verdade.
// Ela é geometria fechada, então nunca vai bater 100% — mas o erro tem que ser
// pequeno inclusive no toque de RASPÃO, que é onde ela mais errava.
import { makeBody, simulate, goalPosts } from '../server/physics.js';
import { resolverPalheta, preverLance } from '../server/palheta.js';
import { PITCH, PHYS } from '../server/config.js';

let fails = 0;
const ok = (n, c, i = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (i ? '  -> ' + i : '')); if (!c) fails++; };
const secao = (t) => console.log('\n== ' + t + ' ==');

/**
 * Monta um lance em que o botão passa a `desvio` cm ao lado do centro da bola.
 * desvio 0 = toque cheio; perto de 3,55 = raspão.
 */
function cenario(desvio, forca = 0.8) {
  const bola = makeBody({ id: 'ball', kind: 'ball', x: 120, y: 60, r: PHYS.ballRadius, m: PHYS.ballMass });
  const botao = makeBody({ id: 'A1', kind: 'button', team: 'A', x: 90, y: 60 + desvio, r: PHYS.buttonRadius, m: PHYS.buttonMass });
  const res = resolverPalheta({ anguloAro: 180, inclinacao: 45, avanco: 0.35, forca });
  const previsao = preverLance(botao, res, [bola]);

  botao.vx = res.vx; botao.vy = res.vy;
  botao.liftBias = res.elevacao;
  simulate([botao, bola], goalPosts());
  const real = Math.hypot(bola.x - 120, bola.y - 60);
  return { previsao, real, res };
}

secao('Toque cheio: previsão já batia');
{
  const { previsao, real } = cenario(0);
  ok('a mira diz que alcança a bola', previsao.alcancaBola);
  ok('marca o toque como cheio', previsao.bola.cheio > 0.98, String(previsao.bola.cheio));
  const erro = Math.abs(previsao.bola.corrida - real) / real;
  ok('erro menor que 12% no toque cheio', erro < 0.12,
    `previu ${previsao.bola.corrida} cm, real ${real.toFixed(1)} cm (${(erro * 100).toFixed(0)}%)`);
}

secao('Raspão: era aqui que a mira mentia');
for (const desvio of [1.5, 2.4, 3.0]) {
  const { previsao, real } = cenario(desvio);
  const erro = Math.abs(previsao.bola.corrida - real) / Math.max(1, real);
  ok(`desvio ${desvio} cm: erro menor que 20%`, erro < 0.20,
    `cheio=${previsao.bola.cheio} previu ${previsao.bola.corrida} cm, real ${real.toFixed(1)} cm (${(erro * 100).toFixed(0)}%)`);
}

secao('Quanto mais de raspão, menos a bola corre');
{
  const cheio = cenario(0).previsao.bola;
  const meio = cenario(2.0).previsao.bola;
  const raspa = cenario(3.2).previsao.bola;
  ok('a previsão cai junto com o "cheio"',
    cheio.corrida > meio.corrida && meio.corrida > raspa.corrida,
    `${cheio.corrida} > ${meio.corrida} > ${raspa.corrida}`);
  ok('o fator cheio também cai', cheio.cheio > meio.cheio && meio.cheio > raspa.cheio,
    `${cheio.cheio} > ${meio.cheio} > ${raspa.cheio}`);
}

secao('A mira avisa quando a parada é fantasia');
{
  // Bola perto da linha de cima, empurrada para fora com força.
  const bola = makeBody({ id: 'ball', kind: 'ball', x: 100, y: 108, r: PHYS.ballRadius, m: PHYS.ballMass });
  const botao = makeBody({ id: 'A1', kind: 'button', team: 'A', x: 100, y: 100, r: PHYS.buttonRadius, m: PHYS.buttonMass });
  const res = resolverPalheta({ anguloAro: 270, inclinacao: 45, avanco: 0.35, forca: 1 });
  const p = preverLance(botao, res, [bola]);
  ok('avisa que a bola sai de campo', p.bola?.saiDeCampo === true,
    JSON.stringify(p.bola?.parada));

  // Adversário na trajetória da bola.
  const bola2 = makeBody({ id: 'ball', kind: 'ball', x: 100, y: 60, r: PHYS.ballRadius, m: PHYS.ballMass });
  const b2 = makeBody({ id: 'A1', kind: 'button', team: 'A', x: 90, y: 60, r: PHYS.buttonRadius, m: PHYS.buttonMass });
  const barreira = makeBody({ id: 'B1', kind: 'button', team: 'B', x: 125, y: 60, r: PHYS.buttonRadius, m: PHYS.buttonMass });
  const res2 = resolverPalheta({ anguloAro: 180, inclinacao: 45, avanco: 0.35, forca: 0.8 });
  const p2 = preverLance(b2, res2, [bola2, barreira]);
  ok('avisa em quem a bola vai bater', p2.bola?.bateEm === 'B1', String(p2.bola?.bateEm));
}

secao('Sem alcançar a bola, não inventa previsão');
{
  const bola = makeBody({ id: 'ball', kind: 'ball', x: 180, y: 60, r: PHYS.ballRadius, m: PHYS.ballMass });
  const botao = makeBody({ id: 'A1', kind: 'button', team: 'A', x: 40, y: 60, r: PHYS.buttonRadius, m: PHYS.buttonMass });
  const res = resolverPalheta({ anguloAro: 180, inclinacao: 45, avanco: 0.35, forca: 0.2 });
  const p = preverLance(botao, res, [bola]);
  ok('diz que não alcança', p.alcancaBola === false && p.bola === null,
    `corrida do disco ${p.corridaDisco} cm`);
}

console.log(fails === 0 ? '\nTUDO OK' : `\n${fails} FALHA(S)`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
