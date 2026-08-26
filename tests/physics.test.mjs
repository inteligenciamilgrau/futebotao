import { makeBody, simulate, goalPosts } from '../server/physics.js';
import { PITCH, PHYS } from '../server/config.js';

function B(x, y, extra = {}) {
  return makeBody({ id: extra.id || 'A1', kind: extra.kind || 'button', team: extra.team ?? 'A',
    x, y, r: extra.r ?? PHYS.buttonRadius, m: extra.m ?? PHYS.buttonMass });
}
const ball = (x, y) => makeBody({ id: 'ball', kind: 'ball', x, y, r: PHYS.ballRadius, m: PHYS.ballMass });

let fails = 0;
const ok = (name, cond, info = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!cond) fails++; };

// 1) Chute reto no gol
{
  const bs = [B(150, 60), ball(158, 60)];
  bs[0].vx = 230;
  const r = simulate(bs, goalPosts());
  ok('chute reto vira gol do A', r.goal && r.goal.team === 'A', JSON.stringify(r.goal));
  ok('simulacao termina rapido', r.seconds < PHYS.maxSimSeconds, r.seconds + 's');
  ok('gera keyframes', r.frames.length > 5, r.frames.length + ' frames');
}

// 2) Atrito faz o disco parar e a distancia bate com a formula d = v^2/(2*mu*g)
{
  const bs = [B(30, 60)];
  bs[0].vx = 150;
  simulate(bs, goalPosts());
  const esperado = 30 + (150 * 150) / (2 * PHYS.muButton * PHYS.gravity);
  ok('distancia de parada bate com Coulomb', Math.abs(bs[0].x - esperado) < 1.5,
     `x=${bs[0].x.toFixed(1)} esperado=${esperado.toFixed(1)}`);
}

// 3) Bola rola mais que o disco com a mesma velocidade
{
  const a = [B(20, 30)]; a[0].vx = 120; simulate(a, goalPosts());
  const b = [ball(20, 90)]; b[0].vx = 120; simulate(b, goalPosts());
  ok('bola percorre mais que o disco', (b[0].x - 20) > (a[0].x - 20) * 1.2, `disco=${(a[0].x-20).toFixed(0)} bola=${(b[0].x-20).toFixed(0)}`);
}

// 4) O disco pode sair do CAMPO, mas nunca da MESA
{
  const bs = [B(100, 60)]; bs[0].vx = 300; bs[0].vy = 120;
  simulate(bs, goalPosts());
  const m = PITCH.margemFora;
  const naMesa = bs[0].x >= -m && bs[0].x <= PITCH.length + m
              && bs[0].y >= -m && bs[0].y <= PITCH.width + m;
  ok('disco fica na mesa', naMesa, `(${bs[0].x.toFixed(1)}, ${bs[0].y.toFixed(1)})`);
}

// 5) Trave: bola no poste nao entra
{
  const bs = [ball(40, PITCH.goalMin)];
  bs[0].vx = -260;
  const r = simulate(bs, goalPosts());
  ok('bola na trave nao vira gol', !r.goal, JSON.stringify(r.goal));
  ok('registrou contato com a trave', r.contacts.some(c => c.a.startsWith('post') || c.b.startsWith('post')));
}

// 6) Conservacao: massas iguais em choque frontal trocam momento
{
  const a = B(80, 60, { id: 'A1' }), b = B(95, 60, { id: 'B1', team: 'B' });
  a.vx = 180;
  simulate([a, b], goalPosts());
  ok('disco parado e empurrado pelo choque', b.x > 95 + 5, `B1 x=${b.x.toFixed(1)}`);
  ok('disco que bateu perde velocidade', a.x < b.x, `A1 x=${a.x.toFixed(1)}`);
}

// 7) Determinismo
{
  const run = () => { const bs = [B(60, 40), ball(70, 47)]; bs[0].vx = 190; bs[0].vy = 95; simulate(bs, goalPosts()); return bs.map(b => `${b.x.toFixed(4)},${b.y.toFixed(4)}`).join('|'); };
  ok('mesma entrada -> mesma saida', run() === run());
}

console.log(fails === 0 ? '\nTUDO OK' : `\n${fails} FALHA(S)`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
