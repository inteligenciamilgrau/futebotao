// Modelo da palheta: como o jeito de encostar e apertar vira velocidade.
//
// No futebol de botão você não empurra o botão: você apoia a palheta no OMBRO
// BISELADO dele e pressiona. O botão escapa por baixo, na direção oposta ao apoio.
// É por isso que o botão tem a borda arredondada — sem o bisel, nada escapa.
//
//        palheta
//          \                        avanco = 0   -> apoio na quina da borda
//           \____                   avanco = 1   -> apoio no centro do topo
//          /     \                  inclinacao   -> ângulo da palheta com a mesa
//         /       \  <- bisel
//        |_________|
//     ============== mesa
//
// Quatro números definem a jogada:
//   anguloAro   graus, ONDE no aro a palheta encosta. O botão sai a 180° disso.
//   inclinacao  graus, ângulo da palheta com a mesa.
//   avanco      0..1, da borda (0) para o centro (1).
//   forca       0.05..1, quanto se aperta.

import { PALHETA, PHYS, PITCH } from './config.js';
import { goalPosts, impulsoContato } from './physics.js';

// As traves são `statics` da simulação, então não vêm em `game.bodies` e a
// previsão não enxergava nenhuma delas: o disco batia no poste e parava 17 cm
// antes do que a mira dizia. Geometria fixa, e ninguém aqui as modifica.
const TRAVES = goalPosts();

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const gauss = (x, centro, sigma) => Math.exp(-((x - centro) ** 2) / (2 * sigma * sigma));

/**
 * Resolve a configuração da palheta em direção + velocidade.
 * Puro e determinístico: mesma configuração, mesmo resultado.
 */
export function resolverPalheta(p = {}) {
  const anguloAro = Number.isFinite(p.anguloAro) ? p.anguloAro : 0;
  const inclinacao = clamp(Number.isFinite(p.inclinacao) ? p.inclinacao : PALHETA.inclinacaoOtima,
    PALHETA.inclinacaoMin, PALHETA.inclinacaoMax);
  const avanco = clamp(Number.isFinite(p.avanco) ? p.avanco : PALHETA.avancoOtimo, 0, 1);
  const forca = clamp(Number.isFinite(p.forca) ? p.forca : 0.6, 0.05, 1);

  // Rendimento: o quanto do aperto vira movimento.
  const sigma = inclinacao < PALHETA.inclinacaoOtima
    ? PALHETA.inclinacaoSigmaBaixa      // deitada: perde força de verdade
    : PALHETA.inclinacaoSigmaAlta;      // em pé: redireciona para cima
  const rendInclinacao = gauss(inclinacao, PALHETA.inclinacaoOtima, sigma);
  const rendAvanco = gauss(avanco, PALHETA.avancoOtimo, PALHETA.avancoSigma);
  const rendimento = rendInclinacao * rendAvanco;

  const escorregou = rendimento < PALHETA.eficienciaMinima;

  // Apoio perto demais do centro: em vez de escapar reto, o botão sai torto.
  // O lado do desvio vem da inclinação, então dá para aprender e corrigir.
  const excesso = Math.max(0, avanco - PALHETA.avancoTorto);
  const lado = inclinacao < PALHETA.inclinacaoOtima ? -1 : 1;
  const desvio = lado * excesso * PALHETA.desvioPorExcesso;

  const direcao = anguloAro + 180 + desvio;

  const aproveitado = escorregou ? rendimento * PALHETA.escorregaFator : rendimento;
  const velocidade = PHYS.minShotSpeed + forca * (PHYS.maxShotSpeed - PHYS.minShotSpeed) * aproveitado;

  // Cavadinha: palheta em pé com força faz o botão pular por cima dos outros.
  const cavada = !escorregou
    && inclinacao >= PALHETA.cavadaInclinacao
    && forca >= PALHETA.cavadaForcaMin;
  const duracaoVoo = cavada
    ? PALHETA.cavadaDuracaoBase + PALHETA.cavadaDuracaoPorForca * forca
    : 0;

  // Elevação: quanto da pancada vai virar ALTURA da bola. Palheta deitada
  // manda rasteiro; em pé, a borda arredondada do botão pega por baixo e
  // levanta — é assim que se faz gol por cima da caixa do goleiro.
  const elevacao = escorregou ? 0 : clamp(
    (inclinacao - PALHETA.elevacaoInicio) / (PALHETA.elevacaoTeto - PALHETA.elevacaoInicio), 0, 1);

  const rad = (direcao * Math.PI) / 180;
  return {
    entrada: { anguloAro, inclinacao, avanco, forca },
    elevacao: Math.round(elevacao * 1000) / 1000,
    // Altura aproximada que a bola atinge (cm), para a UI e para a IA.
    alturaPrevista: Math.round(
      Math.pow(elevacao * PHYS.liftMax * velocidade, 2) / (2 * PHYS.gravity) * 10) / 10,
    direcao: ((direcao % 360) + 360) % 360,
    desvio: Math.round(desvio * 10) / 10,
    rendimento: Math.round(rendimento * 1000) / 1000,
    rendInclinacao: Math.round(rendInclinacao * 1000) / 1000,
    rendAvanco: Math.round(rendAvanco * 1000) / 1000,
    escorregou,
    cavada,
    duracaoVoo: Math.round(duracaoVoo * 1000) / 1000,
    velocidade: Math.round(velocidade * 10) / 10,
    vx: Math.cos(rad) * velocidade,
    vy: Math.sin(rad) * velocidade,
    aviso: diagnostico({ inclinacao, avanco, escorregou, cavada, desvio, rendimento, elevacao, velocidade }),
  };
}

