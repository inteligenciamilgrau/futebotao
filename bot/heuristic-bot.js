// Bot heurístico: joga sozinho, sem LLM. Serve de sparring e de baseline.
//
//   node bot/heuristic-bot.js --game gm_xxx --name sparring --password 1234 [--team B]
//   --convite cvt_xxx entra numa vaga guardada para IA (POST /aguardar)
//   node bot/heuristic-bot.js --create --slots 1x1     (cria e espera adversário)

import { FutebolClient, dist, blockers, caixaLivre, pontoDeAtaque, parseArgs, senhaDeBot } from './client.js';

const args = parseArgs();

const PITCH = { length: 200, width: 120, goalMin: 45, goalMax: 75 };
let R_BOTAO = 2.4, R_BOLA = 1.15;

// Constantes físicas — sobrescritas por GET /api/rules na inicialização.
const FIS = {
  g: 981, muButton: 0.16, muBall: 0.13,
  mButton: 1.0, mBall: 0.45, e: 0.62,
  maxShot: 170, minShot: 10,
};

export function configurarFisica(rules) {
  if (!rules?.physics) return;
  const p = rules.physics;
  R_BOTAO = p.buttonRadius ?? R_BOTAO;
  R_BOLA = p.ballRadius ?? R_BOLA;
  FIS.muButton = p.muButton ?? FIS.muButton;
  FIS.muBall = p.muBall ?? FIS.muBall;
  FIS.e = p.restitutionBody ?? FIS.e;
  FIS.maxShot = p.maxShotSpeed ?? FIS.maxShot;
  if (rules.pitch) { PITCH.goalMin = rules.pitch.goalMin; PITCH.goalMax = rules.pitch.goalMax; PITCH.length = rules.pitch.length; PITCH.width = rules.pitch.width; }
}

/**
 * Força necessária para o disco correr `distDisco` e ainda mandar a bola
 * `corridaBola`. Deduzido do modelo do servidor em vez de chutado:
 *   v_bola  = sqrt(2 * mu_bola * g * corrida)
 *   impulso = (1+e) * v_impacto / (1/m_disco + 1/m_bola)
 *   v0      = sqrt(v_impacto^2 + 2 * mu_disco * g * distDisco)
 */
export function forcaBruta(distDisco, corridaBola) {
  const vBola = Math.sqrt(2 * FIS.muBall * FIS.g * Math.max(1, corridaBola));
  const totInv = 1 / FIS.mButton + 1 / FIS.mBall;
  const vImpacto = (vBola * totInv * FIS.mBall) / (1 + FIS.e);
  const v0 = Math.sqrt(vImpacto * vImpacto + 2 * FIS.muButton * FIS.g * Math.max(0, distDisco));
  return (v0 - FIS.minShot) / (FIS.maxShot - FIS.minShot);
}

/** Igual, já limitada a [0.06, 1]. Acima de 1 a jogada não é alcançável. */
export function forcaPara(distDisco, corridaBola) {
  return Math.round(Math.min(1, Math.max(0.06, forcaBruta(distDisco, corridaBola))) * 100) / 100;
}

/**
 * Palheta que lança o botão na direção pedida. O bot sempre usa o apoio ótimo
 * (45° / 0.35): errar de propósito só perderia rendimento.
 */
export function palhetaDe(direcaoGraus, forca) {
  return {
    anguloAro: Math.round((((direcaoGraus + 180) % 360) + 360) % 360 * 10) / 10,
    inclinacao: 45,
    avanco: 0.35,
    forca,
  };
}

const dentroDaMesa = (p, r = R_BOTAO) =>
  p.x > r && p.x < PITCH.length - r && p.y > r && p.y < PITCH.width - r;

