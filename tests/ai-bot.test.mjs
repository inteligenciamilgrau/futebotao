// Testa o encanamento do bot de IA SEM chamar a API de verdade:
// injeta um SDK falso e confere montagem do prompt, jogada, retentativa e fallback.
// Precisa do servidor no ar.

import { BotIA } from '../bot/ai-bot.js';
import { FutebolClient } from '../bot/client.js';

const BASE = process.env.BASE || 'http://localhost:3000';
let fails = 0;
const ok = (n, c, i = '') => { console.log((c ? '  PASS ' : '  FAIL ') + n + (i ? '  -> ' + i : '')); if (!c) fails++; };
const secao = (t) => console.log('\n== ' + t + ' ==');

/** SDK falso: devolve o que o roteiro mandar e guarda o que recebeu. */
function sdkFalso(roteiro) {
  const chamadas = [];
  let i = 0;
  const criar = async (params) => {
    chamadas.push(params);
    const passo = roteiro[Math.min(i++, roteiro.length - 1)];
    if (passo instanceof Error) throw passo;
    return {
      stop_reason: passo.stop_reason || 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(passo.jogada ?? passo) }],
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 80 },
    };
  };
  class Falso {
    constructor() {
      this.beta = { messages: { create: criar } };
      this.messages = { create: criar };
    }
  }
  return { Falso, chamadas };
}

/** Ponto seguro para o botão da cobrança: sempre para dentro do campo. */
function pertoDaBola(bola, dist = 4.5) {
  const ang = Math.atan2(60 - bola.y, 100 - bola.x);
  return {
    x: Math.max(3, Math.min(197, bola.x + Math.cos(ang) * dist)),
    y: Math.max(3, Math.min(117, bola.y + Math.sin(ang) * dist)),
  };
}
const sufixo = Math.random().toString(36).slice(2, 7);

const humano = new FutebolClient({ base: BASE, name: `humano-${sufixo}`, password: 'teste1234', verbose: false });
const robo = new FutebolClient({ base: BASE, name: `robo-${sufixo}`, password: 'teste1234', verbose: false });
await humano.auth();
await robo.auth();

const g = await humano.createGame({
  name: 'Teste do bot de IA', slotsA: 1, slotsB: 1,
  config: { buttonsPerTeam: 5, maxPossessions: 30, turnTimeoutMs: 600000 },
});
const GID = g.gameId;
await humano.join(GID, 'A');
await robo.join(GID, 'B');
await humano.start(GID);

/* -------------------------------------------------- */
secao('Puxada de estado com frame e descrição');

const st = await robo.state(GID, { describe: true, frame: true });
ok('descrição presente', typeof st.description === 'string' && st.description.length > 200, st.description.length + ' chars');
ok('frame presente em base64', !!st.frame?.data);
ok('bot sabe que não é a vez dele', st.yourTurn === false);
ok('descrição diz de quem é a vez', st.description.includes('Vez de:'));

/* -------------------------------------------------- */
secao('Jogada decidida pelo modelo (SDK falso)');

/**
 * Passa a vez para o time B: A joga até perder a posse.
 * Precisa lidar com as três fases — depois de a bola sair, o turno é de
 * COBRANÇA e nenhum botão é lançável até posicionar um.
 */
async function passarVezParaB() {
  for (let k = 0; k < 40; k++) {
    const s = await humano.state(GID);
    if (s.status !== 'running') return s;
    if (s.possession === 'B' && !s.podePosicionarGoleiro) return s;
    if (!s.yourTurn) return s;

    if (s.podeCobrar) {
      // Formação da saída: a mesa padrão já serve, então só confirma.
      if (s.cobranca?.area?.campo) { await humano.cobrar(GID, { confirmar: true }); continue; }
      const bola = s.bodies.find((b) => b.id === 'ball');
      const id = s.posicionaveis[0];
      await humano.cobrar(GID, { buttonId: id, ...pertoDaBola(bola) });
      await humano.cobrar(GID, { confirmar: true });
      continue;
    }
    if (s.podePosicionarGoleiro) {
      await humano.goleiro(GID, { confirmar: true });
      continue;
    }
    if (!s.controllable?.length) return s;

    // Com as regras novas a posse só passa quando algo dá errado, e um toque
    // limpo MANTÉM a vez. Então o humano manda a bola para fora de propósito:
    // é o jeito curto e determinístico de entregar a vez ao B.
    const bola = s.bodies.find((b) => b.id === 'ball');
    // A bola sai pela reta botão -> bola. Escolhe o botão cuja reta é a mais
    // transversal possível: essa é a que cruza a lateral mais depressa.
    const melhor = s.controllable
      .map((id) => s.bodies.find((b) => b.id === id))
      .filter(Boolean)
      .map((b) => {
        const dx = bola.x - b.x, dy = bola.y - b.y;
        const n = Math.hypot(dx, dy) || 1;
        return { b, ux: dx / n, uy: dy / n };
      })
      .sort((x, y) => Math.abs(y.uy) - Math.abs(x.uy))[0];

    await humano.move(GID, {
      buttonId: melhor.b.id,
      targetX: bola.x + melhor.ux * 300,
      targetY: bola.y + melhor.uy * 300,
      power: 1,
      turnToken: s.turnToken,
    });
  }
  return humano.state(GID);
}

/**
 * Deixa a vez do B pronta para JOGAR. Se ela começar numa cobrança obrigatória,
 * o próprio robô posiciona — o que estes testes exercitam é a jogada, não o
 * posicionamento (esse tem teste próprio).
 */
