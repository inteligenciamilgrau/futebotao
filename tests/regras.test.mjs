// Regras novas: a vez só passa por falta, sem contato, bola fora ou último
// toque do adversário. Goleiro-caixa posicionado pelo defensor.
import { createGame, startGame, applyMove, fullState, declararChute, posicionarGoleiro, goleiroDe, areaDoGoleiro, posicionarBotao, checkTimeout } from '../server/game.js';
import { PITCH } from '../server/config.js';

let fails = 0;
const ok = (n, c, i = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (i ? '  -> ' + i : '')); if (!c) fails++; };
const secao = (t) => console.log('\n== ' + t + ' ==');

function novaPartida(cfg = {}) {
  const g = createGame({ slotsA: 1, slotsB: 1, config: { buttonsPerTeam: 5, turnTimeoutMs: 9e6, maxTurns: 500, ...cfg } });
  g.teams.A.players.push('a1');
  g.teams.B.players.push('b1');
  startGame(g);
  return g;
}
const bola = (g) => g.bodies.find((b) => b.kind === 'ball');
const pega = (g, id) => g.bodies.find((b) => b.id === id);

/**
 * Planta o botão atrás da bola de modo que ela saia na direção `dirGraus`.
 * A bola sai pela reta centro-do-botão -> centro-da-bola, então o botão tem
 * que estar do lado oposto ao alvo.
 */
function armar(g, buttonId, dirGraus, recuo = 9) {
  const b = pega(g, buttonId), bl = bola(g);
  const rad = (dirGraus * Math.PI) / 180;
  const contato = { x: bl.x - Math.cos(rad) * 3.55, y: bl.y - Math.sin(rad) * 3.55 };
  b.x = contato.x - Math.cos(rad) * recuo;
  b.y = contato.y - Math.sin(rad) * recuo;
  return { x: b.x + Math.cos(rad) * 100, y: b.y + Math.sin(rad) * 100 };
}

/** Lança um botão na direção de um ponto. */
function joga(g, playerId, buttonId, alvo, forca = 0.6) {
  const b = pega(g, buttonId);
  const dir = (Math.atan2(alvo.y - b.y, alvo.x - b.x) * 180) / Math.PI;
  return applyMove(g, playerId, { buttonId, palheta: { anguloAro: dir + 180, inclinacao: 45, avanco: 0.35, forca } });
}

/**
 * Dá o primeiro toque da partida. Sem ele não se declara chute a gol: a saída
 * de bola é bola parada, e em bola parada não se declara.
 */
function esquentar(g) {
  const alvo = armar(g, 'A1', 0, 1.2);
  const r = joga(g, 'a1', 'A1', alvo, 0.25);
  if (g.possession !== 'A') throw new Error('o toque de aquecimento perdeu a posse: ' + r.result.outcome);
  return r;
}

secao('Goleiro é uma caixa fixa');
{
  const g = novaPartida();
  const k = goleiroDe(g, 'A');
  ok('goleiro tem forma de caixa', k.forma === 'caixa', k.forma);
  ok('caixa tem largura e espessura', k.w > k.h && k.h > 0, `${k.w} x ${k.h}`);
  ok('caixa é fixa', k.fixed === true && k.invM === 0);
  let erro = null;
  try { joga(g, 'a1', 'AG', bola(g)); } catch (e) { erro = e; }
  ok('não dá para lançar o goleiro', erro?.code === 'KEEPER_IS_BOX', erro?.message);
}

secao('A vez SEGUE quando a jogada é limpa');
{
  const g = novaPartida();
  const b = bola(g);
  const r = joga(g, 'a1', 'A1', { x: b.x + 30, y: b.y + 2 }, 0.35);
  ok('tocou na bola', r.result.touchedBall === true);
  ok('a posse NÃO passou', r.result.possessionChanged === false, r.result.outcome);
  ok('continua com o time A', g.possession === 'A' && g.currentPlayerId === 'a1');
  ok('o contador de toques subiu', g.touchIndex === 1, 'toque ' + g.touchIndex);
  ok('desfecho diz que segue', /segue com o time A/.test(r.result.outcome), r.result.outcome);
}

secao('Não encostar na bola entrega a posse');
{
  const g = novaPartida();
  const r = joga(g, 'a1', 'A2', { x: 10, y: 10 }, 0.2);
  ok('não tocou na bola', r.result.touchedBall === false);
  ok('a posse passou', r.result.possessionChanged === true, r.result.outcome);
  ok('motivo é falta de contato', r.result.motivo === 'sem_contato', r.result.motivo);
  ok('agora é a vez de B', g.possession === 'B');
}

