// Geometria da mesa e constantes físicas.
// Unidade: centímetros. Origem no canto inferior-esquerdo da mesa.
// Time A ataca para +X (defende o gol em x=0). Time B ataca para -X.

export const PITCH = {
  length: 200,        // eixo X
  width: 120,         // eixo Y
  goalWidth: 30,      // abertura do gol (eixo Y)
  goalDepth: 8,       // profundidade da rede atrás da linha
  centerCircle: 22,
  // Quanto de mesa existe FORA das linhas.
  //
  // Não é decoração: os BOTÕES podem sair do campo e usar essa faixa. É como
  // se cobra uma lateral (a bola na risca, o disco de fora trazendo ela para
  // dentro) e é o que deixa buscar uma bola colada na linha sem ela sair. A
  // BOLA continua não podendo: cruzou a linha, saiu.
  //
  // Vale ao menos `raioCobranca`, senão parte do círculo de cobrança cairia
  // fora da mesa e ficaria inalcançável.
  margemFora: 18,
  areaLength: 32,     // grande área (profundidade em X)
  areaWidth: 74,      // grande área (largura em Y)
  penaltySpot: 22,
  alturaTravessao: 9, // acima disso a bola passa POR CIMA do gol
};

PITCH.goalMin = (PITCH.width - PITCH.goalWidth) / 2;   // 45
PITCH.goalMax = (PITCH.width + PITCH.goalWidth) / 2;   // 75
PITCH.areaMin = (PITCH.width - PITCH.areaWidth) / 2;
PITCH.areaMax = (PITCH.width + PITCH.areaWidth) / 2;

export const PHYS = {
  buttonRadius: 2.4,
  buttonMass: 1.0,
  keeperRadius: 6.0,   // no futebol de botão o goleiro é uma peça bem maior
  keeperMass: 4.0,
  ballRadius: 1.15,
  ballMass: 0.45,

  // Atrito de Coulomb: desaceleração constante a = -mu * g  (g = 981 cm/s²)
  gravity: 981,
  muButton: 0.16,     // disco desliza no feltro
  muBall: 0.13,       // bola rola (menos atrito que o disco, mas o feltro segura)

  restitutionBody: 0.62,   // disco x disco / disco x bola
  restitutionWall: 0.55,   // contra a tabela
  tangentFriction: 0.12,   // atrito tangencial no impacto (dá "efeito")

  maxShotSpeed: 170,       // cm/s com power = 1.0 (~92cm de corrida do disco)
  minShotSpeed: 10,
  restSpeed: 2.5,          // abaixo disso o corpo é considerado parado
  maxSimSeconds: 9,        // trava de segurança

  // --- A bola sobe ---
  // O botão tem a borda arredondada, então uma pancada com a palheta em pé
  // pega por baixo da bola e a levanta. É assim que se faz gol por cima da
  // caixa do goleiro. Palheta deitada = jogo rasteiro e forte.
  // A rede não devolve a bola: ela engole quase toda a pancada e a bola
  // descansa dentro do gol. 0 seria grudar; um pouquinho dá vida.
  redeDevolve: 0.18,
  redeArrasta: 0.88,
  ballBounce: 0.5,         // restituição vertical ao cair no feltro
  arAtrito: 0.02,          // no ar a bola quase não perde velocidade horizontal
  liftMax: 1.6,            // fração da velocidade de impacto que vira subida
  alturaBotao: 1.1,        // altura útil de um botão de linha (cm)
  alturaVooMin: 0.35,      // abaixo disso a bola é considerada no chão

  dt: 1 / 600,             // passo interno de integração
  frameEvery: 10,          // grava keyframe a cada N passos -> 60 fps
};

// A palheta é a peça que o jogador encosta no aro do botão e pressiona.
// Direção, velocidade e até a "cavadinha" saem de como ela é posicionada.
export const PALHETA = {
  inclinacaoMin: 10,
  inclinacaoMax: 80,
  inclinacaoOtima: 45,        // pressão mais eficiente
  // A curva de rendimento é ASSIMÉTRICA, e por um motivo físico:
  //  - deitada demais, a palheta desliza no bisel sem empurrar: a força se PERDE.
  //  - em pé, a força não se perde, ela é REDIRECIONADA para cima (PHYS.liftMax).
  // Por isso o lado de baixo é estreito (escorrega rápido) e o de cima é largo.
  inclinacaoSigmaBaixa: 12,
  inclinacaoSigmaAlta: 26,

  // Quanto da pancada vira ALTURA da bola, conforme a inclinação.
  // 45° = rasteiro; a partir daí sobe, até o máximo em 80°.
  elevacaoInicio: 45,
  elevacaoTeto: 80,

  avancoOtimo: 0.35,          // fração do raio do botão, a partir da borda
  avancoSigma: 0.20,

  eficienciaMinima: 0.22,     // abaixo disso a palheta escorrega
  escorregaFator: 0.45,       // quanto sobra da força quando escorrega

  // Avanço demais = palheta perto do centro: o botão escapa torto.
  avancoTorto: 0.55,
  desvioPorExcesso: 70,       // graus por unidade de excesso

  // Cavadinha: palheta em pé + força = o botão pula por cima dos outros.
  cavadaInclinacao: 66,
  cavadaForcaMin: 0.45,
  cavadaDuracaoBase: 0.14,
  cavadaDuracaoPorForca: 0.34,
  cavadaAtrito: 0.03,         // no ar quase não freia
  cavadaAltura: 4.2,          // cm, só para o cliente desenhar o pulo
};

// Goleiro: uma caixa de fósforo que o time defensor posiciona dentro da área.
export const KEEPER = {
  comprimento: 16,   // cm, o lado grande da caixa
  espessura: 4.5,    // cm
  altura: 5,         // só para o 3D
};

export const RULES_DEFAULT = {
  buttonsPerTeam: 5,        // jogadores de linha (o goleiro é extra)

  // A vez SÓ passa quando acontece uma destas coisas. Fora isso, segue jogando.
  requireBallContact: true, // não encostar na bola entrega a posse
  foulOnOpponentFirst: true,// encostar em adversário antes da bola = falta
  perdeNoUltimoToque: true, // a bola parar tendo tocado por último no adversário
  // (a bola sair pela linha também passa a vez, sempre)

  touchesPerPossession: 0,  // 0 = sem limite de toques por posse
  maxTurns: 120,            // relógio da partida: total de jogadas
  maxPossessions: 0,        // 0 = sem limite (o relógio é por turnos)
  turnTimeoutMs: 120000,    // tempo para decidir a jogada

  // O gol só conta se o atacante declarou o chute antes — é o que dá sentido
  // a declarar, já que declarar entrega o posicionamento do goleiro ao rival.
  golExigeDeclaracao: true,
  tempoGoleiroMs: 60000,    // prazo do defensor para posicionar a caixa

  // Cobrança (lateral, escanteio, tiro de meta): quem recebe a bola escolhe um
  // botão e o coloca onde quiser perto dela antes de jogar.
  raioCobranca: 18,         // cm ao redor da bola
  tempoCobrancaMs: 60000,
  // Variação de posição no tiro de meio, em cm. Sem isso, dois adversários
  // determinísticos repetem a mesma partida para sempre. O sorteio usa a
  // semente da partida, então o jogo continua reproduzível de ponta a ponta.
  kickoffJitter: 3.5,
};

export const SERVER = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || './data',
  tokenTtlMs: 1000 * 60 * 60 * 24 * 7,
};