async function prontoParaJogar() {
  await passarVezParaB();
  let s = await robo.state(GID);
  for (let k = 0; k < 4; k++) {
    if (!s.yourTurn || !s.podeCobrar || s.cobrancaOpcional) break;
    const bola = s.bodies.find((b) => b.id === 'ball');
    await robo.cobrar(GID, { buttonId: s.posicionaveis[0], ...pertoDaBola(bola) });
    await robo.cobrar(GID, { confirmar: true });
    s = await robo.state(GID);
  }
  return s;
}

await prontoParaJogar();

const estadoB = await robo.state(GID, { describe: true, frame: true });
ok('agora é a vez do bot', estadoB.yourTurn === true, `posse=${estadoB.possession}`);

const bola = estadoB.bodies.find((b) => b.id === 'ball');
const escolhido = estadoB.controllable[0];
const btn = estadoB.bodies.find((b) => b.id === escolhido);
const paraBola = (b, alvo) => (Math.atan2(alvo.y - b.y, alvo.x - b.x) * 180) / Math.PI + 180;
const { Falso, chamadas } = sdkFalso([
  { jogada: { buttonId: escolhido, anguloAro: paraBola(btn, bola), inclinacao: 45, avanco: 0.35, forca: 0.5, intencao: 'encostar na bola' } },
]);

const bot = new BotIA(robo, GID, Falso);
await bot.jogar();

ok('chamou o modelo uma vez', chamadas.length === 1, chamadas.length + ' chamada(s)');
const p = chamadas[0];
ok('usa claude-opus-5', p.model === 'claude-opus-5', p.model);
ok('pede saída estruturada', p.output_config?.format?.type === 'json_schema');
ok('esquema pede os 4 números da palheta',
   ['anguloAro','inclinacao','avanco','forca'].every((k) => p.output_config.format.schema.properties[k]),
   Object.keys(p.output_config.format.schema.properties).join(','));
ok('marca o system para cache', p.system?.[0]?.cache_control?.type === 'ephemeral');
ok('manda a imagem junto do texto', p.messages[0].content.some((c) => c.type === 'image'));
ok('manda a descrição em texto', p.messages[0].content.some((c) => c.type === 'text' && c.text.includes('SEUS BOTÕES')));
ok('usa thinking adaptativo', p.thinking?.type === 'adaptive');
ok('contabiliza tokens', bot.gasto.chamadas === 1 && bot.gasto.cacheLido === 80, JSON.stringify(bot.gasto));

const depois = await robo.state(GID, { brief: true });
ok('a jogada chegou ao servidor', depois.turnNo === estadoB.turnNo + 1, `turno ${estadoB.turnNo} -> ${depois.turnNo}`);

/* -------------------------------------------------- */
secao('Jogada inválida: erro volta para o modelo e ele corrige');

await prontoParaJogar();
const est2 = await robo.state(GID, { describe: true, frame: true });
if (est2.yourTurn && est2.controllable?.length) {
  const bola2 = est2.bodies.find((b) => b.id === 'ball');
  const btn2 = est2.bodies.find((b) => b.id === est2.controllable[0]);
  const { Falso: F2, chamadas: c2 } = sdkFalso([
    { jogada: { buttonId: 'A1', anguloAro: 0, inclinacao: 45, avanco: 0.35, forca: 0.5, intencao: 'botão do adversário' } },
    { jogada: { buttonId: est2.controllable[0], anguloAro: paraBola(btn2, bola2), inclinacao: 45, avanco: 0.35, forca: 0.5, intencao: 'agora vai' } },
  ]);
  const bot2 = new BotIA(robo, GID, F2);
  await bot2.jogar();
  ok('tentou de novo depois da recusa', c2.length === 2, c2.length + ' chamada(s)');
  const textoSegunda = c2[1].messages[0].content.find((c) => c.type === 'text').text;
  ok('a segunda chamada carrega o motivo da recusa', /RECUSADA/.test(textoSegunda));
  const d2 = await robo.state(GID, { brief: true });
  ok('a jogada corrigida foi aceita', d2.turnNo === est2.turnNo + 1, `turno ${est2.turnNo} -> ${d2.turnNo}`);
} else {
  ok('vez do bot para o teste de retentativa', false, 'não chegou a vez');
}

/* -------------------------------------------------- */
secao('Recusa do modelo cai na heurística de segurança');

await prontoParaJogar();
const est3 = await robo.state(GID, { brief: true });
if (est3.currentPlayerId === robo.playerId) {
  const { Falso: F3, chamadas: c3 } = sdkFalso([{ stop_reason: 'refusal', jogada: {} }]);
  const bot3 = new BotIA(robo, GID, F3);
  await bot3.jogar();
  const d3 = await robo.state(GID, { brief: true });
  ok('mesmo com recusa a partida anda', d3.turnNo === est3.turnNo + 1, `turno ${est3.turnNo} -> ${d3.turnNo}`);
  ok('só uma chamada ao modelo', c3.length === 1);
} else {
  ok('vez do bot para o teste de recusa', false, 'não chegou a vez');
}

/* -------------------------------------------------- */
secao('Erro de API também não trava a partida');

await prontoParaJogar();
const est4 = await robo.state(GID, { brief: true });
if (est4.currentPlayerId === robo.playerId) {
  const erro = new Error('connection reset');
  const { Falso: F4 } = sdkFalso([erro]);
  const bot4 = new BotIA(robo, GID, F4);
  await bot4.jogar();
  const d4 = await robo.state(GID, { brief: true });
  ok('erro de rede não deixa o turno pendurado', d4.turnNo === est4.turnNo, 'turno preservado para o timeout resolver');
} else {
  ok('vez do bot para o teste de erro', false, 'não chegou a vez');
}

console.log(fails === 0 ? '\nTUDO OK\n' : `\n${fails} FALHA(S)\n`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