/** Quanto a bola corre na direção `dir` antes de bater numa tabela. */
function ateAParede(bola, dir) {
  let melhor = Infinity;
  if (dir.x > 1e-6) melhor = Math.min(melhor, (PITCH.length - R_BOLA - bola.x) / dir.x);
  if (dir.x < -1e-6) melhor = Math.min(melhor, (R_BOLA - bola.x) / dir.x);
  if (dir.y > 1e-6) melhor = Math.min(melhor, (PITCH.width - R_BOLA - bola.y) / dir.y);
  if (dir.y < -1e-6) melhor = Math.min(melhor, (R_BOLA - bola.y) / dir.y);
  return Math.max(0, melhor);
}

/** A bola indo em `dir` entra no gol adversário sem obstáculo? */
function chuteAGol(bola, dir, golX, corpos) {
  const dx = golX - bola.x;
  if (dx * dir.x <= 0 || Math.abs(dir.x) < 1e-6) return null;
  const t = dx / dir.x;
  const y = bola.y + dir.y * t;
  if (y < PITCH.goalMin + 2 || y > PITCH.goalMax - 2) return null;
  const alvo = { x: golX, y };
  const barreiras = blockers(bola, alvo, corpos, ['ball'], R_BOLA);
  return { dist: t, y, barreiras: barreiras.length };
}

/**
 * Busca sobre (botão x direção de saída da bola).
 * Mirar sempre no gol falha quando a bola está encostada na tabela: o ponto de
 * contato cai fora da mesa e nenhum botão consegue ocupá-lo. Por isso avaliamos
 * várias direções e escolhemos a melhor viável.
 */
/**
 * Escolhe a jogada.
 *
 * O que guia a escolha é uma coisa só: **a vez não passa enquanto você não
 * erra**. Errar é mandar a bola para fora, não encostar nela, ou acertar um
 * adversário antes dela. Então a jogada certa quase nunca é a mais forte — é a
 * que avança o máximo possível SEM correr nenhum desses riscos, e que deixa a
 * bola perto de um botão nosso para o toque seguinte.
 *
 * A versão anterior pontuava só a DIREÇÃO do chute e usava uma corrida fixa de
 * 42 cm. Ela mandava a bola para fora sozinha e entregava a posse de graça.
 */