secao('Falta: encostar no adversário antes da bola');
{
  const g = novaPartida();
  const a = pega(g, 'A3'), alvo = pega(g, 'B3');
  alvo.x = a.x + 12; alvo.y = a.y;
  const r = joga(g, 'a1', 'A3', { x: alvo.x + 20, y: alvo.y }, 0.7);
  ok('marcou falta', r.result.foul === true, r.result.outcome);
  ok('a posse passou', r.result.possessionChanged === true);
  ok('motivo é falta', r.result.motivo === 'falta', r.result.motivo);
}

secao('Bola fora pela lateral');
{
  const g = novaPartida();
  const alvo = armar(g, 'A1', 90);            // bola sai reto para cima
  const r = joga(g, 'a1', 'A1', alvo, 1.0);
  ok('a bola saiu', !!r.result.fora, JSON.stringify(r.result.fora));
  ok('foi pela lateral', r.result.fora?.linha === 'lateral', r.result.fora?.linha);
  ok('houve reposição', !!r.result.reposicao, r.result.reposicao?.tipo);
  ok('a posse passou para B', g.possession === 'B');
  ok('a bola voltou para dentro do campo',
    bola(g).x >= 0 && bola(g).x <= PITCH.length && bola(g).y >= 0 && bola(g).y <= PITCH.width,
    `(${bola(g).x.toFixed(1)}, ${bola(g).y.toFixed(1)})`);
}

secao('Cobrança depois de a bola sair');
{
  const g = novaPartida();
  const alvo = armar(g, 'A1', 90);
  const r = joga(g, 'a1', 'A1', alvo, 1.0);
  ok('a bola saiu', !!r.result.fora);
  ok('abriu a fase de cobrança', g.fase === 'cobranca', g.fase);
  ok('quem cobra é o time B', g.possession === 'B' && g.currentPlayerId === 'b1');

  const st = fullState(g, 'b1');
  ok('estado marca podeCobrar', st.podeCobrar === true);
  ok('estado não deixa jogar ainda', st.podeJogar === false && st.controllable.length === 0);
  ok('estado lista os botões posicionáveis', st.posicionaveis.length === 5, st.posicionaveis.join(','));
  ok('estado informa o tipo e o raio', st.cobranca?.tipo === 'lateral' && st.cobranca?.raio > 0,
    JSON.stringify(st.cobranca));

  let erro = null;
  try { joga(g, 'b1', 'B1', bola(g)); } catch (e) { erro = e; }
  ok('não dá para jogar antes de cobrar', erro?.code === 'NOT_PLACEMENT_PHASE' || erro?.code === 'NOT_YOUR_TURN', erro?.message);

  erro = null;
  try { posicionarBotao(g, 'b1', { buttonId: 'A1', x: bola(g).x, y: bola(g).y }); } catch (e) { erro = e; }
  ok('não dá para posicionar botão do adversário', erro?.code === 'NOT_YOUR_BUTTON', erro?.message);

  erro = null;
  try { posicionarBotao(g, 'b1', { buttonId: 'B1', x: 100, y: 60 }); } catch (e) { erro = e; }
  ok('longe demais da bola é recusado', erro?.code === 'PLACEMENT_TOO_FAR', erro?.message);

  erro = null;
  try { posicionarBotao(g, 'b1', { confirmar: true }); } catch (e) { erro = e; }
  ok('confirmar sem posicionar é recusado', erro?.code === 'NO_PLACEMENT', erro?.message);

  const bl = bola(g);
  const meio = posicionarBotao(g, 'b1', { buttonId: 'B2', x: bl.x + 5, y: bl.y - 3 });
  ok('posicionar perto da bola é aceito', meio.confirmado === false && meio.botao === 'B2');
  ok('o botão foi mesmo para lá', Math.hypot(pega(g, 'B2').x - (bl.x + 5), pega(g, 'B2').y - (bl.y - 3)) < 2.5,
    `(${pega(g, 'B2').x.toFixed(1)}, ${pega(g, 'B2').y.toFixed(1)})`);

  const fim = posicionarBotao(g, 'b1', { confirmar: true });
  ok('confirmar devolve a fase de jogada', g.fase === 'jogada' && fim.confirmado === true);
  ok('quem cobra continua com a vez', g.currentPlayerId === 'b1');
  ok('agora tem botões controláveis', fullState(g, 'b1').controllable.length === 5);
}

