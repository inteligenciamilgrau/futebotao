// Física 2D determinística de discos sobre a mesa.
// O jogo é plano: o 3D do cliente é só a apresentação disso aqui.
//
// Modelo:
//  - Atrito de Coulomb -> desaceleração CONSTANTE (a = mu * g), que é o
//    comportamento real de um disco deslizando, não decaimento exponencial.
//  - Colisões por impulso com restituição + impulso tangencial (dá "efeito").
//  - Traves são círculos de massa infinita, então dá pra acertar a trave.

import { PITCH, PHYS, PALHETA, KEEPER } from './config.js';

export function makeBody(o) {
  const b = {
    id: o.id,
    kind: o.kind,               // 'button' | 'keeper' | 'ball' | 'post'
    team: o.team ?? null,       // 'A' | 'B' | null
    label: o.label ?? o.id,
    forma: o.forma || 'circulo', // 'circulo' | 'caixa'
    x: o.x, y: o.y,
    vx: o.vx ?? 0, vy: o.vy ?? 0,
    // Terceira dimensão: só a bola voa, mas todo corpo tem uma altura útil,
    // usada para decidir se a bola passa por cima dele.
    z: o.z ?? 0,
    vz: o.vz ?? 0,
    alturaTopo: o.alturaTopo ?? 0,
    // Quanto este corpo levanta a bola ao acertá-la (vem da inclinação da palheta).
    liftBias: o.liftBias ?? 0,
    r: o.r,
    m: o.m,
    // Cavadinha: enquanto t < hopUntil o botão está no ar (passa por cima).
    hopUntil: o.hopUntil ?? 0,
    invM: o.m > 0 ? 1 / o.m : 0,
    fixed: !!o.fixed,
  };
  if (b.kind === 'button') b.alturaTopo = PHYS.alturaBotao;
  if (b.kind === 'ball') b.alturaTopo = o.r * 2;
  if (b.forma === 'caixa') {
    // Goleiro caixa de fósforo: retângulo orientado. `r` vira só o raio
    // envolvente, usado para descartar pares distantes rapidamente.
    b.w = o.w; b.h = o.h;
    b.ang = o.ang ?? 0;                       // radianos
    b.r = Math.hypot(o.w, o.h) / 2;
    b.alturaTopo = o.alturaTopo ?? KEEPER.altura;
  }
  return b;
}

export function goalPosts() {
  const r = 1.3;
  return [
    makeBody({ id: 'post_A_lo', kind: 'post', x: 0, y: PITCH.goalMin, r, m: 0, fixed: true }),
    makeBody({ id: 'post_A_hi', kind: 'post', x: 0, y: PITCH.goalMax, r, m: 0, fixed: true }),
    makeBody({ id: 'post_B_lo', kind: 'post', x: PITCH.length, y: PITCH.goalMin, r, m: 0, fixed: true }),
    makeBody({ id: 'post_B_hi', kind: 'post', x: PITCH.length, y: PITCH.goalMax, r, m: 0, fixed: true }),
  ];
}

function frictionOf(b) {
  return b.kind === 'ball' ? PHYS.muBall : PHYS.muButton;
}

// Abertura do gol: só a bola atravessa a linha ali.
function inGoalMouth(y) {
  return y > PITCH.goalMin && y < PITCH.goalMax;
}

/**
 * O campo tem LINHAS ABERTAS: a bola cruza e sai. Os botões, não — eles param
 * na linha, porque um disco fora do campo não faz sentido nenhum.
 */
/**
 * Segura o botão na BEIRADA DA MESA, não na linha.
 *
 * O campo tem linhas abertas: a bola cruza e sai. O botão, não — ele sai e
 * continua em jogo, na faixa de mesa em volta. É isso que deixa cobrar uma
 * lateral vindo de fora e buscar uma bola colada na linha sem empurrá-la
 * para fora. O que ele não faz é cair da mesa.
 *
 * A parada é seca, sem quique: a componente paralela à borda continua, então
 * dá para deslizar por ela.
 */
