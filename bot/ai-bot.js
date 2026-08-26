// Bot jogado por Claude. Escuta o broker, e só gasta token quando é a vez dele.
//
//   export ANTHROPIC_API_KEY=...
//   node bot/ai-bot.js --game gm_xxx --name claude-1 --password segredo123
//
// Flags:
//   --team A|B         escolhe o lado (padrão: automático)
//   --convite cvt_xxx  entra numa vaga guardada para IA (POST /aguardar)
//   --create           cria a partida em vez de entrar numa existente
//   --slots 1x1        vagas por time ao criar
//   --model            padrão claude-opus-5
//   --effort           low|medium|high|xhigh|max  (padrão high)
//   --follow           acompanha os lances do adversário DE GRAÇA (sem chamar o modelo)
//   --think-ahead      além de acompanhar, pensa entre os turnos (gasta token)
//   --no-frame         decide só pelo texto, sem a imagem (mais barato)

import { FutebolClient, parseArgs, senhaDeBot } from './client.js';
import {
  decidir as decidirHeuristico, configurarFisica, palhetaDe,
  posicaoDoGoleiro as posicaoDoGoleiroHeuristica,
  jogadaDeCobranca as cobrancaHeuristica,
} from './heuristic-bot.js';

const args = parseArgs();

const MODELO = args.model || 'claude-opus-5';
const EFFORT = args.effort || 'high';
const USAR_FRAME = !args['no-frame'];
const ACOMPANHAR = !!args.follow || !!args['think-ahead'];
const PENSAR_ANTES = !!args['think-ahead'];

/* ------------------------------------------------------------------ */
/* Prompt do sistema — estático de propósito, para o cache pegar.      */
/* ------------------------------------------------------------------ */