export function decidir(estado) {
  const meuTime = estado.yourTeam;
  if (!meuTime || !estado.controllable?.length) return null;

  const bola = estado.bodies.find((b) => b.id === 'ball');
  const golX = meuTime === 'A' ? PITCH.length : 0;
  const meuGolX = meuTime === 'A' ? 0 : PITCH.length;
  const corpos = estado.bodies.filter((b) => b.kind !== 'ball');
  const meus = estado.bodies.filter((b) => b.kind === 'button' && b.team === meuTime);
  const deles = estado.bodies.filter((b) => b.kind === 'button' && b.team !== meuTime);

  // Quanto a bola precisa andar para chegar ao gol: é a escala das notas.
  const distGol = Math.abs(golX - bola.x);

  const candidatas = [];
  for (const y of [PITCH.goalMin + 6, PITCH.width / 2, PITCH.goalMax - 6]) {
    const dx = golX - bola.x, dy = y - bola.y, m = Math.hypot(dx, dy) || 1;
    candidatas.push({ x: dx / m, y: dy / m });
  }
  for (let a = 0; a < 360; a += 12) {
    candidatas.push({ x: Math.cos((a * Math.PI) / 180), y: Math.sin((a * Math.PI) / 180) });
  }

  let melhor = null;
  const avaliados = [];

  for (const dir of candidatas) {
    const contato = { x: bola.x - dir.x * (R_BOLA + R_BOTAO), y: bola.y - dir.y * (R_BOLA + R_BOTAO) };
    if (!dentroDaMesa(contato)) continue;

    // ATÉ ONDE A BOLA PODE IR sem sair. Este é o número que faltava: passar
    // disso é perder a posse, e não adianta nota nenhuma depois.
    const ateSair = ateAParede(bola, dir);
    if (ateSair < 8) continue;                       // encostada na linha: não serve

    const gol = chuteAGol(bola, dir, golX, corpos);

    // Quanto queremos que a bola corra nesta direção. Sempre com folga da
    // linha: a bola tem de PARAR dentro, não raspar.
    const folga = 10;
    const desejada = gol && gol.barreiras === 0
      ? gol.dist + 14                                 // no gol dá para ir com tudo
      : Math.min(58, Math.max(14, ateSair - folga));
    if (!gol && desejada < 12) continue;              // avanço ridículo, não vale o risco

    const corrida = Math.min(desejada, gol ? desejada : ateSair - folga);
    const parada = { x: bola.x + dir.x * corrida, y: bola.y + dir.y * corrida };

    // 1) Avanço de verdade: o quanto a bola fica MAIS PERTO do gol deles.
    const distDepois = Math.hypot(golX - parada.x, PITCH.width / 2 - parada.y);
    const distAntes = Math.hypot(golX - bola.x, PITCH.width / 2 - bola.y);
    let nota = (distAntes - distDepois) * 1.6;

    // 2) Gol livre vale mais do que qualquer avanço.
    if (gol) nota += gol.barreiras === 0 ? 220 - gol.dist * 0.2 : 20;

    // 3) A bola tem de parar longe da linha. Raspar é meio caminho para a
    //    lateral no toque seguinte, que é quando se perde a vez.
    const margem = Math.min(parada.x, PITCH.length - parada.x, parada.y, PITCH.width - parada.y);
    if (margem < 14) nota -= (14 - margem) * 4;

    // 4) Deixar a bola perto de um botão NOSSO: é com ele que se continua.
    const meuPerto = meus.reduce((m2, b) => Math.min(m2, dist(b, parada)), Infinity);
    nota -= Math.min(40, meuPerto * 0.55);

    // 5) E longe dos deles, que ganham a bola se ela morrer no pé deles.
    const delesPerto = deles.reduce((m2, b) => Math.min(m2, dist(b, parada)), Infinity);
    if (delesPerto < 14) nota -= (14 - delesPerto) * 2.5;

    // 6) Nunca na direção do nosso próprio gol.
    if (Math.abs(meuGolX - parada.x) < Math.abs(meuGolX - bola.x) - 6) nota -= 30;

    for (const id of estado.controllable) {
      const b = estado.bodies.find((x) => x.id === id);
      if (!b) continue;

      // QUEM ESTÁ NO CAMINHO MUDA TUDO, e não é detalhe de ajuste fino.
      //
      // Encostar num ADVERSÁRIO antes da bola é falta: perde a vez e ainda
      // anula o gol. Encostar num botão NOSSO não é falta nenhuma — no pior
      // caso desvia o disco. Antes os dois pesavam igual, -90 por barreira.
      //
      // O preço disso, medido em 1800 lances: quando o bot escolhia um botão
      // com adversário no caminho, mantinha a posse em 41% dos lances e fazia
      // falta em 32%; com o caminho limpo, 70% e 2%. E em METADE dessas vezes
      // havia outro botão com caminho livre — inclusive quando quem barrava
      // era a caixa do goleiro, que é a maior barreira da mesa e fica bem na
      // frente de quem vai chutar.
      const barreiras = blockers(b, contato, corpos, [b.id], b.r);
      const d = dist(b, contato);

      // E o disco precisa CHEGAR: acima de força 1 ele morre no caminho e o
      // toque não acontece, que é o outro jeito de perder a vez.
      const bruta = forcaBruta(d, corrida);
      const inalcancavel = bruta > 0.95 ? Math.min(3, bruta) * 200 : 0;

      // O RISCO cresce com a distância, e não linearmente. A bola oferece só
      // R_BOLA+R_BOTAO de alvo, então a tolerância angular é atan(3.55/d): a 16 cm
      // sobra folga, a 40 cm meio grau de desvio já erra. E errar a bola entrega a
      // vez de graça — medimos: 87% das falhas de contato vinham de tacadas de
      // mais de 20 cm.
      const risco = Math.pow(Math.max(0, d - 16), 1.6) * 0.65;

      // O peso é por QUEM barra, e cada número tem uma conta atrás:
      //   caixa do goleiro, 300 — tem de vencer o bônus de gol livre (+220),
      //     senão um chute barrado pelo goleiro ganha de um chute limpo. É a
      //     barreira mais comum e a maior de todas, e era a que passava batido.
      //   outro adversário, 150 — é falta na mesma, mas um botão é pequeno e
      //     a linha pode passar de raspão; 150 basta para perder de qualquer
      //     alternativa limpa a distância parecida.
      //   botão nosso, 90 — não é falta, só desvio. Fica como estava.
      //
      // Subir tudo para 900 foi tentado e REPROVADO: a penalidade ficou tão
      // grande que passou a decidir a DIREÇÃO do lance, não só quem chuta, e
      // as trocas de posse pioraram.
      //
      // Em 30 partidas (9000 lances), com a subida do risco logo acima:
      //   falta          361 (12%)  ->  195 (7%)
      //   gols/partida     4,03     ->  4,47
      //   trocas de posse  2917     ->  2944   (empate)
      // Ou seja: quase metade das faltas some sem custar posse nenhuma.
      let pena = 0;
      for (const id of barreiras) {
        const o = corpos.find((c) => c.id === id);
        if (!o || !o.team || o.team === meuTime) { pena += 90; continue; }
        pena += o.forma === 'caixa' ? 300 : 150;
      }
      const notaFinal = nota - pena - risco - inalcancavel;

      const cand = {
        nota: notaFinal, id, body: b, contato, dir, d, gol, corrida, parada,
        corridaDesejada: corrida,
        livre: barreiras.length === 0 && bruta <= 0.95,
      };
      if (cand.livre) avaliados.push(cand);
      if (!melhor || notaFinal > melhor.nota) melhor = cand;
    }
  }

  // Nada viável: encosta na bola de leve, só para não perder a posse por falta
  // de contato. Toque curto, porque um toque forte no escuro manda para fora.
  //
  // Foi tentado, aqui, escolher o melhor candidato de caminho limpo em vez de
  // cair neste toque — e REPROVADO: o toque curto acerta a bola quase sempre,
  // e o "melhor limpo" costuma ser uma tacada longa que erra. O `sem_contato`
  // saltou de 11% para 35% dos lances. Quando não há jogada boa, poucos
  // centímetros valem mais que uma tentativa bonita.
  if (!melhor || !melhor.livre) {
    let perto = null;
    for (const id of estado.controllable) {
      const b = estado.bodies.find((x) => x.id === id);
      if (!b) continue;
      // Mesma distinção de cima: adversário no caminho é falta, botão nosso não.
      const noCaminho = blockers(b, bola, corpos, [b.id], b.r);
      const adv = noCaminho.filter((cid) => {
        const o = corpos.find((c) => c.id === cid);
        return o && o.team && o.team !== meuTime;
      }).length;
      const nota = -adv * 400 - (noCaminho.length - adv) * 40 - dist(b, bola);
      if (!perto || nota > perto.nota) perto = { id, body: b, nota };
    }
    if (!perto) return null;
    const d = dist(perto.body, bola);
    const dirFallback = (Math.atan2(bola.y - perto.body.y, bola.x - perto.body.x) * 180) / Math.PI;
    return {
      buttonId: perto.id,
      palheta: palhetaDe(dirFallback, forcaPara(d, 18)),
      turnToken: estado.turnToken,
      _motivo: 'sem ângulo bom: toque curto para manter a posse',
    };
  }

  let dx, dy;
  if (melhor.d < 4) {
    dx = melhor.dir.x; dy = melhor.dir.y;
  } else {
    dx = (melhor.contato.x - melhor.body.x) / melhor.d;
    dy = (melhor.contato.y - melhor.body.y) / melhor.d;
  }

  let power = forcaPara(melhor.d, melhor.corridaDesejada);
  const direcao = (Math.atan2(dy, dx) * 180) / Math.PI;

  // Chute a gol com a caixa do goleiro no caminho: tenta por cima. A bola só
  // passa dos 5 cm da caixa entre ~9 e ~22 cm depois do toque, então isto só
  // vale a essa distância — de perto ou de longe ela bate mesmo.
  let inclinacao = 45;
  if (melhor.gol && melhor.gol.barreiras > 0 && melhor.gol.dist > 10 && melhor.gol.dist < 24) {
    inclinacao = 64;
    // A palheta em pé rende ~74% do que renderia a 45°, e forcaPara não sabe
    // disso. Sem compensar, o disco morre antes da bola e o toque nem acontece.
    power = Math.min(1, Math.round((power / 0.74) * 100) / 100);
  }

  const alternativas = avaliados
    .filter((c) => c !== melhor)
    .sort((a, b2) => b2.nota - a.nota)
    .slice(0, 3)
    .reverse()
    .map((c) => {
      const dd = c.d < 4 ? c.dir : { x: (c.contato.x - c.body.x) / c.d, y: (c.contato.y - c.body.y) / c.d };
      return {
        buttonId: c.id,
        palheta: palhetaDe((Math.atan2(dd.y, dd.x) * 180) / Math.PI, forcaPara(c.d, c.corridaDesejada)),
        nota: Math.round(c.nota),
      };
    })
    .filter((c) => c.buttonId === melhor.id);

  const p = palhetaDe(direcao, power);
  return {
    buttonId: melhor.id,
    palheta: { ...p, inclinacao },
    alternativas,
    turnToken: estado.turnToken,
    _motivo: melhor.gol
      ? `chute a gol de ${Math.round(melhor.gol.dist)} cm${inclinacao > 50 ? ', por cima da caixa' : ''}`
      : `avança ${Math.round(melhor.corrida)} cm e para a ${Math.round(Math.min(
          melhor.parada.x, PITCH.length - melhor.parada.x,
          melhor.parada.y, PITCH.width - melhor.parada.y))} cm da linha`,
  };
}