function segurarBotao(b, events, t) {
  if (b.kind === 'ball') return;
  const m = PITCH.margemFora;
  const perde = 0;

  const limite = (eixo, minimo, maximo, ladoMin, ladoMax) => {
    const v = eixo === 'x' ? 'vx' : 'vy';
    if (b[eixo] < minimo) {
      b[eixo] = minimo;
      if (b[v] < 0) { b[v] = -b[v] * perde; events.push({ t, type: 'mesa', body: b.id, side: ladoMin }); }
    } else if (b[eixo] > maximo) {
      b[eixo] = maximo;
      if (b[v] > 0) { b[v] = -b[v] * perde; events.push({ t, type: 'mesa', body: b.id, side: ladoMax }); }
    }
  };

  limite('x', -m + b.r, PITCH.length + m - b.r, 'left', 'right');
  limite('y', -m + b.r, PITCH.width + m - b.r, 'bottom', 'top');
}
/**
 * Depois do gol, a bola fica DENTRO do gol.
 *
 * Ela bate na rede, que engole quase toda a pancada, e descansa lá. Antes a
 * simulação só continuava por 0,4 s e cortava — a bola terminava atravessada
 * no nada atrás da meta, e o replay do gol acabava com ela fora da tela.
 *
 * A caixa é a do gol de verdade: fundo a `goalDepth` da linha, laterais nas
 * traves, teto no travessão.
 */
function segurarNaRede(b, gol) {
  const r = b.r;
  const paraDentro = gol.emX === 0 ? -1 : +1;          // sentido de entrada
  const fundo = gol.emX + paraDentro * (PITCH.goalDepth - r);
  const devolve = PHYS.redeDevolve;

  // Fundo da rede.
  if (paraDentro < 0 ? b.x < fundo : b.x > fundo) {
    b.x = fundo;
    if (paraDentro < 0 ? b.vx < 0 : b.vx > 0) b.vx = -b.vx * devolve;
  }
  // Laterais da rede, alinhadas com as traves.
  if (b.y < PITCH.goalMin + r) { b.y = PITCH.goalMin + r; if (b.vy < 0) b.vy = -b.vy * devolve; }
  if (b.y > PITCH.goalMax - r) { b.y = PITCH.goalMax - r; if (b.vy > 0) b.vy = -b.vy * devolve; }
  // Teto: o travessão por dentro.
  if (b.z > PITCH.alturaTravessao - r) {
    b.z = PITCH.alturaTravessao - r;
    if (b.vz > 0) b.vz = -b.vz * devolve;
  }
  // A malha rouba energia também enquanto ela rola lá dentro.
  b.vx *= PHYS.redeArrasta;
  b.vy *= PHYS.redeArrasta;
}

/** A bola saiu? Devolve por onde, para o jogo escolher a reposição. */
function bolaFora(ball) {
  if (ball.y < 0) return { linha: 'lateral', lado: 'baixo', x: ball.x, y: 0 };
  if (ball.y > PITCH.width) return { linha: 'lateral', lado: 'cima', x: ball.x, y: PITCH.width };
  if (ball.x < 0) {
    if (inGoalMouth(ball.y)) return null;                 // é gol, não é saída
    return { linha: 'fundo', gol: 'A', x: 0, y: ball.y };
  }
  if (ball.x > PITCH.length) {
    if (inGoalMouth(ball.y)) return null;
    return { linha: 'fundo', gol: 'B', x: PITCH.length, y: ball.y };
  }
  return null;
}

/**
 * Círculo contra retângulo orientado (o goleiro caixa).
 * Leva o círculo para o referencial da caixa, acha o ponto mais próximo dentro
 * dela e resolve como um contato normal. Se o centro entrar na caixa, empurra
 * pelo eixo de menor penetração.
 * @returns {{nx, ny, prof}|null} normal apontando da caixa para o círculo
 */
export function contatoCirculoCaixa(circ, caixa) {
  const cos = Math.cos(-caixa.ang), sin = Math.sin(-caixa.ang);
  const dx = circ.x - caixa.x, dy = circ.y - caixa.y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;

  const hw = caixa.w / 2, hh = caixa.h / 2;
  const px = Math.max(-hw, Math.min(hw, lx));
  const py = Math.max(-hh, Math.min(hh, ly));

  let nx, ny, prof;
  const dentro = Math.abs(lx) <= hw && Math.abs(ly) <= hh;

  if (dentro) {
    // Centro dentro da caixa: sai pela face mais próxima.
    const folgaX = hw - Math.abs(lx), folgaY = hh - Math.abs(ly);
    if (folgaX < folgaY) { nx = Math.sign(lx) || 1; ny = 0; prof = folgaX + circ.r; }
    else { nx = 0; ny = Math.sign(ly) || 1; prof = folgaY + circ.r; }
  } else {
    const ex = lx - px, ey = ly - py;
    const d = Math.hypot(ex, ey);
    if (d >= circ.r || d === 0) return null;
    nx = ex / d; ny = ey / d; prof = circ.r - d;
  }

  // Volta a normal para o mundo.
  const c2 = Math.cos(caixa.ang), s2 = Math.sin(caixa.ang);
  return { nx: nx * c2 - ny * s2, ny: nx * s2 + ny * c2, prof };
}