/** Explica em português o que a configuração vai causar. Vai para o cliente e para a IA. */
function diagnostico({ inclinacao, avanco, escorregou, cavada, desvio, rendimento, elevacao = 0, velocidade = 0 }) {
  if (escorregou) {
    if (avanco < 0.12) return 'a palheta escorrega da quina: apoie um pouco mais para dentro';
    if (avanco > 0.75) return 'apoio quase no centro: você prende o botão em vez de lançá-lo';
    if (inclinacao < 22) return 'palheta deitada demais: ela desliza sem empurrar';
    if (inclinacao > 72) return 'palheta em pé demais: você aperta para baixo, não para frente';
    return 'a palheta escorrega nessa posição';
  }
  const partes = [];
  if (elevacao > 0.12) {
    const h = Math.pow(elevacao * PHYS.liftMax * velocidade, 2) / (2 * PHYS.gravity);
    partes.push(h >= PITCH.alturaTravessao
      ? `bola MUITO alta (~${h.toFixed(0)}cm): passa por cima do travessão`
      : `bola sobe ~${h.toFixed(0)}cm`);
  }
  if (cavada) partes.push('cavadinha: o botão pula por cima dos outros');
  if (Math.abs(desvio) > 4) partes.push(`sai ${Math.abs(desvio).toFixed(0)}° torto para ${desvio > 0 ? 'a esquerda' : 'a direita'}`);
  if (rendimento > 0.9) partes.push('apoio limpo');
  else if (rendimento < 0.55) partes.push(`rendimento baixo (${Math.round(rendimento * 100)}%)`);
  return partes.join('; ') || `rendimento ${Math.round(rendimento * 100)}%`;
}

/**
 * Modelo inverso: que palheta manda o botão na direção `direcaoGraus`
 * com velocidade `velocidadeAlvo`? Usado pelo modo simples e pelos bots.
 */
export function palhetaPara(direcaoGraus, velocidadeAlvo, opts = {}) {
  const inclinacao = opts.inclinacao ?? PALHETA.inclinacaoOtima;
  const avanco = opts.avanco ?? PALHETA.avancoOtimo;
  const sigma = inclinacao < PALHETA.inclinacaoOtima ? PALHETA.inclinacaoSigmaBaixa : PALHETA.inclinacaoSigmaAlta;
  const rendimento = gauss(inclinacao, PALHETA.inclinacaoOtima, sigma)
                   * gauss(avanco, PALHETA.avancoOtimo, PALHETA.avancoSigma);

  const bruta = (velocidadeAlvo - PHYS.minShotSpeed)
              / ((PHYS.maxShotSpeed - PHYS.minShotSpeed) * Math.max(1e-6, rendimento));

  return {
    anguloAro: ((direcaoGraus + 180) % 360 + 360) % 360,
    inclinacao,
    avanco,
    forca: clamp(Math.round(bruta * 100) / 100, 0.05, 1),
    // Sinaliza quando nem no talo dá: quem chama decide o que fazer.
    alcancavel: bruta <= 1,
  };
}

