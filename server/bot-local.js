// Adversário de IA que roda DENTRO do servidor.
//
// Os bots de `bot/` são clientes: falam com a API por HTTP e WebSocket, e
// precisam de um processo próprio. Isso é ótimo para desenvolver, mas péssimo
// para "quero jogar agora" pelo navegador. Aqui reaproveitamos exatamente a
// mesma heurística, só que chamando o motor direto — sem rede no meio.
//
// A heurística é fixa: geometria e física, sem LLM. Para um adversário com
// modelo de verdade, use `bot/ai-bot.js`.

import { PITCH, PHYS, KEEPER } from './config.js';
import { registerPlayer, getPlayer } from './store.js';
import {
  joinGame, fullState, applyMove, declararChute, posicionarGoleiro, posicionarBotao,
  httpErr,
} from './game.js';
import {
  decidir, posicaoDoGoleiro, deveDeclarar, jogadaDeCobranca, etapasDeAjuste,
  configurarFisica,
} from '../bot/heuristic-bot.js';
import { newId } from './util.js';

// A heurística lê as constantes por `GET /api/rules`; aqui entregamos direto.
configurarFisica({
  pitch: PITCH,
  physics: {
    buttonRadius: PHYS.buttonRadius,
    ballRadius: PHYS.ballRadius,
    muButton: PHYS.muButton,
    muBall: PHYS.muBall,
    restitutionBody: PHYS.restitutionBody,
    maxShotSpeed: PHYS.maxShotSpeed,
  },
});

const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cria um jogador-bot e o coloca no time pedido. */
export function adicionarBot(game, team, { nome } = {}) {
  if (team !== 'A' && team !== 'B') {
    const livreA = game.teams.A.slots - game.teams.A.players.length;
    const livreB = game.teams.B.slots - game.teams.B.players.length;
    team = livreA >= livreB ? 'A' : 'B';
  }
  if (game.teams[team].players.length >= game.teams[team].slots) {
    throw httpErr(409, `time ${team} está cheio`, { code: 'TEAM_FULL' });
  }

  const etiqueta = nome || `IA ${game.teams[team].name}`;
  const perfil = registerPlayer({
    // Sufixo curto evita colidir com bots de outras partidas.
    name: `${etiqueta} ${newId('b', 4).split('_')[1]}`.slice(0, 32),
    password: newId('pw', 12),
    kind: 'ai',
    model: 'heurística local',
    // Não vai para o disco: é uma conta descartável desta partida.
    efemero: true,
  });

  joinGame(game, perfil.playerId, team);
  if (!game.bots) game.bots = new Set();
  game.bots.add(perfil.playerId);
  return { ...perfil, team };
}

export function ehBot(game, playerId) {
  return !!game.bots && game.bots.has(playerId);
}

export function temBot(game) {
  return !!game.bots && game.bots.size > 0;
}

/** É a vez de um bot? Devolve o id dele. */
function botDaVez(game) {
  if (game.status !== 'running' || !game.currentPlayerId) return null;
  return ehBot(game, game.currentPlayerId) ? game.currentPlayerId : null;
}

/**
 * Executa a vez do bot, seja ela qual for: cobrar, posicionar o goleiro,
 * declarar chute ou jogar. Transmite a palheta antes de bater, para quem está
 * assistindo ver a decisão acontecendo.
 *
 * @param {object} game
 * @param {{aim:Function, jogou:Function, mudou:Function}} avisos
 */
async function vezDoBot(game, botId, avisos) {
  const estado = fullState(game, botId);

  // 1) Cobrança de lateral, escanteio ou tiro de meta.
  // Na saída de bola arrumar é opcional: o bot simplesmente bate.
  if (estado.podeCobrar && !estado.cobrancaOpcional) {
    const c = jogadaDeCobranca(estado);
    if (c) {
      posicionarBotao(game, botId, c);
      avisos.mudou();
      await dorme(500);
      posicionarBotao(game, botId, { ...c, confirmar: true });
    } else {
      // Sem escolha boa: põe o botão atrás da bola OLHANDO PARA O MEIO e confirma,
      // para não travar a partida. `bola.x + 4` mandava a bola para o lado de fora
      // quando ela estava na risca — e a lateral se repetia sem fim.
      const id = estado.posicionaveis?.[0];
      const bola = estado.bodies.find((b) => b.id === 'ball');
      if (id && bola) {
        const ang = Math.atan2(PITCH.width / 2 - bola.y, PITCH.length / 2 - bola.x);
        posicionarBotao(game, botId, {
          buttonId: id,
          x: bola.x - Math.cos(ang) * 4,
          y: bola.y - Math.sin(ang) * 4,
        });
      }
      posicionarBotao(game, botId, { confirmar: true });
    }
    avisos.jogou({ tipo: 'cobranca' });
    return;
  }

  // 2) O adversário declarou: posicionar a caixa do goleiro.
  if (estado.podePosicionarGoleiro) {
    const pos = posicaoDoGoleiro(estado);
    if (pos) {
      posicionarGoleiro(game, botId, pos);
      avisos.mudou();
      await dorme(600);
      posicionarGoleiro(game, botId, { ...pos, confirmar: true });
    } else {
      posicionarGoleiro(game, botId, { confirmar: true });
    }
    avisos.jogou({ tipo: 'goleiro' });
    return;
  }

  if (!estado.podeJogar) return;

  // 3) Vale declarar chute a gol?
  if (estado.podeDeclarar && deveDeclarar(estado)) {
    declararChute(game, botId);
    avisos.jogou({ tipo: 'declarou' });
    return;
  }

  // 4) A jogada em si, com a palheta à vista antes de apertar.
  const jogada = decidir(estado);
  if (!jogada) return;

  const etapas = etapasDeAjuste(jogada, estado);
  for (const p of etapas) {
    avisos.aim(botId, jogada.buttonId, p);
    await dorme(190);
  }
  await dorme(260);

  const { _motivo, alternativas, ...mv } = jogada;
  const r = applyMove(game, botId, mv);
  avisos.jogou({ tipo: 'jogada', resultado: r });
}

/**
 * Um passo do relógio dos bots. Chamado pelo tique do servidor.
 * A trava por partida evita duas execuções ao mesmo tempo.
 */
export async function passoDosBots(jogos, avisos) {
  for (const game of jogos) {
    const botId = botDaVez(game);
    if (!botId) { game._botPensa = 0; continue; }
    if (game._botOcupado) continue;

    // Pequena pausa antes de agir: instantâneo fica estranho de assistir.
    if (!game._botPensa) { game._botPensa = Date.now() + 700; continue; }
    if (Date.now() < game._botPensa) continue;

    game._botOcupado = true;
    game._botPensa = 0;
    try {
      await vezDoBot(game, botId, avisos.para(game));
    } catch (e) {
      // A partida acabou no meio da vez dele: não é erro, é o fim do jogo.
      if (e.code === 'GAME_FINISHED') continue;
      // Um erro do bot não pode travar a partida: o timeout resolve, e num
      // jogo sem prazo o próximo tique tenta de novo.
      console.error(`[bot ${game.id}]`, e.message);
    } finally {
      game._botOcupado = false;
    }
  }
}
