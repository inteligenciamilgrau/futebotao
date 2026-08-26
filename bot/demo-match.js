// Partida completa entre dois bots heurísticos, direto pela API.
// Serve de demo e de teste de regressão das regras.
//
//   node bot/demo-match.js [--possessions 40] [--buttons 5] [--slots 1x1] [--quiet]

import { FutebolClient, parseArgs } from './client.js';
import { decidir, etapasDeAjuste, posicaoDoGoleiro, deveDeclarar, jogadaDeCobranca } from './heuristic-bot.js';

const args = parseArgs();
const quieto = !!args.quiet;
const base = args.base || 'http://localhost:3000';
const sufixo = Math.random().toString(36).slice(2, 7);

const say = (...a) => { if (!quieto) console.log(...a); };

// Ritmo do ajuste da palheta. Em --quiet (teste de regressão) vai no talo;
// para assistir no navegador, devagar o suficiente para acompanhar.
const RITMO = quieto
  ? { suavizar: 1, intervalo: 0, pausa: 0 }
  : { suavizar: Number(args.suavizar || 4), intervalo: Number(args.ritmo || 110), pausa: Number(args.pausa || 320) };

async function main() {
  const [slotsA, slotsB] = String(args.slots || '1x1').split('x').map(Number);
  const nA = slotsA || 1, nB = slotsB || 1;

  // Um cliente por vaga, para exercitar times com vários jogadores.
  const azuis = [], rubros = [];
  for (let i = 0; i < nA; i++) azuis.push(new FutebolClient({ base, name: `azul${i + 1}-${sufixo}`, password: 'demo1234', verbose: false }));
  for (let i = 0; i < nB; i++) rubros.push(new FutebolClient({ base, name: `rubro${i + 1}-${sufixo}`, password: 'demo1234', verbose: false }));
  const todos = [...azuis, ...rubros];
  await Promise.all(todos.map((c) => c.auth()));

  const g = await azuis[0].createGame({
    name: 'Demo bot x bot',
    slotsA: nA, slotsB: nB,
    teamAName: 'Azuis', teamBName: 'Vermelhos',
    config: {
      buttonsPerTeam: Number(args.buttons || 5),
      maxTurns: Number(args.turns || 120),
      touchesPerPossession: Number(args.touches || 0),
      turnTimeoutMs: 600000,
    },
  });
  const GID = g.gameId;
  say(`\n  Partida ${GID}  —  ${nA} x ${nB} jogadores, ${args.buttons || 5} botões por time`);
  say(`  Acompanhe ao vivo em ${base}/?game=${GID}\n`);

  for (const c of azuis) await c.join(GID, 'A');
  for (const c of rubros) await c.join(GID, 'B');
  await azuis[0].start(GID);

  const porId = new Map(todos.map((c) => [c.playerId, c]));
  let guarda = 0;
  const limite = Number(args.turns || 120) * 3 + 60;
  let placarAnterior = [0, 0];

  for (;;) {
    if (++guarda > limite) { console.error('  laço de segurança acionado'); break; }

    const st = await azuis[0].state(GID);
    if (st.status === 'finished') {
      const r = st.result;
      say(`\n  FIM: Azuis ${r.scoreA} x ${r.scoreB} Vermelhos — ${r.winner ? `time ${r.winner} venceu` : 'empate'} (${r.reason})`);
      say(`  ${st.lances} lances em ${st.turnNo} turnos`);
      return { gameId: GID, ...r, turnos: st.turnNo, lances: st.lances };
    }

    const cli = porId.get(st.currentPlayerId);
    if (!cli) { console.error('  jogador da vez não é um bot conhecido:', st.currentPlayerId); break; }

    const meuEstado = await cli.state(GID);

    // Cobrança: põe um botão perto da bola e devolve a vez para jogar.
    // Na saída de bola arrumar é opcional: o bot simplesmente bate.
    if (meuEstado.podeCobrar && !meuEstado.cobrancaOpcional) {
      const c = jogadaDeCobranca(meuEstado);
      if (c) {
        await cli.cobrar(GID, c);
        if (RITMO.pausa) await new Promise((res) => setTimeout(res, RITMO.pausa));
        await cli.cobrar(GID, { ...c, confirmar: true });
        say(`  t${String(st.turnNo).padStart(3)} ${meuEstado.yourTeam} cobra ${meuEstado.cobranca?.tipo} com ${c.buttonId}`);
      } else {
        await cli.cobrar(GID, { confirmar: true }).catch(() => {});
      }
      continue;
    }

    // Fase do goleiro: o defensor põe a caixa e devolve a vez.
    if (meuEstado.podePosicionarGoleiro) {
      const pos = posicaoDoGoleiro(meuEstado);
      if (pos) {
        await cli.goleiro(GID, pos);
        if (RITMO.pausa) await new Promise((res) => setTimeout(res, RITMO.pausa));
        await cli.goleiro(GID, { ...pos, confirmar: true });
        say(`  t${String(st.turnNo).padStart(3)} ${meuEstado.yourTeam} goleiro -> (${pos.x}, ${pos.y}) a ${pos.anguloDeg}deg`);
      } else {
        await cli.goleiro(GID, { confirmar: true });
      }
      continue;
    }

    // Chute a gol na cara: declara antes, senão o gol é anulado.
    if (deveDeclarar(meuEstado)) {
      await cli.declarar(GID);
      say(`  t${String(st.turnNo).padStart(3)} ${meuEstado.yourTeam} DECLAROU chute a gol`);
      continue;
    }

    const jogada = decidir(meuEstado);
    if (!jogada) { console.error('  bot sem jogada'); break; }
    const { _motivo, alternativas, ...mv } = jogada;

    let r;
    try {
      // Transmite a configuração da palheta passo a passo antes de bater.
      // Sem isso quem assiste no navegador não vê palheta nenhuma.
      await cli.mirarPassoAPasso(GID, mv.buttonId, etapasDeAjuste(jogada, meuEstado), {
        suavizar: RITMO.suavizar, intervalo: RITMO.intervalo,
      });
      if (RITMO.pausa) await new Promise((res) => setTimeout(res, RITMO.pausa));

      r = await cli.move(GID, mv);
    } catch (e) {
      console.error(`  erro (${e.status}): ${e.message}`);
      break;
    }

    const res = r.result;
    const marca = res.goal ? ' <<< GOL' : '';
    const p = mv.palheta;
    say(`  t${String(res.turnNo).padStart(3)} ${res.team} ${res.buttonId.padEnd(3)} aro ${String(Math.round(p.anguloAro)).padStart(3)}° incl ${p.inclinacao}° av ${p.avanco} f=${p.forca.toFixed(2)}  ${res.outcome}${marca}`);

    const placar = [r.state.scoreA, r.state.scoreB];
    if (placar[0] !== placarAnterior[0] || placar[1] !== placarAnterior[1]) {
      say(`      placar: Azuis ${placar[0]} x ${placar[1]} Vermelhos`);
      placarAnterior = placar;
    }
  }
  return null;
}

main().then((r) => { if (r && quieto) console.log(JSON.stringify(r)); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