/**
 * Previsão analítica do lance: até onde o disco corre e se ele alcança a bola.
 * NÃO é a simulação — é geometria fechada, de propósito: serve para a mira do
 * humano e para o frame da IA sem virar uma sandbox de força bruta.
 */
export function preverLance(botao, resolucao, corpos = []) {
  const v = resolucao.velocidade;
  const rad = (resolucao.direcao * Math.PI) / 180;
  const dir = { x: Math.cos(rad), y: Math.sin(rad) };

  // Durante a cavadinha o disco voa e não colide com nada — e freia com o
  // atrito do ar, muito menor que o do feltro. Cobrar `muButton` do voo todo
  // encurtava a corrida prevista pela metade num lance de força 1.
  const noAr = distanciaNoVoo(v, resolucao.duracaoVoo);
  const distanciaVoo = noAr.dist;
  const corridaDisco = distanciaVoo + (noAr.v * noAr.v) / (2 * PHYS.muButton * PHYS.gravity);

  // Primeiro corpo atingido ao longo de UMA perna reta.
  //
  // A caixa do goleiro é testada como CAIXA. Com o raio envolvente (8.31 para
  // 16 x 4.5) o disco "batia" no goleiro seis centímetros antes da caixa real,
  // e a previsão respondia alcancaBola: false para chutes que passavam limpos.
  // Quem joga pela API lia isso como "não dá para chutar" e desistia.
  const alvos = corpos.concat(TRAVES);
  const buscar = (px, py, ux, uy, vAtual, tempoVoo) => {
    // Voando, o disco passa por cima dos obstáculos MAS ainda pega a bola —
    // é a regra do motor, e é o que faz a cavadinha valer a pena. A previsão
    // pulava a bola junto e respondia "não alcança" a lances que acertavam.
    const cego = distanciaNoVoo(vAtual, tempoVoo).dist;
    const origem = { x: px, y: py };
    const rumo = { x: ux, y: uy };
    let achado = null;
    for (const c of alvos) {
      if (c.id === botao.id) continue;
      const cruz = travessia(origem, rumo, botao.r, c);
      if (!cruz) continue;
      if (cruz.entra < cego && c.kind !== 'ball') continue;
      if (!achado || cruz.entra < achado.t) achado = { t: cruz.entra, corpo: c, nx: cruz.nx, ny: cruz.ny };
    }
    return achado;
  };

  // Onde o disco PARA de verdade. A reta `corridaDisco` só vale quando não há
  // ninguém no caminho e a mesa não acaba antes; medido em 400 lances, isso é
  // 80% deles — nos outros 20% ela errava 19 cm na mediana e 59 cm no pior.
  let corrida = correrAteParar(botao.x, botao.y, dir.x, dir.y, v, botao.r,
    resolucao.duracaoVoo, buscar);
  // `contato` só vem preenchido quando o disco CHEGA nele: um corpo adiante
  // na mira, mas fora do alcance, não é contato nenhum. É o que deixa
  // `primeiroContato: null` significar mesmo "caminho livre".
  const primeiro = corrida.noLimite ? corrida.contato : null;
  // Com que velocidade o disco CHEGA no primeiro corpo. Sai da própria
  // corrida, então já vem com o atrito certo de cada trecho — descontar
  // `muButton` do voo da cavadinha subestimava a pancada. Guardado antes do
  // ricochete, que substitui `corrida` pela perna de depois do choque.
  const vImpacto = corrida.noLimite ? corrida.v : 0;
  // O choque pode cair numa perna DEPOIS de um desvio na beirada, e aí ele não
  // está mais sobre a reta do chute: guarde onde e para onde o disco ia de
  // fato, senão a normal contra a bola sai do lugar errado.
  const impacto = primeiro
    ? { x: corrida.x, y: corrida.y, dx: corrida.dx, dy: corrida.dy, andou: corrida.andou }
    : null;
  if (primeiro) {
    const dep = ricochete(botao, primeiro.corpo, corrida.v * corrida.dx, corrida.v * corrida.dy,
      primeiro.nx, primeiro.ny);
    const vDep = Math.hypot(dep.vx, dep.vy);
    if (vDep > 1e-6) {
      // Numa cavadinha que acerta a bola AINDA NO AR o disco segue voando o
      // resto de `hopUntil`, com 0,03 de atrito. Freando a perna toda com
      // muButton (0,16) a parada prevista caía até 16 cm curta.
      const restanteVoo = Math.max(0, resolucao.duracaoVoo - corrida.tempo);
      const depois = correrAteParar(corrida.x, corrida.y, dep.vx / vDep, dep.vy / vDep, vDep, botao.r,
        restanteVoo);
      corrida = { ...depois, beirada: corrida.beirada || depois.beirada };
    }
  }

  const saida = {
    direcao: Math.round(resolucao.direcao * 10) / 10,
    corridaDisco: Math.round(corridaDisco * 10) / 10,
    distanciaVoo: Math.round(distanciaVoo * 10) / 10,
    // Já conta a cavadinha, o ricochete no `primeiroContato` e a beirada.
    parada: { x: Math.round(corrida.x * 10) / 10, y: Math.round(corrida.y * 10) / 10 },
    // A beirada da mesa entrou na conta: o disco escorrega por ela até parar.
    paraNaBeirada: corrida.beirada,
    // `dist` é o que o disco RODA até o choque, não a distância em linha reta:
    // com um desvio na beirada no meio as duas deixam de ser a mesma coisa.
    primeiroContato: primeiro ? { id: primeiro.corpo.id, dist: Math.round(impacto.andou * 10) / 10 } : null,
    alcancaBola: false,
    bola: null,
  };

  if (!primeiro || primeiro.corpo.kind !== 'ball') return saida;

  // Bateu na bola: com que velocidade, e para onde ela vai.
  const cx = impacto.x, cy = impacto.y;
  const nx = primeiro.corpo.x - cx, ny = primeiro.corpo.y - cy;
  const n = Math.hypot(nx, ny) || 1;
  const ux = nx / n, uy = ny / n;

  // SÓ a componente do impacto ao longo da normal empurra a bola — é o que a
  // simulação faz. Usar a velocidade total superestimava muito num raspão:
  // com o toque a 75° da normal a previsão saía ~13x mais longa que a real.
  const vNormal = Math.max(0, vImpacto * (impacto.dx * ux + impacto.dy * uy));

  const totInv = 1 / botao.m + 1 / primeiro.corpo.m;
  const vBola = ((1 + PHYS.restitutionBody) * vNormal) / (totInv * primeiro.corpo.m);
  const corridaBola = (vBola * vBola) / (2 * PHYS.muBall * PHYS.gravity);

  // Onde a bola pararia se nada atrapalhasse — e o aviso de que algo atrapalha.
  const paradaX = primeiro.corpo.x + ux * corridaBola;
  const paradaY = primeiro.corpo.y + uy * corridaBola;
  const bolaR = primeiro.corpo.r;
  const saiDeCampo = paradaX < bolaR || paradaX > PITCH.length - bolaR
                  || paradaY < bolaR || paradaY > PITCH.width - bolaR;
  // Quanto a bola sobe neste toque. É a mesma conta do motor: a borda do
  // botão converte parte da pancada em altura (vz), e daí é balística.
  const vz0 = (resolucao.elevacao || 0) * PHYS.liftMax * vNormal;

  /**
   * Altura da bola depois de percorrer `d` cm no chão.
   *
   * Sem isso a previsão dizia que a bola bateria no goleiro mesmo quando ela
   * passava por cima dele — e quem joga pela API não tinha como descobrir que
   * a cavadinha funcionava, porque a previsão nunca aprovava o chute.
   */
  const alturaEm = (d) => {
    if (vz0 <= 0) return 0;
    const aDesac = PHYS.muBall * PHYS.gravity;
    const disc = vBola * vBola - 2 * aDesac * d;
    if (disc < 0) return 0;                       // nem chega lá
    const tempo = (vBola - Math.sqrt(disc)) / aDesac;
    return Math.max(0, vz0 * tempo - 0.5 * PHYS.gravity * tempo * tempo);
  };

  const noCaminho = alvos.find((c) => {
    if (c.id === botao.id || c === primeiro.corpo) return false;
    const faixa = travessia(primeiro.corpo, { x: ux, y: uy }, bolaR, c);
    if (!faixa || faixa.entra >= corridaBola) return false;
    if (c.kind === 'post') return true;              // trave é trave, em qualquer altura

    // A bola pode limpar a FRENTE da caixa e cair em cima dela logo depois.
    // Olhar só o ponto de entrada dava a cavadinha por boa e o motor derrubava.
    const fim = Math.min(faixa.sai, corridaBola);
    const passos = 8;
    for (let i = 0; i <= passos; i++) {
      const d = faixa.entra + ((fim - faixa.entra) * i) / passos;
      if (alturaEm(d) <= (c.alturaTopo ?? 0)) return true;
    }
    return false;
  });

  saida.alcancaBola = true;
  // O PULO, em números que dão para desenhar: a altura amostrada ao longo do
  // caminho, mais o ápice e onde a bola volta ao chão. Sem isto o cliente
  // desenhava uma linha rasteira mesmo quando a bola ia pelo alto — e a
  // cavadinha, que é o lance mais bonito do jogo, ficava invisível até bater.
  const voo = montarVoo(alturaEm, corridaBola);

  saida.bola = {
    direcao: Math.round((Math.atan2(uy, ux) * 180) / Math.PI * 10) / 10,
    // Quão de raspão foi o toque: 1 = cheio, perto de 0 = raspando.
    cheio: Math.round((impacto.dx * ux + impacto.dy * uy) * 100) / 100,
    velocidade: Math.round(vBola * 10) / 10,
    corrida: Math.round(corridaBola * 10) / 10,
    parada: { x: Math.round(paradaX * 10) / 10, y: Math.round(paradaY * 10) / 10 },
    // A parada acima ignora obstáculos e linhas. Estes campos avisam disso.
    saiDeCampo,
    bateEm: noCaminho ? noCaminho.id : null,
    voo,
  };
  return saida;
}