function collide(a, b, events, t) {
  // Botão no ar (cavadinha) passa por cima dos OBSTÁCULOS, mas ainda pega a
  // bola: é justamente assim que se cava por cima de uma defesa.
  const voando = a.hopUntil > t || b.hopUntil > t;
  if (voando && a.kind !== 'ball' && b.kind !== 'ball') return false;

  // Bola no alto passa por cima de quem for mais baixo que ela.
  const bola = a.kind === 'ball' ? a : b.kind === 'ball' ? b : null;
  if (bola) {
    const outro = bola === a ? b : a;
    if (outro.kind !== 'post' && bola.z > outro.alturaTopo) return false;
  }

  // Descarte rápido pelo raio envolvente.
  const ddx = b.x - a.x, ddy = b.y - a.y;
  const somaR = a.r + b.r;
  if (ddx * ddx + ddy * ddy >= somaR * somaR) return false;

  if (a.forma === 'caixa' || b.forma === 'caixa') {
    if (a.forma === 'caixa' && b.forma === 'caixa') return false;   // não acontece
    const caixa = a.forma === 'caixa' ? a : b;
    const circ = a.forma === 'caixa' ? b : a;
    const ct = contatoCirculoCaixa(circ, caixa);
    if (!ct) return false;
    return resolverContato(caixa, circ, ct.nx, ct.ny, ct.prof, events, t);
  }

  const dx = b.x - a.x, dy = b.y - a.y;
  const rr = a.r + b.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr || d2 === 0) return false;

  const d = Math.sqrt(d2);
  const nx = dx / d, ny = dy / d;

  return resolverContato(a, b, nx, ny, rr - d, events, t);
}

/**
 * O impulso de UM contato, sem tocar em ninguém: normal com restituição mais
 * tangencial limitado a metade dele.
 *
 * Fica exportado porque a previsão do lance (palheta.js) precisa do MESMO
 * impulso para dizer onde o disco para depois de bater. As duas contas viviam
 * escritas em dois lugares, e uma calibração de `restitutionBody` ou de
 * `tangentFriction` que mexesse em uma delas deixaria a outra mentindo em
 * silêncio.
 *
 * `n` aponta de A para B; `vr` é a velocidade de B RELATIVA a A. Devolve null
 * quando não há impulso a aplicar (já se afastando, ou dois corpos fixos).
 */
export function impulsoContato(vrx, vry, nx, ny, totInv) {
  const vn = vrx * nx + vry * ny;
  if (vn > 0 || totInv <= 0) return null;

  const j = -(1 + PHYS.restitutionBody) * vn / totInv;
  const tx = -ny, ty = nx;
  const vt = vrx * tx + vry * ty;
  let jt = -vt * PHYS.tangentFriction / totInv;
  const maxJt = Math.abs(j) * 0.5;
  if (jt > maxJt) jt = maxJt; else if (jt < -maxJt) jt = -maxJt;
  return { j, jt, tx, ty, vn };
}

/** Separação + impulso. `n` aponta de `a` para `b`. Serve para as duas formas. */
function resolverContato(a, b, nx, ny, prof, events, t) {
  const totInv = a.invM + b.invM;
  if (totInv > 0) {
    const corr = prof / totInv;
    a.x -= nx * corr * a.invM; a.y -= ny * corr * a.invM;
    b.x += nx * corr * b.invM; b.y += ny * corr * b.invM;
  }

  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;

  if (events) {
    events.push({
      t, type: 'contact', a: a.id, b: b.id,
      aKind: a.kind, bKind: b.kind, aTeam: a.team, bTeam: b.team,
      speed: Math.round(Math.abs(vn) * 10) / 10,
      // O ponto de contato sai pela superfície de B, não de A: `a.r` é o raio
      // ENVOLVENTE, e para a caixa do goleiro (16 x 4.5) ele vale 8.31 — o
      // contato era relatado a 8.31 cm do centro da caixa em qualquer ângulo,
      // como se ela fosse um círculo. A colisão sempre esteve certa; o que
      // mentia era a coordenada. B é sempre o círculo nos dois caminhos.
      x: Math.round((b.x - nx * b.r) * 10) / 10,
      y: Math.round((b.y - ny * b.r) * 10) / 10,
    });
  }

  const imp = impulsoContato(b.vx - a.vx, b.vy - a.vy, nx, ny, totInv);
  if (!imp) return true;              // já se afastando, ou dois corpos fixos

  const { j, jt, tx, ty } = imp;
  a.vx -= j * nx * a.invM; a.vy -= j * ny * a.invM;
  b.vx += j * nx * b.invM; b.vy += j * ny * b.invM;

  // A borda arredondada do botão pega POR BAIXO da bola e a levanta. Quanto
  // mais em pé estava a palheta (liftBias), mais a pancada vira altura.
  const alvo = a.kind === 'ball' ? a : b.kind === 'ball' ? b : null;
  if (alvo) {
    const bate = alvo === a ? b : a;
    if (bate.kind === 'button' || bate.kind === 'keeper') {
      const razao = bate.liftBias * PHYS.liftMax;
      if (razao > 0) alvo.vz += razao * Math.abs(vn);
    }
  }

  // Impulso tangencial: raspadas laterais desviam em vez de refletir puro.
  a.vx -= jt * tx * a.invM; a.vy -= jt * ty * a.invM;
  b.vx += jt * tx * b.invM; b.vy += jt * ty * b.invM;
  return true;
}

