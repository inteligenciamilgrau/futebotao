// O som do estádio, feito na mão com WebAudio.
//
// Nenhum arquivo de áudio: ruído filtrado vira murmúrio de torcida, e o mesmo
// ruído com o filtro aberto e o volume alto vira o rugido do gol. Apito e
// tambor saem de osciladores. Assim o jogo continua sem nenhuma dependência
// e sem nenhum download.
//
// O navegador só deixa tocar depois de um gesto do usuário, então nada começa
// sozinho: `ligar()` tem que sair de um clique.

const dur = 2.5;                       // segundos de ruído em laço
const durImpacto = 0.5;                // segundos de ruído branco para as pancadas

// Faixa das velocidades de contato que o servidor manda. O piso é o filtro
// `speed > 12` do próprio servidor; o teto, 137, é o maior valor visto em 1500
// lances. Fora dela o ganho grampeia: uma pancada não fica infinitamente mais
// alta só porque a simulação passou do que já se mediu.
const VELOCIDADE_MINIMA = 12;
const VELOCIDADE_MAXIMA = 137;

// Janela mínima entre duas pancadas, para a carambola não virar zumbido. Vale
// para o lance inteiro, não para um par de peças.
//
// Medida com duas batidas iguais e o envelope em fatias de 5 ms: o vale entre
// os dois ataques cai de 24% do segundo ataque (a 15 ms de distância) para 11%
// (25 ms), 2% (40 ms) e 0% (60 ms). Fica em 60 ms, o primeiro valor em que a
// segunda batida ataca no silêncio; na carambola mais cheia já registrada —
// sete contatos num lance — isso entrega quatro pancadas em vez de sete.
const JANELA_IMPACTO = 0.06;

// Último recurso contra estouro, dentro de `colisao`. É MENOR que a janela de
// cima de propósito: quem agenda decide o que se ouve, e um teto igual ao dele
// engoliria por arredondamento pancadas que ele acabou de aprovar. Aqui só se
// impede o caso que distorce — vozes empilhadas no mesmo milissegundo.
const TETO_VOZES = 0.02;

// Quanto do mestre uma pancada de intensidade máxima pode ocupar. Não é gosto:
// medido. Com 0,66 a pancada mediana (v 63) sai com pico ~0,19 — acima da cama
// de torcida (0,058), no patamar do apito (0,206) — e o pior caso real, sete
// contatos a 137 seguidos, para em 0,35, longe do 1,0 que é distorção. O
// trecho de ruído é sorteado, então o pico oscila ~15% entre execuções: por
// isso a mira é o meio da faixa, e não a borda dela.
const PICO_IMPACTO = 0.66;

/**
 * Timbre de cada par que bate na mesa.
 *
 * `centro`/`q` moldam o ruído — é dele que vem o corpo da pancada; `clique` é o
 * oscilador que dá a borda do ataque; `queda` é o tempo até o silêncio. Acrílico
 * contra acrílico é o mais agudo e o mais curto; a bola oca abafa um pouco; a
 * caixa do goleiro é a maior peça da mesa e soa mais grave e mais longa.
 */
const TIMBRES = {
  'botão+botão': { centro: 3400, q: 1.1, clique: 2400, queda: 0.045, nivel: 1.00 },
  'bola+botão':  { centro: 2200, q: 1.0, clique: 1450, queda: 0.062, nivel: 0.92 },
  'caixa':       { centro: 1150, q: 0.9, clique:  620, queda: 0.095, nivel: 0.88 },
  // Variantes mais surdas do MESMO golpe: o botão batendo na borda da mesa e a
  // bola caindo no feltro. Nível bem mais baixo de propósito — são ruído de
  // fundo do lance, não o acontecimento dele.
  'mesa':        { centro:  760, q: 0.8, clique:  430, queda: 0.075, nivel: 0.55 },
  'quique':      { centro: 1500, q: 1.2, clique:  680, queda: 0.048, nivel: 0.45 },
};

const TIMBRE_PADRAO = 'bola+botão';    // o par mais frequente: 270 dos 337 contatos

