// Renderiza o "frame" táctil que a IA enxerga: vista de cima da mesa em PNG.
// Inclui grade de coordenadas e rótulos, porque é isso que dá base espacial
// para o modelo relacionar o que vê com os números do estado JSON.

import { Surface, TEXT_W } from './png.js';
import { PITCH } from './config.js';

const S = 5;                       // pixels por centímetro
const MARGIN = { l: 46, r: 46, t: 50, b: 46 };

export const COLORS = {
  table: [26, 30, 36],
  grass: [46, 120, 62],
  grassAlt: [42, 111, 57],
  line: [236, 243, 236],
  grid: [255, 255, 255],
  net: [22, 26, 32],
  A: [51, 122, 246],
  B: [232, 72, 60],
  ADark: [22, 62, 140],
  BDark: [140, 32, 24],
  ball: [252, 252, 250],
  ballEdge: [24, 24, 24],
  post: [246, 230, 120],
  text: [238, 240, 245],
  dim: [150, 158, 170],
  highlight: [255, 214, 64],
  previsao: [130, 230, 165],
};

const W = PITCH.length * S + MARGIN.l + MARGIN.r;
const H = PITCH.width * S + MARGIN.t + MARGIN.b;

export const FRAME_SIZE = { width: W, height: H, scale: S, margin: MARGIN };

// Jogo: y cresce para cima. Imagem: y cresce para baixo. Invertemos aqui.
const sx = (x) => MARGIN.l + x * S;
const sy = (y) => MARGIN.t + (PITCH.width - y) * S;

function drawPitch(g) {
  // Faixas de corte de grama (só ajuda a leitura visual)
  const stripes = 10;
  const stripeW = PITCH.length / stripes;
  for (let i = 0; i < stripes; i++) {
    g.rect(sx(i * stripeW), sy(PITCH.width), stripeW * S, PITCH.width * S,
      i % 2 ? COLORS.grassAlt : COLORS.grass);
  }

  // Grade de coordenadas a cada 20 cm
  for (let x = 20; x < PITCH.length; x += 20) {
    g.line(sx(x), sy(PITCH.width), sx(x), sy(0), COLORS.grid, 1, 0.13);
  }
  for (let y = 20; y < PITCH.width; y += 20) {
    g.line(sx(0), sy(y), sx(PITCH.length), sy(y), COLORS.grid, 1, 0.13);
  }

  const L = COLORS.line;
  // Linhas de fundo e laterais
  g.line(sx(0), sy(0), sx(PITCH.length), sy(0), L, 2);
  g.line(sx(0), sy(PITCH.width), sx(PITCH.length), sy(PITCH.width), L, 2);
  g.line(sx(0), sy(0), sx(0), sy(PITCH.width), L, 2);
  g.line(sx(PITCH.length), sy(0), sx(PITCH.length), sy(PITCH.width), L, 2);

  // Meio de campo
  g.line(sx(PITCH.length / 2), sy(0), sx(PITCH.length / 2), sy(PITCH.width), L, 2);
  g.ring(sx(PITCH.length / 2), sy(PITCH.width / 2), PITCH.centerCircle * S, L, 2);
  g.circle(sx(PITCH.length / 2), sy(PITCH.width / 2), 3, L);

  // Grandes áreas
  for (const side of [0, 1]) {
    const x0 = side === 0 ? 0 : PITCH.length - PITCH.areaLength;
    g.strokeRect(sx(x0), sy(PITCH.areaMax), PITCH.areaLength * S, PITCH.areaWidth * S, L, 2);
    const spot = side === 0 ? PITCH.penaltySpot : PITCH.length - PITCH.penaltySpot;
    g.circle(sx(spot), sy(PITCH.width / 2), 3, L);
  }

  // Gols: rede atrás da linha + traves
  for (const side of [0, 1]) {
    const gx = side === 0 ? sx(0) - PITCH.goalDepth * S : sx(PITCH.length);
    g.rect(gx, sy(PITCH.goalMax), PITCH.goalDepth * S, PITCH.goalWidth * S, COLORS.net);
    for (let i = 1; i < PITCH.goalDepth; i += 2)
      g.line(gx + i * S, sy(PITCH.goalMax), gx + i * S, sy(PITCH.goalMin), [70, 78, 90], 1, 0.7);
    g.strokeRect(gx, sy(PITCH.goalMax), PITCH.goalDepth * S, PITCH.goalWidth * S, L, 2);
    const px = side === 0 ? 0 : PITCH.length;
    g.circle(sx(px), sy(PITCH.goalMin), 1.3 * S, COLORS.post, [120, 100, 30], 1);
    g.circle(sx(px), sy(PITCH.goalMax), 1.3 * S, COLORS.post, [120, 100, 30], 1);
  }

  // De quem é cada gol: A defende x=0, B defende x=200.
  g.text('GOL A', sx(3), sy(PITCH.goalMax + 4), 2, COLORS.A);
  g.text('GOL B', sx(PITCH.length - 25), sy(PITCH.goalMax + 4), 2, COLORS.B);
}