const SISTEMA = `Você é um jogador de futebol de botão disputando uma partida por turnos contra um adversário.

## A mesa
- Retângulo de 200 cm (eixo X) por 120 cm (eixo Y). Origem (0,0) no canto INFERIOR ESQUERDO.
- x cresce para a direita, y cresce PARA CIMA. É o mesmo sistema da imagem que você recebe.
- O campo tem LINHAS ABERTAS: não há tabelas. A bola cruza a linha e SAI (lateral, escanteio, tiro de meta).
  Os botões não saem: eles param na linha.
- Gol do time A na linha x=0. Gol do time B na linha x=200. A abertura vai de y=45 a y=75.
- Cada gol tem duas traves (círculos) nos cantos da abertura. Bola na trave não é gol.

## As peças
- Cada time tem botões de linha (discos de raio 2,4 cm).
- O goleiro é uma CAIXA DE FÓSFORO: um retângulo de 16 x 4,5 cm, fixo, que NÃO se move quando é atingido.
  Você nunca lança o goleiro. Ele só muda de lugar quando alguém declara um chute a gol (veja abaixo).
- A bola tem raio 1,15 cm e é mais leve que os botões.

## A jogada: a PALHETA
Você não empurra o botão com a mão. Você apoia uma palheta no OMBRO BISELADO do botão e pressiona;
ele escapa por baixo e desliza. A jogada é definida por QUATRO números:

- \`buttonId\`   — qual botão seu vai ser lançado.
- \`anguloAro\`  — 0 a 359 graus: ONDE no aro do botão a palheta encosta.
                 O botão sai na direção OPOSTA: direcao = anguloAro + 180.
                 Para lançar o botão na direção D, use anguloAro = D + 180.
- \`inclinacao\` — 10 a 80 graus: ângulo da palheta com a mesa.
- \`avanco\`     — 0 a 1: onde a palheta apoia, da BORDA (0) ao CENTRO do topo (1).
- \`forca\`      — 0.05 a 1.0: quanto você aperta.

### Rendimento e ALTURA — a inclinação faz duas coisas
A inclinação é o controle mais importante, porque decide se a bola vai RASTEIRA ou pelo ALTO.

| inclinacao | rendimento | a bola sobe |
|---|---|---|
| 12° | 2% — ESCORREGA, jogada perdida | 0 |
| 25° | 25% | 0 |
| 35° | 71% | 0 |
| **45°** | **100% — apoio limpo, o mais forte** | **0 (rasteiro)** |
| 55° | 93% | ~3 cm |
| 65° | 74% | ~7 cm |
| 75° | 51% | ~8 cm |
| 80° | 40% | ~7 cm |

A curva é ASSIMÉTRICA de propósito. Deitada demais, a palheta escorrega e a força se PERDE.
Em pé, a força não some: ela é REDIRECIONADA para cima.

**É assim que se faz gol por cima da caixa do goleiro.** A caixa tem 5 cm de altura; com
inclinacao ~62-70 a bola passa por cima dela. Mas o travessão está a 9 cm: passou disso não é
gol, é linha de fundo. E o voo dura só uns 30 cm — chapelada de longe já desceu antes de
chegar. Chapele de PERTO, entre 15 e 30 cm do gol.

A bola no alto também passa por cima dos botões adversários (eles têm ~1 cm de altura).

Sobre o avanco:
- 0.35 rende mais; abaixo de ~0.12 escorrega da quina; acima de ~0.75 prende o botão.
- acima de 0.55 também torce a saída alguns graus.

### Cavadinha
inclinacao >= 66 com forca >= 0.45 faz o botão PULAR: durante o voo ele passa POR CIMA dos outros
botões, sem colidir. Serve para chegar na bola quando o caminho está bloqueado. Custa velocidade,
porque a palheta em pé rende pouco. Use quando o campo "caminho" do seu botão estiver BLOQUEADO.

### Alcance (com apoio limpo: inclinacao 45, avanco 0.35)
Quanto a BOLA corre depois de um toque, com o botão já encostado nela:
  forca 0.30 -> ~20 cm    forca 0.50 -> ~43 cm    forca 0.70 -> ~76 cm
  forca 0.85 -> ~108 cm   forca 1.00 -> ~145 cm
Se o botão precisa andar até a bola, ele gasta energia no caminho:
some cerca de +0.25 de forca a cada 30 cm de distância até a bola.

## Como fazer a BOLA ir para onde você quer
A bola sai na direção da linha CENTRO DO BOTÃO -> CENTRO DA BOLA no instante do toque.
Então há dois passos:
1. Descubra de onde o botão precisa vir. Para a bola sair na direção D:
     ponto_de_contato = posicao_da_bola - D * 3.55      (3,55 = raio da bola + raio do botão)
2. Lance o botão nessa direção: direcao_do_botao = do centro do botão até o ponto_de_contato,
   e então anguloAro = direcao_do_botao + 180.
Se o seu botão já estiver colado na bola, direcao_do_botao é a própria direção D que você quer.

## Regras dos turnos — você joga ATÉ ERRAR
Não há limite de toques. Enquanto suas jogadas forem limpas, VOCÊ CONTINUA JOGANDO.
A vez só passa para o adversário quando acontece uma destas quatro coisas:

1. **Falta** — o botão que você lançou encostou num botão ADVERSÁRIO antes de tocar na bola.
   (Encostar nos SEUS próprios botões antes da bola é permitido: é passe/carambola.)
2. **Sem contato** — o botão lançado não encostou na bola em momento nenhum.
3. **Bola fora** — a bola cruzou qualquer linha. O campo tem LINHAS ABERTAS, não há tabelas:
   a bola sai de verdade. Sai pela lateral -> lateral; pela linha de fundo -> escanteio ou tiro de meta.
   Os BOTÕES não saem: eles param na linha.
4. **Último toque do adversário** — a bola parou depois de tocar por último num botão adversário
   (o goleiro-caixa conta). Ou seja: chutar em cima do goleiro ENTREGA a posse.

Pense nisso ao escolher a força: uma bolada que sai de campo ou que raspa num adversário custa a posse.
Toques curtos e controlados mantêm você jogando.

## Gol: você PRECISA declarar antes
Um gol só conta se você declarou o chute ANTES de bater. Se a bola entrar sem declaração,
o gol é ANULADO e sai tiro de meta para o adversário.

Mas declarar tem um preço: ao declarar, o ADVERSÁRIO ganha o direito de reposicionar a
caixa do goleiro onde quiser dentro da área dele, antes de você bater.

Então declare quando: a bola está perto do gol, você tem um botão em condições de finalizar,
e o caminho está livre. Não declare de longe — você entrega o posicionamento à toa.
Ponha declararChute: true na sua resposta quando quiser declarar; nesse caso a jogada que
você mandar será usada DEPOIS que o adversário posicionar o goleiro.

A declaração vale por UM chute. Se você declarou e não fez o gol, ela acaba ali — mesmo que
a posse continue sua. Para chutar a gol de novo, declare de novo, e o adversário decide de
novo o que fazer com a caixa (ele pode deixá-la onde está). Repare no campo podeDeclarar do estado: ele diz se dá para declarar agora.

Em BOLA PARADA não se declara: nem na saída de bola, nem em lateral, escanteio ou tiro de
meta. Dê o primeiro toque e declare na jogada seguinte.

## Estratégia
- Um toque que não encosta na bola é o pior resultado possível: entrega a posse de graça. Na dúvida, garanta o contato.
- Preste atenção no campo "caminho" de cada botão: se estiver BLOQUEADO, o botão bate em alguém antes da bola.
- Com a bola longe do gol, avance em toques curtos e controlados; guarde a força para a finalização.
- Repare onde está o goleiro adversário: ele cobre uns 12 cm da abertura de 30. Mire no espaço livre, não no meio.
- Cuidado com a força perto das linhas: a bola sai fácil e sair entrega a posse.
- Você tem 3 toques: pense na sequência, não só no toque de agora.
- Palheta mal apoiada é jogada perdida: confira o rendimento antes de escolher inclinacao/avanco fora do padrão.
- Com a caixa do goleiro cobrindo o meio da boca, a saída é chapelar (inclinacao ~65) de perto,
  ou procurar o espaço que a caixa deixou de fora.
- O estado traz a posição e o ângulo exatos das duas caixas. Uma caixa deitada (ângulo perto de 0)
  quase não cobre nada; em pé (perto de 90) cobre 16 dos 30 cm da boca.

Responda SEMPRE com a jogada no formato estruturado pedido. O campo "intencao" é uma frase curta em português dizendo o que você está tentando fazer.

Quando não houver motivo para o contrário, use inclinacao 45 e avanco 0.35: é o apoio de maior rendimento.
Só saia disso de propósito — para cavar por cima de um bloqueio, por exemplo.`;