/**
 * Onde um corpo que anda em linha reta ENTRA e SAI de outro corpo.
 *
 * Devolve `{entra, sai}` em centímetros percorridos, ou null se não cruza. A
 * caixa do goleiro é tratada como caixa girada (teste de fatias, inflada pelo
 * raio de quem passa); o resto é círculo. Sair pelo raio ENVOLVENTE da caixa
 * — 8.31 cm para 16 x 4.5 — inchava o goleiro em ~6 cm e fazia a previsão
 * condenar chutes que a física deixava passar.
 *
 * O contorno certo de "onde o CENTRO de um disco de raio r encosta na caixa"
 * é um retângulo de cantos ARREDONDADOS por r, não um retângulo maior: inflar
 * as duas fatias por r é somar um QUADRADO de lado 2r, e a diferença mora na
 * quina. Ali o teste de fatias entrega normal de FACE (erro de até 45°) e
 * antecipa o contato em r·(√2−1) — 0,99 cm para um botão de 2,4 cm de raio.
 * Como a quina é ~27% do contorno de uma caixa 16 x 4.5, isso pegava um em
 * cada quatro toques no goleiro.
 */
function travessia(origem, dir, raio, alvo) {
  if (alvo.forma === 'caixa') {
    const cos = Math.cos(alvo.ang || 0), sin = Math.sin(alvo.ang || 0);
    const dx = origem.x - alvo.x, dy = origem.y - alvo.y;
    const ox = dx * cos + dy * sin;
    const oy = -dx * sin + dy * cos;
    const dxr = dir.x * cos + dir.y * sin;
    const dyr = -dir.x * sin + dir.y * cos;

    let perto = -Infinity, longe = Infinity, entraPelaFaceX = false;
    const hw = alvo.w / 2, hh = alvo.h / 2;
    const fatias = [[ox, dxr, hw + raio], [oy, dyr, hh + raio]];
    for (let i = 0; i < fatias.length; i++) {
      const [o, d, h] = fatias[i];
      if (Math.abs(d) < 1e-9) {
        if (o < -h || o > h) return null;         // paralelo e fora da fatia
        continue;
      }
      let t1 = (-h - o) / d, t2 = (h - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > perto) { perto = t1; entraPelaFaceX = i === 0; }
      longe = Math.min(longe, t2);
      if (perto > longe) return null;
    }
    if (longe < 0) return null;

    // Por onde ele entra no quadrado inflado. Dentro das faixas de face isso
    // já é o contorno de verdade; fora delas o quadrado inventou uma quina
    // reta onde existe um arco.
    const ex = ox + dxr * perto, ey = oy + dyr * perto;
    if (Math.abs(ex) > hw && Math.abs(ey) > hh) {
      // Quina: resolve contra o CÍRCULO de raio `raio` no canto. A prova de
      // que é sempre ESTE canto: qualquer ponto da faixa de face vizinha,
      // dentro do quadrado inflado, já está a menos de `raio` dele — o raio
      // teria de ter entrado no arco antes de chegar lá.
      const qx = Math.sign(ex) * hw, qy = Math.sign(ey) * hh;
      const cx = ox - qx, cy = oy - qy;
      const b = cx * dxr + cy * dyr;
      const c = cx * cx + cy * cy - raio * raio;
      const disc = b * b - c;
      if (disc < 0) return null;                  // passou raspando por fora
      const r1 = -b - Math.sqrt(disc), r2 = -b + Math.sqrt(disc);
      if (r2 < 0 || r1 > longe) return null;
      const entra = Math.max(0, r1);
      // Normal do CANTO para quem anda, invertida: aponta de quem anda para o
      // alvo, como `contatoCirculoCaixa` faz no motor (com o sinal trocado).
      const px = cx + dxr * entra, py = cy + dyr * entra;
      const d = Math.hypot(px, py) || 1;
      const lx = -px / d, ly = -py / d;
      return {
        // `sai` continua o do quadrado: ele só serve para amostrar a altura da
        // bola sobre a caixa, e sobrar faixa ali é conservador (acusa bloqueio
        // a mais, nunca a menos).
        entra, sai: longe,
        nx: lx * cos - ly * sin, ny: lx * sin + ly * cos,
      };
    }

    // Entrada ATRÁS de quem anda e face na frente: ele já está dentro do
    // quadrado inflado. Se também estiver dentro do contorno arredondado, o
    // contato é agora (entra = 0). Se não estiver, ele só pode ter raspado a
    // quina e SAÍDO — o contorno é convexo, e de um convexo não se sai duas
    // vezes. Sem esta conta a previsão anunciava contato imediato com o
    // goleiro para um disco parado a milímetros da quina atirando pro lado
    // oposto.
    if (perto < 0) {
      const fx = Math.max(0, Math.abs(ox) - hw), fy = Math.max(0, Math.abs(oy) - hh);
      if (fx * fx + fy * fy > raio * raio) return null;
    }

    // Normal da FACE por onde ele entra, apontando de quem anda PARA o alvo —
    // é a normal do contato, o que o ricochete precisa para copiar o impulso
    // do motor.
    const lx = entraPelaFaceX ? (Math.sign(dxr) || 1) : 0;
    const ly = entraPelaFaceX ? 0 : (Math.sign(dyr) || 1);
    return {
      entra: Math.max(0, perto), sai: longe,
      nx: lx * cos - ly * sin, ny: lx * sin + ly * cos,
    };
  }

  const rr = raio + alvo.r;
  const ox = origem.x - alvo.x, oy = origem.y - alvo.y;
  const b = ox * dir.x + oy * dir.y;
  const c = ox * ox + oy * oy - rr * rr;
  const disc = b * b - c;
  if (disc < 0) return null;
  const raizes = [-b - Math.sqrt(disc), -b + Math.sqrt(disc)];
  if (raizes[1] < 0) return null;
  const entra = Math.max(0, raizes[0]);
  const ex = origem.x + dir.x * entra - alvo.x, ey = origem.y + dir.y * entra - alvo.y;
  const dc = Math.hypot(ex, ey) || 1;
  return { entra, sai: raizes[1], nx: -ex / dc, ny: -ey / dc };
}