export function posicaoDoGoleiro(estado) {
  const meuTime = estado.yourTeam;
  const area = estado.areaGoleiro?.[meuTime];
  const bola = estado.bodies.find((b) => b.id === 'ball');
  if (!area || !bola) return null;

  const golX = meuTime === 'A' ? 0 : PITCH.length;
  const centro = { x: golX, y: PITCH.width / 2 };

  // Ângulo da reta bola -> gol; a caixa fica perpendicular a ela.
  const ang = Math.atan2(centro.y - bola.y, centro.x - bola.x);
  const perpend = ((ang * 180) / Math.PI + 90 + 360) % 180;

  // Sai da linha na direção da bola, sem passar da área.
  const avanco = meuTime === 'A' ? area.xMin + 4 : area.xMax - 4;
  const yIdeal = Math.max(area.yMin + 2, Math.min(area.yMax - 2,
    PITCH.width / 2 + (bola.y - PITCH.width / 2) * 0.55));

  // O LUGAR IDEAL PODE ESTAR OCUPADO.
  //
  // O servidor recusa a caixa por cima da bola, de um botão ou da trave — e a
  // área do goleiro é justamente onde a bola morre e onde os atacantes se
  // amontoam. Sem esta busca o bot insistia no ponto ideal, tomava 400 e a
  // partida dele acabava ali: seis de seis partidas de teste pararam assim.
  //
  // A varredura é barata e vai do melhor para o pior: primeiro afasta pelo Y,
  // que é o eixo onde há mais espaço, e só depois recua para a linha de gol,
  // onde quase nunca tem gente.
  // As medidas da caixa vêm do estado, não de constante copiada: o servidor
  // manda `w`/`h` tanto em `goleiros[time]` quanto no aviso de vez.
  const cx = estado.goleiros?.[meuTime] || estado.goleiro || {};
  const caixa = { w: cx.w ?? 16, h: cx.h ?? 4.5, anguloDeg: Math.round(perpend) };
  const corpos = [...estado.bodies.filter((b) => b.kind !== 'keeper'), ...traves()];

  // SAIR DE LADO ANTES DE RECUAR — e isso foi medido, não deduzido.
  //
  // O raciocínio natural é o contrário: recuar para a linha mantém o gol
  // coberto, andar no eixo do gol abre um canto. Só que quem entope a área é o
  // ATACANTE, e ele se amontoa justamente na boca do gol; empurrar o goleiro
  // para lá o põe no meio do trânsito. Três ordens medidas em 30 partidas
  // (9000 lances), contando as faltas do jogo inteiro:
  //
  //   recuo por dentro (sai de lado depois)   479   <- esta
  //   por deslocamento total                  531
  //   desvio por dentro (recua primeiro)      755
  for (const recuo of [0, 2, 4, 6, 9, 12]) {
    const x = Math.round((meuTime === 'A' ? avanco - recuo : avanco + recuo) * 10) / 10;
    if (x < area.xMin || x > area.xMax) continue;
    for (const desvio of [0, 3, -3, 6, -6, 10, -10, 15, -15, 20, -20]) {
      const y = Math.round((yIdeal + desvio) * 10) / 10;
      if (y < area.yMin || y > area.yMax) continue;
      // Arredonda ANTES de conferir: é o valor arredondado que vai para o
      // servidor, e conferir o valor cru deixou passar um KEEPER_BLOCKED.
      if (!caixaLivre({ ...caixa, x, y }, corpos)) continue;
      return { x, y, anguloDeg: caixa.anguloDeg };
    }
  }

  // Nada livre: devolve null e o bot só confirma. A caixa fica onde estava, que
  // é uma posição que já passou pela mesma checagem quando foi posta lá.
  return null;
}