secao('Lateral: bola na linha, botão fora do campo');
{
  const g = novaPartida();
  esquentar(g);

  // Manda a bola para fora pela lateral de baixo.
  const bl = bola(g);
  bl.x = 100; bl.y = 5;
  const alvo = armar(g, 'A1', -90);
  const r = joga(g, 'a1', 'A1', alvo, 0.9);
  ok('a bola saiu pela lateral', r.result.reposicao?.tipo === 'lateral', r.result.outcome);

  const b2 = bola(g);
  ok('a bola descansa EM CIMA da linha', b2.y === 0 || b2.y === PITCH.width, String(b2.y));

  const cobrador = g.currentPlayerId;
  const st = fullState(g, cobrador);
  const id = st.posicionaveis[0];

  // O botão vai para FORA da linha, como se cobra de verdade.
  const posto = posicionarBotao(g, cobrador, { buttonId: id, x: b2.x, y: -6 });
  ok('o botão pode ficar fora do campo', posto.confirmado === false, JSON.stringify(posto.botoes));
  ok('e ficou mesmo lá fora', pega(g, id).y < 0, String(pega(g, id).y));
  ok('marcado como fora do campo', pega(g, id).foraDoCampo === true);

  // O estado precisa CONTAR que existe faixa fora das linhas: sem isso o
  // cliente 3D lia undefined, virava zero, e prendia o arrasto na linha.
  const visto = fullState(g, cobrador);
  ok('o estado informa a margem de fora', visto.pitch.margemFora === PITCH.margemFora,
     String(visto.pitch.margemFora));

  let erro = null;
  try { posicionarBotao(g, cobrador, { buttonId: id, x: b2.x, y: -40 }); } catch (e) { erro = e; }
  ok('mas não pode cair da mesa', !!erro, erro?.code + ' ' + erro?.message);

  // Cobra: o botão entra e traz a bola de volta ao jogo.
  posicionarBotao(g, cobrador, { buttonId: id, x: b2.x - 4, y: -5 });
  posicionarBotao(g, cobrador, { confirmar: true });
  const antes = { ...pega(g, id) };
  const lance = joga(g, cobrador, id, { x: b2.x + 20, y: 60 }, 0.5);
  ok('o lance foi aceito', !!lance.result, lance.result?.outcome);
  ok('o botão entrou no campo', pega(g, id).y > 0, `${antes.y} -> ${pega(g, id).y}`);
  // A linha não prende o botão em momento nenhum: ele entra e sai à vontade,
  // o que segura é a beirada da mesa.
  const dele = pega(g, id);
  ok('e continua na mesa', dele.y >= -PITCH.margemFora && dele.y <= PITCH.width + PITCH.margemFora,
     'y=' + dele.y.toFixed(1));
}

secao('Último toque no adversário entrega a posse');
{
  const g = novaPartida();
  const b = bola(g);
  const alvo = pega(g, 'B4');
  alvo.x = b.x + 14; alvo.y = b.y;
  const r = joga(g, 'a1', 'A1', { x: b.x + 30, y: b.y }, 0.55);
  if (r.result.ultimoToqueBola?.team === 'B') {
    ok('a bola tocou por último no adversário', true, r.result.ultimoToqueBola.id);
    ok('a posse passou', r.result.possessionChanged === true, r.result.outcome);
    ok('motivo é último toque', r.result.motivo === 'ultimo_toque', r.result.motivo);
  } else {
    ok('a bola tocou por último no adversário', false, JSON.stringify(r.result.ultimoToqueBola));
  }
}

secao('Gol só vale se foi declarado');
{
  const g = novaPartida();
  const b = bola(g);
  const k = goleiroDe(g, 'B');
  k.y = PITCH.goalMin - 12;
  b.x = PITCH.length - 30; b.y = 60;
  const a = pega(g, 'A1');
  a.x = b.x - 6; a.y = 60;

  const r = joga(g, 'a1', 'A1', { x: PITCH.length + 20, y: 60 }, 0.9);
  ok('a bola entrou', !!r.result.goalAnulado || !!r.result.goal,
    JSON.stringify(r.result.goalAnulado || r.result.goal));
  ok('sem declarar, o gol é anulado', !r.result.goal && !!r.result.goalAnulado, r.result.outcome);
  ok('placar continua zerado', g.teams.A.score === 0, `${g.teams.A.score}`);
  ok('sai tiro de meta', r.result.reposicao?.tipo === 'tiro de meta', r.result.reposicao?.tipo);
}