function drawAxes(g) {
  // Eixo X embaixo, eixo Y à esquerda — em centímetros.
  for (let x = 0; x <= PITCH.length; x += 20) {
    g.textCenter(String(x), sx(x), H - MARGIN.b + 8, 2, COLORS.dim);
  }
  for (let y = 0; y <= PITCH.width; y += 20) {
    const s = String(y);
    g.text(s, MARGIN.l - 8 - TEXT_W(s, 2), sy(y) - 5, 2, COLORS.dim);
  }
  g.text('X (cm) ->', W - MARGIN.r - 62, H - MARGIN.b + 8, 2, COLORS.dim);
  g.text('Y', 8, MARGIN.t - 14, 2, COLORS.dim);
}

function drawHeader(g, scene) {
  const y = 12;
  const nameA = (scene.teamAName || 'TIME A').slice(0, 12);
  const nameB = (scene.teamBName || 'TIME B').slice(0, 12);
  const placar = `${nameA} ${scene.scoreA ?? 0} - ${scene.scoreB ?? 0} ${nameB}`;
  g.textCenter(placar, W / 2, y + 6, 3, COLORS.text);

  // Marcadores de time nos cantos, para associar cor <-> lado
  g.circle(22, y + 6, 8, COLORS.A, [255, 255, 255], 2);
  g.text('A', 36, y + 1, 2, COLORS.A);
  g.circle(W - 22, y + 6, 8, COLORS.B, [255, 255, 255], 2);
  g.text('B', W - 48, y + 1, 2, COLORS.B);

  const linha2 = [];
  if (scene.turnNo != null) linha2.push(`TURNO ${scene.turnNo}`);
  if (scene.possession) linha2.push(`POSSE ${scene.possession}`);
  if (scene.touchIndex != null) {
    linha2.push(scene.touchesPerPossession > 0
      ? `TOQUE ${scene.touchIndex + 1}/${scene.touchesPerPossession}`
      : `TOQUE ${scene.touchIndex + 1}`);
  }
  if (scene.fase === 'goleiro') linha2.push('POSICIONANDO O GOLEIRO');
  else if (scene.declarado) linha2.push('CHUTE DECLARADO');
  if (scene.phase) linha2.push(String(scene.phase).toUpperCase());
  if (linha2.length) g.textCenter(linha2.join('  -  '), W / 2, y + 26, 2, COLORS.dim);

  if (scene.message) {
    g.textCenter(String(scene.message).slice(0, 52), W / 2, H - 13, 2, COLORS.highlight);
  }
}

function drawAttackArrow(g, scene) {
  if (!scene.possession) return;
  const atkA = scene.possession === 'A';
  const dir = atkA ? 1 : -1;
  const color = atkA ? COLORS.A : COLORS.B;
  const yLine = sy(PITCH.width - 7);
  const label = `ATACA ${scene.possession}`;
  const lw = TEXT_W(label, 2);
  const cx = sx(PITCH.length / 2);
  g.rect(cx - lw / 2 - 44, yLine - 10, lw + 88, 20, [0, 0, 0], 0.38);
  g.text(label, cx - lw / 2, yLine - 5, 2, color);
  const ax = atkA ? cx + lw / 2 + 8 : cx - lw / 2 - 8;
  g.arrow(ax, yLine, ax + dir * 30, yLine, color, 2);
}

function drawBodies(g, scene) {
  const active = new Set(scene.activeButtons || []);

  for (const b of scene.bodies) {
    if (b.kind === 'post') continue;
    const cx = sx(b.x), cy = sy(b.y), r = b.r * S;

    if (b.kind === 'ball') {
      // Bola no alto: sombra no chão e bola maior. É como a IA percebe altura
      // numa vista de cima.
      const z = b.z || 0;
      if (z > 0.3) {
        const esc = 1 + z * 0.16;
        g.circle(cx + z * 0.9, cy + z * 1.4, r * esc, [0, 0, 0]);
        g.ring(cx, cy, r * esc + 2, COLORS.previsao, 1);
      }
      const rr = r * (1 + z * 0.09);
      g.circle(cx, cy, rr + 1.5, COLORS.ballEdge);
      g.circle(cx, cy, rr, COLORS.ball);
      continue;
    }

    const base = b.team === 'A' ? COLORS.A : COLORS.B;
    const dark = b.team === 'A' ? COLORS.ADark : COLORS.BDark;

    // Goleiro: caixa de fósforo, retangular e girada.
    if (b.forma === 'caixa') {
      const ang = -(b.ang || 0);            // imagem tem y invertido
      g.rotRect(cx + 2, cy + 3, b.w * S, b.h * S, ang, [0, 0, 0]);
      g.rotRect(cx, cy, b.w * S, b.h * S, ang, dark, base, 2.5);
      g.textCenter('G', cx, cy, 3, [255, 255, 255]);
      continue;
    }

    // Sombra, para o disco "levantar" da mesa
    g.circle(cx + 2, cy + 3, r, [0, 0, 0], null, 0);

    if (active.has(b.id)) g.ring(cx, cy, r + 4, COLORS.highlight, 3);
    g.circle(cx, cy, r, base, dark, 2);
    g.textCenter(String(b.label).replace(/^[AB]/, ''), cx, cy, 3, [255, 255, 255]);
  }

  if (scene.lastShot && !scene.palheta) {
    const { from, to } = scene.lastShot;
    g.arrow(sx(from.x), sy(from.y), sx(to.x), sy(to.y), COLORS.highlight, 2);
  }
}