/**
 * As duas traves do gol, como o servidor as monta em `goalPosts()`.
 *
 * Elas não vêm no estado que o bot recebe, e a caixa do goleiro encosta nelas
 * de verdade — com o goleiro colado na linha, meia espessura já alcança o
 * poste. Espelhar aqui é feio, mas é menos feio do que o bot descobrir o
 * problema só quando o servidor recusar.
 */
function traves() {
  const R = 1.3;
  return [
    { id: 'post_lo_A', x: 0, y: PITCH.goalMin, r: R },
    { id: 'post_hi_A', x: 0, y: PITCH.goalMax, r: R },
    { id: 'post_lo_B', x: PITCH.length, y: PITCH.goalMin, r: R },
    { id: 'post_hi_B', x: PITCH.length, y: PITCH.goalMax, r: R },
  ];
}

export function etapasDeAjuste(mv, estado) {
  const bola = estado.bodies.find((b) => b.id === 'ball');
  const bot = estado.bodies.find((b) => b.id === mv.buttonId);
  const etapas = [];

  if (bola && bot) {
    const dirBola = (Math.atan2(bola.y - bot.y, bola.x - bot.x) * 180) / Math.PI;
    etapas.push({ ...palhetaDe(dirBola, 0.3), inclinacao: 38, avanco: 0.28 });
  }
  for (const alt of mv.alternativas || []) etapas.push(alt.palheta);
  etapas.push(mv.palheta);
  return etapas;
}