/**
 * Quanto o disco anda NO AR e com que velocidade ele pousa.
 *
 * Enquanto `hopUntil` não vence o motor cobra `cavadaAtrito` (0,03) em vez de
 * `muButton` (0,16) — 5,3x menos. A conta aparece em dois lugares (o alcance
 * livre e a busca de contatos), então mora aqui para não divergir.
 */
function distanciaNoVoo(v, duracao) {
  if (!(duracao > 0) || !(v > 0)) return { dist: 0, v: Math.max(0, v) };
  const desac = PALHETA.cavadaAtrito * PHYS.gravity;
  const T = Math.min(duracao, v / desac);
  return { dist: v * T - 0.5 * desac * T * T, v: v - desac * T };
}

/** Distância até a beirada da mesa no sentido do movimento, e por qual eixo. */
function beiradaEm(x, y, dx, dy, raio) {
  const m = PITCH.margemFora;
  let d = Infinity, eixo = null;
  if (dx > 1e-9) { const t = (PITCH.length + m - raio - x) / dx; if (t < d) { d = t; eixo = 'x'; } }
  else if (dx < -1e-9) { const t = (raio - m - x) / dx; if (t < d) { d = t; eixo = 'x'; } }
  if (dy > 1e-9) { const t = (PITCH.width + m - raio - y) / dy; if (t < d) { d = t; eixo = 'y'; } }
  else if (dy < -1e-9) { const t = (raio - m - y) / dy; if (t < d) { d = t; eixo = 'y'; } }
  return { d: Math.max(0, d), eixo };
}

