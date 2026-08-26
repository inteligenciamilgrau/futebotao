// Mesa 3D. O jogo é resolvido em 2D no servidor; aqui só apresentamos.
// Mapeamento: jogo (x, y) -> cena (x - L/2, altura, W/2 - y).
// Uma direção de ângulo θ no jogo vira rotação θ em torno do eixo Y da cena.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Estadio } from './estadio.js';
import { impactosAudiveis, travesAudiveis } from './torcida-som.js';

const COR = {
  A: 0x3a7af0, ADark: 0x1d3f8c,
  B: 0xe6483c, BDark: 0x8c2018,
  bola: 0xfbfbf7,
  feltro: 0x2f7a3e,
  madeira: 0x6b4423,
  madeiraTopo: 0x8a5a2e,
  trave: 0xf2f2f2,
  palheta: 0xf3e9d2,
  mira: 0xffd24a,
  previsao: 0x7fe3a0,
  erro: 0xe6483c,
  cavada: 0x8cdcff,
};

/**
 * Tira um material do tone mapping do renderer.
 *
 * O ACES é ótimo para o cenário, mas o HUD desenhado DENTRO do mundo 3D — a
 * linha de mira, a previsão da bola, a marca de parada, a cor de estado da
 * palheta, a etiqueta com o nome — não é cenário: é sinal. Essas cores foram
 * escolhidas a dedo para gritar um estado de jogo, e vivem justamente no topo
 * da curva, que é onde o ACES mais dobra. Medido no framebuffer, com a marca de
 * parada ocupando o pixel inteiro: o amarelo #ffd24a (255,210,74) chegava à
 * tela como (171,165,121) — um cáqui apagado, quase cinza. Sem tone mapping o
 * material sai na cor exata que alguém escolheu.
 */
const semToneMapping = (m) => { m.toneMapped = false; return m; };

const g2r = (g) => (g * Math.PI) / 180;