// Códigos em que insistir não adianta: a vez não é mais nossa.
// Os demais (botão errado, sem direção, força inválida) são corrigíveis.
const PERDEU_A_VEZ = new Set(['NOT_YOUR_TURN', 'STALE_TURN_TOKEN', 'GAME_NOT_RUNNING', 'GAME_FINISHED']);

const ESQUEMA_JOGADA = {
  type: 'object',
  properties: {
    buttonId: { type: 'string', description: 'id do seu botão, ex: A3' },
    anguloAro: { type: 'number', description: 'graus 0-359: onde a palheta encosta no aro. O botão sai a anguloAro+180.' },
    inclinacao: { type: 'number', description: 'graus 10-80. 45 = rasteiro e mais forte; ~65 levanta a bola ~7cm e passa por cima da caixa do goleiro; <25 escorrega.' },
    avanco: { type: 'number', description: '0-1: apoio da borda (0) ao centro (1). 0.35 rende mais.' },
    forca: { type: 'number', description: '0.05 a 1.0' },
    declararChute: { type: 'boolean', description: 'true para declarar chute a gol antes de bater (o adversário posicionará o goleiro)' },
    intencao: { type: 'string', description: 'uma frase curta explicando a jogada' },
  },
  required: ['buttonId', 'anguloAro', 'inclinacao', 'avanco', 'forca', 'declararChute', 'intencao'],
  additionalProperties: false,
};

const ESQUEMA_COBRANCA = {
  type: 'object',
  properties: {
    buttonId: { type: 'string', description: 'qual dos seus botões vai cobrar' },
    x: { type: 'number', description: 'x onde pôr esse botão, em cm' },
    y: { type: 'number', description: 'y onde pôr esse botão, em cm' },
    intencao: { type: 'string', description: 'uma frase curta explicando a escolha' },
  },
  required: ['buttonId', 'x', 'y', 'intencao'],
  additionalProperties: false,
};

const ESQUEMA_GOLEIRO = {
  type: 'object',
  properties: {
    x: { type: 'number', description: 'posição x do centro da caixa, em cm, dentro da sua área' },
    y: { type: 'number', description: 'posição y do centro da caixa, em cm, dentro da sua área' },
    anguloDeg: { type: 'number', description: '0 a 179: giro da caixa. 90 = atravessada na frente do gol; 0 = de lado (quase não cobre)' },
    intencao: { type: 'string', description: 'uma frase curta explicando a defesa' },
  },
  required: ['x', 'y', 'anguloDeg', 'intencao'],
  additionalProperties: false,
};

