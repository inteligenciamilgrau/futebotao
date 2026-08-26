// O estádio em volta da mesa.
//
// Futebol de botão de verdade é uma mesa numa sala. Aqui a mesa está no meio
// de um estádio: arquibancada em anel, torcida que pula e faz ola, refletores,
// telão de placar e faixas na borda do gramado. Nada disso interfere no jogo —
// é tudo cenário —, então mora num módulo separado do que importa.
//
// A torcida é o único pedaço pesado: são milhares de pessoas. Elas ficam num
// `InstancedMesh` e a animação roda no shader (uma fase por pessoa), então o
// custo por quadro na CPU é zero — só um uniforme de tempo.

import * as THREE from 'three';

const CORES_TORCIDA = [
  0xf4f0e6, 0xe8dcc8, 0x2b3550, 0x39415c, 0x1f242e,
  0xc8b89a, 0x8a5a3b, 0x50607a, 0x6d7a94, 0xd6d2c4,
];

// Em quantos blocos o anel de arquibancada é fatiado. Cada bloco tem cor e
// ânimo próprios; é o que faz a torcida ler como arquibancada de longe.
const SETORES = 22;

// Largura do corredor da escada, medida ao longo do anel. O passo da torcida é
// 5,2, então isto tira uma fileira e meia de gente — corredor que dá para
// subir, sem abrir um vão que quebre o bloco de cor ao lado.
const LARG_ESCADA = 8;

// Envelope da comemoração, em segundos. O que a arquibancada mostra não é o
// valor de `festa` e sim o instante em que cada pessoa cruza o próprio limiar
// (ver `_setores`): rampa curta atropela os limiares e a arquibancada inteira
// levanta junto — o escalonamento existe no atributo e não chega à tela. Gol
// se comemora depressa e se abandona devagar, daí a descida mais longa.
const SUBIDA_FESTA = 1.6;
const DESCIDA_FESTA = 3.5;

// Piso de taxa de quadros para o envelope: um engasgo — aba em segundo plano,
// coleta de lixo — não pode fazer a festa pular a rampa inteira num quadro só.
const DT_MAX = 0.25;

const EIXO_CIMA = new THREE.Vector3(0, 1, 0);

/** Mistura duas cores hex; t=0 dá a primeira. */
function misturar(a, b, t) {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  return ca.lerp(cb, t);
}

export class Estadio {
  /**
   * @param {THREE.Scene} scene
   * @param {{length:number,width:number}} pitch
   * @param {{A:number,B:number}} cores cores dos dois times
   */
  constructor(scene, pitch, cores) {
    this.scene = scene;
    this.pitch = pitch;
    this.cores = cores;
    this.grupo = new THREE.Group();
    this.grupo.name = 'estadio';
    this.scene.add(this.grupo);

    this.uniformes = {
      tempo: { value: 0 },
      festa: { value: 0 },          // 0 = jogo normal, 1 = gol
      ladoFesta: { value: 0 },      // -1 comemora o lado A, +1 o lado B, 0 os dois
      ola: { value: -9 },           // ângulo da ola; fora de [-π,π] = sem ola
    };
    this.festaAte = 0;
    this.olaAte = 0;

    this.construir();
  }

  /* ------------------------------------------------------------ */
  /* Montagem                                                      */
  /* ------------------------------------------------------------ */

  construir() {
    this.limpar();

    const L = this.pitch.length, W = this.pitch.width;
    // A pista em volta do gramado, e onde a arquibancada começa a subir.
    this.pista = { x: L / 2 + 26, z: W / 2 + 26 };
    this.degraus = 14;
    this.passo = { fundo: 9, altura: 4.2 };

    // Antes da torcida de propósito: é ela que abre caminho para as escadas.
    this.escadas = this._ondeSobeEscada();

    this._faixasDeBorda();
    this._bandeirinhas();
    this._arquibancada();
    this._circulacao();
    this._torcida();
    this._bandeiroes();
    this._faixaDoMuro();
    this._refletores();
    this._telao();
    this._ceu();
  }