secao('Gol contra conta para o adversário, mesmo sem declaração');
{
  const g = novaPartida();
  const bola = g.bodies.find((b) => b.kind === 'ball');
  const gk = goleiroDe(g, 'A');
  gk.y = 20;                                  // tira a caixa do caminho
  bola.x = 30; bola.y = 60;
  const a1 = pega(g, 'A1');
  a1.x = 30 + 3.55 + 8; a1.y = 60;

  // O time A manda a bola para o PRÓPRIO gol (x=0). Não declarou nada — e nem
  // faria sentido declarar: declaração é para o gol que você TENTA fazer.
  const r = joga(g, 'a1', 'A1', { x: -100, y: 60 }, 0.9);
  ok('marcou gol contra', !!r.result.goal && r.result.goal.ownGoal === true,
    r.result.outcome + ' ' + JSON.stringify(r.result.goalAnulado || ''));
  ok('o gol NÃO foi anulado por falta de declaração', !r.result.goalAnulado, JSON.stringify(r.result.goalAnulado));
  ok('o ponto foi para o adversário', g.teams.B.score === 1 && g.teams.A.score === 0,
    `A ${g.teams.A.score} x ${g.teams.B.score} B`);
  ok('a saída de bola é de quem levou', g.possession === 'A', g.possession);
}

secao('Fluxo da declaração e do goleiro');
{
  const g = novaPartida();
  ok('começa arrumando a saída de bola', g.fase === 'cobranca' && g.cobranca.opcional === true, g.fase);
  ok('mas dá para bater sem arrumar nada', fullState(g, 'a1').podeJogar === true);
  esquentar(g);
  ok('bater fecha a fase sozinho', g.fase === 'jogada', g.fase);

  const d = declararChute(g, 'a1');
  ok('declarar muda a fase', g.fase === 'goleiro', g.fase);
  ok('a vez passa para o defensor', g.currentPlayerId === 'b1', g.currentPlayerId);
  ok('devolve o defensor', d.defensor === 'b1');

  let erro = null;
  try { joga(g, 'a1', 'A1', bola(g)); } catch (e) { erro = e; }
  ok('o atacante não pode jogar enquanto isso', erro?.code === 'NOT_YOUR_TURN', erro?.message);

  erro = null;
  try { posicionarGoleiro(g, 'a1', { x: 10, y: 60 }); } catch (e) { erro = e; }
  ok('o atacante não posiciona o goleiro do rival', erro?.code === 'NOT_YOUR_TURN', erro?.message);

  const area = areaDoGoleiro('B');
  erro = null;
  try { posicionarGoleiro(g, 'b1', { x: 100, y: 60 }); } catch (e) { erro = e; }
  ok('fora da área é recusado', erro?.code === 'KEEPER_OUT_OF_AREA', erro?.message);

  const meio = posicionarGoleiro(g, 'b1', { x: area.xMax - 6, y: 52, anguloDeg: 90 });
  ok('mover sem confirmar mantém a fase', meio.confirmado === false && g.fase === 'goleiro');
  ok('a caixa foi para onde pediram', Math.abs(goleiroDe(g, 'B').y - 52) < 0.01, String(goleiroDe(g, 'B').y));

  const fim = posicionarGoleiro(g, 'b1', { confirmar: true });
  ok('confirmar devolve a vez ao atacante', g.fase === 'jogada' && g.currentPlayerId === 'a1', g.currentPlayerId);
  ok('o turnToken foi renovado', typeof fim.turnToken === 'string' && fim.turnToken !== d.turnToken);
  ok('a declaração continua valendo', g.declarado === true);
}

secao('Gol declarado conta');
{
  const g = novaPartida();
  esquentar(g);
  const b = bola(g);
  b.x = PITCH.length - 30; b.y = 60;
  const a = pega(g, 'A1');
  a.x = b.x - 6; a.y = 60;

  declararChute(g, 'a1');
  // Defensor cobre a metade de baixo da boca (y 42..58).
  posicionarGoleiro(g, 'b1', { x: PITCH.length - 8, y: 50, anguloDeg: 90, confirmar: true });
  // Atacante manda a bola para y=68 na linha: acima da caixa, dentro do gol.
  const dir = (Math.atan2(68 - 60, PITCH.length - 170) * 180) / Math.PI;
  const alvo = armar(g, 'A1', dir);
  const r = joga(g, 'a1', 'A1', alvo, 0.9);
  ok('gol declarado conta', !!r.result.goal, r.result.outcome);
  ok('placar subiu', g.teams.A.score === 1, `${g.teams.A.score}`);
  ok('volta para o tiro de meio com B', g.possession === 'B');
  ok('a declaração foi consumida', g.declarado === false);
}