/** Pegada inicial: leve, apontada para a bola. É de onde o ajuste começa. */
function pegadaNeutra(estado, buttonId) {
  const bola = estado.bodies?.find((b) => b.id === 'ball');
  const bot = estado.bodies?.find((b) => b.id === buttonId);
  if (!bola || !bot) return { anguloAro: 0, inclinacao: 38, avanco: 0.28, forca: 0.3 };
  const dir = (Math.atan2(bola.y - bot.y, bola.x - bot.x) * 180) / Math.PI;
  return { ...palhetaDe(dir, 0.3), inclinacao: 38, avanco: 0.28 };
}

/* ------------------------------------------------------------------ */

async function carregarSDK() {
  try {
    const mod = await import('@anthropic-ai/sdk');
    return mod.default;
  } catch {
    console.error('\n  Falta o SDK. Rode:  npm install @anthropic-ai/sdk\n');
    process.exit(1);
  }
}

export class BotIA {
  constructor(cli, gameId, Anthropic) {
    this.cli = cli;
    this.gameId = gameId;
    this.anthropic = new Anthropic();
    this.plano = null;          // nota estratégica entre turnos
    this.acompanhamento = [];   // lances do adversário, coletados de graça
    this.gasto = { chamadas: 0, entrada: 0, saida: 0, cacheLido: 0 };
    this.ocupado = false;
  }

  contabiliza(resp) {
    const u = resp.usage || {};
    this.gasto.chamadas++;
    this.gasto.entrada += u.input_tokens || 0;
    this.gasto.saida += u.output_tokens || 0;
    this.gasto.cacheLido += u.cache_read_input_tokens || 0;
  }