/**
 * Roda a simulação até tudo parar, sair um gol, ou estourar o tempo limite.
 * Os corpos são mutados no lugar; ao final ficam nas posições de repouso.
 * @returns {{frames, events, goal, seconds, contacts}}
 */
export function simulate(bodies, statics = goalPosts()) {
  const all = bodies.concat(statics);
  const events = [];
  const frames = [];
  const dt = PHYS.dt;
  const maxSteps = Math.ceil(PHYS.maxSimSeconds / dt);
  const ball = bodies.find((b) => b.kind === 'ball');
  let goal = null;
  let fora = null;
  let ultimoToqueBola = null;   // quem encostou na bola por último
  let step = 0;

  const snapshot = (t) => {
    const p = [];
    for (const b of bodies) p.push(Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10);
    // Altura da bola: é o que faz o cliente desenhar o chute por cima.
    const z = ball ? Math.round(ball.z * 10) / 10 : 0;
    frames.push({ t: Math.round(t * 100) / 100, p, z });
  };

  snapshot(0);

  for (step = 1; step <= maxSteps; step++) {
    const t = step * dt;

    // 1) atrito + integração
    for (const b of bodies) {
      if (b.fixed) continue;
      const noAr = b.z > PHYS.alturaVooMin || b.hopUntil > t;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 0) {
        const mu = noAr ? (b.hopUntil > t ? PALHETA.cavadaAtrito : PHYS.arAtrito) : frictionOf(b);
        const dec = mu * PHYS.gravity * dt;
        if (sp <= dec) { b.vx = 0; b.vy = 0; }
        else { const k = (sp - dec) / sp; b.vx *= k; b.vy *= k; }
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // Voo da bola: parábola e quique no feltro.
      if (b.kind === 'ball' && (b.z > 0 || b.vz !== 0)) {
        b.vz -= PHYS.gravity * dt;
        b.z += b.vz * dt;
        if (b.z <= 0) {
          b.z = 0;
          if (b.vz < 0) {
            b.vz = -b.vz * PHYS.ballBounce;
            events.push({ t, type: 'quique', body: b.id, forca: Math.round(Math.abs(b.vz)) });
            if (b.vz < 18) b.vz = 0;          // quiques minúsculos: assenta
          }
        }
      }
    }

    // 2) linhas: seguram os botões, a bola atravessa
    for (const b of bodies) if (!b.fixed) segurarBotao(b, events, t);

    // 3) colisões (2 passadas ajudam quando vários discos se amontoam)
    for (let pass = 0; pass < 2; pass++) {
      const sink = pass === 0 ? events : null;
      for (let i = 0; i < all.length; i++) {
        for (let k = i + 1; k < all.length; k++) {
          const A = all[i], B = all[k];
          if (A.fixed && B.fixed) continue;
          collide(A, B, sink, t);
        }
      }
    }

    // 4) gol ou saída?
    // Já é gol: a bola vive dentro da rede daqui para a frente.
    if (ball && goal) segurarNaRede(ball, goal);

    if (ball && !goal && !fora) {
      const dentroDaBoca = inGoalMouth(ball.y) && ball.z < PITCH.alturaTravessao;
      const porCima = inGoalMouth(ball.y) && ball.z >= PITCH.alturaTravessao;
      if (ball.x <= 0 && dentroDaBoca) goal = { team: 'B', t, y: ball.y, z: Math.round(ball.z * 10) / 10, emX: 0 };
      else if (ball.x >= PITCH.length && dentroDaBoca) goal = { team: 'A', t, y: ball.y, z: Math.round(ball.z * 10) / 10, emX: PITCH.length };
      if (goal) events.push({ t, type: 'goal', team: goal.team, altura: goal.z });
      else if (porCima && (ball.x <= 0 || ball.x >= PITCH.length)) {
        // Passou por cima do travessão: é linha de fundo, não gol.
        fora = { linha: 'fundo', gol: ball.x <= 0 ? 'A' : 'B', x: ball.x <= 0 ? 0 : PITCH.length, y: ball.y, porCima: true, t };
        events.push({ t, type: 'fora', ...fora });
      }
      else {
        const f = bolaFora(ball);
        if (f) { fora = { ...f, t }; events.push({ t, type: 'fora', ...f }); }
      }
    }

    if (step % PHYS.frameEvery === 0) snapshot(t);

    // 5) repouso
    let moving = false;
    for (const b of bodies) {
      if (b.fixed) continue;
      if (Math.hypot(b.vx, b.vy) > PHYS.restSpeed) { moving = true; break; }
      if (b.kind === 'ball' && (b.z > PHYS.alturaVooMin || Math.abs(b.vz) > 12)) { moving = true; break; }
    }
    if (!moving) { snapshot(t); break; }
    // Tempo de ela entrar, bater na rede e assentar. O `!moving` acima corta
    // antes se ela parar sozinha.
    if (goal && t - goal.t > 1.6) { snapshot(t); break; }
    if (fora && t - fora.t > 0.12) { snapshot(t); break; }  // saiu: não interessa o resto
  }

  const voos = bodies
    .filter((b) => b.hopUntil > 0)
    .map((b) => ({ id: b.id, ate: Math.round(b.hopUntil * 100) / 100, altura: PALHETA.cavadaAltura }));

  for (const b of bodies) {
    if (b.fixed) continue;
    b.vx = 0; b.vy = 0; b.vz = 0;
    b.hopUntil = 0;
    b.liftBias = 0;
    if (b.kind === 'ball') b.z = 0;
  }
  const seconds = Math.round(step * dt * 100) / 100;
  const contacts = events.filter((e) => e.type === 'contact');

  // Quem encostou na bola por último — base da regra de posse.
  for (let i = contacts.length - 1; i >= 0; i--) {
    const c = contacts[i];
    if (c.aKind === 'ball') { ultimoToqueBola = { id: c.b, kind: c.bKind, team: c.bTeam, t: c.t }; break; }
    if (c.bKind === 'ball') { ultimoToqueBola = { id: c.a, kind: c.aKind, team: c.aTeam, t: c.t }; break; }
  }
  return { frames, events, goal, fora, ultimoToqueBola, seconds, contacts, voos };
}