/**
 * Onde pôr o botão para cobrar uma lateral, escanteio ou tiro de meta.
 *
 * A regra aqui é o oposto do que parece: o botão vai ATRÁS da bola em relação
 * a onde se quer mandá-la — e, numa lateral, "atrás" é FORA do campo. A bola
 * descansa em cima da risca, então quem fica do lado de dentro empurra ela
 * para fora e a lateral se repete para sempre. Este bug existiu: o código
 * prendia o botão dentro do campo e as duas IAs ficavam cobrando lateral uma
 * para a outra sem nunca voltar a jogar.
 */
export function jogadaDeCobranca(estado) {
  const bola = estado.bodies.find((b) => b.id === 'ball');
  const meuTime = estado.yourTeam;
  const golX = meuTime === 'A' ? PITCH.length : 0;
  const ids = estado.posicionaveis || [];
  if (!bola || !ids.length) return null;

  let escolhido = null;
  for (const id of ids) {
    const b = estado.bodies.find((x) => x.id === id);
    if (!b) continue;
    const d = dist(b, bola);
    if (!escolhido || d < escolhido.d) escolhido = { id, d };
  }
  if (!escolhido) return null;

  // Para onde a bola deve ir: para DENTRO do campo, adiantando na direção do
  // gol. Nunca para a linha de onde ela acabou de sair.
  const dentro = {
    x: limitar(bola.x + (golX - bola.x) * 0.35, 12, PITCH.length - 12),
    y: PITCH.width / 2,
  };
  let dx = dentro.x - bola.x;
  let dy = dentro.y - bola.y;
  const n = Math.hypot(dx, dy) || 1;
  dx /= n; dy /= n;

  // O botão fica na reta, do lado de trás: bater nele manda a bola para dentro.
  const recuo = Math.min(R_BOLA + R_BOTAO + 0.8, estado.cobranca?.raio ?? 18);
  const alvo = { x: bola.x - dx * recuo, y: bola.y - dy * recuo };

  // O limite é a MESA, não o campo: o botão pode e deve ficar fora das linhas.
  const m = (estado.pitch?.margemFora ?? PITCH.margemFora ?? 0);
  alvo.x = limitar(alvo.x, -m + R_BOTAO + 0.2, PITCH.length + m - R_BOTAO - 0.2);
  alvo.y = limitar(alvo.y, -m + R_BOTAO + 0.2, PITCH.width + m - R_BOTAO - 0.2);

  return { buttonId: escolhido.id, x: Math.round(alvo.x * 10) / 10, y: Math.round(alvo.y * 10) / 10 };
}