  limpar() {
    while (this.grupo.children.length) {
      const o = this.grupo.children[0];
      this.grupo.remove(o);
      o.traverse?.((n) => {
        n.geometry?.dispose?.();
        if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose?.());
        else n.material?.dispose?.();
      });
    }
    this.torcida = null;
    this.bandeiroes = [];
  }

  /**
   * Faixas de publicidade rente ao gramado.
   *
   * Duas coisas importam aqui: elas têm que OLHAR PARA O CAMPO (um plano do
   * three nasce virado para +z, então cada lado precisa do seu giro), e a
   * repetição da textura tem que respeitar a proporção — senão as letras
   * esticam e uma frase entra por cima da outra.
   */
  _faixasDeBorda() {
    const L = this.pitch.length, W = this.pitch.width;
    const tex = this._texturaFaixa();
    const alt = 7;
    const proporcao = tex.image.width / tex.image.height;

    const por = [
      // z positivo é o lado de cá: a faixa olha para -z, ou seja, meia volta.
      { w: L + 34, x: 0, z: (W / 2 + 17), rot: Math.PI },
      { w: L + 34, x: 0, z: -(W / 2 + 17), rot: 0 },
      { w: W + 34, x: (L / 2 + 17), z: 0, rot: -Math.PI / 2 },
      { w: W + 34, x: -(L / 2 + 17), z: 0, rot: Math.PI / 2 },
    ];
    for (const f of por) {
      const t = tex.clone();
      t.needsUpdate = true;
      // Uma repetição a cada "altura × proporção" de comprimento: letra sem
      // distorção e sem sobreposição.
      t.repeat.x = Math.max(1, Math.round(f.w / (alt * proporcao)));
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(f.w, alt),
        // Só a frente: de costas o texto sairia espelhado.
        new THREE.MeshStandardMaterial({ map: t, roughness: 0.7, side: THREE.FrontSide })
      );
      m.position.set(f.x, alt / 2 - 0.2, f.z);
      m.rotation.y = f.rot;
      this.grupo.add(m);
    }
  }

  _texturaFaixa() {
    // A MARCA ENTRA EM UMA PLACA SIM, OUTRA NÃO.
    //
    // Placa de publicidade só funciona por repetição: quem assiste lê uma
    // tarja de raspão, nunca a faixa inteira. Com a marca em um quarto dos
    // painéis, como era, a câmera passava a jogada toda sem mostrar o nome do
    // jogo uma vez. Alternando, qualquer enquadramento pega pelo menos uma.
    const frases = [
      'FUTEBOTÃO', 'PALHETA OFICIAL', 'FUTEBOTÃO', 'MESA & FELTRO',
      'FUTEBOTÃO', 'COPA DOS BOTÕES', 'FUTEBOTÃO', 'JOGA NA MESA',
    ];
    const cv = document.createElement('canvas');
    cv.width = 4096; cv.height = 96;
    const c = cv.getContext('2d');
    const largura = cv.width / frases.length;

    frases.forEach((t, i) => {
      const marca = i % 2 === 0;
      c.fillStyle = marca ? '#0f1620' : '#1b2531';
      c.fillRect(i * largura, 0, largura, cv.height);

      // Filete amarelo em cima e embaixo só na placa da marca: é o que separa
      // o painel do patrocinador do painel do slogan a trinta metros.
      if (marca) {
        c.fillStyle = '#ffd24a';
        c.fillRect(i * largura, 0, largura, 4);
        c.fillRect(i * largura, cv.height - 4, largura, 4);
      }

      c.fillStyle = marca ? '#ffd24a' : '#7fe3a0';
      c.textAlign = 'center'; c.textBaseline = 'middle';

      // Encolhe a fonte até a frase caber na tarja dela, com folga nas beiradas.
      let tamanho = 52;
      const cabe = largura - 48;
      do {
        c.font = `bold ${tamanho}px system-ui, sans-serif`;
        if (c.measureText(t).width <= cabe) break;
        tamanho -= 2;
      } while (tamanho > 14);

      c.fillText(t, i * largura + largura / 2, cv.height / 2 + 2);
    });

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    return tex;
  }

  /**
   * Bandeirinhas de escanteio, uma em cada quina das linhas.
   *
   * São quatro mastros de nada e fazem uma falta enorme: sem elas o gramado é
   * um retângulo verde com risco branco, e com elas é um campo de futebol.
   *
   * O mastro é FINO de propósito. Os botões jogam na margem em volta das
   * linhas (`PITCH.margemFora`) e o escanteio se cobra exatamente ali; um
   * mastro gordo viraria um disco espetado num poste em toda cobrança de
   * canto. Com 0,3 de raio contra 2,4 de botão, o encontro é um arranhão.
   */
  _bandeirinhas() {
    const L = this.pitch.length, W = this.pitch.width;
    const alturaMastro = 8.5;      // um pouco abaixo da trave (9): escala certa
    const comp = 4.6, alt = 2.9;
    // Meia diagonal: joga o centro do pano `comp/2` para fora do mastro, que é
    // o que faz a borda de dentro do pano nascer colada nele.
    const fora = comp / (2 * Math.SQRT2);
    const mastros = [], panos = [];

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = sx * (L / 2), z = sz * (W / 2);

        const mastro = new THREE.CylinderGeometry(0.3, 0.36, alturaMastro, 6);
        mastro.translate(x, alturaMastro / 2, z);
        mastros.push(mastro);

        // O pano sai na DIAGONAL, para fora do campo. Duas razões: assim ele
        // nunca fica de perfil (nem para a câmera de lateral nem para a de
        // fundo de campo, que estão a 90° uma da outra) e não avança por cima
        // do gramado, onde atrapalharia a leitura da jogada.
        const pano = new THREE.PlaneGeometry(comp, alt);
        const m = new THREE.Matrix4().makeRotationY(Math.atan2(-sz, sx));
        m.setPosition(x + sx * fora, alturaMastro - alt / 2 - 0.4, z + sz * fora);
        pano.applyMatrix4(m);
        panos.push(pano);
      }
    }

    // Os quatro mastros são uma malha e os quatro panos são outra: duas cores,
    // dois draw calls, e não oito objetos soltos.
    const malhaMastro = new THREE.Mesh(
      mesclar(mastros),
      new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.5 })
    );
    // Único pedaço do estádio que projeta sombra, e com motivo: ele fica DENTRO
    // do alcance da sombra do sol (±165) e no meio do feltro, ao lado de botões
    // que projetam a deles. Um mastro sem sombra ali flutuaria.
    malhaMastro.castShadow = true;
    this.grupo.add(malhaMastro);

    this.grupo.add(new THREE.Mesh(
      mesclar(panos),
      new THREE.MeshStandardMaterial({
        color: 0xffd24a,
        roughness: 0.85,
        // Dos dois lados: o pano é uma folha de papel, tem verso.
        side: THREE.DoubleSide,
        // O pano é vertical, e o sol vem de cima: ele pega luz de raspão e nos
        // dois cantos da sombra saía marrom (medido: 63,58,34 contra
        // 255,210,74 de cor própria). Um quinto de luz própria é o que faz a
        // bandeirinha continuar amarela nos quatro cantos sem virar lâmpada.
        emissive: 0xffd24a,
        emissiveIntensity: 0.2,
      })
    ));
  }

  /**
   * O anel de arquibancada. Cada degrau é uma moldura retangular vazada, o que
   * dá a rampa das quatro laterais e dos cantos com quatro caixas por degrau.
   */
  _arquibancada() {
    const matConcreto = new THREE.MeshStandardMaterial({ color: 0x565f6b, roughness: 0.95 });
    const matDegrau = new THREE.MeshStandardMaterial({ color: 0x424a55, roughness: 1 });

    for (let i = 0; i < this.degraus; i++) {
      const dentroX = this.pista.x + i * this.passo.fundo;
      const dentroZ = this.pista.z + i * this.passo.fundo;
      const y = i * this.passo.altura;
      const mat = i % 2 ? matDegrau : matConcreto;

      // Dois degraus compridos (fundos de campo em x, laterais em z).
      for (const s of [-1, 1]) {
        const lateral = new THREE.Mesh(
          new THREE.BoxGeometry(dentroX * 2 + this.passo.fundo * 2, this.passo.altura, this.passo.fundo),
          mat
        );
        lateral.position.set(0, y + this.passo.altura / 2, s * (dentroZ + this.passo.fundo / 2));
        lateral.receiveShadow = true;
        this.grupo.add(lateral);

        const fundo = new THREE.Mesh(
          new THREE.BoxGeometry(this.passo.fundo, this.passo.altura, dentroZ * 2),
          mat
        );
        fundo.position.set(s * (dentroX + this.passo.fundo / 2), y + this.passo.altura / 2, 0);
        fundo.receiveShadow = true;
        this.grupo.add(fundo);
      }
    }

    // Muro externo, para o estádio não parecer aberto no vazio.
    //
    // QUATRO PAREDES, e não uma caixa. Uma BoxGeometry com BackSide também tem
    // TAMPA, e essa tampa virava um teto preto por cima do estádio inteiro:
    // do nível do campo não se via mais nem o céu nem o telão. Muro é parede.
    const fora = this.degraus * this.passo.fundo;
    const alturaMuro = this.degraus * this.passo.altura + 26;
    const meiaX = (this.pista.x + fora) + 8;
    const meiaZ = (this.pista.z + fora) + 8;
    const matMuro = new THREE.MeshStandardMaterial({
      color: 0x2a3038, roughness: 1, side: THREE.DoubleSide,
    });
    const yMuro = alturaMuro / 2 - 12;

    for (const [larg, x, z, giro] of [
      [meiaX * 2, 0, -meiaZ, 0],
      [meiaX * 2, 0, meiaZ, Math.PI],
      [meiaZ * 2, -meiaX, 0, Math.PI / 2],
      [meiaZ * 2, meiaX, 0, -Math.PI / 2],
    ]) {
      const parede = new THREE.Mesh(new THREE.PlaneGeometry(larg, alturaMuro), matMuro);
      parede.position.set(x, yMuro, z);
      parede.rotation.y = giro;
      this.grupo.add(parede);
    }

    // `topo` é a última fila; `topoMuro` é onde a parede acaba. Os dois saem
    // daqui de propósito: quem for pendurar coisa na arquibancada precisa dos
    // dois limites, e recalcular a fórmula do muro noutro lugar é o jeito
    // clássico de um deles ficar para trás quando os degraus mudam.
    this.muro = {
      meiaX, meiaZ,
      topo: this.degraus * this.passo.altura,
      topoMuro: yMuro + alturaMuro / 2,
    };
  }

  /**
   * A tarja da marca correndo em volta do estádio inteiro, logo acima da
   * última fila.
   *
   * As faixas rente ao gramado só aparecem quando a câmera está baixa; esta
   * pega o enquadramento oposto — a vista de cima, que é a mais usada para
   * jogar. Entre as duas, não existe ângulo em que o nome do jogo não esteja
   * na tela.
   */
  _faixaDoMuro() {
    const { meiaX, meiaZ, topo } = this.muro;
    const alt = 9;
    const tex = this._texturaMarca();
    const proporcao = tex.image.width / tex.image.height;

    for (const [larg, x, z, giro] of [
      [meiaX * 2, 0, -meiaZ, 0],
      [meiaX * 2, 0, meiaZ, Math.PI],
      [meiaZ * 2, -meiaX, 0, Math.PI / 2],
      [meiaZ * 2, meiaX, 0, -Math.PI / 2],
    ]) {
      const t = tex.clone();
      t.needsUpdate = true;
      // Mesma conta das faixas de borda: repetição pela PROPORÇÃO, senão as
      // letras esticam num lado do estádio e se espremem no outro.
      t.repeat.x = Math.max(1, Math.round(larg / (alt * proporcao)));

      const faixa = new THREE.Mesh(
        new THREE.PlaneGeometry(larg, alt),
        new THREE.MeshStandardMaterial({ map: t, roughness: 0.8, side: THREE.FrontSide })
      );
      // 0,6 para dentro do muro: coladas, as duas superfícies cintilam.
      faixa.position.set(x * 0.994, topo + alt / 2 + 3, z * 0.994);
      faixa.rotation.y = giro;
      this.grupo.add(faixa);
    }
  }

  /**
   * A marca, ladrilhável. Serve na tarja do muro, no pano das bandeirinhas de
   * escanteio e no rodapé do telão — um desenho só, três usos.
   */
  _texturaMarca() {
    if (this._texMarca) return this._texMarca;

    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 128;
    const c = cv.getContext('2d');

    c.fillStyle = '#0f1620';
    c.fillRect(0, 0, cv.width, cv.height);
    c.fillStyle = '#ffd24a';
    c.fillRect(0, 0, cv.width, 5);
    c.fillRect(0, cv.height - 5, cv.width, 5);

    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 62px system-ui, sans-serif';
    for (const [x, cor] of [[256, '#ffd24a'], [768, '#7aa2ff']]) {
      c.fillStyle = cor;
      c.fillText('FUTEBOTÃO', x, cv.height / 2 + 2);
    }
    // Um ponto entre as repetições, para a tarja não virar uma palavra só
    // quando a textura se repete muitas vezes seguidas.
    c.fillStyle = '#3a4658';
    for (const x of [0, 512]) {
      c.beginPath();
      c.arc(x + 6, cv.height / 2, 9, 0, Math.PI * 2);
      c.fill();
    }

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    this._texMarca = tex;
    return tex;
  }

  /** O anel retangular a `r` de distância da boca da arquibancada. */
  _anelEm(r) {
    const dx = this.pista.x + r, dz = this.pista.z + r;
    return { dx, dz, volta: 4 * (dx + dz) };
  }

  /**
   * O anel onde fica a fileira do degrau `i`: o meio do piso, que é onde a
   * torcida senta e por onde a escada passa. `volta` é o perímetro dele —
   * cada degrau tem o seu, e é por isso que a mesma fração `u` sobe o anel
   * inteiro em linha reta (ver `_torcida`).
   */
  _anel(i) {
    return this._anelEm(i * this.passo.fundo + this.passo.fundo * 0.5);
  }

  /**
   * Em quais divisas de setor sobe uma escada.
   *
   * A divisa serve de trilho porque ela já é um raio saindo do meio do campo:
   * a escada acompanha o mesmo `u` do primeiro ao último degrau e nunca corta
   * um bloco de cor pela metade. Uma divisa a cada duas dá bloco de umas
   * quinze cadeiras entre corredores, que é a conta de estádio de verdade.
   *
   * Divisa que passa raspando numa quina fica de fora: ali o anel dobra 90° e
   * a escada sairia com metade dos degraus virada para o outro lado.
   */
  _ondeSobeEscada() {
    const lista = [];
    for (let s = 2; s < SETORES; s += 2) {
      const u = s / SETORES;
      let folga = Infinity;
      for (let i = 0; i < this.degraus; i++) {
        const a = this._anel(i);
        // As quinas ficam em 0, 2dx, 2dx+2dz e 4dx+2dz do perímetro; a folga é
        // a menor distância até uma delas, no degrau mais apertado.
        const d = u * a.volta;
        for (const q of [0, 2 * a.dx, 2 * a.dx + 2 * a.dz, 4 * a.dx + 2 * a.dz, a.volta]) {
          folga = Math.min(folga, Math.abs(d - q));
        }
      }
      if (folga > LARG_ESCADA * 1.5) lista.push(u);
    }
    return lista;
  }

  /** A pessoa em `u` está no corredor de alguma escada? */
  _noCorredor(u, volta) {
    for (const escada of this.escadas) {
      let d = Math.abs(u - escada);
      if (d > 0.5) d = 1 - d;           // o anel fecha: vale a volta mais curta
      if (d * volta < LARG_ESCADA / 2 + 1.8) return true;   // + meio ombro
    }
    return false;
  }

  /**
   * Circulação: as escadas que sobem a arquibancada, o corrimão de cada uma e
   * o guarda-corpo na boca do anel.
   *
   * É o que separa arquibancada de escadaria de concreto — sem corredor a
   * torcida vira um tapete de gente sem começo nem fim, e o degrau da frente
   * some contra o gramado. Tudo aqui é caixa, e todas as caixas viram duas
   * malhas mescladas: dois draw calls para o estádio inteiro.
   */
  _circulacao() {
    const piso = [];
    const metal = [];
    const espessura = 2.6;

    for (const u of this.escadas) {
      const eixo = this._eixoDoLance(u);
      // A placa é um tico mais curta que o passo do lance para não encostar na
      // placa seguinte: duas faces coladas cintilam.
      const fundoPlaca = eixo.passo - 0.3;

      for (let k = 0; k < eixo.lances; k++) {
        // Largura ATRAVESSADA no lance, fundo NA DIREÇÃO dele. Com o giro
        // aplicado, a caixa fica esquadrejada com a escada — e não com o
        // degrau, que é onde ela estava torta.
        const g = new THREE.BoxGeometry(eixo.largura, espessura, fundoPlaca);
        // 0,12 acima do concreto: a placa tem que aparecer, não brigar com ele.
        const topo = this.passo.altura + k * (this.passo.altura / 2) + 0.12;
        const m = eixo.giro.clone();
        m.setPosition(
          eixo.pe.x + eixo.dir.x * (k * eixo.passo),
          topo - espessura / 2,
          eixo.pe.z + eixo.dir.z * (k * eixo.passo)
        );
        g.applyMatrix4(m);
        piso.push(g);
      }
      metal.push(...this._corrimao(eixo));
    }
    metal.push(...this._guardaCorpo());

    const malhaPiso = new THREE.Mesh(
      mesclar(piso),
      new THREE.MeshStandardMaterial({ color: 0x6f7986, roughness: 0.9 })
    );
    malhaPiso.receiveShadow = true;
    this.grupo.add(malhaPiso);

    this.grupo.add(new THREE.Mesh(
      mesclar(metal),
      new THREE.MeshStandardMaterial({ color: 0x9aa4b1, roughness: 0.45, metalness: 0.3 })
    ));
  }

  /**
   * O eixo de um lance de escada: a reta que a escada inteira segue.
   *
   * Uma escada mora numa fração `u` do PERÍMETRO, e o perímetro cresce a cada
   * degrau. Subir mantendo `u` afasta do campo E anda ao longo do anel: o
   * lance é uma reta ENVIESADA em relação ao degrau, com até 39° de viés nas
   * escadas mais tortas deste anel. É de propósito — é o mesmo viés que faz os
   * setores da torcida subirem em cunha e que abre o corredor no lugar certo.
   *
   * Quem manda, portanto, é esta reta, e não o eixo do degrau. O corrimão já a
   * seguia; a placa do piso não, e por isso as escadas de maior viés saíam com
   * os degraus atravessados, metade para fora do corredor e em cima da
   * torcida. Aqui a reta sai uma vez só e vale para os dois.
   *
   * As pontas ficam no MEIO do primeiro e do último lance, não na borda do
   * degrau: é o único par de pontos em que a reta fica paralela à escada.
   * Medindo pela borda ela erra meio degrau lá em cima.
   */
  _eixoDoLance(u) {
    // O piso do degrau tem 9 de fundo — passo demais para uma perna só. A
    // escada o divide em dois lances de 4,5 por 2,1, e é essa divisão que faz
    // o lance ler como escada e não como rampa.
    const lances = this.degraus * 2;
    const rPe = this.passo.fundo / 4;
    const rTopo = rPe + (lances - 1) * (this.passo.fundo / 2);
    const a0 = this._anelEm(rPe), a1 = this._anelEm(rTopo);
    const p0 = pontoNoAnel(u, a0.dx, a0.dz);
    const p1 = pontoNoAnel(u, a1.dx, a1.dz);

    const dir = new THREE.Vector3(p1.x - p0.x, 0, p1.z - p0.z);
    const comprimento = dir.length();
    dir.divideScalar(comprimento);

    // O lance se afasta do campo exatamente `rTopo - rPe`, e gasta
    // `comprimento` para isso: a razão entre os dois É o cosseno do viés.
    const cos = (rTopo - rPe) / comprimento;

    // Giro só em torno de Y — os dois pontos entram na mesma altura. Uma
    // matriz com os pontos nas alturas reais inclinaria a placa junto com a
    // escada, e degrau de escada é deitado.
    const giro = new THREE.Matrix4().lookAt(
      new THREE.Vector3(p0.x, 0, p0.z),
      new THREE.Vector3(p1.x, 0, p1.z),
      EIXO_CIMA
    );

    return {
      pe: p0,
      topo: p1,
      dir,
      giro,
      lances,
      passo: comprimento / (lances - 1),
      // O corredor aberto na torcida tem LARG_ESCADA medido AO LONGO do anel
      // (ver `_noCorredor`); atravessado de viés, ele estreita pelo cosseno.
      // A escada usa a largura que CABE no corredor — mais que isso e a placa
      // volta a pisar em quem está sentado do lado.
      largura: LARG_ESCADA * cos,
      yPe: this.passo.altura + 0.12,
      yTopo: this.degraus * this.passo.altura + this.passo.altura / 2 + 0.12,
    };
  }

  /**
   * Corrimão dos dois lados de um lance.
   *
   * Ele é uma barra só, do pé ao topo, e não uma por degrau: o lance é uma
   * reta e a barra tem que ser a reta.
   */
  _corrimao(eixo) {
    const altura = 3.6;
    const acima = altura / 2;    // a barra nasce rente ao piso dos lances
    // Perpendicular ao lance, no plano do chão: é o que põe a barra na BORDA
    // da placa. Afastar pelo eixo do degrau, como era antes, escorrega a barra
    // ao longo dela mesma e as pontas deixam de casar com o primeiro e o
    // último degrau.
    const perp = new THREE.Vector3().crossVectors(EIXO_CIMA, eixo.dir);

    const saida = [];
    for (const lado of [-1, 1]) {
      const off = perp.clone().multiplyScalar((lado * eixo.largura) / 2);
      const pe = new THREE.Vector3(eixo.pe.x, eixo.yPe + acima, eixo.pe.z).add(off);
      const topo = new THREE.Vector3(eixo.topo.x, eixo.yTopo + acima, eixo.topo.z).add(off);

      const g = new THREE.BoxGeometry(0.5, altura, pe.distanceTo(topo));
      // lookAt alinha o +Z da caixa com o lance; o up fixo mantém a barra em pé.
      const m = new THREE.Matrix4().lookAt(pe, topo, EIXO_CIMA);
      m.setPosition((pe.x + topo.x) / 2, (pe.y + topo.y) / 2, (pe.z + topo.z) / 2);
      g.applyMatrix4(m);
      saida.push(g);
    }
    return saida;
  }

  /**
   * Guarda-corpo na boca da arquibancada: a barra que separa o público do
   * gramado. Vazado de propósito — uma mureta cheia esconderia a primeira
   * fileira, e é justamente ela que dá a escala do estádio.
   */
  _guardaCorpo() {
    const saida = [];
    const rx = this.pista.x + 0.7, rz = this.pista.z + 0.7;
    const yBarra = this.passo.altura + 4.0;
    const alturaPoste = yBarra - this.passo.altura;

    for (const s of [-1, 1]) {
      const emX = new THREE.BoxGeometry(2 * rx, 0.5, 0.5);
      emX.translate(0, yBarra, s * rz);
      saida.push(emX);
      // A barra do fundo morre meio passo antes da quina: se as duas famílias
      // se cruzassem, as faces de cima ficariam coplanares e cintilariam. A
      // falta de 0,25 numa barra de 0,5 não se vê a essa distância.
      const emZ = new THREE.BoxGeometry(0.5, 0.5, 2 * rz - 1);
      emZ.translate(s * rx, yBarra, 0);
      saida.push(emZ);
    }

    // Um poste a cada degrau de fundo (9), arredondado para fechar certo nas
    // quinas — sobra de poste na quina não aparece, falta aparece. A volta em Z
    // pula as pontas: a de X já plantou o poste da quina, e dois postes no
    // mesmo lugar brigam por profundidade.
    const poste = (x, z) => {
      const g = new THREE.BoxGeometry(0.45, alturaPoste, 0.45);
      g.translate(x, this.passo.altura + alturaPoste / 2, z);
      saida.push(g);
    };
    const nX = Math.round((2 * rx) / this.passo.fundo);
    for (let k = 0; k <= nX; k++) {
      const x = -rx + (k * 2 * rx) / nX;
      poste(x, rz); poste(x, -rz);
    }
    const nZ = Math.round((2 * rz) / this.passo.fundo);
    for (let k = 1; k < nZ; k++) {
      const z = -rz + (k * 2 * rz) / nZ;
      poste(rx, z); poste(-rx, z);
    }
    return saida;
  }

  /**
   * A torcida. Uma pessoa é uma caixinha com cabeça; são milhares, então vão
   * todas num InstancedMesh e a animação de pular sai no shader.
   *
   * O anel é fatiado em setores (ver `_setores`), e o setor é a unidade de
   * tudo: dá a cor e dá o ânimo. Sortear cor pessoa a pessoa, como era antes,
   * vira chuvisco a vinte metros de distância — arquibancada de verdade se lê
   * por manchas, não por indivíduos.
   */
  _torcida() {
    const pessoas = [];

    // Duas fileiras por degrau, e ninguém nos dois primeiros (é a pista).
    for (let i = 1; i < this.degraus; i++) {
      const { dx, dz, volta } = this._anel(i);
      const y = i * this.passo.altura + this.passo.altura;

      const passoLateral = 5.2;
      const nLat = Math.floor((dx * 2) / passoLateral);
      const nFundo = Math.floor((dz * 2) / passoLateral);

      // `u` é a distância já percorrida na volta do anel, 0..1, sempre a
      // partir do mesmo canto. Como cada degrau normaliza pelo próprio
      // perímetro, um mesmo `u` cai no mesmo setor em toda a altura: os blocos
      // sobem a arquibancada em cunha, que é como setor de estádio é de verdade.
      // Onde passa escada não senta ninguém: sem abrir o corredor na torcida a
      // escada ficaria desenhada por cima das pessoas.
      const sentar = (p) => { if (!this._noCorredor(p.u, volta)) pessoas.push(p); };

      for (let k = 0; k < nLat; k++) {
        const x = -dx + (k + 0.5) * passoLateral;
        sentar({ x, y, z: dz, u: (x + dx) / volta });
        sentar({ x, y, z: -dz, u: (2 * dx + 2 * dz + (dx - x)) / volta });
      }
      for (let k = 0; k < nFundo; k++) {
        const z = -dz + (k + 0.5) * passoLateral;
        sentar({ x: dx, y, z, u: (2 * dx + (dz - z)) / volta });
        sentar({ x: -dx, y, z, u: (4 * dx + 2 * dz + (z + dz)) / volta });
      }
    }

    const total = pessoas.length;
    // Corpo simples: um tronco e uma cabeça, fundidos numa geometria só.
    const corpo = new THREE.CylinderGeometry(1.5, 1.8, 5.6, 6);
    corpo.translate(0, 2.8, 0);
    const cabeca = new THREE.SphereGeometry(1.35, 7, 5);
    cabeca.translate(0, 6.6, 0);
    const geo = mesclar([corpo, cabeca]);

    geo.setAttribute('fase', new THREE.InstancedBufferAttribute(new Float32Array(total), 1));
    geo.setAttribute('lado', new THREE.InstancedBufferAttribute(new Float32Array(total), 1));
    geo.setAttribute('angulo', new THREE.InstancedBufferAttribute(new Float32Array(total), 1));
    // (limiar, ânimo): quanto de festa a pessoa precisa para levantar, e o
    // tamanho do que ela faz. Vai em atributo justamente para a festa
    // continuar sendo um uniforme só — nada por pessoa por quadro.
    geo.setAttribute('animo', new THREE.InstancedBufferAttribute(new Float32Array(total * 2), 2));

    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this._patchTorcida(mat);

    const malha = new THREE.InstancedMesh(geo, mat, total);
    malha.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    malha.frustumCulled = false;

    // Os limites dos setores saem de um anel de referência (o degrau do meio),
    // não do degrau que está sendo montado: assim eles não escorregam de uma
    // fileira para a outra.
    const iRef = Math.floor(this.degraus / 2);
    const setores = this._setores(
      this.pista.x + iRef * this.passo.fundo,
      this.pista.z + iRef * this.passo.fundo
    );

    const m = new THREE.Matrix4();
    const cor = new THREE.Color();
    const fases = geo.getAttribute('fase');
    const lados = geo.getAttribute('lado');
    const angulos = geo.getAttribute('angulo');
    const animos = geo.getAttribute('animo');

    for (let i = 0; i < total; i++) {
      const p = pessoas[i];
      const setor = setores[Math.min(SETORES - 1, Math.floor(p.u * SETORES))];

      // Parte do público geral não se levanta. Isso precisa aparecer também
      // com a arquibancada parada, senão a pessoa some no meio da multidão:
      // quem fica sentado é desenhado menor.
      const sentado = !setor.organizada && rnd(i * 5.1) > 0.35 + setor.animo * 0.55;
      const animo = sentado ? 0.12 : Math.min(1, setor.animo * (0.8 + rnd(i * 8.9) * 0.25));

      // Altura e giro variados: uma multidão idêntica não parece multidão.
      const escala = (sentado ? 0.7 : 0.9) + rnd(i * 3.7) * 0.32;
      m.makeRotationY(rnd(i * 1.9) * Math.PI * 2);
      m.scale(new THREE.Vector3(escala, escala, escala));
      m.setPosition(p.x, p.y, p.z);
      malha.setMatrixAt(i, m);

      if (setor.organizada) {
        // Dentro do bloco só varia o brilho, e só para baixo: de longe o setor
        // tem que ler como uma mancha só.
        cor.copy(setor.base).multiplyScalar(0.82 + rnd(i * 11.1) * 0.18);
      } else {
        // Público geral: roupa comum, com uma minoria de camisa do time do
        // gol mais próximo.
        if (rnd(i * 7.3) < 0.38) cor.copy(misturar(this.cores[setor.time], 0xffffff, rnd(i * 11.1) * 0.4));
        else cor.setHex(CORES_TORCIDA[Math.floor(rnd(i * 13.7) * CORES_TORCIDA.length)]);
      }
      malha.setColorAt(i, cor);

      fases.setX(i, rnd(i * 2.3) * Math.PI * 2);
      lados.setX(i, p.x < 0 ? -1 : 1);
      angulos.setX(i, Math.atan2(p.z, p.x));
      animos.setXY(i, setor.limiar, animo);
    }
    malha.instanceMatrix.needsUpdate = true;
    if (malha.instanceColor) malha.instanceColor.needsUpdate = true;

    this.grupo.add(malha);
    this.torcida = malha;
  }

  /**
   * Fatia o anel em setores e decide o que é cada um.
   *
   * Atrás dos gols é território de organizada: bloco quase inteiro na cor do
   * time, que levanta no primeiro instante do gol. Nas laterais o padrão é
   * público geral — cor misturada, sobe tarde e nem todo mundo sobe —, com um
   * núcleo organizado aparecendo de vez em quando.
   *
   * @param {number} dx meia-largura do anel de referência, no eixo do campo
   * @param {number} dz meia-largura do anel de referência, no eixo do gol
   */
  _setores(dx, dz) {
    const lista = [];
    for (let s = 0; s < SETORES; s++) {
      const c = pontoNoAnel((s + 0.5) / SETORES, dx, dz);
      const time = c.x < 0 ? 'A' : 'B';
      const organizada = c.fundo ? rnd(s * 17.3) < 0.88 : rnd(s * 19.7) < 0.22;

      if (organizada) {
        lista.push({
          organizada: true,
          time,
          // Uma cor por setor, ora puxada para o claro ora para o escuro: os
          // blocos atrás do gol viram faixas em vez de um borrão chapado.
          base: misturar(this.cores[time], rnd(s * 23.1) < 0.5 ? 0xffffff : 0x101014, 0.15 + rnd(s * 29.3) * 0.2),
          limiar: rnd(s * 31.7) * 0.12,
          animo: 0.85 + rnd(s * 37.1) * 0.15,
        });
      } else {
        lista.push({
          organizada: false,
          time,
          limiar: 0.18 + rnd(s * 41.3) * 0.42,
          animo: 0.45 + rnd(s * 43.9) * 0.35,
        });
      }
    }
    return lista;
  }

  /**
   * Enxerta o pulo no shader da torcida.
   *
   * Cada pessoa tem uma fase própria, então o pulo nunca fica sincronizado —
   * a não ser na comemoração, em que todo mundo sobe junto, e na ola, que é
   * uma onda que corre pelo anel.
   */
  _patchTorcida(mat) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.tempo = this.uniformes.tempo;
      shader.uniforms.festa = this.uniformes.festa;
      shader.uniforms.ladoFesta = this.uniformes.ladoFesta;
      shader.uniforms.ola = this.uniformes.ola;

      shader.vertexShader = `
        attribute float fase;
        attribute float lado;
        attribute float angulo;
        attribute vec2 animo;
        uniform float tempo;
        uniform float festa;
        uniform float ladoFesta;
        uniform float ola;
      ` + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // Vaivém baixinho o tempo todo: uma torcida nunca fica parada. Quem
        // está sentado quase não se mexe.
        float balanco = sin(tempo * 1.6 + fase) * (0.15 + animo.y * 0.4);

        // Comemoração. O uniforme de festa é o mesmo para todo mundo; o que
        // escalona a arquibancada é o limiar de cada um — a organizada explode
        // no começo da rampa, o público geral entra depois e desiste antes.
        float entrou = smoothstep(animo.x, animo.x + 0.3, festa);
        float meu = (ladoFesta == 0.0) ? 1.0 : (lado * ladoFesta > 0.0 ? 1.0 : 0.35);
        float pulo = abs(sin(tempo * 6.5 + fase * 0.6)) * 7.0 * entrou * meu * animo.y;

        // Ola: uma onda estreita correndo pelo anel.
        float dist = abs(atan(sin(angulo - ola), cos(angulo - ola)));
        float onda = smoothstep(0.55, 0.0, dist) * 8.0 * (0.15 + animo.y * 0.85);

        transformed.y += balanco + pulo + onda;
        `
      );
    };
    // Materiais com onBeforeCompile precisam de chave própria de cache.
    mat.customProgramCacheKey = () => 'torcida';
  }

  /**
   * O BANDEIRÃO: um pano gigante por cima da organizada, atrás de cada gol.
   *
   * Ele não fica sempre aberto. Sobe no gol do lado dele e, fora isso, de vez
   * em quando — que é o que faz a arquibancada parecer viva em vez de um papel
   * de parede. Um bandeirão permanente vira cenário em trinta segundos; um que
   * aparece é evento, e o olho volta para ele toda vez.
   *
   * A abertura é feita no SHADER, descartando o que ainda está enrolado: o
   * pano desenrola de baixo para cima, como quem puxa o bandeirão por cima das
   * cabeças. Fazer isso mexendo na geometria custaria um upload por quadro; do
   * jeito que está, o quadro inteiro é um uniforme.
   */
  _bandeiroes() {
    this.bandeiroes = [];

    const larg = 116;
    // 38° de inclinação para trás: em pé o pano fica de perfil para a câmera
    // alta, e deitado some para a câmera rasante. Este ângulo é o único que
    // se lê nas duas.
    const inclinacao = (38 * Math.PI) / 180;
    const cos = Math.cos(inclinacao), sen = Math.sin(inclinacao);

    // De qual fila saem as mãos que seguram o pano.
    const fileira = 3;
    const baseY = fileira * this.passo.altura + 7;

    // A ALTURA NÃO É ESCOLHIDA, É CALCULADA — o pano tem que caber dentro do
    // estádio.
    //
    // Com 74 de altura saindo da fila 6, o topo ia parar em y=90,6 e a parede
    // acaba em 72,8: o bandeirão aparecia recortado contra o céu, do lado de
    // fora do muro. Como ele sobe pelo eixo inclinado, cada unidade de pano
    // vale `cos(38°)` de altura, e é essa conta que decide o tamanho. Assim
    // mexer nos degraus não volta a furar o teto em silêncio.
    const folga = 6;
    const cabe = (this.muro.topoMuro - folga - baseY) / cos;
    const alt = Math.min(74, cabe);

    for (const s of [-1, 1]) {
      const tex = this._texturaBandeirao(s < 0 ? 'A' : 'B');

      const uniformes = {
        tempoPano: { value: 0 },
        abre: { value: 0 },
      };

      const mat = new THREE.MeshLambertMaterial({
        map: tex,
        // O pano é vertical e a luz do estádio vem de cima: sem um piso de luz
        // própria, o bandeirão fica marrom exatamente como acontecia com as
        // bandeirinhas de escanteio.
        emissive: 0xffffff,
        emissiveMap: tex,
        emissiveIntensity: 0.42,
        side: THREE.DoubleSide,
        transparent: true,
      });
      this._patchBandeirao(mat, uniformes);

      const malha = new THREE.Mesh(new THREE.PlaneGeometry(larg, alt, 30, 20), mat);

      // Base explícita em vez de três rotações de Euler: `direita` é a largura
      // do pano, `normal` é para onde ele olha, e `cima` sai do produto
      // vetorial — assim o texto nunca sai espelhado de um dos lados.
      const normal = new THREE.Vector3(-s * cos, sen, 0);
      const direita = new THREE.Vector3(0, 0, s);
      const cima = new THREE.Vector3().crossVectors(normal, direita);
      malha.matrixAutoUpdate = false;
      malha.matrix.makeBasis(direita, cima, normal);

      // A ÂNCORA É A BORDA DE BAIXO DO PANO, não o centro dele.
      //
      // Com o centro sobre uma fila, a metade de baixo do bandeirão entrava no
      // concreto — e é justamente ali que fica o escudo. Aqui a conta parte de
      // onde o pano COMEÇA, na altura dos ombros de quem segura, e sobe meia
      // altura pelo próprio eixo inclinado do pano, que é o que `cima` já é.
      const base = new THREE.Vector3(
        s * (this.pista.x + fileira * this.passo.fundo),
        baseY,
        0
      );
      malha.matrix.setPosition(base.addScaledVector(cima, alt / 2));
      malha.frustumCulled = false;
      this.grupo.add(malha);

      this.bandeiroes.push({ malha, uniformes, alvo: 0, s });
    }

    // O primeiro sobe cedo: quem entra numa partida em andamento tem que ver
    // que isso existe antes do primeiro gol.
    this._proximoBandeirao = performance.now() / 1000 + 12;
  }

  /**
   * O pano. Cor do time, listras de tecido e o escudo do jogo no meio.
   *
   * O escudo é carregado DEPOIS: o canvas já nasce com um pano pintado e o
   * nome escrito à mão, e a imagem entra por cima quando chegar. Assim um
   * `public/img/logo.webp` ausente ou lento não deixa um retângulo vazio
   * pendurado na arquibancada.
   */
  _texturaBandeirao(time) {
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 700;
    const c = cv.getContext('2d');
    const base = new THREE.Color(this.cores[time]).getStyle();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;

    const pintar = (foto) => {
      c.fillStyle = base;
      c.fillRect(0, 0, cv.width, cv.height);

      // Listras na diagonal, escuras: dão pano em vez de cartolina.
      c.save();
      c.globalAlpha = 0.16;
      c.fillStyle = '#000';
      for (let i = -cv.height; i < cv.width; i += 96) {
        c.beginPath();
        c.moveTo(i, 0); c.lineTo(i + 48, 0);
        c.lineTo(i + 48 + cv.height, cv.height); c.lineTo(i + cv.height, cv.height);
        c.closePath(); c.fill();
      }
      c.restore();

      // O ESCUDO, e não o pôster de abertura.
      //
      // Bandeirão de torcida carrega o brasão do time, não uma paisagem. Além
      // disso o escudo tem fundo transparente e é desenho de traço grosso: ele
      // sobrevive a trinta metros de distância, num pano ondulando, com a
      // metade de baixo na sombra. Uma foto de estádio dentro de uma janela
      // vira mancha marrom nessas condições.
      if (foto) {
        // Ocupa a altura quase inteira, centralizado; a cor do time fica de
        // moldura, que é o que identifica o setor de longe.
        const alvo = cv.height * 0.86;
        const escala = alvo / foto.height;
        c.drawImage(
          foto,
          (cv.width - foto.width * escala) / 2,
          (cv.height - alvo) / 2,
          foto.width * escala,
          alvo
        );
      } else {
        // Enquanto o escudo não chega, o nome escrito à mão segura o pano.
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.font = 'bold 132px system-ui, sans-serif';
        c.lineWidth = 14;
        c.strokeStyle = 'rgba(6,10,16,0.85)';
        c.strokeText('FUTEBOTÃO', cv.width / 2, cv.height / 2);
        c.fillStyle = '#ffd24a';
        c.fillText('FUTEBOTÃO', cv.width / 2, cv.height / 2);
      }

      tex.needsUpdate = true;
    };

    pintar(null);

    const img = new Image();
    img.onload = () => pintar(img);
    img.onerror = () => { /* fica o pano liso, e ninguém percebe */ };
    img.src = '/img/logo.webp';

    return tex;
  }

  /** Ondulação do pano e o desenrolar, os dois no shader. */
  _patchBandeirao(mat, uniformes) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.tempoPano = uniformes.tempoPano;
      shader.uniforms.abre = uniformes.abre;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `
          #include <common>
          uniform float tempoPano;
          uniform float abre;
          varying vec2 vPano;
        `)
        .replace('#include <begin_vertex>', `
          #include <begin_vertex>
          vPano = uv;
          // A onda cresce de baixo para cima: a borda de baixo é a que está
          // presa nas mãos, e pano preso não balança.
          float amp = uv.y * abre * 3.4;
          transformed.z += (sin(uv.x * 7.0 + tempoPano * 2.1)
                          + sin(uv.y * 4.5 - tempoPano * 1.6) * 0.7) * amp;
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `
          #include <common>
          uniform float abre;
          varying vec2 vPano;
        `)
        .replace('#include <dithering_fragment>', `
          #include <dithering_fragment>
          // O que ainda não subiu simplesmente não existe.
          if (vPano.y > abre) discard;
          // E a borda que está subindo escurece: é o rolo do pano.
          float rolo = smoothstep(0.06, 0.0, abre - vPano.y);
          gl_FragColor.rgb *= 1.0 - rolo * 0.65;
        `);
    };
  }

  /** Quatro torres de refletor nos cantos. */
  _refletores() {
    const fora = this.degraus * this.passo.fundo;
    const alturaTorre = this.degraus * this.passo.altura + 78;
    const matAco = new THREE.MeshStandardMaterial({ color: 0x767d88, roughness: 0.6, metalness: 0.3 });
    const matLampada = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = sx * (this.pista.x + fora - 8);
        const z = sz * (this.pista.z + fora - 8);

        const mastro = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.4, alturaTorre, 8), matAco);
        mastro.position.set(x, alturaTorre / 2 - 12, z);
        this.grupo.add(mastro);

        const painel = new THREE.Group();
        painel.position.set(x, alturaTorre - 14, z);
        painel.lookAt(0, 30, 0);
        for (let i = 0; i < 3; i++) {
          for (let k = 0; k < 4; k++) {
            const l = new THREE.Mesh(new THREE.BoxGeometry(5, 4.4, 1.6), matLampada);
            l.position.set((k - 1.5) * 5.8, (i - 1) * 5.2, 0.8);
            painel.add(l);
          }
        }
        const costas = new THREE.Mesh(new THREE.BoxGeometry(26, 18, 2), matAco);
        painel.add(costas);
        this.grupo.add(painel);

        // Uma luz de verdade por torre, fraca: o sol da cena continua mandando.
        const luz = new THREE.PointLight(0xfff0cc, 900, 700, 2);
        luz.position.set(x * 0.75, alturaTorre - 20, z * 0.75);
        this.grupo.add(luz);
      }
    }
  }

  /** Telão atrás de um dos fundos, com placar e nome da partida. */
  _telao() {
    const fora = this.degraus * this.passo.fundo;
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 384;
    this._cvTelao = cv;

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    this._texTelao = tex;

    const tela = new THREE.Mesh(
      new THREE.PlaneGeometry(150, 56),
      new THREE.MeshBasicMaterial({ map: tex })
    );
    const z = -(this.pista.z + fora - 14);

    // ALTO o bastante para limpar a arquibancada.
    //
    // O telão fica atrás do fundo, e a arquibancada daquele lado sobe entre
    // ele e quem olha do nível do campo. Com a base a 70,8 contra um topo de
    // arquibancada em 58,8, sobravam 12 cm de folga — e a perspectiva de um
    // ângulo baixo comia isso inteiro. Agora a base fica bem acima do muro.
    const topoDaArquibancada = this.degraus * this.passo.altura;
    const meiaTela = 28;                                  // metade da altura da placa
    const alturaTela = topoDaArquibancada + 34 + meiaTela;
    tela.position.set(0, alturaTela, z);
    tela.rotation.y = 0;                   // olhando para o campo (+z)
    this.grupo.add(tela);

    const moldura = new THREE.Mesh(
      new THREE.BoxGeometry(158, 64, 4),
      new THREE.MeshStandardMaterial({ color: 0x1a1f27, roughness: 0.9 })
    );
    moldura.position.set(0, tela.position.y, z - 2.5);

    // Dois mastros até o muro: um telão boiando no ar entrega o truque.
    const matMastro = new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.9 });
    const pe = alturaTela - meiaTela - topoDaArquibancada;
    for (const lado of [-1, 1]) {
      const mastro = new THREE.Mesh(new THREE.BoxGeometry(4, pe + 6, 4), matMastro);
      mastro.position.set(lado * 62, topoDaArquibancada + pe / 2 - 3, z - 2.5);
      this.grupo.add(mastro);
    }
    this.grupo.add(moldura);

    this.placar({ a: 0, b: 0, nomeA: 'Time A', nomeB: 'Time B', partida: '' });
  }

  /** Fundo: um domo escuro com um leve degradê de céu noturno. */
  _ceu() {
    const cv = document.createElement('canvas');
    cv.width = 4; cv.height = 256;
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#0a0e14');
    g.addColorStop(0.62, '#141b26');
    g.addColorStop(1, '#243043');
    c.fillStyle = g; c.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;

    const domo = new THREE.Mesh(
      new THREE.SphereGeometry(1180, 24, 16),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false })
    );
    this.grupo.add(domo);
  }

  /* ------------------------------------------------------------ */
  /* Vida                                                          */
  /* ------------------------------------------------------------ */

  /** Atualiza o telão. */
  placar({ a = 0, b = 0, nomeA = 'A', nomeB = 'B', partida = '', linha = '' } = {}) {
    const cv = this._cvTelao;
    if (!cv) return;
    const c = cv.getContext('2d');

    c.fillStyle = '#080b10';
    c.fillRect(0, 0, cv.width, cv.height);

    // Malha de pontinhos, para parecer painel de LED.
    c.fillStyle = 'rgba(255,255,255,0.03)';
    for (let y = 4; y < cv.height; y += 8) for (let x = 4; x < cv.width; x += 8) c.fillRect(x, y, 2, 2);

    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#ffd24a';
    c.font = 'bold 44px system-ui, sans-serif';
    c.fillText((partida || 'FUTEBOTÃO').toUpperCase().slice(0, 34), cv.width / 2, 52);

    const placar = `${a}  ×  ${b}`;
    c.font = 'bold 132px system-ui, sans-serif';
    c.fillStyle = '#eaf2ff';
    c.fillText(placar, cv.width / 2, 190);

    // Os nomes se afastam do PLACAR MEDIDO, não de um deslocamento fixo. Com
    // 190 cravado, "TIME A" encostava no 4 — e com dois dígitos em campo
    // ("12 × 10") o número simplesmente passaria por cima do nome.
    const meioPlacar = c.measureText(placar).width / 2;
    const folga = 34;
    const borda = meioPlacar + folga;

    c.font = 'bold 40px system-ui, sans-serif';

    // Nome comprido tem de caber no que sobra até a beirada da tela.
    const cabe = (nome) => {
      let t = nome.toUpperCase().slice(0, 16);
      const espaco = cv.width / 2 - borda - 24;
      while (t.length > 3 && c.measureText(t).width > espaco) t = t.slice(0, -1);
      return t;
    };

    c.fillStyle = '#7aa2ff';
    c.textAlign = 'right';
    c.fillText(cabe(nomeA), cv.width / 2 - borda, 190);
    c.fillStyle = '#ff8b80';
    c.textAlign = 'left';
    c.fillText(cabe(nomeB), cv.width / 2 + borda, 190);

    if (linha) {
      c.textAlign = 'center';
      c.fillStyle = '#8fa2b8';
      c.font = '34px system-ui, sans-serif';
      c.fillText(linha.slice(0, 46), cv.width / 2, 320);
    }
    this._texTelao.needsUpdate = true;
  }

  /**
   * Gol: a torcida vai ao delírio por alguns segundos e sai uma ola em seguida.
   * @param {'A'|'B'|null} time quem marcou; null faz os dois lados pularem
   */
  festejar(time, segundos = 7) {
    const agora = performance.now() / 1000;
    this.festaAte = agora + segundos;
    this.olaAte = agora + segundos + 6;
    this._olaComeco = agora + segundos * 0.55;
    this.uniformes.ladoFesta.value = time === 'A' ? -1 : time === 'B' ? 1 : 0;

    // O bandeirão de quem marcou sobe e fica de pé enquanto durar a festa. Se
    // ninguém marcou (gol contra sem dono), sobem os dois.
    for (const b of this.bandeiroes || []) {
      if (!time || (time === 'A') === (b.s < 0)) this._subirBandeirao(b, agora + segundos + 5);
    }
  }

  /** Põe um bandeirão de pé até `ate` (em segundos de `performance.now`). */
  _subirBandeirao(b, ate) {
    b.ate = Math.max(b.ate || 0, ate);
    // Empurra o sorteio para depois deste: dois bandeirões no ar por acaso
    // logo depois de um gol tira o peso do gesto.
    this._proximoBandeirao = Math.max(this._proximoBandeirao, ate + 25);
  }

  /** Um quadro. `t` em segundos. */
  animar(t) {
    this.uniformes.tempo.value = t;

    // O envelope da festa anda em segundos, não em quadros. Era uma fração
    // fixa por quadro: a 60 fps a subida inteira se resolvia em 0,25 s e a 4
    // fps levava quase um minuto — a mesma comemoração virava dois
    // espetáculos diferentes, e no caso rápido ninguém via o escalonamento.
    const dt = Math.min(DT_MAX, Math.max(0, t - (this._tAnterior ?? t)));
    this._tAnterior = t;

    // Rampa reta nos dois sentidos, porque é ela que transforma o limiar de
    // cada um em atraso na tela. Aproximação exponencial não serve aqui: o
    // fim da rampa rasteja e os limiares altos — o público geral, que devia
    // entrar por último e desistir primeiro — se amontoam todos no mesmo
    // instante.
    const u = this.uniformes.festa;
    if (t < this.festaAte) u.value = Math.min(1, u.value + dt / SUBIDA_FESTA);
    else u.value = Math.max(0, u.value - dt / DESCIDA_FESTA);

    this._animarBandeiroes(t, dt);

    // A ola dá uma volta e some.
    if (t > this._olaComeco && t < this.olaAte) {
      const v = (t - this._olaComeco) / (this.olaAte - this._olaComeco);
      this.uniformes.ola.value = -Math.PI + v * Math.PI * 2;
    } else {
      this.uniformes.ola.value = -9;
    }
  }

  /**
   * Sobe e desce os bandeirões.
   *
   * Um deles é sorteado de tempos em tempos mesmo sem gol nenhum. É a única
   * coisa da arquibancada que acontece por conta própria, e é ela que tira a
   * torcida do lugar de papel de parede entre um lance e outro.
   */
  _animarBandeiroes(t, dt) {
    const lista = this.bandeiroes || [];
    if (!lista.length) return;

    if (t > this._proximoBandeirao) {
      // Alterna os lados: o mesmo bandeirão subindo duas vezes seguidas
      // parece defeito, não torcida.
      this._ladoBandeirao = this._ladoBandeirao === 1 ? 0 : 1;
      this._subirBandeirao(lista[this._ladoBandeirao], t + 14);
      this._proximoBandeirao = t + 48 + rnd(Math.floor(t)) * 30;
    }

    for (const b of lista) {
      const alvo = t < (b.ate || 0) ? 1 : 0;
      // Sobe em 1,8 s e desce em 3 s: puxar o pano é esforço, largar não é.
      const taxa = alvo > b.uniformes.abre.value ? dt / 1.8 : -dt / 3;
      const v = Math.min(1, Math.max(0, b.uniformes.abre.value + taxa));
      b.uniformes.abre.value = v;
      b.uniformes.tempoPano.value = t;
      // Pano abaixado não desenha: são 1200 vértices e um shader a menos.
      b.malha.visible = v > 0.001;
    }
  }

  visivel(sim) {
    this.grupo.visible = !!sim;
  }
}