/** Empurra corpos sobrepostos até separarem (usado ao montar a formação). */
export function settle(bodies, statics = goalPosts(), iterations = 80) {
  const all = bodies.concat(statics);
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < all.length; i++) {
      for (let k = i + 1; k < all.length; k++) {
        const a = all[i], b = all[k];
        if (a.fixed && b.fixed) continue;

        // Caixa (goleiro) usa o contato retângulo-círculo, não o raio envolvente.
        if (a.forma === 'caixa' || b.forma === 'caixa') {
          const caixa = a.forma === 'caixa' ? a : b;
          const circ = a.forma === 'caixa' ? b : a;
          const ct = contatoCirculoCaixa(circ, caixa);
          if (!ct) continue;
          if (!circ.fixed) { circ.x += ct.nx * (ct.prof + 0.05); circ.y += ct.ny * (ct.prof + 0.05); }
          moved = true;
          continue;
        }

        const dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r + 0.05;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 0.001;
        const nx = dx / d, ny = dy / d, push = (rr - d) / 2;
        if (!a.fixed) { a.x -= nx * push; a.y -= ny * push; }
        if (!b.fixed) { b.x += nx * push; b.y += ny * push; }
        moved = true;
      }
    }
    for (const b of bodies) {
      if (b.fixed || b.forma === 'caixa') continue;
      // A BOLA pode descansar em cima da linha — é onde ela fica numa lateral
      // ou num escanteio. Quem decide se ela saiu é o jogo, na simulação, e
      // não este ajuste de sobreposição.
      if (b.kind === 'ball') {
        b.x = Math.min(PITCH.length, Math.max(0, b.x));
        b.y = Math.min(PITCH.width, Math.max(0, b.y));
        continue;
      }
      // Botão anda pela mesa inteira, campo e faixa de fora.
      const m = PITCH.margemFora;
      b.x = Math.min(PITCH.length + m - b.r, Math.max(b.r - m, b.x));
      b.y = Math.min(PITCH.width + m - b.r, Math.max(b.r - m, b.y));
    }
    if (!moved) break;
  }
}