/** Prende um valor entre dois limites. */
function limitar(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}


/** Vale a pena declarar o chute? Só com a bola perto e o caminho livre. */
export function deveDeclarar(estado) {
  const meuTime = estado.yourTeam;
  if (!meuTime || estado.declarado) return false;
  const bola = estado.bodies.find((b) => b.id === 'ball');
  const golX = meuTime === 'A' ? PITCH.length : 0;
  const dist = Math.abs(golX - bola.x);
  if (dist > 65) return false;                    // longe demais: não entrega o goleiro

  // Existe algum botão nosso que consegue mandar a bola para dentro?
  const corpos = estado.bodies.filter((b) => b.kind !== 'ball');
  for (const y of [PITCH.goalMin + 5, PITCH.width / 2, PITCH.goalMax - 5]) {
    const dx = golX - bola.x, dy = y - bola.y, m = Math.hypot(dx, dy) || 1;
    const dir = { x: dx / m, y: dy / m };
    const contato = { x: bola.x - dir.x * (R_BOLA + R_BOTAO), y: bola.y - dir.y * (R_BOLA + R_BOTAO) };
    if (!dentroDaMesa(contato)) continue;
    if (blockers(bola, { x: golX, y }, corpos, [], R_BOLA).length) continue;
    for (const id of estado.controllable || []) {
      const b = estado.bodies.find((x) => x.id === id);
      if (b && !blockers(b, contato, corpos, [b.id], b.r).length) return true;
    }
  }
  return false;
}

/* ---------------------------------------------------------------- */