secao('Declaração vale por um chute só');
{
  const g = novaPartida();
  esquentar(g);

  // Longe do gol, para o chute declarado NÃO entrar e a jogada ser limpa.
  const b = bola(g);
  b.x = 60; b.y = 60;
  const a = pega(g, 'A1');
  a.x = b.x - 6; a.y = 60;

  declararChute(g, 'a1');
  const areaB = areaDoGoleiro('B');
  posicionarGoleiro(g, 'b1', { x: areaB.xMax - 6, y: 50, anguloDeg: 90, confirmar: true });
  ok('a declaração está de pé', g.declarado === true);
  const ondeFicou = { ...goleiroDe(g, 'B') };

  // Chuta para o meio do campo: toque limpo, sem gol, a posse segue com o A.
  const alvo = armar(g, 'A1', 20);
  const r = joga(g, 'a1', 'A1', alvo, 0.4);
  ok('não foi gol', !r.result.goal, r.result.outcome);
  ok('a posse seguiu com o A', g.possession === 'A' && g.currentPlayerId === 'a1', r.result.outcome);

  ok('a declaração foi consumida', g.declarado === false, String(g.declarado));
  ok('o resultado avisa', r.result.declaracaoConsumida === true, r.result.outcome);
  ok('e quem declarou também some', g.declaradoPor === null, String(g.declaradoPor));
  ok('o estado deixa declarar de novo', fullState(g, 'a1').podeDeclarar === true);

  // A caixa fica onde o defensor a deixou: quem decide se ela sai de lá é ele,
  // na próxima declaração.
  const agora = goleiroDe(g, 'B');
  ok('a caixa NÃO se mexeu sozinha', Math.abs(agora.x - ondeFicou.x) < 0.01 && Math.abs(agora.y - ondeFicou.y) < 0.01,
    `${ondeFicou.x},${ondeFicou.y} -> ${agora.x},${agora.y}`);

  // Segundo chute declarado: o defensor arruma a caixa de novo.
  const d2 = declararChute(g, 'a1');
  ok('dá para declarar outra vez', g.fase === 'goleiro' && d2.defensor === 'b1', g.fase);
  ok('e a vez volta a ser do defensor', g.currentPlayerId === 'b1', g.currentPlayerId);

  // O defensor pode simplesmente confirmar e manter a caixa onde ela já está.
  posicionarGoleiro(g, 'b1', { confirmar: true });
  const mantida = goleiroDe(g, 'B');
  ok('confirmar sem mexer mantém a caixa', Math.abs(mantida.x - ondeFicou.x) < 0.01 && Math.abs(mantida.y - ondeFicou.y) < 0.01,
    `${mantida.x},${mantida.y}`);
}

secao('Gol declarado não fica valendo para o lance seguinte');
{
  const g = novaPartida();
  esquentar(g);
  const b = bola(g);
  b.x = 60; b.y = 60;
  pega(g, 'A1').x = b.x - 6; pega(g, 'A1').y = 60;

  declararChute(g, 'a1');
  posicionarGoleiro(g, 'b1', { confirmar: true });
  joga(g, 'a1', 'A1', armar(g, 'A1', 20), 0.4);   // chute declarado sem gol

  // Agora empurra a bola para dentro do gol SEM declarar: tem que ser anulado.
  const bl = bola(g);
  bl.x = PITCH.length - 30; bl.y = 60;
  const gk = goleiroDe(g, 'B');
  gk.y = PITCH.goalMin - 12;
  const a1 = pega(g, 'A1');
  a1.x = bl.x - 6; a1.y = 60;

  const r = joga(g, 'a1', 'A1', { x: PITCH.length + 20, y: 60 }, 0.9);
  ok('a bola entrou', !!r.result.goal || !!r.result.goalAnulado, r.result.outcome);
  ok('mas o gol foi anulado', !r.result.goal && !!r.result.goalAnulado, r.result.outcome);
  ok('o placar não subiu', g.teams.A.score === 0, String(g.teams.A.score));
}

secao('O goleiro barra de verdade');
{
  const g = novaPartida();
  esquentar(g);
  const b = bola(g);
  b.x = PITCH.length - 30; b.y = 60;
  const a = pega(g, 'A1');
  a.x = b.x - 6; a.y = 60;

  declararChute(g, 'a1');
  // Caixa bem no meio da boca, atravessada.
  posicionarGoleiro(g, 'b1', { x: PITCH.length - 6, y: 60, anguloDeg: 90, confirmar: true });
  const alvo = armar(g, 'A1', 0);
  const r = joga(g, 'a1', 'A1', alvo, 0.9);
  ok('chute no meio bate no goleiro', !r.result.goal, r.result.outcome);
  ok('placar não subiu', g.teams.A.score === 0, `${g.teams.A.score}`);
}