// Nível do estalo da palheta, em `base + forca * escala`.
//
// São o par antigo (0,05 e 0,09) multiplicados pelo MESMO fator: a razão entre
// eles é o que separa o toque de leve da paulada, e ela já estava certa — forca
// 1,00 sai 2,57x forca 0,05. Errado estava o chão. Medido: com 0,05/0,09 o
// estalo saía com pico 0,046, ABAIXO da cama de torcida (0,058) — o som mais
// tocado da partida sumia debaixo do fundo. Assim ele sai perto de 0,17, entre
// o tambor (0,135) e o apito (0,206).
const PALHETA_BASE = 0.115;
const PALHETA_ESCALA = 0.207;

// Até onde o estalo vai: a mesma queda de 0,12 s de antes. O que muda é o
// conteúdo — ruído passa-alta no lugar da varredura que terminava em 220 Hz e
// devolvia um 'bop' grave, com 180 zc/s contra 4608 do apito.
const PALHETA_QUEDA = 0.12;
const PALHETA_CORTE = 2600;            // Hz do passa-alta: abaixo disso é abafado
const PALHETA_BORDA = 0.014;           // segundos do pico agudo que dá a borda

// A TRAVE — o único som do jogo que tem rabo.
//
// Uma pancada comum morre em 0,04 s, e é isso que a mantém no lugar dela: são
// 337 por partida. A trave é o oposto — 1,4 bolas e 5,4 botões por partida, o
// lance mais dramático que a mesa produz. Ela é uma barra presa na mesa e
// CONTINUA vibrando depois do choque; é o rabo que faz quem está jogando saber
// o que aconteceu sem precisar ler o registro.
//
// Duas partes: a batida (ruído agudo, curtíssimo, dá a borda do ataque) e o
// rabo, feito de parciais INARMÔNICOS. A inarmonia não é enfeite: parciais em
// razão inteira soam como nota, e nota afinada aqui vira campainha. Metal
// batido tem o espectro torto, e é o torto que soa como metal.
//
// Os níveis não são gosto: medidos. A trave tem que sair entre 0,15 e 0,30 de
// pico — abaixo disso ela some dentro do lance, acima ela começa a distorcer
// quando cai junto de uma pancada — e tem que sair ACIMA de uma `colisao`
// comum, senão não se distingue dela.
//
// Quem manda no pico são os PARCIAIS, e é de propósito: eles são
// determinísticos e sozinhos dão 0,25 sempre. A batida é a parte sorteada (o
// trecho de ruído muda a cada disparo); com ela em 0,34 o pico passeava de
// 0,23 a 0,35 — ora abaixo de uma colisão de sorte, ora estourando o teto de
// 0,30. Em 0,06 ela acrescenta até 0,03, e em seis renderizações o pico ficou
// entre 0,25 e 0,29, sempre acima da colisão da mesma rodada.
const TRAVE_BATIDA = 0.012;            // segundos do choque
const TRAVE_BATIDA_PICO = 0.06;
const TRAVE_CORTE = 3200;              // Hz do passa-alta da batida
const TRAVE_PARCIAIS = [
  { hz: 1250, nivel: 0.241, queda: 0.60 },
  { hz: 1970, nivel: 0.161, queda: 0.44 },
  { hz: 2830, nivel: 0.113, queda: 0.30 },
  { hz: 4180, nivel: 0.072, queda: 0.19 },
];

// Janela mínima entre duas traves. A bola raspa nos dois postes da mesma boca
// em poucos quadros, e dois rabos de 0,6 s empilhados deixam de ser trave e
// viram zumbido — além de somarem oito osciladores quase no mesmo instante.
const JANELA_TRAVE = 0.22;

// Último recurso dentro de `trave`, pelo mesmo motivo que TETO_VOZES existe
// dentro de `colisao`: MENOR que a janela de cima, para não engolir por
// arredondamento uma trave que o agendador acabou de aprovar, e grande o
// bastante para barrar o caso que estoura — dois rabos no mesmo quadro.
const TETO_TRAVE = 0.08;

