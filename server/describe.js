// Traduz o estado do jogo para texto compacto, pensado para consumo por LLM.
// Regras e formato de jogada NÃO entram aqui de propósito: vão no system prompt
// do bot, que é cacheável. Aqui vai só o que muda a cada turno.

import { PITCH } from './config.js';
import { teamOf, controllableButtons, perfil, areaDoGoleiro, goleiroDe, regiaoDeFormacao, raioCobranca } from './game.js';

const r1 = (v) => Math.round(v * 10) / 10;

/** Nome legível do jogador; para bots, com o modelo junto. */
function nomeJogador(playerId) {
  const p = perfil(playerId);
  if (!p) return '—';
  return p.model ? `${p.name} (${p.model})` : p.name;
}
const deg = (rad) => Math.round((rad * 180) / Math.PI);

/** Distância de um ponto ao segmento AB. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Distância do segmento até um RETÂNGULO ORIENTADO (o goleiro caixa).
 * Sem isto, usar o raio envolvente da caixa (8,31 cm) faria quase toda linha
 * parecer bloqueada — inclusive a bola->gol, escondendo a fresta ao lado da
 * caixa, que é justamente por onde se faz gol.
 */
function distSegmentoCaixa(from, to, caixa) {
  const cos = Math.cos(-caixa.ang), sin = Math.sin(-caixa.ang);
  const local = (px, py) => {
    const dx = px - caixa.x, dy = py - caixa.y;
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  };
  const a = local(from.x, from.y);
  const b = local(to.x, to.y);
  const hw = caixa.w / 2, hh = caixa.h / 2;

  // Distância de um ponto ao retângulo alinhado aos eixos, no referencial dele.
  const aoRetangulo = (p) => {
    const dx = Math.max(Math.abs(p.x) - hw, 0);
    const dy = Math.max(Math.abs(p.y) - hh, 0);
    return Math.hypot(dx, dy);
  };

  // Amostragem de 1 cm: a caixa é fina, então passo grosso a deixaria passar.
  const comp = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(2, Math.ceil(comp));
  let menor = Infinity;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const d = aoRetangulo({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    if (d < menor) menor = d;
    if (menor === 0) break;
  }
  return menor;
}

/** O que atrapalha o trajeto reto de `from` até `to` para um disco de raio rm. */
export function blockers(from, to, bodies, ignore = [], rm = 2.4) {
  const out = [];
  for (const b of bodies) {
    if (ignore.includes(b.id)) continue;
    if (b.forma === 'caixa') {
      const d = distSegmentoCaixa(from, to, b);
      if (d < rm - 0.3) out.push({ id: b.id, folga: r1(d - rm) });
      continue;
    }
    const d = distToSegment(b.x, b.y, from.x, from.y, to.x, to.y);
    if (d < b.r + rm - 0.3) out.push({ id: b.id, folga: r1(d - b.r - rm) });
  }
  return out;
}

function linhaBotao(b, ball, bodies) {
  const dx = ball.x - b.x, dy = ball.y - b.y;
  const dist = Math.hypot(dx, dy);
  const ang = deg(Math.atan2(dy, dx));
  const bloq = blockers(b, ball, bodies, [b.id, 'ball'], b.r);
  const via = bloq.length ? `BLOQUEADO por ${bloq.map((x) => x.id).join(',')}` : 'LIVRE';
  return `  ${b.id.padEnd(3)} (${r1(b.x).toString().padStart(5)}, ${r1(b.y).toString().padStart(5)})  `
       + `dist_bola ${r1(dist).toString().padStart(5)}  ang_bola ${String(ang).padStart(4)}deg  caminho ${via}`;
}

/**
 * @param {object} game
 * @param {string} viewerId jogador que vai ler isso
 * @param {object} opts { historico: n }
 */
export function describeGame(game, viewerId, opts = {}) {
  const nHist = opts.historico ?? 6;
  const meuTime = teamOf(game, viewerId);
  const adv = meuTime === 'A' ? 'B' : 'A';
  const ball = game.bodies.find((b) => b.kind === 'ball');
  const L = [];

  const A = game.teams.A, B = game.teams.B;
  L.push(`PARTIDA ${game.id} "${game.name}" | status ${game.status} | TURNO ${game.turnNo}`);
  L.push(`PLACAR: ${A.name} (A) ${A.score} x ${B.score} ${B.name} (B)`);
  L.push(`Relógio: posse ${game.possessionsPlayed} de ${game.config.maxPossessions}`);

  if (meuTime) {
    const alvoX = meuTime === 'A' ? PITCH.length : 0;
    L.push(`Você joga no time ${meuTime} "${game.teams[meuTime].name}". Ataca o gol em x=${alvoX}. Defende o gol em x=${meuTime === 'A' ? 0 : PITCH.length}.`);
  } else {
    L.push('Você está assistindo (não joga nesta partida).');
  }

  if (game.status === 'running') {
    const suaVez = game.currentPlayerId === viewerId;
    const restante = game.turnDeadline ? Math.max(0, Math.round((game.turnDeadline - Date.now()) / 1000)) : null;
    // Partida sem relógio tem prazo null, e `${null}s` virava o literal
    // "nulls" no meio da frase.
    const prazo = restante === null ? 'sem prazo' : `${restante}s`;
    const limite = game.config.touchesPerPossession > 0 ? ` de ${game.config.touchesPerPossession}` : ' (sem limite)';
    L.push(`Posse: time ${game.possession}${game.possession === meuTime ? ' (SUA)' : ' (adversário)'} | toque ${game.touchIndex + 1}${limite}`);
    L.push(`Relógio: turno ${game.turnNo} de ${game.config.maxTurns}`);

    if (game.fase === 'goleiro') {
      const defTeam = game.possession === 'A' ? 'B' : 'A';
      L.push(`>>> FASE: POSICIONAR O GOLEIRO. O time ${game.possession} declarou chute a gol.`);
      if (suaVez) {
        const a = areaDoGoleiro(defTeam);
        const k = goleiroDe(game, defTeam);
        L.push(`>>> É COM VOCÊ: mova a caixa do goleiro ${defTeam}G e confirme. Prazo: ${prazo}. turnToken=${game.turnToken}`);
        L.push(`    Ela está em (${r1(k.x)}, ${r1(k.y)}) a ${Math.round((k.ang*180)/Math.PI)}°, mede ${k.w} x ${k.h} cm.`);
        L.push(`    Pode ficar em x de ${a.xMin} a ${a.xMax} e y de ${a.yMin} a ${a.yMax}.`);
      } else {
        L.push(`    Quem posiciona: ${nomeJogador(game.currentPlayerId)}. Aguarde.`);
      }
    } else {
      // Cobrança de lateral, escanteio ou tiro de meta: a instrução que mais
      // pega quem joga por API é onde pôr o botão. A bola descansa em cima da
      // risca, então quem fica do lado de dentro empurra ela para fora e a
      // cobrança se repete. Isso já travou duas IAs numa lateral sem fim.
      if (game.fase === 'cobranca' && !game.cobranca?.formacao && suaVez) {
        const b = game.bodies.find((x) => x.kind === 'ball');
        L.push(`>>> FASE: COBRAR ${game.cobranca?.tipo}. A bola está em (${r1(b.x)}, ${r1(b.y)}), em cima da linha.`);
        L.push(`    Ponha um botão a até ${raioCobranca(game)} cm dela e depois jogue.`);
        L.push(`    O botão PODE ficar FORA DO CAMPO — há ${PITCH.margemFora} cm de mesa além de cada linha.`);
        L.push('    E quase sempre DEVE: o botão sai na reta botão -> bola, então um botão');
        L.push('    do lado de dentro manda a bola para fora e a cobrança recomeça. Fique do');
        L.push('    lado de fora, atrás da bola, mirando para dentro do campo.');
      }

      // Formação da saída: os dois times montam a mesa ao mesmo tempo.
      if (game.fase === 'cobranca' && game.cobranca?.formacao && meuTime) {
        const r = regiaoDeFormacao(game, meuTime);
        const pronto = game.cobranca.prontos?.[meuTime];
        L.push('>>> FASE: MONTAR A MESA para a saída de bola. Os dois times arrumam ao mesmo tempo.');
        if (pronto) {
          L.push('    Você já disse que está pronto.');
        } else {
          L.push(`    Seus botões vão em x de ${r.campo.xMin} a ${r.campo.xMax}, y de ${r.campo.yMin} a ${r.campo.yMax}.`);
          L.push(r.podeNoCirculo
            ? `    Você bate a saída: até ${r.maxNoCirculo} botões podem entrar no círculo central (raio ${r.circulo.raio} em torno de (${r.circulo.x}, ${r.circulo.y})). Usados: ${r.usadosNoCirculo}.`
            : `    Você NÃO bate a saída: fique todo fora do círculo central (raio ${r.circulo.raio} em torno de (${r.circulo.x}, ${r.circulo.y})).`);
          L.push('    POST /place {buttonId, x, y} move um botão; {confirmar:true} diz que você terminou.');
          L.push('    Arrumar é opcional: a formação padrão já é válida.');
        }
      }
      L.push(suaVez
        ? `>>> É A SUA VEZ. Prazo: ${prazo}. turnToken=${game.turnToken}${game.declarado ? ' | você JÁ declarou o chute: o gol vale.' : ' | você ainda NÃO declarou: gol não conta.'}`
        : `Vez de: ${nomeJogador(game.currentPlayerId)} (não é você; observe e planeje).`);
      if (suaVez && game.reinicio && !game.declarado) {
        L.push(`    BOLA PARADA (${game.reinicio}): NÃO dá para declarar chute a gol agora.`);
        L.push('    Dê este primeiro toque; a declaração libera na jogada seguinte.');
      }
    }
  } else if (game.status === 'finished' && game.result) {
    const v = game.result.winner;
    L.push(`FIM DE JOGO. ${v ? `Vitória do time ${v}` : 'Empate'}. (${game.result.reason})`);
  } else {
    L.push(`Aguardando jogadores: A ${A.players.length}/${A.slots}, B ${B.players.length}/${B.slots}.`);
  }

  L.push('');
  L.push(`CAMPO: ${PITCH.length} x ${PITCH.width} cm, com LINHAS ABERTAS: a BOLA cruza e sai. Os BOTÕES não: eles seguem jogando na faixa de ${PITCH.margemFora} cm de mesa em volta do campo.`);
  L.push(`Gols: abertura em y de ${PITCH.goalMin} a ${PITCH.goalMax}, nas linhas x=0 (time A defende) e x=${PITCH.length} (time B defende).`);
  L.push(`BOLA: (${r1(ball.x)}, ${r1(ball.y)})`);

  const meus = game.bodies.filter((b) => b.team === meuTime);
  const deles = game.bodies.filter((b) => b.team === adv);
  const controlaveis = new Set(controllableButtons(game, viewerId));

  if (meuTime) {
    L.push('');
    L.push(`SEUS BOTÕES (time ${meuTime})${controlaveis.size ? ' — mova UM deles nesta jogada:' : ':'}`);
    for (const b of meus) {
      const marca = controlaveis.has(b.id) ? '*' : ' ';
      const extra = b.kind === 'keeper' ? '  [goleiro, automático]' : '';
      L.push(marca + linhaBotao(b, ball, game.bodies).slice(1) + extra);
    }

    L.push('');
    L.push(`BOTÕES ADVERSÁRIOS (time ${adv}):`);
    for (const b of deles) {
      if (b.kind === 'keeper') continue;
      const dist = Math.hypot(ball.x - b.x, ball.y - b.y);
      L.push(`  ${b.id.padEnd(3)} (${r1(b.x).toString().padStart(5)}, ${r1(b.y).toString().padStart(5)})  dist_bola ${r1(dist)}`);
    }
    const kAdv = goleiroDe(game, adv);
    const kMeu = goleiroDe(game, meuTime);
    L.push('');
    L.push('GOLEIROS (caixas fixas, retangulares):');
    L.push(`  ${kAdv.id} (adversário) em (${r1(kAdv.x)}, ${r1(kAdv.y)}), ${kAdv.w} x ${kAdv.h} cm, girado ${Math.round((kAdv.ang*180)/Math.PI)}deg`);
    L.push(`  ${kMeu.id} (seu)        em (${r1(kMeu.x)}, ${r1(kMeu.y)}), ${kMeu.w} x ${kMeu.h} cm, girado ${Math.round((kMeu.ang*180)/Math.PI)}deg`);

    // Geometria do alvo. Varremos a boca inteira em vez de olhar só o centro:
    // com a caixa do goleiro no meio, é a FRESTA do lado que decide o lance, e
    // testar só o centro esconderia exatamente ela.
    const alvoX = meuTime === 'A' ? PITCH.length : 0;
    const folgaPoste = 1.3 + ball.r;      // o centro da bola não chega mais perto
    const yMin = PITCH.goalMin + folgaPoste;
    const yMax = PITCH.goalMax - folgaPoste;

    L.push('');
    L.push(`ALVO: gol do time ${adv}, na linha x=${alvoX}.`);
    L.push(`  Postes (corpos reais, raio 1.3) em (${alvoX}, ${PITCH.goalMin}) e (${alvoX}, ${PITCH.goalMax}).`);
    L.push(`  Por causa deles, o CENTRO da bola só entra com y entre ${r1(yMin)} e ${r1(yMax)}.`);
    L.push(`  Bola no alto passa por cima da caixa do goleiro (5cm), mas acima de ${PITCH.alturaTravessao}cm bate no travessão.`);

    const miras = [];
    for (let i = 0; i <= 8; i++) {
      const y = yMin + ((yMax - yMin) * i) / 8;
      const alvo = { x: alvoX, y };
      const bloq = blockers(ball, alvo, game.bodies, ['ball'], ball.r);
      miras.push({ y: r1(y), livre: bloq.length === 0, por: bloq.map((x) => x.id) });
    }
    const livres = miras.filter((m) => m.livre);
    const dGol = Math.hypot(alvoX - ball.x, PITCH.width / 2 - ball.y);
    L.push(`  bola->gol: dist ${r1(dGol)} cm.`);
    if (livres.length) {
      // Agrupa em faixas contínuas: "y de 62.5 a 69.4" é acionável.
      const faixas = [];
      for (const m of miras) {
        if (!m.livre) { faixas.push(null); continue; }
        const ultima = faixas[faixas.length - 1];
        if (ultima) ultima.ate = m.y;
        else faixas.push({ de: m.y, ate: m.y });
      }
      const texto = faixas.filter(Boolean)
        .map((f) => (f.de === f.ate ? `y=${f.de}` : `y de ${f.de} a ${f.ate}`)).join('; ');
      L.push(`  RASTEIRO LIVRE em: ${texto}`);
    } else {
      const culpados = [...new Set(miras.flatMap((m) => m.por))].join(',');
      L.push(`  Nenhuma mira rasteira livre (bloqueado por ${culpados}). Considere levantar a bola.`);
    }
  }

  if (nHist > 0 && game.log.length) {
    L.push('');
    L.push('ÚLTIMOS LANCES:');
    for (const e of game.log.slice(-nHist)) {
      L.push('  ' + resumoEvento(e));
    }
  }

  return L.join('\n');
}

export function resumoEvento(e) {
  const t = `t${e.turnNo ?? '-'}`;
  switch (e.type) {
    case 'goal': return `${t} GOL do time ${e.team}${e.ownGoal ? ' (contra!)' : ''} — placar ${e.scoreA} x ${e.scoreB}`;
    case 'foul': return `${t} falta do time ${e.team}: ${e.buttonId} encostou em ${e.on} antes da bola`;
    case 'miss': return `${t} time ${e.team}: ${e.buttonId} não alcançou a bola, perdeu a posse`;
    case 'touch': return `${t} time ${e.team}: toque válido com ${e.buttonId} (${e.touchIndex})`;
    case 'declaracaoConsumida': return `${t} time ${e.team} chutou declarado e não fez gol: a declaração acabou — para chutar a gol de novo, declare outra vez`;
    case 'timeout': return `${t} time ${e.team} estourou o tempo e perdeu a posse`;
    case 'declara': return `${t} time ${e.team} DECLAROU chute a gol — o adversário vai posicionar o goleiro`;
    case 'goleiro': return `${t} time ${e.team} posicionou o goleiro em (${e.x}, ${e.y})`;
    case 'goleiroAuto': return `${t} time ${e.team} demorou: o goleiro ficou onde estava`;
    case 'encerrada': return `${t} a partida foi ENCERRADA por ${nomeJogador(e.playerId)}`;
    case 'formacao': return `${t} time ${e.team} terminou de montar a mesa`;
    case 'cobranca': return `${t} time ${e.team} posicionou ${e.botao} para cobrar o ${e.tipo}`;
    case 'cobrancaAuto': return `${t} time ${e.team} demorou: ${e.botao} foi posto na bola automaticamente`;
    case 'fora': return `${t} bola fora — ${e.tipo} para o time ${e.para}`;
    case 'ultimoToque': return `${t} a bola tocou por último em ${e.em} — a posse passa`;
    case 'goalAnulado': return `${t} gol anulado do time ${e.team} (${e.razao})`;
    case 'join': return `${t} ${e.playerId} entrou no time ${e.team}`;
    case 'leave': return `${t} ${e.playerId} saiu do time ${e.team}`;
    case 'start': return `${t} partida começou`;
    case 'finish': return `${t} fim: ${e.scoreA} x ${e.scoreB}${e.winner ? ` — time ${e.winner} venceu` : ' — empate'}`;
    default: return `${t} ${e.type}`;
  }
}