secao('Sem limite: a vez só passa pelas regras');
{
  // É exatamente o que o formulário manda com as duas caixas marcadas.
  const g = createGame({ slotsA: 1, slotsB: 1, config: {
    buttonsPerTeam: 5,
    maxTurns: 0, maxPossessions: 0, touchesPerPossession: 0,
    turnTimeoutMs: 0, tempoGoleiroMs: 0, tempoCobrancaMs: 0,
  } });
  g.teams.A.players.push('a1');
  g.teams.B.players.push('b1');
  startGame(g);

  ok('sem prazo no turno', g.turnDeadline === null, String(g.turnDeadline));
  ok('checkTimeout não faz nada sem prazo', checkTimeout(g) === null);
  ok('a vez continua com quem começou', g.currentPlayerId === 'a1');

  // Muitas jogadas limpas seguidas: a posse não pode virar por contagem.
  // O botão fica COLADO na bola e o toque aponta para o meio do campo, para o
  // lance ser limpo — o que testamos aqui é a contagem, não a mira.
  let jogadas = 0;
  let motivoDaVirada = null;
  for (let i = 0; i < 12 && g.status === 'running' && g.possession === 'A'; i++) {
    const st = fullState(g, g.currentPlayerId);
    if (!st.podeJogar || !st.controllable.length) break;
    const bl = bola(g);
    const paraOMeio = (Math.atan2(60 - bl.y, 100 - bl.x) * 180) / Math.PI;
    const alvo = armar(g, st.controllable[0], paraOMeio, 1.2);
    const r = joga(g, 'a1', st.controllable[0], alvo, 0.3);
    jogadas++;
    if (r.result.possessionChanged) { motivoDaVirada = r.result.motivo; break; }
    ok('toque ' + jogadas + ' manteve a posse', g.possession === 'A' && g.currentPlayerId === 'a1',
      r.result.outcome);
  }
  if (motivoDaVirada) {
    ok('se a posse virou, foi por um motivo das regras',
      ['falta', 'sem_contato', 'bola_fora', 'ultimo_toque', 'gol'].includes(motivoDaVirada), motivoDaVirada);
  }
  ok('jogou várias vezes seguidas sem trocar por contagem', jogadas >= 4, jogadas + ' jogadas');
  ok('o contador de toques passou de 3 sem virar a posse',
     g.touchIndex >= 3 || motivoDaVirada !== null, 'toque ' + g.touchIndex);
  ok('a partida não terminou por relógio', g.status === 'running' || g.turnNo > 12,
    'status=' + g.status + ' turno=' + g.turnNo);

  // Prazo do goleiro também é ilimitado.
  if (g.status === 'running' && g.possession === 'A' && g.fase === 'jogada') {
    declararChute(g, 'a1');
    ok('fase do goleiro também fica sem prazo', g.turnDeadline === null, String(g.turnDeadline));
    ok('e o tempo não a resolve sozinha', checkTimeout(g) === null && g.fase === 'goleiro', g.fase);
  }
}

secao('Saída de bola: cada time monta o seu campo');
{
  const g = novaPartida();
  const stA = fullState(g, 'a1');
  const stB = fullState(g, 'b1');

  ok('os dois times podem arrumar', stA.podeCobrar === true && stB.podeCobrar === true);
  ok('a área é a de formação', stA.cobranca.area.tipo === 'formação', stA.cobranca.area.tipo);
  ok('o A monta na metade dele', stA.cobranca.area.campo.xMax === PITCH.length / 2,
    JSON.stringify(stA.cobranca.area.campo));
  ok('o B monta na metade dele', stB.cobranca.area.campo.xMin === PITCH.length / 2,
    JSON.stringify(stB.cobranca.area.campo));
  ok('cada um só arruma os botões do próprio time',
    stA.posicionaveis.every((id) => id.startsWith('A')) && stB.posicionaveis.every((id) => id.startsWith('B')),
    stA.posicionaveis.join(',') + ' | ' + stB.posicionaveis.join(','));

  ok('quem bate pode entrar no círculo', stA.cobranca.area.podeNoCirculo === true);
  ok('e o adversário não', stB.cobranca.area.podeNoCirculo === false);
  ok('o limite no círculo é dois', stA.cobranca.area.maxNoCirculo === 2, String(stA.cobranca.area.maxNoCirculo));
}