/**
 * Intensidade de uma pancada, a partir da velocidade normal do contato.
 *
 * PURA e exportada de propósito: é o único pedaço do som que dá para conferir
 * sem ouvido, e `tests/som.test.mjs` confere os grampos e a faixa.
 *
 * A raiz não é enfeite. A energia do choque cresce com o QUADRADO da
 * velocidade e a audição comprime isso de volta; num mapeamento linear todo
 * contato do primeiro quartil (34 cm/s para baixo) sumia debaixo da torcida
 * enquanto os de 137 estouravam sozinhos. Com a raiz a batida mais forte fica
 * ~4x a mais fraca — diferença que se ouve, sem virar dois jogos diferentes.
 */
export function ganhoDeImpacto(velocidade) {
  const v = Number(velocidade);
  const grampeada = Number.isFinite(v)
    ? Math.max(VELOCIDADE_MINIMA, Math.min(VELOCIDADE_MAXIMA, v))
    : VELOCIDADE_MINIMA;
  const u = (grampeada - VELOCIDADE_MINIMA) / (VELOCIDADE_MAXIMA - VELOCIDADE_MINIMA);
  return 0.3 + 0.95 * Math.sqrt(u);
}

/**
 * Nível do estalo da palheta, a partir da força do golpe (0..1).
 *
 * PURA e exportada pelo mesmo motivo que `ganhoDeImpacto`: a razão entre o
 * toque de leve e a paulada é a única parte do estalo que se confere sem
 * ouvido, e `tests/som.test.mjs` a segura no lugar quando alguém mexer no nível.
 */
export function ganhoDePalheta(forca = 0.5) {
  const f = Number(forca);
  const grampeada = Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0.5;
  return PALHETA_BASE + grampeada * PALHETA_ESCALA;
}

/** Qual dos três timbres um par de peças produz. */
export function timbreDoPar(aKind, bKind) {
  // A trave é uma barra presa na mesa: bate seca e aguda, mesmo quando quem
  // bateu nela foi a bola.
  if (aKind === 'post' || bKind === 'post') return 'botão+botão';
  if (aKind === 'keeper' || bKind === 'keeper') return 'caixa';
  if (aKind === 'ball' || bKind === 'ball') return 'bola+botão';
  return 'botão+botão';
}

/**
 * Escolhe quais eventos da trajetória viram pancada, com que força e que timbre.
 *
 * PURA, e por isso testável: é aqui que mora o TETO de disparos. Sem ele um
 * lance de carambola agenda sete vozes em 30 ms, elas somam e o pico vai a 1,0
 * — que não é "alto", é distorção.
 *
 * @param {Array} eventos `traj.events` como o servidor manda
 * @param {number} janela segundos mínimos entre duas pancadas
 * @returns {Array<{t:number, velocidade:number, tipo:string}>} em ordem de tempo
 */
export function impactosAudiveis(eventos, janela = JANELA_IMPACTO) {
  if (!Array.isArray(eventos)) return [];

  const brutos = [];
  for (const e of eventos) {
    if (!e || !Number.isFinite(e.t)) continue;
    if (e.type === 'contact') {
      brutos.push({ t: e.t, velocidade: e.speed, tipo: timbreDoPar(e.aKind, e.bKind) });
    } else if (e.type === 'mesa') {
      // A borda não manda velocidade nenhuma; o baque dela é sempre o mesmo.
      brutos.push({ t: e.t, velocidade: 45, tipo: 'mesa' });
    } else if (e.type === 'quique') {
      brutos.push({ t: e.t, velocidade: e.forca, tipo: 'quique' });
    }
  }
  brutos.sort((a, b) => a.t - b.t);

  const saida = [];
  let ultimo = -Infinity;
  for (const i of brutos) {
    if (i.t - ultimo < janela) continue;
    saida.push(i);
    ultimo = i.t;
  }
  return saida;
}