/* ------------------------------------------------------------------ */

/** Ruído determinístico: mesma semente, mesma multidão em toda sessão. */
function rnd(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Onde cai, no anel retangular de meias-larguras `dx`/`dz`, o ponto a uma
 * fração `u` do perímetro. O percurso começa no canto (-dx, +dz) e dá a volta.
 * `fundo` diz se ele está num dos lados curtos, atrás de um gol.
 */
function pontoNoAnel(u, dx, dz) {
  let d = (((u % 1) + 1) % 1) * 4 * (dx + dz);
  if (d < 2 * dx) return { x: -dx + d, z: dz, fundo: false };
  d -= 2 * dx;
  if (d < 2 * dz) return { x: dx, z: dz - d, fundo: true };
  d -= 2 * dz;
  if (d < 2 * dx) return { x: dx - d, z: -dz, fundo: false };
  return { x: -dx, z: -dz + (d - 2 * dx), fundo: true };
}

/**
 * Junta geometrias não indexadas numa só. É o que `BufferGeometryUtils.merge`
 * faria, mas sem puxar o addon — aqui só precisamos de posição e normal.
 */
function mesclar(geos) {
  const partes = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of partes) total += g.getAttribute('position').count;

  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let off = 0;
  for (const g of partes) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    pos.set(p.array, off * 3);
    nor.set(n.array, off * 3);
    off += p.count;
    g.dispose();
  }
  const saida = new THREE.BufferGeometry();
  saida.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  saida.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return saida;
}