secao('O time que bate pode adiantar dois no círculo');
{
  const g = novaPartida();
  const centro = { x: PITCH.length / 2, y: PITCH.width / 2 };

  // Tira todo mundo do A do círculo, para contar do zero.
  for (const b of g.bodies) if (b.team === 'A' && b.kind === 'button') { b.x = 30; b.y = 20 + b.id.charCodeAt(1); }

  const r1 = posicionarBotao(g, 'a1', { buttonId: 'A1', x: centro.x - 6, y: centro.y - 4 });
  ok('o primeiro entra no círculo', r1.confirmado === false, JSON.stringify(r1.area?.usadosNoCirculo));
  posicionarBotao(g, 'a1', { buttonId: 'A2', x: centro.x - 4, y: centro.y + 7 });

  let erro = null;
  try { posicionarBotao(g, 'a1', { buttonId: 'A3', x: centro.x - 2, y: centro.y }); } catch (e) { erro = e; }
  ok('o terceiro no círculo é recusado', erro?.code === 'CIRCLE_LIMIT', erro?.message);

  // Fora do círculo, mas ainda na metade dele: vale.
  const livre = posicionarBotao(g, 'a1', { buttonId: 'A3', x: 40, y: 40 });
  ok('fora do círculo, no próprio campo, vale', livre.confirmado === false);

  erro = null;
  try { posicionarBotao(g, 'a1', { buttonId: 'A3', x: PITCH.length - 30, y: 60 }); } catch (e) { erro = e; }
  ok('passar para o campo do adversário é recusado', erro?.code === 'OUT_OF_HALF', erro?.message);
}

secao('O adversário monta o campo dele, fora do círculo');
{
  const g = novaPartida();
  const centro = { x: PITCH.length / 2, y: PITCH.width / 2 };

  const ok1 = posicionarBotao(g, 'b1', { buttonId: 'B1', x: PITCH.length - 40, y: 40 });
  ok('o B arruma sem ter a vez', ok1.formacao === true && ok1.team === 'B', JSON.stringify(ok1.team));
  ok('e o botão foi mesmo', Math.abs(pega(g, 'B1').x - (PITCH.length - 40)) < 3, String(pega(g, 'B1').x));

  let erro = null;
  try { posicionarBotao(g, 'b1', { buttonId: 'B2', x: centro.x + 6, y: centro.y }); } catch (e) { erro = e; }
  ok('o B não entra no círculo', erro?.code === 'CIRCLE_IS_THEIRS', erro?.message);

  erro = null;
  try { posicionarBotao(g, 'b1', { buttonId: 'B2', x: 40, y: 60 }); } catch (e) { erro = e; }
  ok('nem passa para o campo do A', erro?.code === 'OUT_OF_HALF', erro?.message);

  erro = null;
  try { posicionarBotao(g, 'b1', { buttonId: 'A1', x: PITCH.length - 40, y: 60 }); } catch (e) { erro = e; }
  ok('nem mexe em botão do adversário', erro?.code === 'NOT_YOUR_BUTTON', erro?.message);
}

secao('Pronto do adversário não tira a vez de ninguém');
{
  const g = novaPartida();
  const r = posicionarBotao(g, 'b1', { confirmar: true });
  ok('o B diz que está pronto', r.confirmado === true && r.formacao === true);
  ok('a fase continua de formação', g.fase === 'cobranca', g.fase);
  ok('e a vez segue com quem bate', g.currentPlayerId === 'a1', g.currentPlayerId);
  ok('o B não arruma mais', fullState(g, 'b1').podeCobrar === false);
  ok('mas o A ainda arruma', fullState(g, 'a1').podeCobrar === true);

  let erro = null;
  try { posicionarBotao(g, 'b1', { buttonId: 'B2', x: PITCH.length - 40, y: 60 }); } catch (e) { erro = e; }
  ok('depois de pronto, o B é recusado', erro?.code === 'ALREADY_READY', erro?.message);

  esquentar(g);
  ok('quem bate encerra a formação jogando', g.fase === 'jogada', g.fase);
}

secao('Em bola parada não se declara chute a gol');
{
  const g = novaPartida();
  ok('a saída de bola é marcada como recomeço', g.reinicio === 'saída de bola', String(g.reinicio));
  ok('o estado avisa que não dá para declarar', fullState(g, 'a1').podeDeclarar === false);

  let erro = null;
  try { declararChute(g, 'a1'); } catch (e) { erro = e; }
  ok('declarar na saída de bola é recusado', erro?.code === 'CANNOT_DECLARE_ON_RESTART', erro?.message);
  ok('e a declaração não pegou', g.declarado === false && g.fase !== 'goleiro', g.fase);

  esquentar(g);
  ok('depois do primeiro toque o recomeço acaba', g.reinicio === null, String(g.reinicio));
  ok('e aí dá para declarar', fullState(g, 'a1').podeDeclarar === true);
  declararChute(g, 'a1');
  ok('declarou de verdade', g.fase === 'goleiro');
}