/**
 * Corre com o disco até ele parar, do jeito que o motor corre.
 *
 * A corrida livre `v²/(2·mu·g)` erra em dois lugares:
 *  - na CAVADINHA o disco está no ar e o atrito é `cavadaAtrito` (0,03), não
 *    `muButton` (0,16): medido, ele corre até 46 cm a mais do que a reta dizia;
 *  - a BEIRADA DA MESA segura o disco. `segurarBotao` zera só a componente
 *    normal e deixa a paralela seguir, então ele desliza pela borda em vez de
 *    parar onde a reta apontava — 9,6 cm de erro na mediana desses lances.
 *
 * `buscar(x, y, dx, dy, v, tempoDeVooQueFalta)` devolve o próximo corpo no
 * caminho da perna atual (ou null). É chamado no começo e DE NOVO depois de
 * cada desvio na beirada: a perna nova aponta para outro lado, então o contato
 * da anterior deixou de valer e um novo pode existir. Antes disso o limite
 * virava Infinity e a perna desviada corria cega — a previsão dizia "caminho
 * livre" enquanto o motor registrava o contato.
 *
 * Para no contato devolvendo `noLimite`, o corpo em `contato` e a velocidade
 * que sobrou, para quem chamou resolver o ricochete. `tempo` é quanto durou a
 * corrida, que é o que diz se o disco ainda estava no ar quando bateu.
 */
