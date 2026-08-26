// Gera o frame a partir de uma partida de verdade, para conferir o desenho.
import fs from 'node:fs';
import { createGame, startGame, sceneOf, declararChute, posicionarGoleiro, goleiroDe } from '../server/game.js';
import { renderScene, FRAME_SIZE } from '../server/render.js';
import { resolverPalheta, pontoDeApoio, preverLance } from '../server/palheta.js';
import { PITCH } from '../server/config.js';

const g = createGame({
  name: 'Frame', teamAName: 'Azuis', teamBName: 'Vermelhos',
  slotsA: 1, slotsB: 1, config: { buttonsPerTeam: 5 },
});
g.teams.A.players.push('a1');
g.teams.B.players.push('b1');
startGame(g);
g.teams.A.score = 2;
g.teams.B.score = 1;
g.turnNo = 22;

// Bola no ataque, chute declarado, goleiro puxado para um canto.
const bola = g.bodies.find((b) => b.kind === 'ball');
bola.x = 150; bola.y = 66;
const a5 = g.bodies.find((b) => b.id === 'A5');
a5.x = 140; a5.y = 60;

// A bola já rolou nesta partida imaginária: sem isso não se declara.
g.reinicio = null;
g.fase = 'jogada';
g.cobranca = null;
declararChute(g, 'a1');
posicionarGoleiro(g, 'b1', { x: PITCH.length - 8, y: 52, anguloDeg: 75, confirmar: true });

// Palheta armada mirando a bola.
const dir = (Math.atan2(bola.y - a5.y, bola.x - a5.x) * 180) / Math.PI;
const conf = { anguloAro: dir + 180, inclinacao: 45, avanco: 0.35, forca: 0.7 };
const res = resolverPalheta(conf);
const apoio = pontoDeApoio(a5, conf.anguloAro, conf.avanco);
const previsao = preverLance(a5, res, g.bodies);

const cena = sceneOf(g, 'a1', 'CHUTE DECLARADO — goleiro posicionado');
cena.palheta = {
  playerName: 'claude-1', buttonId: 'A5', palheta: conf, apoio,
  direcao: res.direcao, rendimento: res.rendimento,
  escorregou: res.escorregou, cavada: res.cavada, previsao,
};

const png = renderScene(cena);
fs.writeFileSync('tests/frame.png', png);

const k = goleiroDe(g, 'B');
console.log('PNG', FRAME_SIZE.width + 'x' + FRAME_SIZE.height, (png.length / 1024).toFixed(1) + ' KB');
console.log('goleiro B: caixa', k.w + 'x' + k.h, 'em (' + k.x + ', ' + k.y + ') a', Math.round((k.ang * 180) / Math.PI) + '°');
console.log('previsão: alcança a bola?', previsao.alcancaBola, '| disco corre', previsao.corridaDisco, 'cm');