  /** Chamada ao modelo, com uma tentativa sem os betas se eles não estiverem liberados. */
  async chamar(params) {
    try {
      return await this.anthropic.beta.messages.create({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (err) {
      const msg = String(err?.message || '');
      if (err?.status === 400 && /beta|fallback/i.test(msg)) {
        return this.anthropic.messages.create(params);
      }
      throw err;
    }
  }

  /** Decide a jogada olhando o frame + a descrição do estado. */
  async decidirJogada(estado, erroAnterior = null) {
    const conteudo = [];

    if (USAR_FRAME && estado.frame) {
      conteudo.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: estado.frame.data },
      });
    }

    const partes = [estado.description];
    if (this.plano) partes.push(`\nSEU PLANO DO TURNO ANTERIOR:\n${this.plano}`);
    if (this.acompanhamento.length) {
      partes.push(`\nO QUE ACONTECEU DESDE A SUA ÚLTIMA JOGADA:\n${this.acompanhamento.join('\n')}`);
    }
    if (erroAnterior) {
      partes.push(`\nATENÇÃO: sua jogada anterior foi RECUSADA pelo servidor: "${erroAnterior}". Corrija e mande outra.`);
    }
    partes.push('\nÉ a sua vez. Escolha o botão, o ponto de mira e a força.');

    conteudo.push({ type: 'text', text: partes.join('\n') });

    const resp = await this.chamar({
      model: MODELO,
      max_tokens: 16000,
      system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: conteudo }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: EFFORT,
        format: { type: 'json_schema', schema: ESQUEMA_JOGADA },
      },
    });

    this.contabiliza(resp);

    if (resp.stop_reason === 'refusal') {
      console.log('  [modelo recusou; usando a heurística de segurança]');
      return null;
    }

    const texto = resp.content.find((b) => b.type === 'text')?.text;
    if (!texto) return null;
    try { return JSON.parse(texto); } catch { return null; }
  }

  /**
   * Cobrança de lateral, escanteio ou tiro de meta: escolhe um botão e o
   * posiciona perto da bola antes de jogar.
   */
  async cobrar(estado) {
    const bola = estado.bodies.find((b) => b.id === 'ball');
    const raio = estado.cobranca?.raio ?? 18;

    let escolha = null;
    try {
      const resp = await this.chamar({
        model: MODELO,
        max_tokens: 4000,
        system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: `${estado.description}

A bola saiu e a cobrança do ${estado.cobranca?.tipo} é sua. Antes de jogar, escolha UM dos seus
botões e diga onde colocá-lo. Ele tem que ficar a até ${raio} cm da bola, que está em
(${bola.x}, ${bola.y}).

ATENÇÃO — o botão PODE e quase sempre DEVE ficar FORA DO CAMPO nesta hora.
A bola descansa em cima da linha. O botão sai na direção da reta
centro-do-botão -> centro-da-bola, então um botão do lado de DENTRO empurra a bola
para FORA e a lateral se repete. Ponha-o do lado de fora da linha, atrás da bola, e
mire para dentro do campo. Você tem ${estado.pitch?.margemFora ?? 18} cm de mesa além de
cada linha para trabalhar.

Botões disponíveis: ${(estado.posicionaveis || []).join(', ')}.`,
        }],
        thinking: { type: 'adaptive' },
        output_config: { effort: EFFORT, format: { type: 'json_schema', schema: ESQUEMA_COBRANCA } },
      });
      this.contabiliza(resp);
      if (resp.stop_reason !== 'refusal') {
        const texto = resp.content.find((b) => b.type === 'text')?.text;
        if (texto) escolha = JSON.parse(texto);
      }
    } catch (e) {
      console.error('  erro ao decidir a cobrança:', e.message);
    }

    if (!escolha || !(estado.posicionaveis || []).includes(escolha.buttonId)) {
      escolha = cobrancaHeuristica(estado);
      if (escolha) escolha.intencao = '(heurística de segurança)';
    }
    if (!escolha) { console.error('  sem cobrança possível'); return; }

    // O servidor recusa fora do raio; melhor já mandar dentro.
    const d = Math.hypot(escolha.x - bola.x, escolha.y - bola.y);
    if (d > raio) {
      const k = (raio - 0.5) / d;
      escolha.x = bola.x + (escolha.x - bola.x) * k;
      escolha.y = bola.y + (escolha.y - bola.y) * k;
    }

    await this.cli.cobrar(this.gameId, { buttonId: escolha.buttonId, x: escolha.x, y: escolha.y });
    await new Promise((r) => setTimeout(r, 400));
    await this.cli.cobrar(this.gameId, { buttonId: escolha.buttonId, x: escolha.x, y: escolha.y, confirmar: true });

    console.log(`  ${this.cli.name} > cobra ${estado.cobranca?.tipo} com ${escolha.buttonId} em (${Math.round(escolha.x)}, ${Math.round(escolha.y)})`);
    console.log(`     "${escolha.intencao}"`);
  }

  /** Onde pôr a caixa do goleiro. Decisão curta: só texto, sem imagem. */
  async decidirGoleiro(estado) {
    const time = estado.yourTeam;
    const area = estado.areaGoleiro?.[time];
    const k = estado.goleiros?.[time];
    const bola = estado.bodies.find((b) => b.id === 'ball');

    const resp = await this.chamar({
      model: MODELO,
      max_tokens: 4000,
      system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `${estado.description}

O ADVERSÁRIO DECLAROU CHUTE A GOL. Você posiciona a caixa do goleiro antes de ele bater.
A caixa mede ${k.w} x ${k.h} cm e está em (${k.x}, ${k.y}) a ${k.anguloDeg}deg.
Ela pode ficar com o centro em x de ${area.xMin} a ${area.xMax} e y de ${area.yMin} a ${area.yMax}.
A bola está em (${bola.x}, ${bola.y}) e o seu gol é a abertura em x=${time === 'A' ? 0 : 200}, y de 45 a 75.

A caixa é FIXA: ela não se move quando a bola bate. Cubra o ângulo mais provável do chute.
Lembre: se a bola tocar por último na sua caixa, a posse volta para você.`,
      }],
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: ESQUEMA_GOLEIRO } },
    });

    this.contabiliza(resp);
    if (resp.stop_reason === 'refusal') return null;
    const texto = resp.content.find((b) => b.type === 'text')?.text;
    if (!texto) return null;
    try { return JSON.parse(texto); } catch { return null; }
  }

  /** Fase do goleiro: decide, mostra a caixa se ajeitando, confirma. */
  async posicionarGoleiro(estado) {
    const time = estado.yourTeam;
    const area = estado.areaGoleiro[time];
    let pos = await this.decidirGoleiro(estado);

    if (!pos) {
      pos = posicaoDoGoleiroHeuristica(estado) || { x: (area.xMin + area.xMax) / 2, y: 60, anguloDeg: 90 };
      pos.intencao = '(heurística de segurança)';
    }
    // O servidor recusa fora da área; melhor mandar já dentro.
    pos.x = Math.max(area.xMin, Math.min(area.xMax, pos.x));
    pos.y = Math.max(area.yMin, Math.min(area.yMax, pos.y));

    await this.cli.goleiro(this.gameId, { x: pos.x, y: pos.y, anguloDeg: pos.anguloDeg });
    await new Promise((r) => setTimeout(r, 450));
    await this.cli.goleiro(this.gameId, { x: pos.x, y: pos.y, anguloDeg: pos.anguloDeg, confirmar: true });

    console.log(`  ${this.cli.name} > goleiro em (${Math.round(pos.x)}, ${Math.round(pos.y)}) a ${Math.round(pos.anguloDeg)}deg`);
    console.log(`     "${pos.intencao}"`);
  }

  /**
   * "Ir pensando enquanto os outros jogam": chamada curta, só texto,
   * que atualiza o plano. É opcional justamente porque gasta token.
   */
  async pensarAntes() {
    if (!PENSAR_ANTES || this.ocupado) return;
    try {
      const estado = await this.cli.state(this.gameId, { describe: true, history: 4 });
      if (estado.status !== 'running' || estado.yourTurn) return;

      const resp = await this.chamar({
        model: MODELO,
        max_tokens: 1200,
        system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: `${estado.description}\n\nNÃO é a sua vez agora. Em no máximo 3 frases, diga qual é o seu plano para quando a posse voltar: que botão usar, para onde levar a bola, e o que evitar.`,
        }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
      });
      this.contabiliza(resp);
      const t = resp.content.find((b) => b.type === 'text')?.text;
      if (t) { this.plano = t.trim(); console.log(`  [pensando] ${this.plano.replace(/\n/g, ' ')}`); }
    } catch (e) {
      console.error('  erro ao pensar antes:', e.message);
    }
  }

  async jogar() {
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      // Só AQUI puxamos o pacote caro (descrição + imagem).
      const estado = await this.cli.state(this.gameId, { describe: true, frame: USAR_FRAME, history: 6 });
      if (!estado.yourTurn || estado.status !== 'running') return;

      // Três fases: cobrar, posicionar o goleiro, ou jogar.
      // Na saída de bola arrumar é opcional: o bot simplesmente bate.
      if (estado.podeCobrar && !estado.cobrancaOpcional) {
        await this.cobrar(estado);
        return;
      }
      if (estado.podePosicionarGoleiro) {
        await this.posicionarGoleiro(estado);
        return;
      }

      let erro = null;
      let ultimaConf = null;    // de onde a palheta parte na próxima transmissão

      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        let jogada = await this.decidirJogada(estado, erro);

        if (!jogada) {
          jogada = decidirHeuristico(estado);
          if (!jogada) { console.error('  sem jogada possível'); return; }
          jogada.intencao = '(heurística de segurança)';
        }

        // Quer declarar? Declara e devolve: a vez volta depois que o
        // adversário posicionar o goleiro, e aí a jogada é escolhida de novo
        // já sabendo onde a caixa ficou.
        if (jogada.declararChute && estado.podeDeclarar) {
          await this.cli.declarar(this.gameId);
          console.log(`  ${this.cli.name} > DECLAROU chute a gol — "${jogada.intencao}"`);
          return;
        }

        const conf = jogada.palheta || {
          anguloAro: jogada.anguloAro,
          inclinacao: jogada.inclinacao,
          avanco: jogada.avanco,
          forca: jogada.forca,
        };

        try {
          // Transmite a configuração passo a passo. Na primeira tentativa parte
          // da pegada neutra; nas seguintes, parte de onde a palheta estava —
          // então dá para ver o modelo CORRIGINDO depois de uma recusa.
          const partida = ultimaConf || pegadaNeutra(estado, jogada.buttonId);
          await this.cli.mirarPassoAPasso(this.gameId, jogada.buttonId, [partida, conf],
            { suavizar: 5, intervalo: 110 });
          ultimaConf = conf;
          await new Promise((r) => setTimeout(r, 420));

          const r = await this.cli.move(this.gameId, {
            buttonId: jogada.buttonId,
            palheta: conf,
            turnToken: estado.turnToken,
          });
          console.log(`  ${this.cli.name} > ${jogada.buttonId} aro ${Math.round(conf.anguloAro)}° incl ${Math.round(conf.inclinacao)}° av ${Number(conf.avanco).toFixed(2)} f=${Number(conf.forca).toFixed(2)}`);
          console.log(`     "${jogada.intencao}"`);
          console.log(`     ${r.result.outcome}`);
          this.acompanhamento = [];
          this.plano = null;
          return;
        } catch (e) {
          // Perder a vez e escolher errado são coisas diferentes, e o servidor
          // agora diz qual é qual. Sem isso, um botão do adversário escolhido
          // pelo modelo entregava a posse de graça.
          if (PERDEU_A_VEZ.has(e.code)) { console.log(`  turno já passou (${e.message})`); return; }
          erro = e.message;
          console.log(`  jogada recusada (tentativa ${tentativa}): ${erro}`);
        }
      }
      console.error('  três tentativas recusadas, passando a vez');
    } catch (e) {
      console.error('  erro:', e.message);
    } finally {
      this.ocupado = false;
      this.relatorioGasto();
    }
  }

  relatorioGasto() {
    const g = this.gasto;
    console.log(`     [tokens] ${g.chamadas} chamadas | entrada ${g.entrada} (cache ${g.cacheLido}) | saída ${g.saida}`);
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  const Anthropic = await carregarSDK();

  const cli = new FutebolClient({
    base: args.base || 'http://localhost:3000',
    name: args.name || 'claude',
    password: senhaDeBot({ nome: args.name || 'claude', padrao: 'claude-secreto-1234', arg: args.password }),
    kind: 'ai',
    model: MODELO,          // aparece na mesa, no replay e na etiqueta da palheta
  });
  await cli.auth();
  configurarFisica(await cli.rules());

  let gameId = args.game;
  if (args.create) {
    const [sa, sb] = String(args.slots || '1x1').split('x').map(Number);
    const g = await cli.createGame({
      name: args.gameName || 'Claude joga',
      slotsA: sa || 1, slotsB: sb || 1,
      teamAName: args.teamA || 'Azuis', teamBName: args.teamB || 'Vermelhos',
      config: { buttonsPerTeam: Number(args.buttons || 5), maxPossessions: Number(args.possessions || 40) },
    });
    gameId = g.gameId;
    console.log(`\n  partida criada: ${gameId}`);
    console.log(`  assista em ${cli.base}/?game=${gameId}\n`);
  }
  if (!gameId) {
    const { games } = await cli.listGames();
    const livre = games.find((g) => g.status !== 'finished' && (g.teams.A.ocupadas < g.teams.A.slots || g.teams.B.ocupadas < g.teams.B.slots));
    if (!livre) { console.error('nenhuma partida com vaga. use --create ou --game <id>'); process.exit(1); }
    gameId = livre.gameId;
  }

  const entrada = await cli.join(gameId, args.team, !!args.autostart, args.convite || null);
  console.log(`[${cli.name}] time ${entrada.team} na partida ${gameId}`);

  const bot = new BotIA(cli, gameId, Anthropic);

  // O ponto central da economia de token: por padrão só o tópico privado.
  // Com --follow, o de eventos também — mas ele NÃO chama o modelo.
  const topicos = [`player/${cli.playerId}/turn`];
  if (ACOMPANHAR) topicos.push(`game/${gameId}/event`, `game/${gameId}/turn`);
  await cli.connectWS(topicos);
  console.log(`[${cli.name}] escutando ${topicos.join(', ')}`);

  cli.onEvent = (ev) => {
    if (!ev.texto) return;
    console.log(`  · ${ev.texto}`);
    bot.acompanhamento.push(ev.texto);
    if (bot.acompanhamento.length > 8) bot.acompanhamento.shift();
  };

  let ultimoTurnoVisto = 0;
  cli.on(`game/${gameId}/turn`, (p) => {
    if (!PENSAR_ANTES) return;
    if (p.currentPlayerId === cli.playerId) return;
    if (p.turnNo === ultimoTurnoVisto) return;
    ultimoTurnoVisto = p.turnNo;
    bot.pensarAntes();
  });

  // tratarVez não perde aviso e ainda sonda de reserva: com as regras novas o
  // jogador mantém a vez, e um aviso perdido custaria o turno inteiro.
  cli.tratarVez(gameId, () => bot.jogar());

  const st = await cli.state(gameId, { brief: true });
  if (st.currentPlayerId === cli.playerId) bot.jogar();

  process.on('SIGINT', () => {
    console.log('\n  total de tokens:', JSON.stringify(bot.gasto));
    cli.close();
    process.exit(0);
  });
}

// Importado (pelos testes), só exporta. Invocado direto, joga.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