function correrAteParar(x, y, dx, dy, v, raio, duracaoVoo = 0, buscar = null) {
  const fases = [];
  if (duracaoVoo > 0) fases.push({ desac: PALHETA.cavadaAtrito * PHYS.gravity, tempo: duracaoVoo });
  fases.push({ desac: PHYS.muButton * PHYS.gravity, tempo: Infinity });

  let beirada = false, tempo = 0, andou = 0;
  let contato = buscar ? buscar(x, y, dx, dy, v, duracaoVoo) : null;
  let restante = contato ? contato.t : Infinity;

  for (const fase of fases) {
    let sobra = fase.tempo;
    // Depois da primeira beirada o disco anda num eixo só, então duas bastam.
    for (let volta = 0; volta < 3 && v > 0 && sobra > 0; volta++) {
      const t = Math.min(sobra, v / fase.desac);
      const daFase = v * t - 0.5 * fase.desac * t * t;
      const borda = beiradaEm(x, y, dx, dy, raio);
      const corte = Math.min(borda.d, restante);

      if (corte >= daFase) {                       // nada corta: a fase inteira cabe
        x += dx * daFase; y += dy * daFase; restante -= daFase; andou += daFase;
        v -= fase.desac * t; sobra -= t; tempo += t;
        break;
      }

      const vCorte = Math.sqrt(Math.max(0, v * v - 2 * fase.desac * corte));
      x += dx * corte; y += dy * corte; andou += corte;
      const gasto = (v - vCorte) / fase.desac;
      sobra -= gasto; tempo += gasto;
      v = vCorte;
      if (restante <= borda.d) return { x, y, dx, dy, v, beirada, tempo, andou, contato, noLimite: true };
      restante -= corte;

      beirada = true;
      if (borda.eixo === 'x') { v *= Math.abs(dy); dx = 0; dy = Math.sign(dy); }
      else { v *= Math.abs(dx); dy = 0; dx = Math.sign(dx); }
      contato = buscar ? buscar(x, y, dx, dy, v, Math.max(0, duracaoVoo - tempo)) : null;
      restante = contato ? contato.t : Infinity;
    }
  }
  return { x, y, dx, dy, v: 0, beirada, tempo, andou, contato: null, noLimite: false };
}