/**
 * Desenha a palheta apoiada no aro do botão, mais a previsão do lance.
 * Aparece no frame que a IA recebe: ela vê a própria mira antes de apertar.
 */
function drawPalheta(g, scene) {
  const p = scene.palheta;
  if (!p || !p.apoio) return;

  const botao = scene.bodies.find((b) => b.id === p.buttonId);
  if (!botao) return;

  const bx = sx(botao.x), by = sy(botao.y);
  const ax = sx(p.apoio.x), ay = sy(p.apoio.y);
  const cor = p.escorregou ? COLORS.B : p.cavada ? [140, 220, 255] : COLORS.highlight;

  // Trajeto previsto do disco.
  if (p.previsao) {
    const rad = (-p.direcao * Math.PI) / 180;   // -y na imagem
    const dx = Math.cos(rad), dy = Math.sin(rad);
    const alcance = p.previsao.corridaDisco * S;
    g.line(bx, by, bx + dx * alcance, by + dy * alcance, cor, 2, 0.5);
    g.ring(bx + dx * alcance, by + dy * alcance, 4, cor, 1);

    // Trajeto previsto da bola, se o disco chegar nela.
    if (p.previsao.alcancaBola && p.previsao.bola) {
      const bola = scene.bodies.find((b) => b.kind === 'ball');
      if (bola) {
        const br = (-p.previsao.bola.direcao * Math.PI) / 180;
        const alv = p.previsao.bola.corrida * S;
        g.line(sx(bola.x), sy(bola.y),
               sx(bola.x) + Math.cos(br) * alv, sy(bola.y) + Math.sin(br) * alv,
               COLORS.previsao || [130, 230, 165], 2, 0.85);
      }
    }
  }

  // A palheta: uma cunha apoiada no aro, apontando para fora do botão.
  const aro = (-p.palheta.anguloAro * Math.PI) / 180;
  const fora = { x: Math.cos(aro), y: Math.sin(aro) };
  const lado = { x: -fora.y, y: fora.x };
  const comp = 13 + p.palheta.forca * 12;              // força = palheta maior
  const larg = 4 + (1 - p.palheta.inclinacao / 90) * 5; // deitada = mais larga na vista de cima

  const p1 = { x: ax + lado.x * larg, y: ay + lado.y * larg };
  const p2 = { x: ax - lado.x * larg, y: ay - lado.y * larg };
  const p3 = { x: ax + fora.x * comp, y: ay + fora.y * comp };
  g.line(p1.x, p1.y, p2.x, p2.y, cor, 3);
  g.line(p1.x, p1.y, p3.x, p3.y, cor, 2);
  g.line(p2.x, p2.y, p3.x, p3.y, cor, 2);
  g.circle(ax, ay, 2.5, cor);

  // Quem está segurando.
  if (p.playerName) {
    const txt = String(p.playerName).slice(0, 16).toUpperCase();
    const w = TEXT_W(txt, 2);
    const tx = Math.min(W - MARGIN.r - w, Math.max(MARGIN.l, bx - w / 2));
    const ty = by - botao.r * S - 22;
    g.rect(tx - 5, ty - 4, w + 10, 17, [0, 0, 0], 0.55);
    g.text(txt, tx, ty, 2, cor);
  }
}

/**
 * Desenha a cena e devolve o buffer PNG.
 * @param {object} scene ver docs/API.md -> "frame"
 */
export function renderScene(scene) {
  const g = new Surface(W, H, COLORS.table);
  drawPitch(g);
  drawAxes(g);
  drawBodies(g, scene);
  drawPalheta(g, scene);
  drawAttackArrow(g, scene);
  drawHeader(g, scene);
  return g.toPNG();
}

export function renderSceneDataUri(scene) {
  return 'data:image/png;base64,' + renderScene(scene).toString('base64');
}