/**
 * Quais contatos com a trave viram o som de trave, e quando.
 *
 * PURA e separada de `impactosAudiveis` de propósito: a trave NÃO é uma
 * pancada a mais na fila das 337. Ela tem janela própria — o rabo dura 0,6 s,
 * dez vezes uma pancada comum — e não pode ser descartada pela janela das
 * outras só porque um botão encostou noutro 40 ms antes.
 *
 * `bola` separa os dois casos que a partida produz: bola na trave (1,4 por
 * jogo) é o que tira o fôlego de quem está vendo; botão na trave (5,4) é só
 * uma peça batendo num poste.
 *
 * @param {Array} eventos `traj.events` como o servidor manda
 * @param {number} janela segundos mínimos entre duas traves
 * @returns {Array<{t:number, bola:boolean}>} em ordem de tempo
 */
export function travesAudiveis(eventos, janela = JANELA_TRAVE) {
  if (!Array.isArray(eventos)) return [];

  const brutos = [];
  for (const e of eventos) {
    if (!e || !Number.isFinite(e.t) || e.type !== 'contact') continue;
    if (e.aKind !== 'post' && e.bKind !== 'post') continue;
    brutos.push({ t: e.t, bola: e.aKind === 'ball' || e.bKind === 'ball' });
  }
  brutos.sort((a, b) => a.t - b.t);

  const saida = [];
  let ultimo = -Infinity;
  for (const i of brutos) {
    if (i.t - ultimo < janela) continue;
    saida.push(i);
    ultimo = i.t;
  }
  return saida;
}

export class TorcidaSom {
  constructor() {
    this.ctx = null;
    this.ligado = false;
    this.volume = 0.5;
    this.volumeMusica = 0.35;
    this.tocando = false;
    // Instante da última pancada JÁ agendada: ver o teto de vozes em `colisao`.
    this._ultimoImpacto = -Infinity;
    // O mesmo, para a trave: ver TETO_TRAVE.
    this._ultimaTrave = -Infinity;
  }

  /** Liga o som. Precisa vir de um clique/tecla do usuário. */
  async ligar() {
    if (this.ctx) {
      await this.ctx.resume();
      this.ligado = true;
      this._murmurio(0.16);
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;

    const ctx = new AC();
    this.ctx = ctx;

    this.mestre = ctx.createGain();
    this.mestre.gain.value = this.volume;
    this.mestre.connect(ctx.destination);

    // Fonte única de ruído rosa, em laço.
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const branco = Math.random() * 2 - 1;
      // Filtro de Voss simplificado: ruído rosa soa muito mais com "gente".
      b0 = 0.99765 * b0 + branco * 0.0990460;
      b1 = 0.96300 * b1 + branco * 0.2965164;
      b2 = 0.57000 * b2 + branco * 1.0526913;
      d[i] = (b0 + b1 + b2 + branco * 0.1848) * 0.22;
    }
    const fonte = ctx.createBufferSource();
    fonte.buffer = buf;
    fonte.loop = true;

    // Passa-banda: fecha para murmúrio, abre para rugido.
    this.filtro = ctx.createBiquadFilter();
    this.filtro.type = 'bandpass';
    this.filtro.frequency.value = 520;
    this.filtro.Q.value = 0.55;

    this.ganhoTorcida = ctx.createGain();
    this.ganhoTorcida.gain.value = 0;

    fonte.connect(this.filtro).connect(this.ganhoTorcida).connect(this.mestre);
    fonte.start();
    this.fonte = fonte;

    // Ruído BRANCO, curto, só para as pancadas. O rosa da torcida não serve
    // aqui: ele cai 3 dB por oitava, e é justamente em cima de 2 kHz que mora
    // o estalo do acrílico — filtrado dali, o rosa entrega sopro, não batida.
    this.ruidoImpacto = ctx.createBuffer(1, Math.floor(ctx.sampleRate * durImpacto), ctx.sampleRate);
    const di = this.ruidoImpacto.getChannelData(0);
    for (let i = 0; i < di.length; i++) di[i] = Math.random() * 2 - 1;

    this.ligado = true;
    this._murmurio(0.16);
    return true;
  }

  desligar() {
    this.ligado = false;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.ganhoTorcida.gain.cancelScheduledValues(t);
    this.ganhoTorcida.gain.setTargetAtTime(0, t, 0.25);
  }