/**
 * Velocidade do disco DEPOIS de bater em `alvo`, com `n` apontando do disco
 * para ele. É o mesmo impulso de `resolverContato` no motor — normal com
 * restituição mais o tangencial limitado a metade dele.
 *
 * Vale para UM contato. Se o disco bater de novo depois, ele para antes do
 * que a previsão diz; `primeiroContato` é o aviso de que há alguém no caminho.
 */
function ricochete(disco, alvo, vx, vy, nx, ny) {
  const invD = disco.invM ?? (disco.m > 0 ? 1 / disco.m : 0);
  const invA = alvo.fixed ? 0 : (alvo.invM ?? (alvo.m > 0 ? 1 / alvo.m : 0));
  // O motor manda a velocidade de B RELATIVA a A com `n` de A para B. Aqui o
  // disco é A e o alvo está parado, então a relativa é `-v`.
  const imp = impulsoContato(-vx, -vy, nx, ny, invD + invA);
  if (!imp) return { vx, vy };
  const { j, jt, tx, ty } = imp;
  return { vx: vx - (j * nx + jt * tx) * invD, vy: vy - (j * ny + jt * ty) * invD };
}

/**
 * O perfil de altura da bola ao longo do caminho, para quem vai desenhar.
 *
 * Devolve null quando a bola vai rasteira — assim o cliente sabe que é para
 * desenhar uma reta e não um arco. `pontos` são pares [distância, altura] em
 * centímetros, do toque até a bola voltar ao chão.
 */
function montarVoo(alturaEm, corrida) {
  const AMOSTRAS = 16;
  const pontos = [];
  let alturaMax = 0;
  let ondeMax = 0;
  let pouso = null;

  for (let i = 0; i <= AMOSTRAS; i++) {
    const d = (corrida * i) / AMOSTRAS;
    const z = alturaEm(d);
    pontos.push([Math.round(d * 10) / 10, Math.round(z * 100) / 100]);
    if (z > alturaMax) { alturaMax = z; ondeMax = d; }
    if (pouso === null && i > 0 && z <= 0) pouso = d;
  }

  // Menos de 2 mm não é pulo, é ruído da conta.
  if (alturaMax < 0.2) return null;

  return {
    alturaMax: Math.round(alturaMax * 10) / 10,
    ondeMax: Math.round(ondeMax * 10) / 10,
    pouso: pouso === null ? null : Math.round(pouso * 10) / 10,
    pontos,
  };
}

/** Onde a palheta encosta, em coordenadas da mesa (para desenhar). */
export function pontoDeApoio(botao, anguloAro, avanco) {
  const rad = (anguloAro * Math.PI) / 180;
  const raio = botao.r * (1 - clamp(avanco, 0, 1) * 0.82);
  return {
    x: botao.x + Math.cos(rad) * raio,
    y: botao.y + Math.sin(rad) * raio,
    raio,
  };
}

export { PALHETA };