async function main() {
  const cli = new FutebolClient({
    base: args.base || 'http://localhost:3000',
    name: args.name || 'sparring',
    password: senhaDeBot({ nome: args.name || 'sparring', padrao: 'sparring1234', arg: args.password }),
    kind: 'ai',
  });
  await cli.auth();
  configurarFisica(await cli.rules());

  let gameId = args.game;
  if (args.create) {
    const [sa, sb] = String(args.slots || '1x1').split('x').map(Number);
    const g = await cli.createGame({
      name: args.gameName || 'Partida do sparring',
      slotsA: sa || 1, slotsB: sb || 1,
      teamAName: args.teamA || 'Azuis', teamBName: args.teamB || 'Vermelhos',
      config: { buttonsPerTeam: Number(args.buttons || 5), maxPossessions: Number(args.possessions || 40) },
    });
    gameId = g.gameId;
    console.log(`\n  partida criada: ${gameId}`);
    console.log(`  abra http://localhost:3000 e entre nela, ou rode outro bot com --game ${gameId}\n`);
  }
  if (!gameId) {
    const { games } = await cli.listGames();
    const livre = games.find((g) => g.status !== 'finished' && (g.teams.A.ocupadas < g.teams.A.slots || g.teams.B.ocupadas < g.teams.B.slots));
    if (!livre) { console.error('nenhuma partida com vaga. use --create ou --game <id>'); process.exit(1); }
    gameId = livre.gameId;
  }

  const entrada = await cli.join(gameId, args.team, !!args.autostart, args.convite || null);
  console.log(`[${cli.name}] entrou em ${gameId} pelo time ${entrada.team}`);

  await cli.connectWS([`player/${cli.playerId}/turn`, `game/${gameId}/event`]);
  console.log(`[${cli.name}] escutando o broker`);

  cli.onEvent = (ev) => {
    if (ev.texto) console.log(`  · ${ev.texto}`);
  };

  cli.tratarVez(gameId, async () => {
    {
      const estado = await cli.state(gameId);
      if (!estado.yourTurn) return;

      // Cobrança de lateral/escanteio/tiro de meta: põe um botão na bola.
      // Na saída de bola arrumar é opcional: o bot simplesmente bate.
      if (estado.podeCobrar && !estado.cobrancaOpcional) {
        const c = jogadaDeCobranca(estado);
        if (c) {
          await cli.cobrar(gameId, c);
          await new Promise((r) => setTimeout(r, 280));
          await cli.cobrar(gameId, { ...c, confirmar: true });
          console.log(`  ${cli.name} > cobra ${estado.cobranca?.tipo} com ${c.buttonId} em (${c.x}, ${c.y})`);
        }
        return;
      }

      // Fase de goleiro: posiciona a caixa e devolve a vez.
      if (estado.podePosicionarGoleiro) {
        const pos = posicaoDoGoleiro(estado);
        if (pos) {
          await cli.goleiro(gameId, pos);
          await new Promise((r) => setTimeout(r, 300));
          await cli.goleiro(gameId, { ...pos, confirmar: true });
          console.log(`  ${cli.name} > goleiro em (${pos.x}, ${pos.y}) a ${pos.anguloDeg}°`);
        } else {
          await cli.goleiro(gameId, { confirmar: true });
        }
        return;
      }

      // Vale a pena declarar? Aí o adversário posiciona e a vez volta.
      if (deveDeclarar(estado)) {
        await cli.declarar(gameId);
        console.log(`  ${cli.name} > DECLAROU chute a gol`);
        return;
      }
      const jogada = decidir(estado);
      if (!jogada) { console.log('  sem jogada possível'); return; }
      const { _motivo, ...mv } = jogada;

      // Mostra a configuração acontecendo: pega a palheta, pesa as alternativas
      // que realmente avaliou, e só então assenta na escolhida.
      await cli.mirarPassoAPasso(gameId, mv.buttonId, etapasDeAjuste(mv, estado));
      await new Promise((r) => setTimeout(r, 260));

      const { alternativas, ...paraEnviar } = mv;
      const r = await cli.move(gameId, paraEnviar);
      const p = mv.palheta;
      console.log(`  ${cli.name} > ${mv.buttonId} aro ${Math.round(p.anguloAro)}° f=${p.forca} | ${_motivo} | ${r.result.outcome}`);
    }
  });

  // Se já for a nossa vez quando conectamos, começa agora.
  const st = await cli.state(gameId, { brief: true });
  if (st.currentPlayerId === cli.playerId) cli.onTurn(st);

  process.on('SIGINT', () => { cli.close(); process.exit(0); });
}

// Só roda sozinho quando é o módulo invocado direto; importado, exporta apenas.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