secao('Nem na cobrança de lateral');
{
  const g = novaPartida();
  esquentar(g);

  // Manda a bola para fora pela lateral: quem cobra é o time B.
  const bl = bola(g);
  bl.x = 100; bl.y = PITCH.width - 6;
  const alvo = armar(g, 'A1', 90);
  const r = joga(g, 'a1', 'A1', alvo, 0.9);
  ok('a bola saiu', !!r.result.reposicao, r.result.outcome);
  ok('abriu a cobrança', g.fase === 'cobranca', g.fase);
  ok('o recomeço tem o nome da cobrança', typeof g.reinicio === 'string' && g.reinicio.length > 0, String(g.reinicio));

  const cobrador = g.currentPlayerId;
  let erro = null;
  try { declararChute(g, cobrador); } catch (e) { erro = e; }
  ok('declarar na cobrança é recusado', erro?.code === 'CANNOT_DECLARE_ON_RESTART', erro?.code + ': ' + erro?.message);

  // Posiciona e cobra: só DEPOIS disso a declaração libera.
  const st = fullState(g, cobrador);
  const b2 = bola(g);
  const ang = Math.atan2(60 - b2.y, 100 - b2.x);
  posicionarBotao(g, cobrador, { buttonId: st.posicionaveis[0], x: b2.x + Math.cos(ang) * 4.5, y: b2.y + Math.sin(ang) * 4.5 });
  posicionarBotao(g, cobrador, { confirmar: true });
  ok('ainda em recomeço logo depois de posicionar', g.reinicio !== null, String(g.reinicio));

  erro = null;
  try { declararChute(g, g.currentPlayerId); } catch (e) { erro = e; }
  ok('e continua recusando até a bola rolar', erro?.code === 'CANNOT_DECLARE_ON_RESTART', erro?.code);
}

secao('A palheta volta como estava antes de declarar');
{
  const g = novaPartida();
  esquentar(g);

  // O jogador miou e o servidor guardou a última mira dele.
  const minhaMira = { anguloAro: 137, inclinacao: 62, avanco: 0.71, forca: 0.83 };
  g.lastAim = { gameId: g.id, playerId: 'a1', buttonId: 'A3', turnNo: g.turnNo, palheta: { ...minhaMira } };

  declararChute(g, 'a1');
  ok('a mira foi guardada ao declarar', !!g.miraGuardada && g.miraGuardada.buttonId === 'A3');

  const fim = posicionarGoleiro(g, 'b1', { confirmar: true });
  ok('confirmar o goleiro devolve a mira', !!fim.miraGuardada, JSON.stringify(fim.miraGuardada || null));
  ok('com a palheta idêntica',
    JSON.stringify(fim.miraGuardada.palheta) === JSON.stringify(minhaMira),
    JSON.stringify(fim.miraGuardada?.palheta));
  ok('e com o mesmo botão', fim.miraGuardada.buttonId === 'A3', fim.miraGuardada?.buttonId);
  ok('a mira corrente do jogo volta a ser a guardada',
    g.lastAim?.palheta?.inclinacao === 62 && g.lastAim?.restaurada === true,
    JSON.stringify(g.lastAim?.palheta || null));

  // Mira de outro jogador não é restaurada: cada um com a sua.
  const g2 = novaPartida();
  esquentar(g2);
  g2.lastAim = { gameId: g2.id, playerId: 'b1', buttonId: 'B1', turnNo: g2.turnNo, palheta: { ...minhaMira } };
  declararChute(g2, 'a1');
  ok('mira do adversário não é guardada', g2.miraGuardada === null, JSON.stringify(g2.miraGuardada));
}

secao('Prazo zero não vira timeout instantâneo');
{
  const g = novaPartida({ turnTimeoutMs: 0 });
  ok('prazo nulo, não Date.now()', g.turnDeadline === null, String(g.turnDeadline));
  const antes = g.turnNo;
  checkTimeout(g);
  ok('o turno não avança sozinho', g.turnNo === antes, `${antes} -> ${g.turnNo}`);
}

secao('Relógio por turnos');
{
  const g = novaPartida({ maxTurns: 3 });
  let jogadas = 0;
  while (g.status === 'running' && jogadas < 10) {
    const st = fullState(g, g.currentPlayerId);
    if (!st.controllable.length) break;
    joga(g, g.currentPlayerId, st.controllable[0], bola(g), 0.4);
    jogadas++;
  }
  ok('a partida termina exatamente no limite de turnos', g.status === 'finished', `status=${g.status}`);
  ok('foram jogadas maxTurns jogadas', jogadas === 3, jogadas + ' jogadas, turno ' + g.turnNo);
}

console.log(fails === 0 ? '\nTUDO OK' : `\n${fails} FALHA(S)`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