  /* ---------------------------------------------------------------- */
  /* Música de fundo                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Toca a faixa de fundo, em laço.
   *
   * É um <audio> ligado ao grafo por `createMediaElementSource`, e não um
   * buffer decodificado: uma música inteira em `decodeAudioData` vira dezenas
   * de megabytes de PCM na memória e só começa depois de baixar tudo. O
   * elemento transmite enquanto baixa e repete sozinho.
   *
   * Ela tem GRAFO PRÓPRIO até a saída — não passa pelo `mestre`. É de
   * propósito: o volume da torcida e o volume da música são duas coisas, e
   * quem baixa a música para ouvir o jogo não quer perder o apito junto.
   */
  async musica(url = '/audio/maracana.mp3') {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
    }
    await this.ctx.resume();

    if (!this.audio) {
      const el = new Audio(url);
      el.loop = true;
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      this.audio = el;

      this.ganhoMusica = this.ctx.createGain();
      this.ganhoMusica.gain.value = this.volumeMusica ?? 0.35;
      this.ganhoMusica.connect(this.ctx.destination);
      this.ctx.createMediaElementSource(el).connect(this.ganhoMusica);
    }

    try {
      await this.audio.play();
      this.tocando = true;
      return true;
    } catch {
      // Arquivo ausente, formato não suportado ou gesto recusado: quem chamou
      // avisa na tela. O jogo não depende disto.
      this.tocando = false;
      return false;
    }
  }

  pararMusica() {
    this.audio?.pause();
    this.tocando = false;
  }

  alternarMusica() {
    if (this.tocando) { this.pararMusica(); return Promise.resolve(false); }
    return this.musica();
  }

  definirVolumeMusica(v) {
    this.volumeMusica = Math.max(0, Math.min(1, v));
    if (this.ganhoMusica) this.ganhoMusica.gain.value = this.volumeMusica;
  }

  /**
   * Abaixa a música por alguns segundos e devolve. Chamado no gol: música alta
   * por cima do rugido da torcida transforma os dois em barulho.
   */
  _abaixarMusica(segundos = 6) {
    if (!this.ganhoMusica || !this.tocando) return;
    const t = this.ctx.currentTime;
    const g = this.ganhoMusica.gain;
    const cheio = this.volumeMusica ?? 0.35;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(cheio * 0.22, t + 0.3);
    g.setValueAtTime(cheio * 0.22, t + segundos);
    g.setTargetAtTime(cheio, t + segundos, 1.4);
  }

  alternar() { return this.ligado ? (this.desligar(), false) : (this.ligar(), true); }

  definirVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.mestre) this.mestre.gain.value = this.volume;
  }

  /** Nível de fundo da torcida. */
  _murmurio(nivel, quando = 0.6) {
    if (!this.ctx || !this.ligado) return;
    const t = this.ctx.currentTime;
    this.ganhoTorcida.gain.cancelScheduledValues(t);
    this.ganhoTorcida.gain.setTargetAtTime(nivel, t, quando);
    this.filtro.frequency.cancelScheduledValues(t);
    this.filtro.frequency.setTargetAtTime(520, t, quando);
  }

  /**
   * Rugido: o filtro abre, o volume sobe e volta devagar.
   *
   * `quando` existe porque o gol CHEGA antes de acontecer. O servidor publica
   * o evento `goal` ANTES da trajetória (server/index.js), e a bola só cruza a
   * linha na mediana a 0,46 s dentro da fita — que por sua vez começa 0,19 s
   * depois, quando o taco encosta. Sem atraso a torcida gritava ~0,65 s antes
   * da bola entrar. Quem chama passa o `t` do evento `goal` da fita.
   *
   * A música abaixa na hora, e não em `quando`: são 0,3 s de rampa e ela tem
   * que estar fora do caminho QUANDO o rugido chegar, não depois.
   *
   * @param {number} quando atraso em segundos, no relógio do WebAudio
   */
  gol(quando = 0) {
    // Antes da guarda: a música pode estar tocando com o som da torcida
    // desligado, e nesse caso ela ainda tem que dar passagem ao gol.
    this._abaixarMusica();
    if (!this.ctx || !this.ligado) return;
    const atraso = Number.isFinite(Number(quando)) ? Math.max(0, Number(quando)) : 0;
    const t = this.ctx.currentTime + atraso;
    const g = this.ganhoTorcida.gain, f = this.filtro.frequency;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.85, t + 0.35);
    g.setValueAtTime(0.85, t + 3.2);
    g.setTargetAtTime(0.16, t + 3.2, 2.4);

    f.cancelScheduledValues(t);
    f.setValueAtTime(f.value, t);
    f.linearRampToValueAtTime(1500, t + 0.4);
    f.setTargetAtTime(520, t + 3.4, 2.2);

    this.apito(atraso + 0.35, 3);
    for (let i = 0; i < 10; i++) this.tambor(atraso + 0.9 + i * 0.42);
  }

  /** Ooooh — a torcida quase vibra: quase-gol, bola na trave. */
  suspiro() {
    if (!this.ctx || !this.ligado) return;
    const t = this.ctx.currentTime;
    const g = this.ganhoTorcida.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.42, t + 0.2);
    g.setTargetAtTime(0.16, t + 0.7, 0.9);
  }

  /**
   * Murmúrio de decepção: o mesmo bolo de gente do `suspiro`, mas curto e
   * baixo. Não tem síntese nova nenhuma — é a MESMA cama de ruído rosa com
   * outro envelope, como o `gol` e o `suspiro` também são.
   *
   * Existe porque o desfecho mais frequente da partida é o pior de todos para
   * repetir um 'ooooh' de quase-gol: a bicuda no vento, 33,8 por jogo. Quem
   * errou o botão inteiro não merece a mesma reação de quem quase fez o gol —
   * e ouvir o 'ooooh' trinta vezes por partida o gastaria até não significar
   * mais nada. Metade da altura (0,26 contra 0,42) e um terço do tempo até
   * começar a voltar (0,28 s contra 0,70 s).
   */
  desanimo() {
    if (!this.ctx || !this.ligado) return;
    const t = this.ctx.currentTime;
    const g = this.ganhoTorcida.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.26, t + 0.12);
    g.setTargetAtTime(0.16, t + 0.28, 0.35);
  }

  /** Apito do juiz. */
  apito(atraso = 0, repeticoes = 1) {
    if (!this.ctx || !this.ligado) return;
    const t0 = this.ctx.currentTime + atraso;
    for (let i = 0; i < repeticoes; i++) {
      const t = t0 + i * 0.28;
      const o = this.ctx.createOscillator();
      const o2 = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'triangle'; o.frequency.value = 2380;
      o2.type = 'triangle'; o2.frequency.value = 2960;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.02);
      g.gain.setTargetAtTime(0, t + 0.16, 0.05);
      o.connect(g); o2.connect(g); g.connect(this.mestre);
      o.start(t); o2.start(t);
      o.stop(t + 0.4); o2.stop(t + 0.4);
    }
  }

  /** Tambor da torcida. */
  tambor(atraso = 0) {
    if (!this.ctx || !this.ligado) return;
    const t = this.ctx.currentTime + atraso;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.16);
    g.gain.setValueAtTime(0.28, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g); g.connect(this.mestre);
    o.start(t); o.stop(t + 0.35);
  }

  /**
   * Estalo seco da palheta batendo no botão.
   *
   * É o som mais tocado da partida — um por lance, ~300 por jogo — e por muito
   * tempo era o mais fraco: pico 0,046 contra 0,058 da cama de torcida, ou
   * seja, ninguém ouvia. Agora nasce entre o tambor e o apito.
   *
   * O timbre é o de `colisao`, e não por preguiça: acrílico batendo em
   * acrílico é transiente largo e agudo, não nota. A varredura descendente que
   * morava aqui acabava em 220 Hz — grave e tonal, um 'bop'. Ruído branco pelo
   * passa-alta dá o corpo; um pulso curto de oscilador fixo dá a borda.
   *
   * @param {number} forca 0..1, como o jogador ajustou a palheta
   * @param {number} quando atraso em segundos, no relógio do WebAudio
   */
  palheta(forca = 0.5, quando = 0) {
    if (!this.ctx || !this.ligado || !this.ruidoImpacto) return;
    const atraso = Number.isFinite(Number(quando)) ? Math.max(0, Number(quando)) : 0;
    const t = this.ctx.currentTime + atraso;
    const pico = ganhoDePalheta(forca);
    const fim = t + PALHETA_QUEDA;

    // O corpo: ruído branco com o grave cortado fora. Começa num ponto sorteado
    // do buffer para dois lances seguidos não saírem com a mesma forma de onda.
    const fonte = this.ctx.createBufferSource();
    fonte.buffer = this.ruidoImpacto;
    const alta = this.ctx.createBiquadFilter();
    alta.type = 'highpass';
    alta.frequency.value = PALHETA_CORTE;
    alta.Q.value = 0.7;
    const gr = this.ctx.createGain();
    gr.gain.setValueAtTime(pico, t);
    gr.gain.exponentialRampToValueAtTime(0.0006, fim);
    fonte.connect(alta).connect(gr).connect(this.mestre);
    fonte.start(t, Math.random() * (durImpacto - PALHETA_QUEDA - 0.02));
    fonte.stop(fim);

    // A borda do ataque: pulso curtíssimo de oscilador, frequência FIXA e bem
    // acima do corte. Sem ele o ruído sozinho sai como sopro, não como estalo.
    const fimBorda = t + PALHETA_BORDA;
    const o = this.ctx.createOscillator();
    const go = this.ctx.createGain();
    o.type = 'square';
    o.frequency.value = 3300;
    go.gain.setValueAtTime(pico * 0.4, t);
    go.gain.exponentialRampToValueAtTime(0.0006, fimBorda);
    o.connect(go).connect(this.mestre);
    o.start(t);
    o.stop(fimBorda + 0.004);
  }

  /**
   * A pancada de um contato: acrílico contra acrílico, contra a bola ou contra
   * a caixa do goleiro.
   *
   * É de LONGE o som mais frequente da partida — 337 impactos por partida
   * contra 3,6 gols — e por isso tem que ser curto e ficar no lugar dele:
   * ataque na primeira amostra, corpo de ruído filtrado e silêncio antes de
   * 0,12 s. Nada de varredura tonal como a da palheta: varredura repetida 337
   * vezes deixa de ser estalo e vira miado.
   *
   * @param {number} velocidade velocidade normal do contato, em cm/s (12..137)
   * @param {string} tipo chave de TIMBRES
   * @param {number} quando atraso em segundos, no relógio do WebAudio
   */
  colisao(velocidade = 63, tipo = TIMBRE_PADRAO, quando = 0) {
    if (!this.ctx || !this.ligado || !this.ruidoImpacto) return;
    const timbre = TIMBRES[tipo] || TIMBRES[TIMBRE_PADRAO];
    const atraso = Number.isFinite(quando) ? Math.max(0, quando) : 0;
    const t = this.ctx.currentTime + atraso;

    // Teto de vozes por dentro: quem agenda já espaça as pancadas, mas basta um
    // chamador esquecer disso para vinte osciladores caírem no mesmo
    // milissegundo, somarem e estourarem. A comparação é com o instante
    // AGENDADO — e só para frente, senão um lance novo que começa enquanto o
    // anterior ainda tem som na fila sairia mudo inteiro.
    const desdeAnterior = t - this._ultimoImpacto;
    if (desdeAnterior >= 0 && desdeAnterior < TETO_VOZES) return;
    this._ultimoImpacto = t;

    const pico = ganhoDeImpacto(velocidade) * timbre.nivel * PICO_IMPACTO;
    const fim = t + timbre.queda;

    // O corpo: ruído branco pela banda do material. Começa num ponto sorteado
    // do buffer para duas batidas seguidas não saírem com a mesma forma de onda.
    const fonte = this.ctx.createBufferSource();
    fonte.buffer = this.ruidoImpacto;
    const banda = this.ctx.createBiquadFilter();
    banda.type = 'bandpass';
    banda.frequency.value = timbre.centro;
    banda.Q.value = timbre.q;
    const gr = this.ctx.createGain();
    gr.gain.setValueAtTime(pico, t);
    gr.gain.exponentialRampToValueAtTime(0.0004, fim);
    fonte.connect(banda).connect(gr).connect(this.mestre);
    fonte.start(t, Math.random() * (durImpacto - timbre.queda - 0.02));
    fonte.stop(fim);

    // A borda do ataque: um pulso de oscilador curtíssimo. Frequência FIXA —
    // é ele que faz a diferença entre "pancada" e "sopro", e uma varredura
    // aqui devolveria o miado que a palheta tem.
    const fimClique = t + Math.min(0.016, timbre.queda);
    const o = this.ctx.createOscillator();
    const go = this.ctx.createGain();
    o.type = 'square';
    o.frequency.value = timbre.clique;
    go.gain.setValueAtTime(pico * 0.45, t);
    go.gain.exponentialRampToValueAtTime(0.0004, fimClique);
    o.connect(go).connect(this.mestre);
    o.start(t);
    o.stop(fimClique + 0.004);
  }

  /**
   * A trave: pancada metálica que RESSOA.
   *
   * É o contrário de `colisao` de propósito. Lá o trabalho era caber 337 vezes
   * por partida sem virar zumbido, e por isso tudo morre em 0,04 s. Aqui são
   * sete acontecimentos por jogo, e o que precisa ficar claro é justamente que
   * NÃO foi mais uma pancada: o rabo de meio segundo é o que diz, sem palavra
   * nenhuma, que a bola bateu no poste.
   *
   * O ataque continua sendo ruído — é o que separa pancada de nota. O rabo é
   * de osciladores, porque ruído filtrado não sustenta: um passa-banda com Q
   * alto o bastante para ressoar meio segundo já é um oscilador com passos a
   * mais. Todos param: `stop()` no fim de cada queda, senão sete traves por
   * partida deixariam 28 vozes penduradas.
   *
   * @param {number} quando atraso em segundos, no relógio do WebAudio
   */
  trave(quando = 0) {
    if (!this.ctx || !this.ligado || !this.ruidoImpacto) return;
    const atraso = Number.isFinite(Number(quando)) ? Math.max(0, Number(quando)) : 0;
    const t = this.ctx.currentTime + atraso;

    // Teto de vozes, igual ao de `colisao` e pelo mesmo motivo — só que aqui
    // cada disparo custa cinco vozes, não duas. A comparação é com o instante
    // AGENDADO, e só para frente: um lance novo que comece com som antigo
    // ainda na fila não pode sair mudo por causa disso.
    const desdeAnterior = t - this._ultimaTrave;
    if (desdeAnterior >= 0 && desdeAnterior < TETO_TRAVE) return;
    this._ultimaTrave = t;

    // A batida: ruído branco com o grave fora. Começa num ponto sorteado do
    // buffer para duas traves seguidas não saírem com a mesma forma de onda.
    const fimBatida = t + TRAVE_BATIDA;
    const fonte = this.ctx.createBufferSource();
    fonte.buffer = this.ruidoImpacto;
    const alta = this.ctx.createBiquadFilter();
    alta.type = 'highpass';
    alta.frequency.value = TRAVE_CORTE;
    alta.Q.value = 0.7;
    const gb = this.ctx.createGain();
    gb.gain.setValueAtTime(TRAVE_BATIDA_PICO, t);
    gb.gain.exponentialRampToValueAtTime(0.0005, fimBatida);
    fonte.connect(alta).connect(gb).connect(this.mestre);
    fonte.start(t, Math.random() * (durImpacto - TRAVE_BATIDA - 0.02));
    fonte.stop(fimBatida);

    // O rabo: os parciais inarmônicos. Os agudos morrem primeiro, os graves
    // seguram o fim — é assim que metal batido perde brilho enquanto ainda
    // soa, e é o que impede o rabo de virar um zumbido de altura constante.
    for (const parcial of TRAVE_PARCIAIS) {
      const fim = t + parcial.queda;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.value = parcial.hz;
      g.gain.setValueAtTime(parcial.nivel, t);
      g.gain.exponentialRampToValueAtTime(0.0004, fim);
      o.connect(g).connect(this.mestre);
      o.start(t);
      o.stop(fim + 0.01);
    }
  }
}
