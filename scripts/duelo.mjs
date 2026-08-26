// Mede a força de uma heurística fazendo ela jogar partidas inteiras.
//
// Existe porque "a IA está mais inteligente" não se sabe lendo o diff. Aqui ela
// joga contra si mesma um número grande de partidas e o que interessa sai em
// números: gols, quantas vezes perdeu a posse, e POR QUÊ perdeu.
//
// O motivo da perda é o que mais ensina. Numa partida em que a vez só passa
// quando você erra, o placar é consequência de quantas vezes você mandou a bola
// para fora ou não encostou nela.
//
//   node scripts/duelo.mjs            10 partidas
//   node scripts/duelo.mjs 30         30 partidas

import { createGame, startGame, applyMove, fullState, posicionarGoleiro, posicionarBotao, declararChute } from '../server/game.js';
// Qual heurística medir: por padrão a atual;  compara com outra.
const MOD = (process.argv.find((x) => x.startsWith('--modulo=')) || '').split('=')[1] || '../bot/heuristic-bot.js';
const { decidir, deveDeclarar, posicaoDoGoleiro, jogadaDeCobranca, configurarFisica } = await import(MOD);
import { PITCH, PHYS } from '../server/config.js';

configurarFisica({ pitch: PITCH, physics: PHYS });

const PARTIDAS = Number(process.argv[2] || 10);
const MAX_LANCES = 300;

function partida(semente) {
  const g = createGame({
    slotsA: 1, slotsB: 1,
    config: { buttonsPerTeam: 5, maxTurns: MAX_LANCES, turnTimeoutMs: 0, touchesPerPossession: 0, maxPossessions: 0 },
  });
  g.rngState = semente;
  g.teams.A.players.push('a1');
  g.teams.B.players.push('b1');
  startGame(g);

  const motivos = {};
  let lances = 0;

  while (g.status === 'running' && lances < MAX_LANCES) {
    const quem = g.currentPlayerId;
    const st = fullState(g, quem);

    try {
      if (st.podeCobrar && !st.cobrancaOpcional) {
        const c = jogadaDeCobranca({ ...st, pitch: { margemFora: PITCH.margemFora } });
        if (c) posicionarBotao(g, quem, c);
        posicionarBotao(g, quem, { confirmar: true });
        continue;
      }
      if (st.podePosicionarGoleiro) {
        const pos = posicaoDoGoleiro(st);
        if (pos) posicionarGoleiro(g, quem, pos);
        posicionarGoleiro(g, quem, { confirmar: true });
        continue;
      }
      if (!st.podeJogar) break;

      if (st.podeDeclarar && deveDeclarar(st)) { declararChute(g, quem); continue; }

      const jogada = decidir(st);
      if (!jogada) break;
      const { _motivo, alternativas, ...mv } = jogada;
      const r = applyMove(g, quem, mv);
      lances++;
      if (r.result.motivo) motivos[r.result.motivo] = (motivos[r.result.motivo] || 0) + 1;
    } catch (e) {
      motivos['erro:' + (e.code || e.message.slice(0, 24))] = (motivos['erro:...'] || 0) + 1;
      break;
    }
  }

  return { lances, a: g.teams.A.score, b: g.teams.B.score, motivos };
}

const total = { lances: 0, gols: 0, motivos: {} };
for (let i = 0; i < PARTIDAS; i++) {
  const r = partida(1000 + i * 7919);
  total.lances += r.lances;
  total.gols += r.a + r.b;
  for (const [k, v] of Object.entries(r.motivos)) total.motivos[k] = (total.motivos[k] || 0) + v;
}

const perdas = Object.entries(total.motivos).sort((a, b) => b[1] - a[1]);
const trocas = perdas.reduce((s, [, v]) => s + v, 0);

console.log(`${PARTIDAS} partidas, ${total.lances} lances`);
console.log(`gols: ${total.gols}  (${(total.gols / PARTIDAS).toFixed(2)} por partida)`);
console.log(`trocas de posse: ${trocas}  (1 a cada ${(total.lances / Math.max(1, trocas)).toFixed(1)} lances)`);
console.log('\npor que a posse passou:');
for (const [k, v] of perdas) {
  console.log(`  ${k.padEnd(20)} ${String(v).padStart(4)}  ${((v / trocas) * 100).toFixed(0)}%`);
}