export class Cena3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.pecas = new Map();
    this.controlaveis = new Set();
    this.selecionado = null;
    this.animando = false;
    this.aoSelecionar = null;
    this.pitch = { length: 200, width: 120, goalMin: 45, goalMax: 75, goalWidth: 30, margemFora: 18 };
    this.raios = { button: 2.4, keeper: 6.0, ball: 1.15 };
    this.replay = null;
    // Quem monta a cena pendura o TorcidaSom aqui. É a cena que sabe QUANDO
    // cada pancada do lance acontece; sem isso ela simplesmente não toca nada.
    this.som = null;
    // Temporizadores dos sons de desfecho ainda por tocar. Ver `_adiar`.
    this._temposDesfecho = [];

    this._initRenderer();
    this._initCena();
    this._initInput();
    this._loop();
  }

  /* ------------------------------------------------------------ */

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    // Sem tone mapping tudo que passa de 1.0 vira branco chapado, e num jogo
    // noturno é bem aí que a luz interessa: o brilho no topo do botão, a linha
    // branca, a lâmpada do refletor. A curva filmica dobra esse topo em vez de
    // cortar, e de quebra separa as faixas do gramado e as cores da torcida.
    // A exposição não é gosto: 1,1 foi medida para o feltro sair na MESMA
    // claridade de antes, senão a mesa toda escureceria junto.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x11151c);
    this.scene.fog = new THREE.Fog(0x11151c, 400, 780);

    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 1400);
    this.camera.position.set(0, 165, 205);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // PASSA da horizontal de propósito.
    //
    // O OrbitControls sempre aponta a câmera para o ALVO: enquanto ela estiver
    // acima dele, a vista olha para baixo, e não existe ângulo que resolva isso.
    // Deixar o giro cruzar a horizontal é o que permite levantar a vista — e o
    // mergulho na mesa que isso causaria é aparado em _segurarNoPiso, a cada
    // quadro.
    this.controls.maxPolarAngle = Math.PI * 0.72;
    this.controls.minDistance = 55;
    this.controls.maxDistance = 620;
    // Arrastar move o alvo TAMBÉM na vertical. Preso ao plano do chão, a
    // única forma de ver o alto era afastar a câmera; agora dá para subir a
    // mira e olhar para cima sem sair do nível do campo.
    this.controls.screenSpacePanning = true;
    // Esquerdo arrasta a mesa, direito orbita, roda dá zoom.
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };

    addEventListener('resize', () => this.redimensionar());
    this.redimensionar();
  }

  redimensionar() {
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 600;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _initCena() {
    this.scene.add(new THREE.HemisphereLight(0xd8e6ff, 0x2a3038, 0.75));

    const sol = new THREE.DirectionalLight(0xffffff, 1.5);
    sol.position.set(90, 190, 120);
    sol.castShadow = true;
    sol.shadow.mapSize.set(2048, 2048);
    const d = 165;
    Object.assign(sol.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 10, far: 520 });
    sol.shadow.camera.updateProjectionMatrix();
    sol.shadow.bias = -0.0008;
    this.scene.add(sol);

    const preenche = new THREE.DirectionalLight(0x99bbff, 0.35);
    preenche.position.set(-120, 90, -60);
    this.scene.add(preenche);

    this.grupoMesa = new THREE.Group();
    this.grupoPecas = new THREE.Group();
    this.grupoMira = new THREE.Group();
    this.scene.add(this.grupoMesa, this.grupoPecas, this.grupoMira);

    this._construirMesa();
    this._construirPalheta();

    // O estádio em volta: arquibancada, torcida, refletores e telão.
    this.estadio = new Estadio(this.scene, this.pitch, { A: COR.A, B: COR.B });
  }

  cena(gx, gy, altura = 0) {
    return new THREE.Vector3(gx - this.pitch.length / 2, altura, this.pitch.width / 2 - gy);
  }

  /** O caminho de volta: ponto da cena -> coordenada do jogo. */
  jogo(v) {
    return { x: v.x + this.pitch.length / 2, y: this.pitch.width / 2 - v.z };
  }

  /** Onde o raio do mouse encosta no feltro. */
  _pontoNoFeltro(ev) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plano = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const onde = new THREE.Vector3();
    return ray.ray.intersectPlane(plano, onde) ? this.jogo(onde) : null;
  }

  /** Qual botão está debaixo do mouse, entre os ids dados. */
  _botaoSobOMouse(ev, ids) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const alvos = [...this.pecas.entries()].filter(([id]) => ids.has(id)).map(([, p]) => p.mesh);
    const hit = ray.intersectObjects(alvos, true);
    if (!hit.length) return null;
    let o = hit[0].object;
    while (o && !o.userData?.id) o = o.parent;
    return o?.userData?.id || null;
  }

  /**
   * Liga o arrasto de botões com o mouse — saída de bola e cobrança.
   *
   * @param {null|{ids:string[], centro:{x,y}, raio:number, aoArrastar:Function, aoSoltar:Function}} cfg
   */
  posicionamento(cfg) {
    this._posic = cfg && cfg.ids?.length ? { ...cfg, ids: new Set(cfg.ids) } : null;
    // O arrasto NÃO mora aqui de propósito: o estado do servidor chega no meio
    // do arrasto e refaz esta configuração. Se o arrasto viesse junto, o
    // pointerup não encontrava mais nada para soltar e a câmera ficava presa.
    if (this._arrasto && !this._posic?.ids.has(this._arrasto)) this._soltarArrasto();
    this._desenharArea(this._posic);
    if (!this._arrasto) this.canvas.style.cursor = this._posic ? 'grab' : 'crosshair';
  }

  /** Há um botão preso ao ponteiro agora? */
  arrastando() { return this._arrasto || null; }

  /** Devolve o controle da câmera e o cursor, aconteça o que acontecer. */
  _soltarArrasto() {
    this._arrasto = null;
    this.controls.enabled = true;
    this.canvas.style.cursor = this._posic ? 'grab' : 'crosshair';
  }

  /**
   * Prende o ponto na região permitida. A região é ou um círculo (cobrança) ou
   * o próprio campo mais, para quem bate a saída, o círculo central.
   */
  _limitarNaRegiao(pt, r) {
    if (!r) return pt;

    const noCirculo = r.circulo
      && Math.hypot(pt.x - r.circulo.x, pt.y - r.circulo.y) <= r.circulo.raio;

    if (r.campo) {
      if (noCirculo && r.podeNoCirculo) return pt;      // dentro do círculo, vale
      const c = r.campo;
      // A folga é o raio do que está sendo arrastado, para o corpo não nascer
      // metade fora. Para a caixa do goleiro ela é ZERO: o servidor limita o
      // CENTRO da caixa à área, e descontar 3 aqui roubaria três centímetros
      // de área que a regra dá.
      const f = r.folga ?? 3;
      pt.x = Math.max(c.xMin + f, Math.min(c.xMax - f, pt.x));
      pt.y = Math.max(c.yMin + f, Math.min(c.yMax - f, pt.y));
      // Se caiu dentro do círculo sem poder, empurra para fora pela borda.
      if (r.circulo && !r.podeNoCirculo) {
        const dx = pt.x - r.circulo.x, dy = pt.y - r.circulo.y;
        const d = Math.hypot(dx, dy);
        if (d < r.circulo.raio) {
          const k = d < 0.01 ? 1 : r.circulo.raio / d;
          pt.x = r.circulo.x + (d < 0.01 ? r.circulo.raio : dx * k);
          pt.y = r.circulo.y + (d < 0.01 ? 0 : dy * k);
          pt.x = Math.max(c.xMin + 3, Math.min(c.xMax - 3, pt.x));
        }
      }
      return pt;
    }

    // Cobrança comum: um círculo só. Ele PODE passar da linha — é assim que
    // se cobra uma lateral, com a bola na risca e o disco de fora. O que
    // limita é a beirada da mesa.
    const cx = r.x ?? 0, cy = r.y ?? 0, raio = r.raio ?? 18;
    const dx = pt.x - cx, dy = pt.y - cy;
    const d = Math.hypot(dx, dy);
    if (d > raio) { pt.x = cx + (dx / d) * raio; pt.y = cy + (dy / d) * raio; }
    // Sem margem conhecida, o padrão é o raio da própria cobrança: prender o
    // botão na linha seria inventar uma regra que o servidor não tem.
    const m = this.pitch.margemFora ?? raio;
    pt.x = Math.max(-m, Math.min(this.pitch.length + m, pt.x));
    pt.y = Math.max(-m, Math.min(this.pitch.width + m, pt.y));
    return pt;
  }

  /** Desenha no feltro onde os botões podem ficar. */
  _desenharArea(posic) {
    if (this._areaMesh) {
      this.scene.remove(this._areaMesh);
      this._areaMesh.traverse((n) => n.geometry?.dispose?.());
      this._areaMesh = null;
    }
    if (!posic?.regiao) return;
    const r = posic.regiao;
    const grupo = new THREE.Group();
    const matChao = semToneMapping(new THREE.MeshBasicMaterial({
      color: COR.mira, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false,
    }));
    const matLinha = semToneMapping(new THREE.MeshBasicMaterial({
      color: COR.mira, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false,
    }));

    if (r.campo) {
      const c = r.campo;
      const w = c.xMax - c.xMin, h = c.yMax - c.yMin;
      const chao = new THREE.Mesh(new THREE.PlaneGeometry(w, h), matChao);
      chao.rotation.x = -Math.PI / 2;
      chao.position.copy(this.cena((c.xMin + c.xMax) / 2, (c.yMin + c.yMax) / 2, 0.06));
      grupo.add(chao);
    }
    if (r.circulo) {
      const raio = r.circulo.raio;
      const anel = new THREE.Mesh(new THREE.RingGeometry(raio - 0.4, raio, 96), matLinha);
      anel.rotation.x = -Math.PI / 2;
      anel.position.copy(this.cena(r.circulo.x, r.circulo.y, 0.09));
      grupo.add(anel);
      if (r.podeNoCirculo) {
        const disco = new THREE.Mesh(new THREE.CircleGeometry(raio, 64), matChao);
        disco.rotation.x = -Math.PI / 2;
        disco.position.copy(this.cena(r.circulo.x, r.circulo.y, 0.07));
        grupo.add(disco);
      }
    }
    if (!r.campo && !r.circulo) {
      const raio = r.raio ?? 18;
      const anel = new THREE.Mesh(new THREE.RingGeometry(raio - 0.35, raio, 96), matLinha);
      anel.rotation.x = -Math.PI / 2;
      anel.position.copy(this.cena(r.x, r.y, 0.08));
      grupo.add(anel);
    }

    this.scene.add(grupo);
    this._areaMesh = grupo;
  }

  /* ------------------------------------------------------------ */
  /* Mesa                                                          */
  /* ------------------------------------------------------------ */

  /**
   * Gramado. É uma textura só, desenhada aqui — não há arquivo de imagem no
   * projeto —, então tudo o que o feltro tem de irregular precisa ser
   * construído à mão: as faixas do corte, o tingimento desigual, o grão da
   * fibra e o puído das áreas. A mesa é a maior superfície da tela; verde
   * chapado com linhas brancas lê como papel de cartaz, não como pano.
   */
  _texturaCampo() {
    const L = this.pitch.length, W = this.pitch.width;
    const esc = 10;                                  // px por cm
    const cv = document.createElement('canvas');
    cv.width = L * esc; cv.height = W * esc;
    const c = cv.getContext('2d');
    const px = (v) => v * esc;

    // Sorteio com semente fixa: o feltro precisa ser o MESMO em toda carga e
    // em todos os clientes. Com Math.random, dois jogadores olhando a mesma
    // partida veriam manchas diferentes, e o replay não bateria com a jogada.
    let semente = 0x1f2e3d4c;
    const rnd = () => {
      semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0;
      return semente / 4294967296;
    };

    const FAIXAS = 10;
    const lf = cv.width / FAIXAS;
    // Tons de base propositalmente mais fundos que o verde final: o grão e as
    // manchas somam claro por cima e levantam a média. Medido no pano puro, o
    // conjunto cai em rgb(49,126,65)/(44,114,57) — a mesma cor de antes deste
    // trabalho. A textura mudou a superfície, não a paleta.
    const CLARO = '#297b3b', ESCURO = '#236f33';

    for (let i = 0; i < FAIXAS; i++) {
      c.fillStyle = i % 2 ? ESCURO : CLARO;
      c.fillRect(lf * i, 0, lf, cv.height);
    }

    // A borda da faixa não é uma régua: 1,2 cm de transição tira o serrilhado
    // que aparecia com a câmera rente à mesa.
    const meia = px(0.6);
    for (let i = 1; i < FAIXAS; i++) {
      const x = lf * i;
      const g = c.createLinearGradient(x - meia, 0, x + meia, 0);
      g.addColorStop(0, i % 2 ? CLARO : ESCURO);
      g.addColorStop(1, i % 2 ? ESCURO : CLARO);
      c.fillStyle = g;
      c.fillRect(x - meia, 0, meia * 2, cv.height);
    }

    // O rolo deita o pelo para um lado só, e a faixa clareia de uma borda à
    // outra. O sentido alterna, como no corte de verdade — é por isso que o
    // degradê de faixas vizinhas se encontra no mesmo tom na divisa, sem
    // degrau. Duas cores chapadas leem como adesivo; é este volume que falta.
    for (let i = 0; i < FAIXAS; i++) {
      const invertida = i % 2;
      const g = c.createLinearGradient(lf * (i + invertida), 0, lf * (i + 1 - invertida), 0);
      g.addColorStop(0, 'rgba(255,255,255,0.055)');
      g.addColorStop(0.5, 'rgba(255,255,255,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.055)');
      c.fillStyle = g;
      c.fillRect(lf * i, 0, lf, cv.height);
    }

    // Tingimento irregular: manchas largas e suaves, claras e escuras, que
    // quebram o verde sem virar sujeira.
    for (let i = 0; i < 130; i++) {
      const x = rnd() * cv.width, y = rnd() * cv.height;
      const r = px(3 + rnd() * 10);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rnd() < 0.5 ? 'rgba(172,214,150,0.04)' : 'rgba(10,38,16,0.045)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // Puído: onde o botão raspa o pano todo jogo o feltro perde pelo e clareia.
    // As bocas de gol são o ponto de mais tráfego da mesa, a marca de pênalti é
    // onde a bola é assentada, e o círculo central é onde toda saída acontece.
    const puido = (cx, cy, rx, ry, forca) => {
      c.save();
      c.translate(px(cx), px(W - cy));
      c.scale(rx / ry, 1);                           // elipse a partir de um radial
      const r = px(ry);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, `rgba(204,214,172,${forca})`);
      g.addColorStop(0.55, `rgba(196,208,166,${forca * 0.42})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(-r, -r, r * 2, r * 2);
      c.restore();
    };
    const marcarPuido = (k) => {
      for (const perto of [true, false]) {
        const at = (v) => (perto ? v : L - v);
        puido(at(7), W / 2, 11, 16, 0.06 * k);       // boca do gol
        puido(at(22), W / 2, 4.5, 4.5, 0.07 * k);      // marca de pênalti
        puido(at(30), W / 2, 14, 23, 0.03 * k);      // frente da grande área
      }
      puido(L / 2, W / 2, 22, 20, 0.035 * k);        // círculo central
    };
    marcarPuido(1);

    // Grão da fibra. Um ladrilho de 128 px repetido custa uma passada de
    // pattern; sortear pixel a pixel nos 2000×1200 do campo seriam 2,4 milhões
    // de sorteios para o mesmo efeito. O mipmap dissolve o grão de longe, então
    // ele só aparece quando a câmera chega perto — que é quando faz falta.
    const ladrilho = document.createElement('canvas');
    ladrilho.width = ladrilho.height = 128;
    const lc = ladrilho.getContext('2d');
    const img = lc.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = rnd();
      const claro = v > 0.5;
      img.data[i] = claro ? 206 : 10;
      img.data[i + 1] = claro ? 238 : 34;
      img.data[i + 2] = claro ? 196 : 14;
      img.data[i + 3] = Math.abs(v - 0.5) * 2 * 26;
    }
    lc.putImageData(img, 0, 0);
    const grao = c.createPattern(ladrilho, 'repeat');
    c.fillStyle = grao;
    c.fillRect(0, 0, cv.width, cv.height);

    c.strokeStyle = 'rgba(255,255,255,0.92)';
    c.lineWidth = Math.max(2, px(0.5));
    const linha = (x1, y1, x2, y2) => { c.beginPath(); c.moveTo(px(x1), px(W - y1)); c.lineTo(px(x2), px(W - y2)); c.stroke(); };
    const ret = (x, y, w, h) => c.strokeRect(px(x), px(W - y - h), px(w), px(h));

    ret(0.6, 0.6, L - 1.2, W - 1.2);
    linha(L / 2, 0.6, L / 2, W - 0.6);
    c.beginPath(); c.arc(px(L / 2), px(W / 2), px(22), 0, Math.PI * 2); c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.92)';
    c.beginPath(); c.arc(px(L / 2), px(W / 2), px(0.9), 0, Math.PI * 2); c.fill();

    ret(0.6, (W - 74) / 2, 32, 74);
    ret(L - 32.6, (W - 74) / 2, 32, 74);
    ret(0.6, (W - 40) / 2, 12, 40);
    ret(L - 12.6, (W - 40) / 2, 12, 40);
    for (const sx of [22, L - 22]) { c.beginPath(); c.arc(px(sx), px(W / 2), px(0.9), 0, Math.PI * 2); c.fill(); }

    // Segunda passada POR CIMA da tinta. A linha da grande área é justamente o
    // que mais sofre; linha impecável sobre feltro gasto entrega o desenho.
    c.globalAlpha = 0.55;
    marcarPuido(0.9);
    c.globalAlpha = 0.22;
    c.fillStyle = grao;
    c.fillRect(0, 0, cv.width, cv.height);
    c.globalAlpha = 1;

    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _construirMesa() {
    // configurar() reconstrói a mesa quando as medidas chegam do servidor, e
    // isso acontece a cada entrada em partida. Sem soltar o que saiu, cada
    // entrada deixava mais um gramado de 2000x1200 preso na GPU.
    while (this.grupoMesa.children.length) {
      const filho = this.grupoMesa.children[0];
      this.grupoMesa.remove(filho);
      filho.traverse((o) => {
        o.geometry?.dispose();
        // Só o mapa do campo é exclusivo desta mesa; o da rede é compartilhado
        // por todos os panos e sobrevive à reconstrução de propósito.
        if (o === this.planoCampo) o.material.map?.dispose();
        o.material?.dispose();
      });
    }
    const L = this.pitch.length, W = this.pitch.width;
    const { goalMin, goalMax } = this.pitch;

    const campo = new THREE.Mesh(
      new THREE.PlaneGeometry(L, W),
      new THREE.MeshStandardMaterial({ map: this._texturaCampo(), roughness: 0.95 })
    );
    campo.rotation.x = -Math.PI / 2;
    campo.receiveShadow = true;
    this.grupoMesa.add(campo);
    this.planoCampo = campo;

    // A madeira vai além das linhas de propósito: os BOTÕES jogam nessa faixa.
    const fora2 = (this.pitch.margemFora ?? 18) * 2 + 8;
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(L + fora2, 10, W + fora2),
      new THREE.MeshStandardMaterial({ color: COR.madeira, roughness: 0.8 })
    );
    base.position.y = -5.2;
    base.receiveShadow = true;
    this.grupoMesa.add(base);

    // Linhas abertas: não há tabelas. Só uma faixa de fora de campo em volta,
    // rente à mesa, para deixar claro onde a bola deixa de estar em jogo.
    // Faixa de fora de campo: é jogável para os botões, então tem que caber a
    // margem inteira e ainda sobrar borda.
    const fora = new THREE.Mesh(
      new THREE.PlaneGeometry(L + fora2 - 4, W + fora2 - 4),
      new THREE.MeshStandardMaterial({ color: 0x2b3a2f, roughness: 1 })
    );
    fora.rotation.x = -Math.PI / 2;
    fora.position.y = -0.08;
    fora.receiveShadow = true;
    this.grupoMesa.add(fora);

    for (const lado of [-1, 1]) {
      const gx = lado * (L / 2);
      const xJogo = lado < 0 ? 0 : L;
      const matTrave = new THREE.MeshStandardMaterial({ color: COR.trave, roughness: 0.35, metalness: 0.1 });
      const alturaGol = 9;
      for (const gy of [goalMin, goalMax]) {
        const poste = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, alturaGol, 16), matTrave);
        poste.position.copy(this.cena(xJogo, gy, alturaGol / 2));
        poste.castShadow = true;
        this.grupoMesa.add(poste);
      }
      const travessao = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, this.pitch.goalWidth, 16), matTrave);
      travessao.rotation.x = Math.PI / 2;
      travessao.position.set(gx, alturaGol, 0);
      this.grupoMesa.add(travessao);

      this._construirRede(gx, lado, alturaGol);
    }
  }

  /**
   * Textura da rede: malha de losangos num fundo transparente. É o desenho da
   * redinha mesmo, repetido pelo pano — bem mais legível que um wireframe.
   */
  _texturaRede() {
    if (this._texRede) return this._texRede;
    const n = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = n;
    const c = cv.getContext('2d');
    c.clearRect(0, 0, n, n);
    c.strokeStyle = 'rgba(238,244,252,0.92)';
    c.lineWidth = 2.2;
    c.lineCap = 'round';
    // Duas famílias de diagonais formam os losangos da rede.
    for (let i = -n; i <= n * 2; i += 16) {
      c.beginPath(); c.moveTo(i, 0); c.lineTo(i + n, n); c.stroke();
      c.beginPath(); c.moveTo(i, n); c.lineTo(i + n, 0); c.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    this._texRede = tex;
    return tex;
  }

  _panoDeRede(w, h, repX, repY) {
    const tex = this._texturaRede().clone();
    tex.needsUpdate = true;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repX, repY);
    return new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, side: THREE.DoubleSide,
        depthWrite: false, opacity: 0.85,
      })
    );
  }

  /** Rede do gol: fundo, duas laterais e o teto. */
  _construirRede(gx, lado, alturaGol) {
    const prof = 8;
    const larg = this.pitch.goalWidth;
    const passo = 4;                  // cm por losango
    const g = new THREE.Group();

    // Fundo, paralelo à linha do gol.
    const fundo = this._panoDeRede(larg, alturaGol, larg / passo, alturaGol / passo);
    fundo.rotation.y = Math.PI / 2;
    fundo.position.set(gx + lado * prof, alturaGol / 2, 0);
    g.add(fundo);

    // Laterais.
    for (const s of [-1, 1]) {
      const lateral = this._panoDeRede(prof, alturaGol, prof / passo, alturaGol / passo);
      lateral.position.set(gx + (lado * prof) / 2, alturaGol / 2, (s * larg) / 2);
      g.add(lateral);
    }

    // Teto. Só o rotation.x: a ordem Euler padrão (XYZ) aplica o Z ANTES,
    // então um rotation.z aqui trocaria profundidade por largura.
    const teto = this._panoDeRede(prof, larg, prof / passo, larg / passo);
    teto.rotation.x = -Math.PI / 2;
    teto.position.set(gx + (lado * prof) / 2, alturaGol, 0);
    g.add(teto);

    this.grupoMesa.add(g);
  }

  /* ------------------------------------------------------------ */
  /* Peças                                                         */
  /* ------------------------------------------------------------ */

  /**
   * Perfil torneado do botão. Ele NÃO é uma tampa reta: a borda sobe em bisel
   * arredondado até um topo menor. É esse ombro que a palheta usa para o botão
   * escapar por baixo — sem ele, nenhum controle de palheta faria sentido.
   */
  _perfilBotao(r, alturaBorda) {
    const rTopo = r * 0.70;
    const pts = [new THREE.Vector2(0, 0), new THREE.Vector2(r * 0.6, 0), new THREE.Vector2(r, 0.06)];
    const passos = 10;
    for (let i = 1; i <= passos; i++) {
      const t = i / passos;
      const ang = (t * Math.PI) / 2;
      pts.push(new THREE.Vector2(rTopo + (r - rTopo) * Math.cos(ang), 0.06 + (alturaBorda - 0.06) * Math.sin(ang)));
    }
    pts.push(new THREE.Vector2(rTopo * 0.6, alturaBorda));
    pts.push(new THREE.Vector2(0, alturaBorda));
    return { pts, rTopo };
  }

  /**
   * Marca de uso do botão. Botão de jogo não fica sujo, fica RISCADO — e o
   * risco se vê como um fio de sombra na cor, não como perda de brilho. Por
   * isso ele entra no `map` e não em roughnessMap: medi as duas versões num
   * close a 4 cm, e com roughnessMap o botão ficou indistinguível do liso,
   * porque rugosidade só aparece onde o realce especular bate — uma faixa
   * estreita no alto do bisel — e o resto do botão continuava de fábrica.
   *
   * O UV do LatheGeometry dá a volta em u e sobe o perfil em v, então uma
   * linha horizontal aqui vira um risco concêntrico no botão, que é a marca
   * que o uso deixa mesmo: o botão gira raspando o feltro.
   *
   * Base BRANCA de propósito. O `map` multiplica a cor do material, então
   * branco é a cor do time intacta e a MESMA textura serve aos dois times e a
   * todos os botões — uma só na GPU. Por ser compartilhada, ela também não
   * entra no dispose de `_descartarPeca`.
   */
  _texturaDesgaste() {
    if (this._texDesgaste) return this._texDesgaste;
    const n = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = n;
    const c = cv.getContext('2d');

    // Semente fixa pelo mesmo motivo do feltro: dois clientes na mesma partida
    // têm que ver o mesmo botão, e o replay tem que bater com a jogada.
    let semente = 0x51ed270f;
    const rnd = () => {
      semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0;
      return semente / 4294967296;
    };

    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, n, n);

    // Onde ficam as coisas em v: os 15 pontos do perfil dão v = índice/14, e o
    // bisel — a única parte que se vê — ocupa de 0,14 a 0,86. Com o flipY
    // padrão da textura, v=0 é a ÚLTIMA linha do canvas, então o bisel é a
    // faixa y entre 0,14n e 0,86n. Riscar fora disso seria riscar a base, que
    // está encostada no feltro, e o topo, que o disco do número cobre.
    const yDe = (v) => n * (1 - v);
    c.lineCap = 'round';
    for (let i = 0; i < 240; i++) {
      // Viés para a quina externa (v baixo): é ela que raspa o pano e apanha
      // da palheta. O topo do bisel encosta em menos coisa.
      const v = 0.16 + 0.68 * Math.pow(rnd(), 1.5);
      // Risco CURTO e um pouco torto. Anel inteiro e perfeitamente horizontal
      // não lê como arranhão: lê como sulco torneado, e o botão vira um disco
      // de vinil. Como só metade da volta aparece de uma vez, 3% a 10% da
      // largura já é um traço visível.
      const x0 = rnd() * n;
      const larg = n * (0.03 + rnd() * 0.07);
      const torto = (rnd() - 0.5) * n * 0.012;
      c.strokeStyle = `rgba(28,26,22,${(0.02 + rnd() * 0.055).toFixed(3)})`;
      c.lineWidth = 0.6 + rnd() * 1.3;
      c.beginPath(); c.moveTo(x0, yDe(v)); c.lineTo(x0 + larg, yDe(v) + torto); c.stroke();
    }

    // Pancada de botão em botão: risco curto, fundo e fora do eixo.
    for (let i = 0; i < 16; i++) {
      const v = 0.18 + 0.5 * rnd();
      const x = rnd() * n, dy = (rnd() - 0.5) * n * 0.06;
      c.strokeStyle = `rgba(20,18,16,${(0.07 + rnd() * 0.08).toFixed(3)})`;
      c.lineWidth = 0.8 + rnd() * 1.2;
      c.beginPath(); c.moveTo(x, yDe(v)); c.lineTo(x + n * (0.02 + rnd() * 0.06), yDe(v) + dy); c.stroke();
    }

    // Pé do botão: a poeira do feltro assenta na quina de baixo e não sai.
    const g = c.createLinearGradient(0, yDe(0.3), 0, yDe(0.1));
    g.addColorStop(0, 'rgba(60,56,44,0)');
    g.addColorStop(1, 'rgba(60,56,44,0.10)');
    c.fillStyle = g;
    c.fillRect(0, yDe(0.3), n, yDe(0.1) - yDe(0.3));

    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    // Multiplica uma cor, então é cor: sem sRGB os riscos sairiam com outro peso.
    tex.colorSpace = THREE.SRGBColorSpace;
    this._texDesgaste = tex;
    return tex;
  }

/**
   * A bola de futebol clássica, desenhada por ÂNGULO e não por pixel.
   *
   * Os doze pentágonos pretos de uma bola ficam exatamente nas doze direções
   * dos vértices de um icosaedro. Em vez de desenhar formas no canvas — que a
   * projeção equirretangular esticaria perto dos polos —, cada texel vira uma
   * DIREÇÃO e pergunta a que distância angular está do vértice mais próximo.
   * Assim o desenho sai certo em toda a esfera, inclusive nos polos.
   */
  _texturaBola() {
    if (this._texBola) return this._texBola;

    const L = 512, A = 256;
    const cv = document.createElement('canvas');
    cv.width = L; cv.height = A;
    const c = cv.getContext('2d');
    const img = c.createImageData(L, A);

    // Os doze vértices do icosaedro, normalizados.
    const f = (1 + Math.sqrt(5)) / 2;
    const eixos = [];
    for (const s1 of [-1, 1]) {
      for (const s2 of [-1, 1]) {
        eixos.push([0, s1, s2 * f], [s1, s2 * f, 0], [s2 * f, 0, s1]);
      }
    }
    const n = Math.hypot(1, f);
    for (const e of eixos) { e[0] /= n; e[1] /= n; e[2] /= n; }

    // Raio angular do pentágono e da costura em volta dele.
    const RAIO = Math.cos((20.5 * Math.PI) / 180);
    const COSTURA = Math.cos((23.5 * Math.PI) / 180);

    for (let j = 0; j < A; j++) {
      const theta = (j / (A - 1)) * Math.PI;              // 0..pi, do polo ao polo
      const sy = Math.cos(theta), st = Math.sin(theta);
      for (let i = 0; i < L; i++) {
        const phi = (i / L) * Math.PI * 2;
        const dx = st * Math.cos(phi), dy = sy, dz = st * Math.sin(phi);

        let perto = -1;
        for (const e of eixos) {
          const d = Math.abs(dx * e[0] + dy * e[1] + dz * e[2]);
          if (d > perto) perto = d;
        }

        let v;
        if (perto > RAIO) v = 26;                          // pentágono preto
        else if (perto > COSTURA) v = 120;                 // costura em volta
        else v = 240;                                      // couro branco

        // Um sujeirinha para o couro não parecer plástico.
        v += ((i * 7 + j * 13) % 11) - 5;

        const k = (j * L + i) * 4;
        img.data[k] = v; img.data[k + 1] = v; img.data[k + 2] = v; img.data[k + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this._texBola = tex;
    return tex;
  }

  /**
   * Gira a bola conforme ela anda, como uma bola que rola de verdade.
   *
   * Rolamento sem escorregar: o ângulo é a distância percorrida dividida pelo
   * raio, e o eixo é perpendicular ao movimento, deitado. Sem isto a bola
   * deslizava pelo campo como um disco de gelo — e com a textura nova isso
   * ficaria gritante.
   */
  _rolarBola(peca, x, y) {
    const antes = peca.ultimaPos;
    peca.ultimaPos = { x, y };
    if (!antes) return;

    const dx = x - antes.x, dy = y - antes.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.01) return;

    // No mundo da cena, o y do jogo vira -z.
    //
    // O eixo sai da condição de rolar sem escorregar: o ponto de contato tem de
    // ter velocidade zero, ou seja  v + w x (0,-R,0) = 0,  o que dá
    // w = (vz, 0, -vx) / R. Com o sinal trocado a textura girava para trás,
    // como roda de carroça em filme antigo.
    const ux = dx / d, uz = -dy / d;
    if (!this._eixoRolo) this._eixoRolo = new THREE.Vector3();
    this._eixoRolo.set(uz, 0, -ux);
    peca.mesh.rotateOnWorldAxis(this._eixoRolo, d / (peca.r || 1));
  }

  _texturaNumero(texto, corFundo) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const c = cv.getContext('2d');
    c.fillStyle = corFundo;
    c.beginPath(); c.arc(128, 128, 128, 0, Math.PI * 2); c.fill();
    const brilho = c.createRadialGradient(96, 92, 8, 128, 128, 130);
    brilho.addColorStop(0, 'rgba(255,255,255,0.30)');
    brilho.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = brilho; c.beginPath(); c.arc(128, 128, 128, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#ffffff';
    c.font = 'bold 150px system-ui, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 10; c.strokeStyle = 'rgba(0,0,0,0.45)';
    c.strokeText(texto, 128, 140);
    c.fillText(texto, 128, 140);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _criarPeca(b) {
    const hex = (n) => '#' + n.toString(16).padStart(6, '0');

    if (b.kind === 'ball') {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(b.r, 32, 24),
        new THREE.MeshStandardMaterial({
          map: this._texturaBola(), roughness: 0.55, metalness: 0,
        })
      );
      m.castShadow = true;
      m.userData.altura = b.r;
      return m;
    }

    const cor = b.team === 'A' ? COR.A : COR.B;
    const corEscura = b.team === 'A' ? COR.ADark : COR.BDark;

    // Goleiro: caixa de fósforo. Retângulo mesmo, com a etiqueta em cima.
    if (b.forma === 'caixa') {
      const grupo = new THREE.Group();
      const alt = 5;
      const caixa = new THREE.Mesh(
        new THREE.BoxGeometry(b.w, alt, b.h),
        new THREE.MeshStandardMaterial({ color: cor, roughness: 0.55, metalness: 0.05 })
      );
      caixa.position.y = alt / 2;
      caixa.castShadow = true;
      caixa.receiveShadow = true;
      grupo.add(caixa);

      // Faixa clara no topo, como a lixa da caixa de fósforo.
      const faixa = new THREE.Mesh(
        new THREE.BoxGeometry(b.w * 0.84, 0.25, b.h * 0.5),
        new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.9 })
      );
      faixa.position.y = alt + 0.05;
      grupo.add(faixa);

      // Só as ARESTAS da caixa. Um BoxGeometry em wireframe mostraria também
      // as diagonais da triangulação, que aparecem como triângulos soltos.
      const contorno = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(b.w, alt, b.h)),
        new THREE.LineBasicMaterial({ color: corEscura })
      );
      contorno.position.y = alt / 2;
      grupo.add(contorno);

      grupo.userData.altura = 0;
      grupo.userData.alturaTopo = alt;
      grupo.userData.caixa = true;
      return grupo;
    }

    const alturaBorda = b.r * 0.44;
    const { pts, rTopo } = this._perfilBotao(b.r, alturaBorda);

    const grupo = new THREE.Group();

    // Corpo torneado: o bisel é o que faz a palheta funcionar.
    const corpo = new THREE.Mesh(
      new THREE.LatheGeometry(pts, 48),
      new THREE.MeshStandardMaterial({
        color: b.kind === 'keeper' ? corEscura : cor,
        map: this._texturaDesgaste(),
        roughness: 0.28,
        // Plástico não tem metal nenhum, e aqui o 0,12 não estava nem dando
        // reflexo: a cena não tem environment map, então ele só comia 12% do
        // difuso. Zerar devolve essa luz; medido num close, o bisel do botão
        // azul subiu de 97 para 103 de luminância — os riscos escurecem menos
        // do que o metal falso escurecia, e a cor do time sai mais fiel.
        metalness: 0,
      })
    );
    corpo.castShadow = true;
    corpo.receiveShadow = true;
    grupo.add(corpo);

    // Aro do topo com o número.
    const rotulo = b.kind === 'keeper' ? 'G' : String(b.id).replace(/^[AB]/, '');
    const topo = new THREE.Mesh(
      new THREE.CircleGeometry(rTopo * 0.98, 40),
      new THREE.MeshStandardMaterial({ map: this._texturaNumero(rotulo, hex(b.kind === 'keeper' ? cor : corEscura)), roughness: 0.35 })
    );
    topo.rotation.x = -Math.PI / 2;
    topo.position.y = alturaBorda + 0.02;
    grupo.add(topo);

    // Anel de destaque dos botões que dá para mover. Fica no raio EXATO do
    // botão: é nesse aro que a palheta encosta, e um anel maior parecia um
    // círculo solto, desalinhado da palheta.
    const anel = new THREE.Mesh(
      new THREE.TorusGeometry(b.r, 0.2, 8, 48),
      semToneMapping(new THREE.MeshBasicMaterial({ color: COR.mira }))
    );
    anel.rotation.x = -Math.PI / 2;
    anel.position.y = 0.03;
    anel.visible = false;
    grupo.add(anel);

    grupo.userData.anel = anel;
    grupo.userData.altura = 0;         // o grupo tem origem na base
    grupo.userData.alturaTopo = alturaBorda;
    grupo.userData.corpo = corpo;
    return grupo;
  }

  sincronizar(bodies) {
    const vistos = new Set();
    for (const b of bodies) {
      if (b.kind === 'post') continue;
      vistos.add(b.id);
      let p = this.pecas.get(b.id);
      if (!p) {
        const mesh = this._criarPeca(b);
        mesh.userData.id = b.id;
        this.grupoPecas.add(mesh);
        p = { mesh, kind: b.kind, team: b.team, r: b.r };
        this.pecas.set(b.id, p);
      }
      // O botão que está preso no ponteiro manda mais que o servidor: puxá-lo
      // de volta a cada estado faria o arrasto tremer.
      if (b.id !== this._arrasto) {
        p.mesh.position.copy(this.cena(b.x, b.y, this._alturaDe(p)));
        if (b.kind === 'ball') this._rolarBola(p, b.x, b.y);
      }
      // Ângulo do jogo -> rotação em Y, mesma convenção do mapeamento.
      if (b.forma === 'caixa') p.mesh.rotation.y = g2r(b.anguloDeg || 0);
    }
    if (this.sombraBola) this.sombraBola.visible = false;
    for (const [id, p] of this.pecas) {
      if (!vistos.has(id)) {
        this.grupoPecas.remove(p.mesh);
        this._descartarPeca(p.mesh);
        this.pecas.delete(id);
      }
    }
    this._atualizarDestaques();
  }

  /**
   * Devolve à GPU o que a peça segurava. Tirar do grupo some com ela da tela,
   * mas o three.js não coleta nada sozinho: geometria, material e a textura de
   * 256x256 que `_texturaNumero` desenha PARA CADA BOTÃO seguem alocados até
   * alguém pedir dispose. E o elenco troca sozinho — partida nova, mudança no
   * número de botões, cada `configurar()` —, então o que fica para trás não
   * para de crescer. Medido: 10 trocas de elenco deixavam 100 texturas e 270
   * geometrias órfãs na GPU.
   */
  _descartarPeca(mesh) {
    mesh.traverse((o) => {
      o.geometry?.dispose();
      // Aceita lista de materiais: hoje nenhuma peça usa, mas custa uma linha
      // e o dia em que usar não vira vazamento silencioso.
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        // O mapa do número é desenhado POR BOTÃO e morre com ele; o do
        // desgaste é um só para a cena inteira e sobrevive de propósito.
        if (m.map && m.map !== this._texDesgaste) m.map.dispose();
        m.dispose();
      }
    });
  }

  _alturaDe(p) {
    return p.kind === 'ball' ? p.r : 0;
  }

  destacar(ids) {
    this.controlaveis = new Set(ids || []);
    if (this.selecionado && !this.controlaveis.has(this.selecionado)) this.selecionar(null);
    this._atualizarDestaques();
  }

  _atualizarDestaques() {
    for (const [id, p] of this.pecas) {
      const anel = p.mesh.userData?.anel;
      if (!anel) continue;
      anel.visible = this.controlaveis.has(id);
      // Só a cor muda com a seleção: crescer tirava o anel do aro.
      anel.material.color.setHex(id === this.selecionado ? 0xffffff : COR.mira);
    }
  }

  selecionar(id) {
    this.selecionado = id && this.controlaveis.has(id) ? id : null;
    this._atualizarDestaques();
    this.aoSelecionar?.(this.selecionado);
  }

  /**
   * Câmera na nuca do jogador: atrás da palheta, baixa, olhando para a bola.
   * A palheta apoia no lado do botão oposto ao alvo, então "atrás dela" é o
   * prolongamento da reta bola -> botão.
   */
  visaoDeJogador(id = this.selecionado, { suave = true } = {}) {
    const p = this.pecas.get(id);
    const bl = this.pecas.get('ball');
    if (!p || !bl || this.animando) return false;

    const btn = p.mesh.position, alvoBola = bl.mesh.position;
    let dx = alvoBola.x - btn.x, dz = alvoBola.z - btn.z;
    const d = Math.hypot(dx, dz);
    // Botão em cima da bola: sem direção definida, olha do lado do gol.
    if (d < 0.01) { dx = 1; dz = 0; } else { dx /= d; dz /= d; }

    const RECUO = 24, ALTURA = 9;
    const destino = new THREE.Vector3(btn.x - dx * RECUO, ALTURA, btn.z - dz * RECUO);
    const mira = new THREE.Vector3(alvoBola.x, 1.6, alvoBola.z);
    this._irComCamera(destino, mira, suave ? 420 : 0);
    return true;
  }

  /**
   * Leva a câmera até uma posição/alvo. Corre num contador próprio: um
   * movimento de câmera não pode cancelar a animação de um lance.
   */
  _irComCamera(destino, mira, duracao = 420) {
    this._camTween = (this._camTween || 0) + 1;
    const meu = this._camTween;
    const de = this.camera.position.clone();
    const deAlvo = this.controls.target.clone();

    const pousar = () => {
      this.camera.position.copy(destino);
      this.controls.target.copy(mira);
      this.controls.update();
    };
    if (duracao <= 0) return pousar();

    const inicio = performance.now();
    const suavizar = (u) => u * u * (3 - 2 * u);
    const passo = () => {
      if (meu !== this._camTween || this.animando) return;
      const u = Math.min(1, (performance.now() - inicio) / duracao);
      const k = suavizar(u);
      this.camera.position.lerpVectors(de, destino, k);
      this.controls.target.lerpVectors(deAlvo, mira, k);
      this.controls.update();
      if (u < 1) requestAnimationFrame(passo);
      else pousar();
    };
    requestAnimationFrame(passo);
  }

  /* ------------------------------------------------------------ */
  /* Palheta                                                       */
  /* ------------------------------------------------------------ */

  /**
   * A palheta é montada como um taco de sinuca: a ponta encosta no aro do botão
   * e o corpo sobe para trás no ângulo de inclinação. O pivô fica NA PONTA, que
   * é o ponto de contato — mudar a inclinação gira em torno dele, como um taco.
   */
/**
   * Marca o ponto mais alto do pulo com uma bola fantasma e um risco até o
   * chão. É o que deixa claro QUANTO ela sobe — o arco sozinho, visto de cima,
   * parece um caminho torto.
   */
  _marcarApice(ponto, altura) {
    if (!this.apicePrevisto) {
      const g = new THREE.SphereGeometry(this.raios.ball, 12, 8);
      const m = semToneMapping(new THREE.MeshBasicMaterial({ color: COR.previsao, transparent: true, opacity: 0.35 }));
      this.apicePrevisto = new THREE.Mesh(g, m);
      this.apicePrevisto.visible = false;
      this.grupoMira.add(this.apicePrevisto);

      const linha = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      this.hasteApice = new THREE.Line(linha, semToneMapping(new THREE.LineBasicMaterial({
        color: COR.previsao, transparent: true, opacity: 0.45,
      })));
      this.hasteApice.visible = false;
      this.grupoMira.add(this.hasteApice);
    }

    // Um pulo de meio centímetro não merece anúncio.
    if (!ponto || altura < 0.6) {
      this.apicePrevisto.visible = false;
      this.hasteApice.visible = false;
      return;
    }

    this.apicePrevisto.position.copy(ponto);
    this.apicePrevisto.visible = true;
    this.hasteApice.geometry.setFromPoints([
      new THREE.Vector3(ponto.x, 0.05, ponto.z),
      ponto.clone(),
    ]);
    this.hasteApice.visible = true;
  }

  /** Sombra da bola no feltro: é o que dá a leitura de altura. */
  _atualizarSombra(x, y, alto) {
    if (!this.sombraBola) {
      this.sombraBola = new THREE.Mesh(
        new THREE.CircleGeometry(1, 20),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false })
      );
      this.sombraBola.rotation.x = -Math.PI / 2;
      this.scene.add(this.sombraBola);
    }
    const h = Math.max(0, alto);
    this.sombraBola.visible = h > 0.2;
    if (!this.sombraBola.visible) return;
    this.sombraBola.position.copy(this.cena(x, y, 0.05));
    // Quanto mais alta a bola, maior e mais fraca a sombra.
    const esc = 1 + h * 0.16;
    this.sombraBola.scale.setScalar(this.raios.ball * esc);
    this.sombraBola.material.opacity = Math.max(0.08, 0.4 - h * 0.03);
  }

  _construirPalheta() {
    this.grupoPalheta = new THREE.Group();
    this.grupoPalheta.visible = false;
    this.grupoMira.add(this.grupoPalheta);

    // Pivô na ponta: recebe a inclinação.
    this.pivoPalheta = new THREE.Group();
    this.grupoPalheta.add(this.pivoPalheta);

    // A palheta de verdade é uma pecinha chata de plástico, não um taco:
    // um disco simples, apoiado de canto no aro do botão.
    const RAIO = 4.6, ESP = 0.55;

    // Bem translúcida: a palheta tapa exatamente a região que interessa olhar
    // — o aro do botão e a bola logo atrás. Sem depthWrite ela não come o que
    // está por trás; o aro escuro é que dá o contorno.
    // Sem tone mapping porque a COR do disco é o aviso: creme = normal, azul =
    // cavadinha, vermelho = escorregou. É material iluminado, então o risco era
    // o brilho especular estourar em branco sem a curva do ACES para dobrá-lo —
    // medido, não estoura: com opacidade 0,28 o realce se dilui no feltro, e o
    // azul da cavadinha ganhou saturação em vez de perder.
    const matDisco = semToneMapping(new THREE.MeshStandardMaterial({
      color: COR.palheta, roughness: 0.15, metalness: 0.03,
      transparent: true, opacity: 0.28, side: THREE.DoubleSide,
      depthWrite: false,
    }));

    // O disco nasce deitado (eixo Y) e é virado para ficar de pé no plano XY.
    const disco = new THREE.Mesh(new THREE.CylinderGeometry(RAIO, RAIO, ESP, 44), matDisco);
    disco.rotation.z = Math.PI / 2;
    // Encostado pelo bordo: o centro fica a um raio da ponta de contato.
    disco.position.set(0, RAIO, 0);
    disco.renderOrder = 3;
    this.pivoPalheta.add(disco);

    // Contorno do disco: é ele que dá a leitura de borda, já que o disco em si
    // é quase transparente.
    //
    // A rotação NÃO é decorativa. Um cilindro tem o eixo em Y e vira X com o
    // rotation.z acima; um toro nasce com o furo em Z. Sem alinhar os dois, o
    // contorno ficava 90° virado em relação ao disco — uma argola solta ao lado
    // da palheta em vez da borda dela.
    const aro = new THREE.Mesh(
      new THREE.TorusGeometry(RAIO - 0.06, 0.13, 8, 48),
      semToneMapping(new THREE.MeshStandardMaterial({ color: COR.palheta, roughness: 0.35, transparent: true, opacity: 0.85 }))
    );
    aro.rotation.y = Math.PI / 2;          // furo do toro em X, como o eixo do disco
    aro.position.copy(disco.position);
    this.pivoPalheta.add(aro);

    this.pecasPalheta = { disco, aro };
    this.raioPalheta = RAIO;

    // Etiqueta fica fora do pivô, para não tombar com a inclinação.
    this.etiqueta = this._criarEtiqueta('');
    this.etiqueta.position.set(0, 15, 0);
    this.grupoPalheta.add(this.etiqueta);

    // Previsão: para onde o disco vai, e para onde a bola vai.
    const mk = (cor, tracejado) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const m = semToneMapping(tracejado
        ? new THREE.LineDashedMaterial({ color: cor, dashSize: 3.5, gapSize: 2.5 })
        : new THREE.LineBasicMaterial({ color: cor }));
      const l = new THREE.Line(g, m);
      l.visible = false;
      this.grupoMira.add(l);
      return l;
    };
    this.linhaDisco = mk(COR.mira, false);
    this.linhaBola = mk(COR.previsao, true);
    this.marcaParada = new THREE.Mesh(
      new THREE.TorusGeometry(1.8, 0.28, 6, 24),
      semToneMapping(new THREE.MeshBasicMaterial({ color: COR.mira }))
    );
    this.marcaParada.rotation.x = -Math.PI / 2;
    this.marcaParada.visible = false;
    this.grupoMira.add(this.marcaParada);
  }

  _criarEtiqueta(texto) {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 128;
    const spr = new THREE.Sprite(semToneMapping(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false,
    })));
    spr.scale.set(34, 8.5, 1);
    spr.userData.canvas = cv;
    spr.userData.escalaBase = { x: 34, y: 8.5 };
    this._escreverEtiqueta(spr, texto);
    return spr;
  }

  _escreverEtiqueta(spr, texto, cor = '#ffd24a') {
    const cv = spr.userData.canvas;
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    if (!texto) { spr.material.map.needsUpdate = true; return; }
    c.font = 'bold 54px system-ui, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const w = Math.min(cv.width - 20, c.measureText(texto).width + 56);
    c.fillStyle = 'rgba(10,14,20,0.82)';
    const x = (cv.width - w) / 2;
    c.beginPath(); c.roundRect(x, 22, w, 84, 20); c.fill();
    c.strokeStyle = cor; c.lineWidth = 4; c.stroke();
    c.fillStyle = cor;
    c.fillText(texto, cv.width / 2, 66);
    spr.material.map.needsUpdate = true;
  }

  /**
   * Prévia local da palheta, sem esperar o servidor.
   *
   * O apoio é a MESMA conta do motor (`pontoDeApoio`), então a prévia cai no
   * lugar certo. Ela existe porque a resposta do servidor leva uma ida e volta:
   * sem isso, arrastar o slider parecia travado e a palheta só pulava quando a
   * pessoa soltava. O servidor confirma logo em seguida, com rendimento e
   * previsão do lance.
   *
   * @param {{x:number,y:number,r?:number,id:string}} botao
   * @param {{anguloAro:number,inclinacao:number,avanco:number,forca:number}} p
   */
  previaPalheta(botao, p) {
    if (!botao || !p) return;
    const peca = this.pecas.get(botao.id);
    const alturaTopo = peca?.mesh.userData?.alturaTopo ?? 1;
    const apoio = this._apoioDe(botao, p);

    this.grupoPalheta.visible = true;
    this.grupoPalheta.position.copy(this.cena(apoio.x, apoio.y, alturaTopo * 0.72));
    this.grupoPalheta.rotation.y = g2r(p.anguloAro);
    this.pivoPalheta.rotation.z = g2r(p.inclinacao);
    this.pivoPalheta.position.set(0, 0, 0);
    this.pecasPalheta.disco.scale.set(1, 0.85 + p.forca * 0.45, 1);
    this.pecasPalheta.aro.scale.setScalar(1);
  }

  /**
   * Onde a palheta encosta no aro. É a mesma conta do motor (`pontoDeApoio`),
   * feita aqui para o desenho poder acompanhar o botão sem esperar o servidor.
   */
  _apoioDe(botao, p) {
    const rad = (p.anguloAro * Math.PI) / 180;
    const r = (botao.r ?? this.raios.button) * (1 - Math.min(1, Math.max(0, p.avanco)) * 0.82);
    return { x: botao.x + Math.cos(rad) * r, y: botao.y + Math.sin(rad) * r };
  }

  /**
   * A posição do botão AGORA, tirada da própria cena. É a coisa mais fresca que
   * o cliente tem: é o que a pessoa está vendo. O `aim.botao` do payload é uma
   * foto do momento da mira, e envelhece assim que alguém arrasta o botão.
   */
  _ondeEsta(id, seNaoAchar = null) {
    const peca = this.pecas.get(id);
    if (!peca) return seNaoAchar;
    const pt = this.jogo(peca.mesh.position);
    return { ...pt, r: peca.r ?? this.raios.button, id };
  }

  /**
   * Mostra a palheta como o servidor a resolveu.
   *
   * O apoio é RECALCULADO a partir de onde o botão está agora, e não copiado do
   * payload: se o botão foi reposicionado depois da mira, o apoio que veio do
   * servidor aponta para o lugar antigo e a palheta ficaria boiando lá.
   *
   * @param {object} aim payload de game/{id}/aim
   */
  mostrarPalheta(aim) {
    if (!aim || aim.limpar || !aim.palheta || !aim.apoio) return this.esconderPalheta();

    const p = this.pecas.get(aim.buttonId);
    const alturaTopo = p?.mesh.userData?.alturaTopo ?? 1;
    const centro = this._ondeEsta(aim.buttonId, aim.botao);
    const apoio = centro ? this._apoioDe(centro, aim.palheta) : aim.apoio;

    this.grupoPalheta.visible = true;
    this.grupoPalheta.position.copy(this.cena(apoio.x, apoio.y, alturaTopo * 0.72));
    // Ângulo do jogo -> rotação em torno de Y (mesma convenção do mapeamento).
    this.grupoPalheta.rotation.y = g2r(aim.palheta.anguloAro);
    // A ponta fica no aro e o taco sobe para trás conforme a inclinação.
    this.pivoPalheta.rotation.z = g2r(aim.palheta.inclinacao);
    this.pivoPalheta.position.set(0, 0, 0);

    // A força engrossa o disco: dá para ver o quanto se está apertando.
    const esc = 0.85 + aim.palheta.forca * 0.45;
    // A espessura do cilindro é o eixo dele (Y local). Escalar Z esticava o
        // disco em UMA das direções do círculo, virando elipse — e aí ele saía de
        // baixo do próprio contorno.
        this.pecasPalheta.disco.scale.set(1, esc, 1);
    this.pecasPalheta.aro.scale.setScalar(1);

    const cor = aim.escorregou ? COR.erro : aim.cavada ? COR.cavada : COR.palheta;
    this.pecasPalheta.disco.material.color.setHex(cor);
    this.pecasPalheta.aro.material.color.setHex(cor);

    const corTexto = aim.escorregou ? '#ff8b80' : aim.cavada ? '#8cdcff' : '#ffd24a';
    this._escreverEtiqueta(this.etiqueta, aim.playerName || '', corTexto);
    this.etiqueta.material.color.set(0xffffff);

    // Previsão do lance. Sai do botão onde ele está AGORA.
    const botao = centro || aim.botao;
    const prev = aim.previsao;

    // O quanto o disco corre e para onde ele vai dependem só da palheta, então
    // valem em qualquer posição. Já "alcança a bola" e o rumo da bola foram
    // calculados para o lugar onde o botão estava na hora da mira: se ele andou
    // desde então, essa parte está velha e é melhor não desenhar nada do que
    // desenhar errado. A mira nova chega logo em seguida.
    const mudouDeLugar = aim.botao && centro
      && Math.hypot(centro.x - aim.botao.x, centro.y - aim.botao.y) > 0.5;

    if (botao && prev) {
      const rad = g2r(prev.direcao);
      const fim = { x: botao.x + Math.cos(rad) * prev.corridaDisco, y: botao.y + Math.sin(rad) * prev.corridaDisco };
      this.linhaDisco.geometry.setFromPoints([this.cena(botao.x, botao.y, 1.4), this.cena(fim.x, fim.y, 1.4)]);
      this.linhaDisco.material.color.setHex(aim.escorregou ? COR.erro : COR.mira);
      this.linhaDisco.visible = true;
      this.marcaParada.position.copy(this.cena(fim.x, fim.y, 0.3));
      this.marcaParada.visible = true;

      const bola = this.pecas.get('ball');
      if (prev.alcancaBola && prev.bola && bola && !mudouDeLugar) {
        const br = g2r(prev.bola.direcao);
        const bx = bola.mesh.position.x, bz = bola.mesh.position.z;
        const raio = bola.r ?? this.raios.ball;
        const emD = (d, z) => new THREE.Vector3(
          bx + Math.cos(br) * d,
          raio + z,
          bz - Math.sin(br) * d,
        );

        // Se a bola vai pelo alto, a linha vira ARCO: é o desenho do pulo. O
        // servidor manda o perfil de altura amostrado, então aqui é só ligar
        // os pontos. Sem isso, uma cavadinha parecia um chute rasteiro.
        const voo = prev.bola.voo;
        const pontos = voo?.pontos?.length
          ? voo.pontos.map(([d, z]) => emD(d, z))
          : [emD(0, 0), emD(prev.bola.corrida, 0)];

        this.linhaBola.geometry.setFromPoints(pontos);
        this.linhaBola.computeLineDistances();
        this.linhaBola.visible = true;

        this._marcarApice(voo ? emD(voo.ondeMax, voo.alturaMax) : null, voo?.alturaMax ?? 0);
      } else {
        this.linhaBola.visible = false;
        this._marcarApice(null, 0);
      }
    }
  }

  esconderPalheta() {
    this.grupoPalheta.visible = false;
    this.linhaDisco.visible = false;
    this.linhaBola.visible = false;
    this.marcaParada.visible = false;
    if (this.apicePrevisto) this.apicePrevisto.visible = false;
    if (this.hasteApice) this.hasteApice.visible = false;
  }

  /**
   * A batida: o taco avança sobre o ponto de contato e some.
   * Roda antes da trajetória, para o lance começar com a palheta apertando.
   *
   * O estalo sai DAQUI, no instante em que o taco encosta — antes ele saía de
   * `tocarLance`, quando o lance chegava do broker, e chegava 190 ms na frente
   * da imagem. Pior: quando a palheta não está na tela este método devolve na
   * hora, então o adiantamento era ora 190 ms ora nenhum. `encostar()` é o
   * único ponto de saída dos dois caminhos, e por isso som e imagem batem nos
   * dois.
   *
   * @param {Function} aoTerminar chamado quando o taco encostou
   * @param {number} forca 0..1, o que o jogador ajustou na palheta
   */
  golpear(aoTerminar, forca = 0.5) {
    const encostar = () => { this.som?.palheta(forca); aoTerminar?.(); };
    if (!this.grupoPalheta.visible) { encostar(); return; }
    this.linhaDisco.visible = false;
    this.linhaBola.visible = false;
    this.marcaParada.visible = false;

    const inclinacao0 = this.pivoPalheta.rotation.z;
    const duracao = 190;
    const inicio = performance.now();

    const passo = () => {
      const u = Math.min(1, (performance.now() - inicio) / duracao);
      // Recua um pouco e desce rápido em cima do botão.
      const arma = u < 0.35 ? -(u / 0.35) * 0.9 : -(1 - (u - 0.35) / 0.65) * 0.9;
      this.pivoPalheta.position.x = arma;
      this.pivoPalheta.rotation.z = inclinacao0 * (1 - 0.55 * Math.max(0, (u - 0.35) / 0.65));
      if (u < 1) { requestAnimationFrame(passo); return; }
      this.esconderPalheta();
      this.pivoPalheta.position.x = 0;
      this.pivoPalheta.rotation.z = inclinacao0;
      encostar();
    };
    requestAnimationFrame(passo);
  }

  /* ------------------------------------------------------------ */
  /* Entrada                                                       */
  /* ------------------------------------------------------------ */

  _initInput() {
    // Clique curto seleciona um botão; arrasto é da câmera (esquerdo = pan).
    let inicio = null;
    this.canvas.addEventListener('pointerdown', (ev) => {
      if (ev.button === 0) inicio = { x: ev.clientX, y: ev.clientY, t: performance.now() };
    });
    this.canvas.addEventListener('pointerup', (ev) => {
      if (ev.button !== 0 || !inicio || this.animando) { inicio = null; return; }
      const dist = Math.hypot(ev.clientX - inicio.x, ev.clientY - inicio.y);
      const dur = performance.now() - inicio.t;
      inicio = null;
      if (dist > 5 || dur > 600) return;      // foi arrasto de câmera, não clique

      const rect = this.canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const alvos = [...this.pecas.entries()]
        .filter(([id]) => this.controlaveis.has(id))
        .map(([, p]) => p.mesh);
      const hit = ray.intersectObjects(alvos, true);
      if (hit.length) {
        let o = hit[0].object;
        while (o && !o.userData?.id) o = o.parent;
        if (o?.userData?.id) this.selecionar(o.userData.id);
      }
    });
    // Arrasto de posicionamento: aperta, arrasta, solta.
    this.canvas.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || !this._posic || this.animando) return;
      const id = this._botaoSobOMouse(ev, this._posic.ids);
      if (!id) return;
      ev.preventDefault();
      inicio = null;                          // não é clique de seleção
      this._arrasto = id;
      this._ponteiro = ev.pointerId;
      this.controls.enabled = false;
      this.canvas.style.cursor = 'grabbing';
      try { this.canvas.setPointerCapture(ev.pointerId); } catch { /* sem captura, tudo bem */ }
    });

    const arrastar = (ev) => {
      const id = this._arrasto;
      const P = this._posic;
      if (!id || !P) return null;
      const cru = this._pontoNoFeltro(ev);
      if (!cru) return null;
      const pt = this._limitarNaRegiao(cru, P.regiao);
      const x = Math.round(pt.x * 10) / 10, y = Math.round(pt.y * 10) / 10;
      const peca = this.pecas.get(id);
      if (peca) peca.mesh.position.copy(this.cena(x, y, this._alturaDe(peca)));
      P.aoArrastar?.(id, x, y);
      return { id, x, y };
    };
    this.canvas.addEventListener('pointermove', arrastar);

    const soltar = (ev) => {
      if (!this._arrasto) return;
      const aoSoltar = this._posic?.aoSoltar;
      let onde = null;
      try { onde = arrastar(ev); } catch { /* solta mesmo assim */ }
      try { this.canvas.releasePointerCapture(this._ponteiro); } catch { /* já solto */ }
      const id = this._arrasto;
      this._soltarArrasto();
      if (!onde) {
        const peca = this.pecas.get(id);
        if (peca) {
          const pt = this.jogo(peca.mesh.position);
          onde = { id, x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10 };
        }
      }
      if (onde) aoSoltar?.(onde.id, onde.x, onde.y);
    };
    this.canvas.addEventListener('pointerup', soltar);
    this.canvas.addEventListener('pointercancel', soltar);
    // Se o ponteiro sumir da janela com o botão apertado, solta assim mesmo.
    addEventListener('pointerup', soltar);
    addEventListener('blur', () => { if (this._arrasto) this._soltarArrasto(); });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ------------------------------------------------------------ */
  /* Animação                                                      */
  /* ------------------------------------------------------------ */

  /**
   * Registra uma animação nova; a anterior é cancelada.
   *
   * Cancelar TEM que desfazer o que a animação mexeu — câmera travada, selo
   * de replay na tela, sinalizador de "animando". Um `return` seco no meio do
   * loop deixava tudo isso ligado e a tela congelava sem ninguém para
   * destravá-la.
   *
   * @param {Function|null} desfazer roda se esta animação for interrompida
   * @returns {number} o id desta animação
   */
  _novaAnimacao(desfazer = null) {
    // A torcida não pode reagir a um lance que foi cancelado no meio: os sons
    // de desfecho ainda na fila morrem junto com a animação que os marcou.
    for (const id of this._temposDesfecho) clearTimeout(id);
    this._temposDesfecho.length = 0;

    const anterior = this._limpezaAnim;
    this._limpezaAnim = desfazer;
    if (anterior) { try { anterior(); } catch { /* limpeza nunca derruba */ } }
    this._animacaoAtual = (this._animacaoAtual || 0) + 1;
    return this._animacaoAtual;
  }

  /** Terminou por bem: não há mais nada a desfazer. */
  _fimDaAnimacao() { this._limpezaAnim = null; }

  /** Último recurso: solta o que uma animação tenha deixado preso. */
  destravar() {
    this._novaAnimacao();
    this.animando = false;
    this.controls.enabled = true;
    this.controls.update();
  }

  /**
   * @param {Object|null} desfecho o `lastMove` do servidor — no que o lance
   *   deu. Vem junto porque o SOM do desfecho tem hora marcada dentro da fita,
   *   e quem sabe essa hora é a cena, não quem recebeu o pacote do broker.
   */
  animar(traj, aoTerminar, forca = 0.5, desfecho = null) {
    if (!traj?.frames?.length) { aoTerminar?.(); return; }
    this.animando = true;
    // Primeiro a palheta bate, depois o disco sai: a causa antes do efeito.
    // O estalo é do `golpear`, que sabe a hora exata em que o taco encosta.
    this.golpear(() => {
      this._tocarTrajetoria(traj, 1, () => { this.animando = false; aoTerminar?.(); }, desfecho);
    }, forca);
  }

  _tocarTrajetoria(traj, velocidade, aoTerminar, desfecho = null) {
    const frames = traj.frames;
    const duracao = frames[frames.length - 1].t;
    this._agendarImpactos(traj.events, velocidade);
    const inicio = performance.now();
    const meuId = this._novaAnimacao(() => aoTerminar?.());
    // DEPOIS do `_novaAnimacao`, e não antes: é ele que limpa os temporizadores
    // do lance anterior, e chamar antes apagaria os que acabaram de ser
    // marcados aqui.
    this._agendarDesfecho(traj.events, duracao, velocidade, desfecho);

    const passo = () => {
      if (meuId !== this._animacaoAtual) return;      // outra animação assumiu
      const t = ((performance.now() - inicio) / 1000) * velocidade;
      if (t >= duracao) {
        this._aplicarQuadro(traj, frames.length - 1);
        this._fimDaAnimacao();
        aoTerminar?.();
        return;
      }
      let i = 1;
      while (i < frames.length - 1 && frames[i].t < t) i++;
      const f0 = frames[i - 1], f1 = frames[i];
      const k = Math.max(0, Math.min(1, (t - f0.t) / Math.max(1e-6, f1.t - f0.t)));
      this._aplicarQuadro(traj, i - 1, k, t);
      requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
  }

  /**
   * Dá voz às pancadas do lance: agenda TODAS de uma vez, pelo relógio do
   * WebAudio.
   *
   * O servidor já mandava `traj.events` com o instante, o par que bateu e a
   * velocidade de cada contato — e a cena jogava fora. São 337 impactos por
   * partida contra 3,6 gols: era o barulho que mais faltava no jogo.
   *
   * Agendado, e não disparado dentro do `requestAnimationFrame`. O quadro
   * chega a cada 16 ms e com jitter; uma pancada precisa cair no milissegundo
   * em que a peça encosta, senão o som descola da imagem. O WebAudio agenda
   * com precisão de amostra, então basta entregar o `t` do evento como atraso.
   *
   * @param {Array} eventos `traj.events`; o replay não os guarda, e aí é vazio
   * @param {number} velocidade da fita — `t` é segundo de verdade só a 1x
   */
  _agendarImpactos(eventos, velocidade) {
    if (!this.som?.ligado || !(velocidade > 0)) return;
    for (const i of impactosAudiveis(eventos)) {
      this.som.colisao(i.velocidade, i.tipo, i.t / velocidade);
    }
  }

  /**
   * Dá voz ao DESFECHO do lance: no que ele deu, na hora em que deu.
   *
   * São ~67 por partida — bicuda no vento, bola fora, trave, gol anulado — e
   * até aqui todos terminavam em silêncio absoluto: o jogador via o botão
   * parar e não tinha retorno nenhum de qual dos desfechos aconteceu.
   *
   * Cada um tem HORA dentro da fita, e é por isso que este agendamento mora na
   * cena e não no `app.js`: o servidor publica o evento ANTES da trajetória, e
   * quem toca ao receber o pacote toca antes de o lance começar. Era o caso do
   * gol — a torcida gritava ~0,65 s antes de a bola entrar.
   *
   * @param {Array} eventos `traj.events`; o replay não os guarda, e aí é vazio
   * @param {number} duracao segundos da fita (o `t` do último quadro)
   * @param {number} velocidade da fita — `t` é segundo de verdade só a 1x
   * @param {Object|null} desfecho o `lastMove` do servidor
   */
  _agendarDesfecho(eventos, duracao, velocidade, desfecho) {
    if (!this.som?.ligado || !(velocidade > 0)) return;
    const lista = Array.isArray(eventos) ? eventos : [];

    // O gol e o gol anulado acontecem no mesmo instante — quando a bola cruza
    // a linha. O que muda é a reação.
    const gol = lista.find((e) => e.type === 'goal');
    const tGol = gol ? gol.t / velocidade : null;
    if (tGol != null && desfecho?.goal) this.som.gol(tGol);
    else if (tGol != null && desfecho?.goalAnulado) this._adiar(() => this.som.suspiro(), tGol);

    // A trave. O 'ooooh' por cima só quando quem bateu foi a BOLA: botão na
    // trave são 5,4 por partida e é só uma peça achando um poste; bola na
    // trave são 1,4, e é a única coisa que a mesa produz que dá para chamar
    // de quase-gol sem exagero.
    for (const tr of travesAudiveis(lista)) {
      this.som.trave(tr.t / velocidade);
      if (tr.bola) this._adiar(() => this.som.suspiro(), tr.t / velocidade);
    }

    // Bola fora. Pelo fundo depois de chute declarado é quase-gol e leva o
    // 'ooooh' inteiro; pela lateral, ou pelo fundo sem chute declarado, é só
    // decepção — e são 22 por partida, frequentes demais para gastar o
    // 'ooooh' em todas elas.
    const fora = lista.find((e) => e.type === 'fora');
    if (fora && !desfecho?.goal) {
      const quaseGol = fora.linha === 'fundo' && desfecho?.declarado;
      this._adiar(() => (quaseGol ? this.som.suspiro() : this.som.desanimo()),
                  fora.t / velocidade);
    }

    // A bicuda no vento: o desfecho mais frequente da partida (33,8) e o único
    // sem instante próprio, porque não houve contato nenhum para marcar um. O
    // jogador só descobre que errou quando o botão para, então é aí que sai.
    // A falta fica de fora: ela já tem o apito, e apito com murmúrio por cima
    // são duas notícias ao mesmo tempo.
    if (desfecho && desfecho.touchedBall === false && !desfecho.foul && !fora && !gol) {
      this._adiar(() => this.som.desanimo(), duracao / velocidade);
    }
  }

  /**
   * Toca daqui a `segundos` — e some se outra animação assumir a mesa.
   *
   * Temporizador, e não o relógio do WebAudio que as pancadas exigem: estes
   * são sons de TORCIDA, envelopes de 0,1 s para cima, onde os 16 ms de jitter
   * de um quadro não se ouvem. O que não se pode é a torcida suspirar por um
   * lance que já foi cancelado, e por isso todo temporizador entra na lista
   * que `_novaAnimacao` limpa.
   */
  _adiar(fn, segundos) {
    const ms = Math.max(0, Number(segundos) || 0) * 1000;
    this._temposDesfecho.push(setTimeout(fn, ms));
  }

  /** Aplica o quadro `i` (opcionalmente interpolando para o seguinte). */
  _aplicarQuadro(traj, i, k = 0, tAbs = null) {
    const ids = traj.ids;
    const f0 = traj.frames[i];
    const f1 = k > 0 ? traj.frames[i + 1] : null;
    const t = tAbs != null ? tAbs : f0.t;

    for (let j = 0; j < ids.length; j++) {
      const p = this.pecas.get(ids[j]);
      if (!p) continue;
      let x = f0.p[j * 2], y = f0.p[j * 2 + 1];
      if (f1) {
        x += (f1.p[j * 2] - x) * k;
        y += (f1.p[j * 2 + 1] - y) * k;
      }

      // Cavadinha: durante o voo o botão sobe numa parábola.
      let altura = this._alturaDe(p);
      const voo = traj.voos?.find((v) => v.id === ids[j]);
      if (voo && t < voo.ate) {
        const u = t / voo.ate;
        altura += voo.altura * 4 * u * (1 - u);
      }
      // A bola tem altura própria, vinda da simulação.
      if (p.kind === 'ball') {
        const z0 = f0.z ?? 0;
        const z1 = f1 ? (f1.z ?? 0) : z0;
        altura += z0 + (z1 - z0) * k;
        this._atualizarSombra(x, y, altura - p.r);
        this._rolarBola(p, x, y);
      }
      p.mesh.position.copy(this.cena(x, y, altura));

      if (p.kind === 'ball' && f1) {
        p.mesh.rotation.z -= (f1.p[j * 2] - f0.p[j * 2]) / p.r * 0.1;
        p.mesh.rotation.x -= (f1.p[j * 2 + 1] - f0.p[j * 2 + 1]) / p.r * 0.1;
      }
    }
  }

  /* ------------------------------------------------------------ */
  /* Replay do gol                                                 */
  /* ------------------------------------------------------------ */

  /**
   * Reprisa o lance do gol com a câmera em movimento, para ficar claro que é
   * replay e não jogo ao vivo: começa baixa atrás de quem chutou, gira em
   * torno da bola e termina alta atrás do gol.
   * @param {object} traj trajetória do lance
   * @param {'A'|'B'} timeQueMarcou
   */
/**
   * Reprisa o gol com a câmera em movimento e PARA onde se pede.
   *
   * `cameraFinal` existe porque a reprise antes voltava para a posição de
   * antes dela e só então alguém dava um salto para outro plano. Eram três
   * movimentos seguidos, e ninguém entendia o que o adversário ia fazer.
   * Agora a reprise pousa direto no plano final, e fica parada nele.
   */
  replayDoGol(traj, timeQueMarcou, aoTerminar, { cameraFinal = null } = {}) {
    if (!traj?.frames?.length) { aoTerminar?.(); return; }

    const L = this.pitch.length;
    // Gol atacado: A marca em x=L, B marca em x=0.
    const golX = timeQueMarcou === 'A' ? L : 0;
    const alvo = this.cena(golX, this.pitch.width / 2, 6);

    // Onde a bola estava no começo do lance: a câmera nasce atrás dela.
    const iBola = traj.ids.indexOf('ball');
    const f0 = traj.frames[0];
    const partidaBola = iBola >= 0
      ? this.cena(f0.p[iBola * 2], f0.p[iBola * 2 + 1], 0)
      : new THREE.Vector3(0, 0, 0);

    const dir = Math.sign(golX - (this.pitch.length / 2)) || 1;
    const camIni = new THREE.Vector3(partidaBola.x - dir * 52, 16, partidaBola.z + 46);
    const camFim = new THREE.Vector3(alvo.x + dir * 62, 58, -34);

    this.controls.enabled = false;
    this.animando = true;
    this.esconderPalheta();

    const camAntes = this.camera.position.clone();
    const alvoAntes = this.controls.target.clone();

    const duracao = traj.frames[traj.frames.length - 1].t;
    const velocidade = 0.45;                 // câmera lenta, é replay
    const total = duracao / velocidade;
    const inicio = performance.now();

    // Se algo interromper a reprise (o replay da partida, outro lance), a
    // câmera volta na hora e quem esperava é avisado.
    // Onde a reprise pousa: o plano pedido, ou de volta ao que estava.
    const pouso = cameraFinal
      ? { pos: new THREE.Vector3(...cameraFinal), alvo: new THREE.Vector3(0, 0, 0) }
      : { pos: camAntes, alvo: alvoAntes };

    const devolverCamera = () => {
      this.camera.position.copy(pouso.pos);
      this.controls.target.copy(pouso.alvo);
      this.camera.lookAt(pouso.alvo);
      this.controls.enabled = true;
      this.controls.update();
      this.animando = false;
    };
    const meuId = this._novaAnimacao(() => { devolverCamera(); aoTerminar?.(); });
    const suave = (u) => u * u * (3 - 2 * u);

    const passo = () => {
      if (meuId !== this._animacaoAtual) return;
      const decorrido = (performance.now() - inicio) / 1000;
      const u = Math.min(1, decorrido / total);

      // Câmera: interpola e ainda orbita um pouco em volta do alvo.
      const k = suave(u);
      const orbita = (u - 0.5) * 0.55;
      const pos = camIni.clone().lerp(camFim, k);
      const rel = pos.clone().sub(alvo);
      rel.applyAxisAngle(new THREE.Vector3(0, 1, 0), orbita);
      this.camera.position.copy(alvo.clone().add(rel));
      this.camera.lookAt(alvo);

      const t = Math.min(duracao, decorrido * velocidade);
      let i = 1;
      while (i < traj.frames.length - 1 && traj.frames[i].t < t) i++;
      const a = traj.frames[i - 1], b = traj.frames[i];
      const kk = Math.max(0, Math.min(1, (t - a.t) / Math.max(1e-6, b.t - a.t)));
      this._aplicarQuadro(traj, i - 1, kk, t);

      if (u < 1) { requestAnimationFrame(passo); return; }

      // Volta a câmera para onde estava, suavemente.
      const volta = performance.now();
      const devolver = () => {
        if (meuId !== this._animacaoAtual) return;
        const v = Math.min(1, (performance.now() - volta) / 700);
        const kv = suave(v);
        this.camera.position.lerpVectors(this.camera.position, pouso.pos, kv * 0.35);
        this.controls.target.lerpVectors(this.controls.target, pouso.alvo, kv * 0.35);
        this.camera.lookAt(this.controls.target);
        if (v < 1) { requestAnimationFrame(devolver); return; }
        devolverCamera();
        this._fimDaAnimacao();
        aoTerminar?.();
      };
      requestAnimationFrame(devolver);
    };
    requestAnimationFrame(passo);
  }

  /* ------------------------------------------------------------ */
  /* Replay                                                        */
  /* ------------------------------------------------------------ */

  /**
   * Cada lance vira uma fita única de passos:
   *   [ajuste, ajuste, ..., golpe, quadro, quadro, ...]
   * Assim dá para andar passo a passo pela CONFIGURAÇÃO da palheta e depois
   * pela jogada, no mesmo controle — que é o ponto de rever um lance.
   * @param {{lances:Array, trajetorias:Array}} dados de GET /replay?full=1
   */
  carregarReplay(dados) {
    const trajPorN = new Map((dados.trajetorias || []).map((t) => [t.n, t]));

    const lances = (dados.lances || []).map((l) => {
      const traj = trajPorN.get(l.n);
      if (!traj) return null;
      const ajustes = traj.ajustes || [];
      const passos = [
        ...ajustes.map((aim, i) => ({ tipo: 'ajuste', aim, i })),
        ...(ajustes.length ? [{ tipo: 'golpe', aim: ajustes[ajustes.length - 1] }] : []),
        ...traj.frames.map((_, i) => ({ tipo: 'quadro', i })),
      ];
      return { ...l, traj, ajustes, passos };
    }).filter(Boolean);

    this.replay = {
      lances,
      lance: 0,
      passo: 0,
      tocando: false,
      velocidade: 1,
      msAjuste: 240,          // ritmo de cada passo de configuração
      aoMudar: null,
    };
    this.animando = false;
    this.esconderPalheta();
    if (lances.length) this.irPara(0, 0);
    return lances.length;
  }

  fecharReplay() {
    if (this.replay) this.replay.tocando = false;
    this._novaAnimacao();
    this.replay = null;
  }

  irPara(lance, passo = 0) {
    const R = this.replay;
    if (!R?.lances.length) return;
    R.lance = Math.max(0, Math.min(R.lances.length - 1, lance));
    const L = R.lances[R.lance];
    R.passo = Math.max(0, Math.min(L.passos.length - 1, passo));
    this._aplicarPasso(L, L.passos[R.passo]);
    R.aoMudar?.(this.estadoReplay());
  }

  /** Aplica um passo: ajuste (palheta parada), golpe, ou quadro da trajetória. */
  _aplicarPasso(L, passo) {
    if (!passo) return;
    if (passo.tipo === 'quadro') {
      if (passo.i === 0) this.esconderPalheta();
      this._aplicarQuadro(L.traj, passo.i);
      return;
    }
    // Ajuste e golpe acontecem ANTES do lance: mesa na posição inicial.
    this._aplicarQuadro(L.traj, 0);
    this.mostrarPalheta(passo.aim);
    if (passo.tipo === 'golpe') {
      // Palheta apertada em cima do botão, o instante da batida.
      this.pivoPalheta.rotation.z = g2r(passo.aim.palheta.inclinacao) * 0.45;
      this.pivoPalheta.position.x = -0.9;
    } else {
      this.pivoPalheta.position.x = 0;
    }
  }

  passoQuadro(delta) {
    const R = this.replay;
    if (!R) return;
    R.tocando = false;
    let p = R.passo + delta;
    let l = R.lance;
    while (p < 0) {
      if (l === 0) { p = 0; break; }
      l -= 1; p += R.lances[l].passos.length;
    }
    while (p > R.lances[l].passos.length - 1) {
      if (l === R.lances.length - 1) { p = R.lances[l].passos.length - 1; break; }
      p -= R.lances[l].passos.length; l += 1;
    }
    this.irPara(l, p);
  }

  passoLance(delta) {
    const R = this.replay;
    if (!R) return;
    R.tocando = false;
    this.irPara(R.lance + delta, 0);
  }

  /** Volta ao primeiro lance da partida. */
  primeiroLance() {
    if (!this.replay) return;
    this.replay.tocando = false;
    this.irPara(0, 0);
  }

  /** Vai para o último lance, já no quadro final. */
  ultimoLance() {
    const R = this.replay;
    if (!R?.lances.length) return;
    R.tocando = false;
    const ultimo = R.lances.length - 1;
    this.irPara(ultimo, R.lances[ultimo].passos.length - 1);
  }

  tocarReplay() {
    const R = this.replay;
    if (!R?.lances.length || R.tocando) return;
    R.tocando = true;
    this._reproduzirDoAtual();
    R.aoMudar?.(this.estadoReplay());
  }

  pausarReplay() {
    if (!this.replay) return;
    this.replay.tocando = false;
    this._novaAnimacao();
    this.replay.aoMudar?.(this.estadoReplay());
  }

  _reproduzirDoAtual() {
    const R = this.replay;
    if (!R?.tocando) return;
    const L = R.lances[R.lance];
    const passo = L.passos[R.passo];

    const meuId = this._novaAnimacao();
    const vivo = () => meuId === this._animacaoAtual && R.tocando;

    const avancar = () => {
      if (!vivo()) return;
      if (R.passo < L.passos.length - 1) { R.passo += 1; R.aoMudar?.(this.estadoReplay()); this._reproduzirDoAtual(); return; }
      if (R.lance < R.lances.length - 1) { R.lance += 1; R.passo = 0; R.aoMudar?.(this.estadoReplay()); this._reproduzirDoAtual(); return; }
      R.tocando = false;
      R.aoMudar?.(this.estadoReplay());
    };

    // Passo de configuração: mostra e segura um instante.
    if (passo.tipo === 'ajuste' || passo.tipo === 'golpe') {
      this._aplicarPasso(L, passo);
      setTimeout(() => { if (vivo()) avancar(); }, R.msAjuste / R.velocidade);
      return;
    }

    // A partir daqui é a trajetória, tocada em tempo real até o fim do lance.
    const frames = L.traj.frames;
    const tInicial = frames[passo.i].t;
    const duracao = frames[frames.length - 1].t;
    const partida = performance.now();
    this.esconderPalheta();

    const quadro = () => {
      if (!vivo()) return;
      const t = tInicial + ((performance.now() - partida) / 1000) * R.velocidade;

      if (t >= duracao) {
        this._aplicarQuadro(L.traj, frames.length - 1);
        R.passo = L.passos.length - 1;
        R.aoMudar?.(this.estadoReplay());
        if (R.lance < R.lances.length - 1) { R.lance += 1; R.passo = 0; R.aoMudar?.(this.estadoReplay()); this._reproduzirDoAtual(); }
        else { R.tocando = false; R.aoMudar?.(this.estadoReplay()); }
        return;
      }

      let i = 1;
      while (i < frames.length - 1 && frames[i].t < t) i++;
      const f0 = frames[i - 1], f1 = frames[i];
      const k = Math.max(0, Math.min(1, (t - f0.t) / Math.max(1e-6, f1.t - f0.t)));
      this._aplicarQuadro(L.traj, i - 1, k, t);

      const idxPasso = L.passos.length - frames.length + (i - 1);
      if (idxPasso !== R.passo) { R.passo = idxPasso; R.aoMudar?.(this.estadoReplay()); }
      requestAnimationFrame(quadro);
    };
    requestAnimationFrame(quadro);
  }

  estadoReplay() {
    const R = this.replay;
    if (!R?.lances.length) return null;
    const L = R.lances[R.lance];
    const passo = L.passos[R.passo] || {};
    const nAjustes = L.ajustes.length;
    return {
      lance: R.lance,
      total: R.lances.length,
      passo: R.passo,
      passos: L.passos.length,
      tipo: passo.tipo,
      aim: passo.aim || null,
      // Numeração legível: "ajuste 2/5" ou "quadro 7/21".
      indiceAjuste: passo.tipo === 'ajuste' ? passo.i + 1 : null,
      totalAjustes: nAjustes,
      indiceQuadro: passo.tipo === 'quadro' ? passo.i + 1 : null,
      totalQuadros: L.traj.frames.length,
      tocando: R.tocando,
      velocidade: R.velocidade,
      info: L,
    };
  }

  /* ------------------------------------------------------------ */

/**
   * Guarda a câmera de agora, para poder voltar a ela depois.
   *
   * É o que faz a mesa "não se mexer sozinha" enquanto o adversário posiciona
   * o goleiro: quando a vez volta, a vista volta com ela.
   */
  guardarCamera() {
    this._cameraGuardada = {
      pos: this.camera.position.clone(),
      alvo: this.controls.target.clone(),
    };
  }

  /** Volta para a câmera guardada. Devolve false se não havia nenhuma. */
  restaurarCamera({ suave = true } = {}) {
    const g = this._cameraGuardada;
    if (!g) return false;
    this._cameraGuardada = null;
    this._irComCamera(g.pos, g.alvo, suave ? 500 : 0);
    return true;
  }

  /** As posições dos planos fixos, para quem precisa pedir um pouso. */
  static PLANOS = {
    alto: [0, 215, 1],
    tresQuartos: [0, 165, 205],
    timeA: [-205, 95, 0],
    timeB: [205, 95, 0],
    lateral: [0, 90, 195],
    // Baixo E DENTRO da tigela. Com z=150 este plano caía no meio da
    // arquibancada (ela começa em 86) e a vista virava um paredão de torcedores.
    rasante: [0, 20, 78],
  };

  camera_preset(nome, { suave = false } = {}) {
    const alvos = Cena3D.PLANOS;
    if (nome === 'jogador') {
      if (this.visaoDeJogador()) return;
      // Sem botão escolhido não há nuca para ficar atrás: cai no rasante.
      nome = 'rasante';
    }
    const p = alvos[nome] || alvos.tresQuartos;
    const destino = new THREE.Vector3(p[0], p[1], p[2]);
    const alvo = new THREE.Vector3(0, 0, 0);
    if (suave) this._irComCamera(destino, alvo, 600);
    else {
      this.camera.position.copy(destino);
      this.controls.target.copy(alvo);
      this.controls.update();
    }
  }

  /** Placar e nome da partida no telão do estádio. */
  telao(dados) { this.estadio?.placar(dados); }

  /** A torcida comemora o gol do time dado. */
  festa(team) { this.estadio?.festejar(team); }

  /** Liga/desliga o cenário — útil em máquina fraca. */
  mostrarEstadio(sim) { this.estadio?.visivel(sim); }

  configurar(pitch, physics) {
    if (pitch) Object.assign(this.pitch, pitch);
    if (physics) {
      this.raios.button = physics.buttonRadius ?? this.raios.button;
      this.raios.keeper = physics.keeperRadius ?? this.raios.keeper;
      this.raios.ball = physics.ballRadius ?? this.raios.ball;
    }
    this._construirMesa();
    this.estadio?.construir();
  }

  /**
   * O nome de quem segura a palheta é um sprite: de longe fica bom, mas com a
   * câmera colada ele tomava a tela inteira. Encolhe conforme a câmera chega
   * perto, para ocupar mais ou menos o mesmo tanto de tela sempre.
   */
  _ajustarEtiqueta() {
    const e = this.etiqueta;
    if (!e || !this.grupoPalheta?.visible) return;
    if (!this._vAux) this._vAux = new THREE.Vector3();
    const dist = this.camera.position.distanceTo(e.getWorldPosition(this._vAux));
    const base = e.userData.escalaBase;
    const k = Math.max(0.26, Math.min(1, dist / 120));
    e.scale.set(base.x * k, base.y * k, 1);
    // Perto, o nome também desce: a 15 de altura ele saía do quadro.
    e.position.y = 6 + 9 * k;
  }

  /**
   * Segura a câmera acima do feltro e, ao encostar no piso, sobe o ALVO.
   *
   * É o que transforma girar-para-baixo em olhar-para-cima no nível do campo:
   * a câmera para de descer e quem passa a subir é a mira. Sem isto, cruzar a
   * horizontal enfiaria a câmera embaixo da mesa e mostraria o avesso do
   * tabuleiro.
   */
  _segurarNoPiso() {
    const PISO = 4;                  // 4 cm acima do feltro
    const TETO_DO_ALVO = 90;         // sobe até a altura do telão, e não além
    const cam = this.camera.position;
    if (cam.y >= PISO) return;

    const falta = PISO - cam.y;
    cam.y = PISO;
    this.controls.target.y = Math.min(TETO_DO_ALVO, this.controls.target.y + falta);
  }

  _loop() {
    const render = () => {
      this.controls.update();
      this._segurarNoPiso();
      this._ajustarEtiqueta();
      this.estadio?.animar(performance.now() / 1000);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
  }
}
