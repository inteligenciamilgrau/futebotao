// Cola entre rede, cena 3D e DOM.

import { Net } from './net.js';
import { Cena3D } from './scene3d.js';
import { atalhoPalheta, atalhoBotao, focoEmControle } from './teclado.js';
import { TorcidaSom } from './torcida-som.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const net = new Net();
// O som do estádio só começa depois de um clique: é regra do navegador.
const som = new TorcidaSom();
let cena = null;
let estado = null;
let gameId = new URLSearchParams(location.search).get('game') || null;
let regras = null;
let animando = false;
let cronometro = null;
let emReplay = false;

// Configuração corrente da palheta (o que os controles editam).
const palheta = { anguloAro: 180, inclinacao: 45, avanco: 0.35, forca: 0.6 };
let aimTimer = null;
let aimUltimo = 0;
let ultimoAim = null;

/* ------------------------------------------------------------------ */
/* Telas e avisos                                                      */
/* ------------------------------------------------------------------ */

const mostrarTela = (nome) => $$('.tela').forEach((t) => t.classList.toggle('ativa', t.dataset.tela === nome));

function aviso(msg, tipo = 'info') {
  const el = $('#aviso');
  el.textContent = msg;
  el.className = 'aviso ' + tipo + ' visivel';
  clearTimeout(aviso._t);
  aviso._t = setTimeout(() => el.classList.remove('visivel'), 4200);
}

const nomeCurto = (id) => (id || '').replace(/^plr_/, '').slice(0, 12);

/** Nome do jogador a partir do último estado recebido. */
function nomePorId(id) {
  if (!estado) return null;
  for (const t of ['A', 'B']) {
    const p = estado.teams?.[t]?.players?.find((q) => q.playerId === id);
    if (p) return p.name;
  }
  return null;
}
const escapar = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ */
/* Autenticação                                                        */
/* ------------------------------------------------------------------ */

async function autenticar(modo) {
  const nome = $('#authNome').value.trim();
  const senha = $('#authSenha').value;
  if (nome.length < 2 || senha.length < 4) return aviso('Nome com 2+ letras e senha com 4+ caracteres.', 'erro');
  try {
    if (modo === 'registrar') await net.registrar(nome, senha);
    else await net.entrar(nome, senha);
    await depoisDeEntrar();
  } catch (e) { aviso(e.message, 'erro'); }
}

async function depoisDeEntrar() {
  $('#quemSou').textContent = `${net.playerName} · ${net.playerId}`;
  net.conectar();
  net.assinar(['lobby/games', `player/${net.playerId}/turn`]);
  regras = await net.regras();
  if (gameId) await abrirPartida(gameId);
  else { mostrarTela('lobby'); await recarregarLobby(); }
}

/**
 * Avisa como ESTE servidor está configurado — que ele escuta a rede inteira,
 * que os bots de exemplo têm senha no código. É melhor a pessoa saber disso
 * jogando do que descobrir depois.
 */
async function mostrarAvisosDeSeguranca() {
  const caixa = $('#avisoSeguranca');
  try {
    const { avisos } = await net.seguranca();
    if (!avisos?.length) return;
    if (sessionStorage.getItem('avisoSegurancaFechado') === String(avisos.length)) return;

    caixa.innerHTML =
      '<button class="as-fechar" title="fechar">×</button>'
      + avisos.map((a) => `<div class="as-item"><span>⚠</span><span><b>${escapar(a.titulo)}</b> — ${escapar(a.texto)}</span></div>`).join('');
    caixa.style.display = '';
    caixa.querySelector('.as-fechar').onclick = () => {
      caixa.style.display = 'none';
      sessionStorage.setItem('avisoSegurancaFechado', String(avisos.length));
    };
  } catch { /* servidor antigo ou sem a rota: não é motivo para atrapalhar */ }
}

/* ------------------------------------------------------------------ */
/* Lobby                                                               */
/* ------------------------------------------------------------------ */

/**
 * Botões de um cartão do lobby. Cada time só é oferecido se AQUELE time tiver
 * vaga — antes os dois apareciam sempre que houvesse alguma vaga, e clicar no
 * time cheio devolvia um 409 na cara do jogador.
 */
function acoesDaPartida(g) {
  const encerrada = g.status === 'finished';
  const assistir = `<button class="secundario" data-assistir="${g.gameId}">${encerrada ? 'Ver replay' : 'Assistir'}</button>`;

  // Já está na partida: o que falta é voltar para ela, não escolher time.
  if (g.seuTime) {
    return `<button data-assistir="${g.gameId}">Voltar para a partida (time ${g.seuTime})</button>`;
  }
  if (encerrada) return assistir;

  const botaoDoTime = (t) => {
    const time = g.teams[t];
    const nome = escapar(time.name);
    // `vagas` vem do servidor, mas nunca dependa só dele: se o campo faltar
    // (servidor mais antigo), calcular daria `undefined > 0` = falso e TODO
    // time apareceria como cheio.
    const vagas = Number.isFinite(time.vagas)
      ? time.vagas
      : Math.max(0, (time.slots ?? 0) - (time.ocupadas ?? 0));

    if (vagas > 0) {
      const quantas = time.slots > 1 ? ` (${time.ocupadas}/${time.slots})` : '';
      return `<button data-entrar="${g.gameId}" data-time="${t}">Entrar no ${nome}${quantas}</button>`;
    }
    return `<button class="secundario cheio" disabled title="este time já está completo">${nome} · cheio</button>`;
  };

  const vagasA = Number.isFinite(g.teams.A.vagas) ? g.teams.A.vagas : g.teams.A.slots - g.teams.A.ocupadas;
  const vagasB = Number.isFinite(g.teams.B.vagas) ? g.teams.B.vagas : g.teams.B.slots - g.teams.B.ocupadas;
  const chamarIA = (vagasA + vagasB) > 0
    ? '<button class="secundario ia" data-ia="' + g.gameId + '" title="preencher a vaga com a IA embutida">+ IA</button>'
    : '';

  return botaoDoTime('A') + botaoDoTime('B') + chamarIA + assistir;
}

async function recarregarLobby() {
  const { games } = await net.listarPartidas();
  const lista = $('#listaPartidas');
  lista.innerHTML = '';
  if (!games.length) {
    lista.innerHTML = '<p class="vazio">Nenhuma partida ainda. Crie uma aí do lado.</p>';
    return;
  }
  for (const g of games) {
    const div = document.createElement('div');
    div.className = 'cartao-partida';
    div.innerHTML = `
      <div class="cp-topo"><strong>${escapar(g.name)}</strong><span class="tag tag-${g.status}">${g.status}</span></div>
      <div class="cp-placar">
        <span class="time-a">${escapar(g.teams.A.name)}</span><b>${g.score[0]} – ${g.score[1]}</b><span class="time-b">${escapar(g.teams.B.name)}</span>
      </div>
      <div class="cp-info">
        ${g.teams.A.ocupadas}/${g.teams.A.slots} vs ${g.teams.B.ocupadas}/${g.teams.B.slots} jogadores ·
        ${g.config.buttonsPerTeam} botões<br>
        <b>${g.lances ?? 0} lances</b> · turno ${g.turnNo}${g.config.maxTurns > 0 ? '/' + g.config.maxTurns : ' (sem limite)'}${g.fase === 'goleiro' ? ' · posicionando goleiro' : ''}
      </div>
      <div class="cp-acoes">${acoesDaPartida(g)}</div>`;
    lista.appendChild(div);
  }

  lista.onclick = async (ev) => {
    const bE = ev.target.closest('[data-entrar]');
    const bA = ev.target.closest('[data-assistir]');
    try {
      const bIA = ev.target.closest('[data-ia]');
      if (bIA) { await net.chamarIA(bIA.dataset.ia); await recarregarLobby(); return; }
      if (bE) { await net.entrarPartida(bE.dataset.entrar, bE.dataset.time); await abrirPartida(bE.dataset.entrar); }
      else if (bA) await abrirPartida(bA.dataset.assistir);
    } catch (e) { aviso(e.message, 'erro'); }
  };
}

async function criarPartida(ev) {
  ev.preventDefault();
  try {
    const g = await net.criarPartida({
      name: $('#novoNome').value.trim() || 'Partida',
      teamAName: $('#novoTimeA').value.trim() || 'Azuis',
      teamBName: $('#novoTimeB').value.trim() || 'Rubros',
      slotsA: Number($('#novoSlotsA').value),
      slotsB: Number($('#novoSlotsB').value),
      config: {
        buttonsPerTeam: Number($('#novoBotoes').value),
        // 0 significa SEM LIMITE nos três casos.
        maxTurns: $('#novoSemFim').checked ? 0 : Number($('#novoTurnos').value),
        maxPossessions: 0,
        turnTimeoutMs: $('#novoSemRelogio').checked ? 0 : Number($('#novoTempo').value) * 1000,
        tempoGoleiroMs: $('#novoSemRelogio').checked ? 0 : 60000,
        tempoCobrancaMs: $('#novoSemRelogio').checked ? 0 : 60000,
        touchesPerPossession: $('#novoLimiteToques').checked ? Number($('#novoToques').value) : 0,
      },
    });
    // Dá para criar uma partida SEM entrar nela: é assim que se monta uma
    // mesa de IA contra IA e se assiste de fora.
    const como = $('#novoComoEntrar').value;
    if (como === 'A' || como === 'B') await net.entrarPartida(g.gameId, como);
    await abrirPartida(g.gameId);
    if (como === 'assistir') aviso('Partida criada. Preencha os times com IA para ver o jogo.', 'ok');
  } catch (e) { aviso(e.message, 'erro'); }
}

/* ------------------------------------------------------------------ */
/* Partida                                                             */
/* ------------------------------------------------------------------ */

const TOPICOS = (id) => [`game/${id}/state`, `game/${id}/turn`, `game/${id}/event`, `game/${id}/chat`, `game/${id}/lobby`, `game/${id}/aim`, `game/${id}/keeper`, `game/${id}/place`];

async function abrirPartida(id) {
  gameId = id;
  history.replaceState(null, '', `?game=${id}`);
  mostrarTela('jogo');

  if (!cena) {
    cena = new Cena3D($('#tela3d'));
    // A cena é quem sabe o instante de cada contato do lance; entregar o som a
    // ela é o que faz as pancadas tocarem na hora certa.
    cena.som = som;
    // Exposta de propósito: é por aqui que a foto headless (scripts/foto.py)
    // lê triângulos, draw calls e texturas para medir o custo da cena.
    window.__cena = cena;
    cena.aoSelecionar = (bid) => {
      $('#botaoSelecionado').textContent = bid || '—';
      $('#btnChutar').disabled = !bid || !estado?.yourTurn;
      marcarChip(bid);
      travarControles(!bid || !estado?.yourTurn);
      if (bid) {
        apontarNaBola();
        // Câmera na nuca do jogador: atrás da palheta, olhando para a bola.
        cena.visaoDeJogador(bid);
      } else cena?.esconderPalheta();
    };
  }

  net.assinar(TOPICOS(id));
  const st = await net.estado(id);
  // As medidas saem de /api/rules e o estado só refina: se um campo faltar no
  // estado, ele não pode virar `undefined` na cena e ser lido como zero.
  if (regras) cena.configurar({ ...regras.pitch, ...st.pitch }, regras.physics);
  aplicarEstado(st, true);
}

function aplicarEstado(st, imediato = false) {
  if (animando && !imediato) return;
  const eraMinhaVez = estado?.yourTurn === true;
  estado = st;
  if (!emReplay) {
    cena.sincronizar(st.bodies);
    cena.destacar(st.controllable || []);

    // A mesa mudou, então a PREVISÃO da última mira não vale mais: o disco
    // pode ter deixado de alcançar a bola, o caminho pode ter aberto, o botão
    // pode ter sido arrastado. A palheta se ancora sozinha no botão, mas a
    // trajetória prevista só o servidor sabe calcular — então pede de novo.
    // É barato: a mira é limitada a uma a cada 60 ms.
    if (st.podeJogar && cena.selecionado && !cena.arrastando()) agendarAim();

    if (st.yourTurn && st.podeJogar) {
      // Segui com a vez: volta o mesmo botão que acabei de jogar, que é com
      // ele que quase sempre se continua a jogada.
      if (!cena.selecionado && ultimoBotaoJogado && (st.controllable || []).includes(ultimoBotaoJogado)) {
        cena.selecionar(ultimoBotaoJogado);
      }
    } else if (eraMinhaVez && st.status === 'running') {
      // A vez virou para o adversário: abre o plano, senão a IA joga e o
      // jogador fica olhando para a nuca do próprio botão. Suave, porque um
      // salto seco no meio da partida desorienta.
      ultimoBotaoJogado = null;
      if (!animando) cena.camera_preset('tresQuartos', { suave: true });
    }
  }
  desenharHUD(st);
}

function desenharHUD(st) {
  $('#nomeTimeA').textContent = st.teams.A.name;
  $('#nomeTimeB').textContent = st.teams.B.name;
  $('#placarA').textContent = st.scoreA;
  $('#placarB').textContent = st.scoreB;
  cena?.telao({
    a: st.scoreA, b: st.scoreB,
    nomeA: st.teams?.A?.name || 'A', nomeB: st.teams?.B?.name || 'B',
    partida: st.name || '',
    linha: st.status === 'finished'
      ? 'FIM DE JOGO'
      : `LANCE ${st.turnNo || 0}${st.config?.maxTurns ? ' DE ' + st.config.maxTurns : ''}`,
  });
  // Nome da partida em destaque: com várias partidas abertas, é o que diz em
  // qual delas você está.
  const nome = st.name || 'Partida';
  $('#tituloPartida').textContent = nome;
  document.title = `${nome} · ${st.scoreA}–${st.scoreB} · Futebotão`;

  const papel = $('#seuPapel');
  if (st.yourTeam) {
    papel.textContent = `você joga no ${st.teams[st.yourTeam].name}`;
    papel.className = 'papel time-' + st.yourTeam.toLowerCase();
  } else {
    papel.textContent = 'assistindo';
    papel.className = 'papel assistindo';
  }

  const toque = st.touchesPerPossession > 0
    ? `toque ${st.touchIndex + 1}/${st.touchesPerPossession}`
    : `toque ${st.touchIndex + 1}`;
  $('#infoTurno').textContent = st.status === 'running'
    ? (st.fase === 'goleiro'
        ? `Turno ${st.turnNo} · POSICIONANDO O GOLEIRO`
        : `Turno ${st.turnNo} · posse ${st.possession} · ${toque}${st.declarado ? " · CHUTE DECLARADO" : ""}`)
    : st.status === 'lobby' ? 'Aguardando jogadores' : 'Fim de jogo';
  $('#infoRelogio').textContent = st.maxTurns > 0
    ? `${st.lances ?? 0} lances · turno ${st.turnNo}/${st.maxTurns}`
    : `${st.lances ?? 0} lances · turno ${st.turnNo} · sem limite`;

  $('.hud').classList.toggle('posse-a', st.possession === 'A' && st.status === 'running');
  $('.hud').classList.toggle('posse-b', st.possession === 'B' && st.status === 'running');

  const suaVez = !!st.yourTurn;
  $('#painelJogada').classList.toggle('ativo', !!st.podeJogar);
  $('#estadoVez').textContent = st.status !== 'running'
    ? (st.status === 'lobby' ? 'não começou' : 'encerrada')
    : st.podeJogar ? 'É A SUA VEZ'
    : st.fase === 'goleiro' ? 'goleiro sendo posicionado'
    : `vez de ${st.currentPlayer?.name || "—"}`;
  $('#estadoVez').className = 'etiqueta-vez' + (suaVez ? ' destaque' : '');
  $('#seuTime').textContent = st.yourTeam ? `Você joga no time ${st.yourTeam}` : 'Você está assistindo';

  const faltaA = st.teams.A.slots - st.teams.A.players.length;
  const faltaB = st.teams.B.slots - st.teams.B.players.length;
  const completa = faltaA === 0 && faltaB === 0;
  $('#btnIniciar').style.display = st.status === 'lobby' && st.teams.A.players.length && st.teams.B.players.length ? '' : 'none';

  // Faltou gente na mesa: dá para preencher com a IA embutida e já começar.
  const btnIA = $('#btnChamarIA');
  const podeChamarIA = st.status === 'lobby' && !completa;
  btnIA.style.display = podeChamarIA ? '' : 'none';
  if (podeChamarIA) {
    // Prefere o time que NÃO é o seu: o normal é querer um adversário.
    const alvo = faltaB > 0 && st.yourTeam !== 'B' ? 'B'
      : faltaA > 0 && st.yourTeam !== 'A' ? 'A'
      : faltaA > 0 ? 'A' : 'B';
    btnIA.dataset.time = alvo;
    btnIA.textContent = 'Jogar contra a IA fixa (entra no ' + st.teams[alvo].name + ')';
  }

  // Guardar vaga para uma IA de fora — uma LLM, um subagente. Cada time tem a
  // sua: dá para esperar uma no azul, outra no vermelho, ou as duas.
  desenharEsperas(st);
  // De fora da mesa: um clique enche os dois lados de IA e a partida começa.
  const btnDuelo = $('#btnIAvsIA');
  const soAssistindo = !st.yourTeam && st.status === 'lobby';
  const vagasTotais = faltaA + faltaB;
  btnDuelo.style.display = soAssistindo && vagasTotais > 0 ? '' : 'none';
  if (btnDuelo.style.display === '') {
    btnDuelo.textContent = vagasTotais > 1
      ? `Preencher a mesa com IA (${vagasTotais} vagas) e assistir`
      : 'Preencher a última vaga com IA e assistir';
  }

  $('#btnSairPartida').style.display = st.yourTeam ? '' : 'none';
  // Encerrar: quem está na mesa, ou quem criou a partida e está de fora.
  $('#btnEncerrar').style.display =
    st.status === 'running' && (st.yourTeam || st.souDono) ? '' : 'none';
  $('#btnAbrirReplay').style.display = st.turnNo > 0 ? '' : 'none';
  $('#btnChutar').disabled = !suaVez || !cena?.selecionado;

  desenharChips(st);
  travarControles(!st.podeJogar || !cena?.selecionado);

  // Três fases, três painéis: jogar, posicionar o goleiro, ou cobrar.
  const posicionando = !!st.podePosicionarGoleiro;
  const cobrando = !!st.podeCobrar;
  $('#painelGoleiro').style.display = posicionando ? '' : 'none';
  $('#painelCobranca').style.display = cobrando ? '' : 'none';
  // Na saída de bola dá para arrumar E bater: os dois painéis ficam à mão.
  $('#painelJogada').style.display =
    posicionando || emReplay || (cobrando && !st.cobrancaOpcional) ? 'none' : '';
  if (posicionando) prepararGoleiro(st);
  // Remontar o painel no meio de um arrasto tiraria o botão da mão.
  if (cobrando && !cena?.arrastando()) prepararCobranca(st);
  // O arrasto é um só e serve às duas fases: só desliga quando nenhuma delas
  // está ativa, senão a cobrança apagava o arrasto do goleiro logo depois de
  // `prepararGoleiro` tê-lo ligado.
  if (!cobrando) {
    cobranca.botao = null; cobranca.area = null;
    if (!posicionando) cena?.posicionamento(null);
  }

  $('#btnDeclarar').style.display = st.podeDeclarar ? '' : 'none';
  $('#avisoDeclarado').style.display = st.declarado && st.podeJogar ? '' : 'none';
  $('#btnChutar').disabled = !st.podeJogar || !cena?.selecionado;

  $('#listaJogadores').innerHTML = ['A', 'B'].map((t) => `
    <div class="time-bloco time-${t.toLowerCase()}">
      <h4>${escapar(st.teams[t].name)} <span>(${st.teams[t].players.length}/${st.teams[t].slots})</span></h4>
      ${st.teams[t].players.map((p) => `<div class="${p.playerId === st.currentPlayerId ? 'jogador vez' : 'jogador'}">
          <span class="jg-nome">${escapar(p.name)}</span>
          ${p.model ? `<span class="jg-modelo">${escapar(p.model)}</span>` : p.kind === 'ai' ? '<span class="jg-modelo">bot</span>' : ''}
          ${p.playerId === net.playerId ? '<em>(você)</em>' : ''}
        </div>`).join('') || '<div class="jogador vazio">vaga aberta</div>'}
    </div>`).join('');

  atualizarCronometro(st);

  if (st.status === 'finished' && st.result) {
    $('#estadoVez').textContent = st.result.winner ? `time ${st.result.winner} venceu` : 'empate';
  }
}

function desenharChips(st) {
  const alvo = $('#listaBotoes');
  const ids = st.controllable || [];
  // O número no chip é a tecla que escolhe aquele botão.
  alvo.innerHTML = ids.length
    ? ids.map((id, i) => {
        const tecla = i < 9 ? String(i + 1) : i === 9 ? '0' : '';
        return `<button class="chip" data-botao="${id}">${tecla ? `<kbd>${tecla}</kbd>` : ''}${id}</button>`;
      }).join('')
    : '<span class="chips-vazio">—</span>';
  alvo.onclick = (ev) => {
    const b = ev.target.closest('[data-botao]');
    if (b) cena.selecionar(b.dataset.botao);
  };
  marcarChip(cena?.selecionado);
}

const marcarChip = (id) => $$('#listaBotoes .chip').forEach((c) => c.classList.toggle('ativo', c.dataset.botao === id));

/** Sem botão escolhido não há palheta para ajustar. */
function travarControles(travar) {
  $('#painelJogada').classList.toggle('travado', travar);
  for (const c of CONTROLES) { $(c.slider).disabled = travar; $(c.num).disabled = travar; }
  $('#btnMirarBola').disabled = travar;
  $('#btnOtimo').disabled = travar;
  $('#dicaEscolha').style.display = travar ? '' : 'none';
}

function atualizarCronometro(st) {
  clearInterval(cronometro);
  const el = $('#cronometro');
  if (st.status !== 'running') { el.textContent = ''; el.classList.remove('urgente'); return; }
  // Sem prazo: ninguém perde a vez por demorar.
  if (!st.turnDeadline) { el.textContent = 'sem prazo'; el.classList.remove('urgente'); return; }
  const tick = () => {
    const s = Math.max(0, Math.round((st.turnDeadline - Date.now()) / 1000));
    el.textContent = `${s}s`;
    el.classList.toggle('urgente', s <= 15);
    if (s <= 0) clearInterval(cronometro);
  };
  tick();
  cronometro = setInterval(tick, 500);
}

/* ------------------------------------------------------------------ */
/* Controles da palheta                                                */
/* ------------------------------------------------------------------ */

const CONTROLES = [
  { chave: 'anguloAro', slider: '#ctlAngulo', num: '#ctlAnguloNum', val: '#ctlAnguloVal', fmt: (v) => `${Math.round(v)}°` },
  { chave: 'inclinacao', slider: '#ctlInclinacao', num: '#ctlInclinacaoNum', val: '#ctlInclinacaoVal', fmt: (v) => `${Math.round(v)}°` },
  { chave: 'avanco', slider: '#ctlAvanco', num: '#ctlAvancoNum', val: '#ctlAvancoVal', fmt: (v) => v.toFixed(2) },
  { chave: 'forca', slider: '#ctlForca', num: '#ctlForcaNum', val: '#ctlForcaVal', fmt: (v) => v.toFixed(2) },
];

function ligarControles() {
  for (const c of CONTROLES) {
    const sl = $(c.slider), nu = $(c.num);
    const aplicar = (v, origem) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      palheta[c.chave] = n;
      if (origem !== 'slider') sl.value = String(n);
      if (origem !== 'num') nu.value = String(n);
      $(c.val).textContent = c.fmt(n);
      $('#saidaDir').textContent = `${Math.round(((palheta.anguloAro + 180) % 360 + 360) % 360)}°`;
      agendarAim();
    };
    sl.addEventListener('input', () => aplicar(sl.value, 'slider'));
    nu.addEventListener('input', () => aplicar(nu.value, 'num'));
    aplicar(palheta[c.chave], null);
  }
}

function definirPalheta(novo) {
  Object.assign(palheta, novo);
  for (const c of CONTROLES) {
    $(c.slider).value = String(palheta[c.chave]);
    $(c.num).value = String(palheta[c.chave]);
    $(c.val).textContent = c.fmt(palheta[c.chave]);
  }
  $('#saidaDir').textContent = `${Math.round(((palheta.anguloAro + 180) % 360 + 360) % 360)}°`;
  agendarAim();
}

/**
 * Transmite a mira.
 *
 * O envio é *throttle*, não *debounce*: enquanto a pessoa arrasta o slider ou
 * segura a seta, sai uma mira a cada ~60 ms. Com debounce só saía quando ela
 * soltava, e a palheta ficava parada o tempo todo do movimento.
 *
 * A prévia local sai na hora, antes disso: o desenho não espera a rede.
 */
function agendarAim() {
  if (!estado?.yourTurn || !cena?.selecionado || emReplay) return;

  const botao = estado.bodies?.find((b) => b.id === cena.selecionado);
  if (botao) cena.previaPalheta(botao, palheta);

  const agora = performance.now();
  const espera = Math.max(0, 60 - (agora - aimUltimo));
  clearTimeout(aimTimer);
  aimTimer = setTimeout(async () => {
    aimUltimo = performance.now();
    // Se um botão acabou de ser reposicionado, o servidor precisa saber disso
    // antes de resolver a mira — senão ele apoia a palheta no lugar antigo.
    if (cbPendente) { try { await cbPendente; } catch { /* o erro já apareceu */ } }
    if (!cena?.selecionado) return;
    net.mirar(gameId, cena.selecionado, {
      anguloAro: palheta.anguloAro,
      inclinacao: palheta.inclinacao,
      avanco: palheta.avanco,
      forca: palheta.forca,
    });
  }, espera);
}

/** Aponta o apoio de forma que o botão saia na direção da bola. */
function apontarNaBola() {
  if (!estado || !cena?.selecionado) return;
  const bola = estado.bodies.find((b) => b.id === 'ball');
  const bot = estado.bodies.find((b) => b.id === cena.selecionado);
  if (!bola || !bot) return;
  const dir = (Math.atan2(bola.y - bot.y, bola.x - bot.x) * 180) / Math.PI;
  definirPalheta({ anguloAro: Math.round(((dir + 180) % 360 + 360) % 360) });
}

function mostrarDiagnostico(aim) {
  const el = $('#diagnostico');
  if (!aim || aim.limpar) { el.innerHTML = ''; return; }
  const p = aim.previsao || {};
  const classe = aim.escorregou ? 'ruim' : aim.cavada ? 'cavada' : aim.rendimento > 0.85 ? 'bom' : 'medio';
  const linhas = [
    `<div class="dg-linha"><span>rendimento</span><b>${Math.round(aim.rendimento * 100)}%</b></div>`,
    `<div class="dg-linha"><span>velocidade</span><b>${aim.velocidade} cm/s</b></div>`,
    `<div class="dg-linha"><span>o disco corre</span><b>${p.corridaDisco ?? '—'} cm</b></div>`,
  ];
  if (p.alcancaBola && p.bola) {
    linhas.push(`<div class="dg-linha ok"><span>acerta a bola</span><b>ela corre ${p.bola.corrida} cm</b></div>`);
    // O pulo: quanto sobe e onde volta ao chão. É o que decide se a bola passa
    // por cima da caixa do goleiro (5 cm) ou bate nela.
    if (p.bola.voo) {
      const v = p.bola.voo;
      linhas.push(`<div class="dg-linha cavada"><span>ela sobe</span><b>${v.alturaMax} cm no ponto mais alto</b></div>`);
      linhas.push(`<div class="dg-linha"><span>voa</span><b>de ${v.ondeMax} cm até pousar em ${v.pouso ?? "—"} cm</b></div>`);
    }
    linhas.push(`<div class="dg-linha"><span>bola para em</span><b>(${p.bola.parada.x}, ${p.bola.parada.y})</b></div>`);
  } else {
    const quem = p.primeiroContato ? `bate em ${p.primeiroContato.id}` : 'não alcança a bola';
    linhas.push(`<div class="dg-linha alerta"><span>atenção</span><b>${quem}</b></div>`);
  }
  el.innerHTML = `<p class="dg-aviso ${classe}">${escapar(aim.aviso || '')}</p>` + linhas.join('');
}

/** O botão do último lance meu: se a vez continuar, ele volta selecionado. */
let ultimoBotaoJogado = null;

/** Quantas repetições seguidas da mesma tecla — é o que acelera o passo. */
let repeticoes = 0;
let ultimaTecla = null;

async function enviarJogada() {
  if (!estado?.yourTurn) return aviso('Não é a sua vez.', 'erro');
  if (!cena?.selecionado) return aviso('Escolha um botão primeiro.', 'erro');
  try {
    $('#btnChutar').disabled = true;
    ultimoBotaoJogado = cena.selecionado;
    await net.jogar(gameId, {
      buttonId: cena.selecionado,
      palheta: { ...palheta },
      turnToken: estado.turnToken,
    });
  } catch (e) {
    aviso(e.message, 'erro');
    $('#btnChutar').disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Cobrança (lateral, escanteio, tiro de meta)                         */
/* ------------------------------------------------------------------ */

const cobranca = { botao: null, x: 0, y: 0, raio: 18, area: null, botoes: [], opcional: false };

/** Área desta cobrança: círculo central na saída de bola, bola nas demais. */
function areaDaCobranca(st) {
  if (st?.cobranca?.area) return st.cobranca.area;
  const bola = st?.bodies?.find((b) => b.id === 'ball') || { x: 100, y: 60 };
  return { tipo: 'perto da bola', x: bola.x, y: bola.y, raio: st?.cobranca?.raio ?? 18, maxBotoes: 1 };
}
let cbTimer = null, cbEnvio = null;
// O último posicionamento em voo. A mira espera por ele: o servidor calcula o
// apoio da palheta com a posição que ELE conhece do botão.
let cbPendente = null;
let cbUltimo = 0;

const CTL_CB = [
  { chave: 'x', slider: '#cbX', num: '#cbXNum', val: '#cbXVal' },
  { chave: 'y', slider: '#cbY', num: '#cbYNum', val: '#cbYVal' },
];

function ligarControlesCobranca() {
  for (const c of CTL_CB) {
    const sl = $(c.slider), nu = $(c.num);
    const aplicar = (v, origem) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      cobranca[c.chave] = n;
      if (origem !== 'slider') sl.value = String(n);
      if (origem !== 'num') nu.value = String(n);
      $(c.val).textContent = n.toFixed(1);
      const corpo = estado?.bodies?.find((b) => b.id === cobranca.botao);
      if (corpo) { corpo.x = cobranca.x; corpo.y = cobranca.y; }
      // Mesma história do arrasto: o botão andou, a mira tem de acompanhar.
      if (cena?.selecionado === cobranca.botao) {
        cena.previaPalheta({ id: cobranca.botao, x: cobranca.x, y: cobranca.y, r: corpo?.r }, palheta);
        apontarNaBola();
      } else {
        cena?.esconderPalheta();
      }
      mostrarDistanciaCobranca();
      agendarCobranca();
    };
    sl.addEventListener('input', () => aplicar(sl.value, 'slider'));
    nu.addEventListener('input', () => aplicar(nu.value, 'num'));
  }
}

/** O ponto atual cabe na região? Devolve o motivo, ou null se está tudo bem. */
function foraDaRegiao(a, x, y) {
  if (!a) return null;
  if (a.campo) {
    const noCirculo = a.circulo && Math.hypot(x - a.circulo.x, y - a.circulo.y) <= a.circulo.raio;
    if (noCirculo) {
      if (!a.podeNoCirculo) return 'só o time que bate a saída entra no círculo central';
      if (a.usadosNoCirculo > a.maxNoCirculo) return `no máximo ${a.maxNoCirculo} botões no círculo`;
      return null;
    }
    const c = a.campo;
    if (x < c.xMin || x > c.xMax || y < c.yMin || y > c.yMax) return 'cada time monta no seu campo';
    return null;
  }
  const d = Math.hypot(x - a.x, y - a.y);
  return d > a.raio ? `o botão está a ${d.toFixed(1)} cm do centro, e o limite é ${a.raio}` : null;
}

function mostrarDistanciaCobranca() {
  const a = cobranca.area;
  if (!a) return;
  const problema = foraDaRegiao(a, cobranca.x, cobranca.y);
  $('#cbInfo').textContent = problema || (a.campo
    ? `No campo do seu time${a.podeNoCirculo ? ` · ${a.usadosNoCirculo}/${a.maxNoCirculo} no círculo` : ''}.`
    : `A ${Math.hypot(cobranca.x - a.x, cobranca.y - a.y).toFixed(1)} cm do centro, de ${a.raio}.`);
  $('#cbInfo').className = 'mini' + (problema ? ' alerta' : ' ok');
  $('#btnConfirmarCobranca').disabled = !!problema || (!cobranca.botao && !cobranca.opcional);
}

function prepararCobranca(st) {
  const a = areaDaCobranca(st);
  cobranca.area = a;
  cobranca.raio = a.raio;
  cobranca.botoes = st.cobranca?.botoes || [];
  cobranca.opcional = !!st.cobrancaOpcional;

  const formando = !!a.campo;
  $('#cbTitulo').textContent = formando ? 'Montar a mesa' : 'Cobrança';
  $('#cbAviso').textContent = formando
    ? (a.bate
        ? `Saída de bola: arrume seus botões no seu campo, e até ${a.maxNoCirculo} deles dentro do círculo central. Arraste com o mouse ou use as coordenadas — se não quiser mexer, é só bater.`
        : 'O adversário vai bater a saída: arrume seus botões no seu campo, fora do círculo central. Arraste com o mouse ou use as coordenadas.')
    : `Bola fora — ${st.cobranca?.tipo}. Escolha um botão e ponha onde quiser a até ${a.raio} cm da bola (dá para arrastar com o mouse).`;

  // Limites dos controles: a caixa útil da região.
  const lim = (v, min, max) => Math.max(min, Math.min(max, v));
  const caixa = formando
    ? { xMin: a.campo.xMin, xMax: a.campo.xMax, yMin: a.campo.yMin, yMax: a.campo.yMax }
    : { xMin: a.x - a.raio, xMax: a.x + a.raio, yMin: a.y - a.raio, yMax: a.y + a.raio };
  // Quem bate pode alcançar o círculo, que passa da linha do meio.
  if (formando && a.bate) {
    caixa.xMin = Math.min(caixa.xMin, a.circulo.x - a.circulo.raio);
    caixa.xMax = Math.max(caixa.xMax, a.circulo.x + a.circulo.raio);
  }
  // Na cobrança o botão pode passar da linha, então os controles alcançam a
  // faixa de mesa que existe do lado de fora.
  // O botão pode passar da linha na cobrança, então os controles alcançam a
  // faixa de mesa. O raio da área é o piso: sem ele, um servidor que não
  // informe a margem prenderia o jogador na linha.
  const fora = formando ? 0 : (regras?.pitch?.margemFora ?? a.raio ?? 0);
  $('#cbX').min = lim(caixa.xMin, -fora, 200 + fora); $('#cbX').max = lim(caixa.xMax, -fora, 200 + fora);
  $('#cbY').min = lim(caixa.yMin, -fora, 120 + fora); $('#cbY').max = lim(caixa.yMax, -fora, 120 + fora);
  $('#cbXNum').min = $('#cbX').min; $('#cbXNum').max = $('#cbX').max;
  $('#cbYNum').min = $('#cbY').min; $('#cbYNum').max = $('#cbY').max;

  const cheio = !formando && cobranca.botoes.length >= a.maxBotoes;
  $('#cbLista').innerHTML = (st.posicionaveis || [])
    .map((id) => {
      const posto = cobranca.botoes.includes(id);
      // Com a cota cheia, só os já arrumados continuam clicáveis.
      const travado = cheio && !posto ? ' disabled' : '';
      return `<button class="chip${id === cobranca.botao ? ' ativo' : ''}${posto ? ' posto' : ''}" data-cb="${id}"${travado}>${id}</button>`;
    }).join('');
  $('#cbLista').onclick = (ev) => {
    const b = ev.target.closest('[data-cb]');
    if (!b || b.disabled) return;
    escolherBotaoCobranca(b.dataset.cb, st);
  };

  // Arrasto no campo: mexer no botão com o mouse vale igual às coordenadas.
  const arrastaveis = cheio ? cobranca.botoes : (st.posicionaveis || []);
  cena?.posicionamento({
    ids: arrastaveis,
    regiao: a,
    aoArrastar: (id, x, y) => escreverCobranca(id, x, y),
    aoSoltar: (id, x, y) => { escreverCobranca(id, x, y); enviarCobranca(); },
  });

  $('#btnConfirmarCobranca').textContent = formando
    ? (a.bate ? 'Pronto (ou bata direto)' : 'Pronto, terminei')
    : 'Pronto, vou cobrar';

  if (!cobranca.botao && st.posicionaveis?.length) escolherBotaoCobranca(st.posicionaveis[0], st);
  else mostrarDistanciaCobranca();

  clearInterval(cbTimer);
  if (!st.turnDeadline) { $('#cbPrazo').textContent = 'sem prazo'; return; }
  const tick = () => {
    const s = Math.max(0, Math.round((st.turnDeadline - Date.now()) / 1000));
    $('#cbPrazo').textContent = `${s}s`;
    if (s <= 0) clearInterval(cbTimer);
  };
  tick();
  cbTimer = setInterval(tick, 500);
}

/**
 * Escolhe o botão da cobrança. Na lateral ele já vai para trás da bola virado
 * para o gol; na saída de bola fica onde está — a formação já é válida e quem
 * quiser mexer arrasta.
 */
function escolherBotaoCobranca(id, st) {
  const atual = st.bodies.find((b) => b.id === id);
  if (cobranca.opcional || cobranca.area?.campo) {
    escreverCobranca(id, atual?.x ?? cobranca.area.x, atual?.y ?? cobranca.area.y);
    return;                                   // sem envio: nada mudou ainda
  }

  const bola = st.bodies.find((b) => b.id === 'ball');
  const golX = st.yourTeam === 'A' ? 200 : 0;
  const ang = Math.atan2(60 - bola.y, golX - bola.x) + Math.PI;
  escreverCobranca(id,
    Math.round((bola.x + Math.cos(ang) * 4.5) * 10) / 10,
    Math.round((bola.y + Math.sin(ang) * 4.5) * 10) / 10);
  agendarCobranca();
}

/** Põe botão e coordenada nos controles, sem falar com o servidor. */
function escreverCobranca(id, x, y) {
  cobranca.botao = id;
  cobranca.x = x;
  cobranca.y = y;
  // O estado local anda junto com o mouse. Quem calcula a mira a partir dele —
  // a palheta, principalmente — precisa da posição NOVA na mesma hora, senão
  // aponta para onde o botão estava antes do arrasto.
  const corpo = estado?.bodies?.find((b) => b.id === id);
  if (corpo) { corpo.x = x; corpo.y = y; }

  // A palheta está apoiada neste botão? Então ela vem junto — e mira de novo.
  //
  // Re-apontar é o ponto: o ângulo do aro é ABSOLUTO, então o que apontava
  // para a bola no lugar antigo aponta para o vazio no lugar novo. O disco
  // passava longe da bola e a previsão do lance simplesmente sumia.
  if (cena?.selecionado === id) {
    cena.previaPalheta({ id, x, y, r: corpo?.r }, palheta);
    apontarNaBola();
    agendarCobranca();      // o servidor precisa acompanhar para prever certo
  }
  $('#cbBotao').textContent = id;
  $('#cbLista .chip').forEach((c) => c.classList.toggle('ativo', c.dataset.cb === id));
  for (const c of CTL_CB) {
    $(c.slider).value = String(cobranca[c.chave]);
    $(c.num).value = String(cobranca[c.chave]);
    $(c.val).textContent = cobranca[c.chave].toFixed(1);
  }
  mostrarDistanciaCobranca();
}

/** Manda a posição agora, sem esperar o temporizador do arrasto. */
function enviarCobranca() {
  if (!cobranca.botao) return;
  clearTimeout(cbEnvio);
  cbPendente = net.cobrar(gameId, { buttonId: cobranca.botao, x: cobranca.x, y: cobranca.y })
    .then(() => { if (estado?.podeJogar && cena?.selecionado) agendarAim(); })
    .catch((e) => aviso(e.message, 'erro'));
}

/**
 * Manda a posição do botão para o servidor. Throttle, não debounce: num
 * arrasto contínuo o debounce só disparava quando a pessoa parava, e até lá o
 * servidor previa o lance com o botão no lugar antigo.
 */
function agendarCobranca() {
  if (!cobranca.botao) return;
  const espera = Math.max(0, 80 - (performance.now() - cbUltimo));
  clearTimeout(cbEnvio);
  cbEnvio = setTimeout(() => {
    cbUltimo = performance.now();
    cbPendente = net.cobrar(gameId, { buttonId: cobranca.botao, x: cobranca.x, y: cobranca.y })
      .then(() => { if (estado?.podeJogar && cena?.selecionado) agendarAim(); })
      .catch((e) => aviso(e.message, 'erro'));
  }, espera);
}

async function confirmarCobranca() {
  try {
    $('#btnConfirmarCobranca').disabled = true;
    await net.cobrar(gameId, { buttonId: cobranca.botao, x: cobranca.x, y: cobranca.y, confirmar: true });
    cobranca.botao = null;
  } catch (e) {
    aviso(e.message, 'erro');
    $('#btnConfirmarCobranca').disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Goleiro caixa                                                       */
/* ------------------------------------------------------------------ */

const goleiro = { x: 0, y: 0, anguloDeg: 90 };
let gkTimer = null;
let gkPronto = false;
// O texto normal da linha da área, guardado para o aviso de posição bloqueada
// poder devolvê-lo quando o arrasto voltar para um lugar bom.
let gkTextoArea = '';

const CTL_GK = [
  { chave: 'x', slider: '#gkX', num: '#gkXNum', val: '#gkXVal', fmt: (v) => v.toFixed(1) },
  { chave: 'y', slider: '#gkY', num: '#gkYNum', val: '#gkYVal', fmt: (v) => v.toFixed(1) },
  { chave: 'anguloDeg', slider: '#gkAng', num: '#gkAngNum', val: '#gkAngVal', fmt: (v) => Math.round(v) + '°' },
];

function ligarControlesGoleiro() {
  for (const c of CTL_GK) {
    const sl = $(c.slider), nu = $(c.num);
    const aplicar = (v, origem) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      goleiro[c.chave] = n;
      if (origem !== 'slider') sl.value = String(n);
      if (origem !== 'num') nu.value = String(n);
      $(c.val).textContent = c.fmt(n);
      agendarGoleiro();
    };
    sl.addEventListener('input', () => aplicar(sl.value, 'slider'));
    nu.addEventListener('input', () => aplicar(nu.value, 'num'));
  }
}

/**
 * A caixa cabe em (x, y) sem invadir bola, botão ou trave?
 *
 * ESTA CONTA NÃO DECIDE NADA — quem decide é `obstaculoDoGoleiro`, no
 * servidor. Ela existe só para o arrasto avisar na hora: sem isso, passar o
 * mouse por cima de um botão viraria uma sequência de erros vindos do
 * servidor, um a cada 80 ms.
 *
 * É a mesma geometria de `contatoCirculoCaixa`: leva o centro do círculo para
 * as coordenadas da caixa e mede até o retângulo.
 */
function goleiroCabe(x, y, angDeg, st) {
  const k = st.goleiros?.[st.yourTeam];
  if (!k) return { cabe: true };

  const ang = (angDeg * Math.PI) / 180;
  const cos = Math.cos(-ang), sin = Math.sin(-ang);
  const hw = k.w / 2, hh = k.h / 2;

  // As traves não vêm em `bodies`; são montadas a partir das regras.
  const p = regras?.pitch;
  const traves = p ? [
    { id: 'trave', x: 0, y: p.goalMin, r: 1.3 }, { id: 'trave', x: 0, y: p.goalMax, r: 1.3 },
    { id: 'trave', x: p.length, y: p.goalMin, r: 1.3 }, { id: 'trave', x: p.length, y: p.goalMax, r: 1.3 },
  ] : [];

  for (const c of [...(st.bodies || []).filter((b) => b.kind !== 'keeper'), ...traves]) {
    if (!Number.isFinite(c.r)) continue;
    const dx = c.x - x, dy = c.y - y;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    const dentro = Math.abs(lx) <= hw && Math.abs(ly) <= hh;
    const fx = Math.max(Math.abs(lx) - hw, 0);
    const fy = Math.max(Math.abs(ly) - hh, 0);
    if (dentro || Math.hypot(fx, fy) < c.r - 0.05) {
      return { cabe: false, quem: c.id === 'trave' ? 'a trave' : c.kind === 'ball' ? 'a bola' : `o botão ${c.id}` };
    }
  }
  return { cabe: true };
}

/** Ajusta os limites dos controles à área do time e mostra a caixa atual. */
function prepararGoleiro(st) {
  const time = st.yourTeam;
  const area = st.areaGoleiro?.[time];
  const k = st.goleiros?.[time];
  if (!area || !k) return;

  $('#gkX').min = area.xMin; $('#gkX').max = area.xMax;
  $('#gkXNum').min = area.xMin; $('#gkXNum').max = area.xMax;
  $('#gkY').min = area.yMin; $('#gkY').max = area.yMax;
  $('#gkYNum').min = area.yMin; $('#gkYNum').max = area.yMax;
  gkTextoArea = `Área: x de ${area.xMin} a ${area.xMax}, y de ${area.yMin} a ${area.yMax}.`
    + ` A caixa mede ${k.w} x ${k.h} cm. Arraste com o mouse ou use os controles.`;
  $('#gkArea').textContent = gkTextoArea;
  $('#gkArea').classList.remove('erro');

  if (!gkPronto) {
    goleiro.x = k.x; goleiro.y = k.y; goleiro.anguloDeg = k.anguloDeg;
    for (const c of CTL_GK) {
      $(c.slider).value = String(goleiro[c.chave]);
      $(c.num).value = String(goleiro[c.chave]);
      $(c.val).textContent = c.fmt(goleiro[c.chave]);
    }
    gkPronto = true;
  }

  // ARRASTO COM O MOUSE, do mesmo jeito que na cobrança.
  //
  // Os três controles continuam valendo — eles é que dão o ângulo e o ajuste
  // fino —, mas ninguém mira uma caixa por coordenada quando pode arrastá-la.
  // Remontar isto no meio de um arrasto tiraria a caixa da mão, daí a guarda.
  if (!cena?.arrastando()) {
    cena?.posicionamento({
      ids: [k.id],
      // Folga zero: a área do goleiro limita o CENTRO da caixa, e é o servidor
      // que diz onde ela acaba.
      regiao: { campo: area, folga: 0 },
      aoArrastar: (id, x, y) => moverGoleiro(x, y, st),
      aoSoltar: (id, x, y) => moverGoleiro(x, y, st),
    });
  }

  clearInterval(gkTimer);
  if (!st.turnDeadline) { $('#gkPrazo').textContent = 'sem prazo'; return; }
  const tick = () => {
    const s = Math.max(0, Math.round((st.turnDeadline - Date.now()) / 1000));
    $('#gkPrazo').textContent = `${s}s`;
    if (s <= 0) clearInterval(gkTimer);
  };
  tick();
  gkTimer = setInterval(tick, 500);
}

/**
 * Move a caixa pelo arrasto e diz na hora quando o lugar está ocupado.
 *
 * Posição bloqueada NÃO é enviada: o servidor recusaria com 400, e a essa
 * altura o mouse já andou mais dez centímetros. Em vez do erro, a linha da
 * área vira aviso e a última posição boa continua valendo.
 */
function moverGoleiro(x, y, st) {
  const teste = goleiroCabe(x, y, goleiro.anguloDeg, st);
  const linha = $('#gkArea');

  if (!teste.cabe) {
    linha.textContent = `Aí não dá: a caixa fica por cima ${
      teste.quem.startsWith('a ') ? `d${teste.quem.slice(1)}` : `de ${teste.quem}`}.`;
    linha.classList.add('erro');
    return;
  }
  linha.classList.remove('erro');
  linha.textContent = gkTextoArea;

  goleiro.x = x;
  goleiro.y = y;
  for (const c of CTL_GK) {
    if (c.chave === 'anguloDeg') continue;
    $(c.slider).value = String(goleiro[c.chave]);
    $(c.num).value = String(goleiro[c.chave]);
    $(c.val).textContent = c.fmt(goleiro[c.chave]);
  }
  agendarGoleiro();
}

let gkEnvio = null;
function agendarGoleiro() {
  clearTimeout(gkEnvio);
  gkEnvio = setTimeout(() => {
    net.goleiro(gameId, { ...goleiro }).catch((e) => aviso(e.message, 'erro'));
  }, 80);
}

async function confirmarGoleiro() {
  try {
    $('#btnConfirmarGoleiro').disabled = true;
    await net.goleiro(gameId, { ...goleiro, confirmar: true });
    gkPronto = false;
  } catch (e) {
    aviso(e.message, 'erro');
  } finally {
    $('#btnConfirmarGoleiro').disabled = false;
  }
}

async function declararChute() {
  // A vista de agora volta quando o adversário terminar com o goleiro: quem
  // declarou já estava mirando de algum ângulo, e perder esse ângulo é perder
  // metade do trabalho.
  cena?.guardarCamera();
  try {
    await net.declarar(gameId);
    aviso('Chute declarado. O adversário está posicionando o goleiro.');
  } catch (e) { aviso(e.message, 'erro'); }
}

/* ------------------------------------------------------------------ */
/* Replay                                                              */
/* ------------------------------------------------------------------ */

async function abrirReplay() {
  try {
    const dados = await net.replay(gameId);
    if (!dados.total) return aviso('Ainda não há lances para rever.');
    // Se um lance (ou a reprise de um gol) estava rodando, ele para aqui —
    // senão as duas animações disputam a câmera.
    abortarAnimacao();
    emReplay = true;
    $('#painelReplay').style.display = '';
    $('#painelJogada').style.display = 'none';
    cena.esconderPalheta();
    cena.destacar([]);
    cena.carregarReplay(dados);
    cena.replay.aoMudar = pintarReplay;
    montarListaLances(dados.lances);
    pintarReplay(cena.estadoReplay());
  } catch (e) { aviso(e.message, 'erro'); }
}

function fecharReplay() {
  emReplay = false;
  cena.fecharReplay();
  $('#painelReplay').style.display = 'none';
  $('#painelJogada').style.display = '';
  if (estado) aplicarEstado(estado, true);
}

function montarListaLances(lances) {
  $('#rpLista').innerHTML = lances.map((l) => `
    <button class="rp-item ${l.goal ? 'gol' : l.foul ? 'falta' : ''}" data-lance="${l.n}">
      <span class="rp-n">${l.n + 1}</span>
      <span class="rp-time time-${l.team.toLowerCase()}">${l.team}</span>
      <span class="rp-bot">${l.buttonId}</span>
      <span class="rp-out">${escapar(l.outcome)}</span>
      <span class="rp-aj" title="passos de configuração da palheta">${l.ajustes || 0}⚙</span>
      <span class="rp-pl">${l.scoreA}-${l.scoreB}</span>
    </button>`).join('');
  $('#rpLista').onclick = (ev) => {
    const b = ev.target.closest('[data-lance]');
    if (b) cena.irPara(Number(b.dataset.lance), 0);
  };
}

function pintarReplay(e) {
  if (!e) return;
  const l = e.info;
  $('#rpDescricao').innerHTML =
    `<b>Lance ${e.lance + 1}/${e.total}</b> · turno ${l.turnNo} · time ${l.team} · ${l.buttonId}<br>` +
    `<span class="rp-sub">${escapar(l.outcome)} — placar ${l.scoreA}-${l.scoreB}</span>`;

  // A fase diz o que está na tela: ajustando a palheta, batendo, ou o lance rolando.
  const fase = $('#rpFase');
  if (e.tipo === 'ajuste' && e.aim) {
    const p = e.aim.palheta;
    fase.className = 'rp-fase ajuste' + (e.aim.escorregou ? ' ruim' : '') + (e.aim.definitivo ? ' final' : '');
    fase.innerHTML =
      `<span class="rf-tag">configurando ${e.indiceAjuste}/${e.totalAjustes}${e.aim.definitivo ? ' — é esta' : ''}</span>` +
      `<span class="rf-quem">${escapar(e.aim.playerName || '')}</span>` +
      `<div class="rf-nums">` +
        `<span>aro <b>${Math.round(p.anguloAro)}°</b></span>` +
        `<span>incl <b>${Math.round(p.inclinacao)}°</b></span>` +
        `<span>avanço <b>${Number(p.avanco).toFixed(2)}</b></span>` +
        `<span>força <b>${Number(p.forca).toFixed(2)}</b></span>` +
      `</div>` +
      `<div class="rf-aviso">sai a ${Math.round(e.aim.direcao)}° · rendimento ${Math.round((e.aim.rendimento ?? 0) * 100)}% — ${escapar(e.aim.aviso || '')}</div>`;
  } else if (e.tipo === 'golpe') {
    fase.className = 'rp-fase golpe';
    fase.innerHTML = '<span class="rf-tag">apertou a palheta</span>';
  } else {
    fase.className = 'rp-fase lance';
    fase.innerHTML = `<span class="rf-tag">lance rolando — quadro ${e.indiceQuadro}/${e.totalQuadros}</span>`;
  }

  $('#rpPlay').textContent = e.tocando ? '⏸' : '▶';
  const sl = $('#rpQuadro');
  sl.max = String(e.passos - 1);
  sl.value = String(e.passo);
  $('#rpQuadroVal').textContent = `${e.passo + 1}/${e.passos}`;
  $$('#rpLista .rp-item').forEach((it) => it.classList.toggle('atual', Number(it.dataset.lance) === e.lance));
  const atual = $('#rpLista .rp-item.atual');
  if (atual) atual.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------------ */
/* Eventos do broker                                                   */
/* ------------------------------------------------------------------ */

/* Um lance de cada vez na tela. O que chegar durante uma animação espera a
 * vez: dois lances rodando juntos piscavam e travavam a cena. */
let filaLance = null;
let vigiaAnim = 0;


net.addEventListener('estado', (ev) => {
  const p = ev.detail;
  if (p.gameId !== gameId || emReplay) return;

  if (p.trajectory && cena) {
    if (animando) { filaLance = p; return; }
    tocarLance(p);
  } else {
    net.estado(gameId).then((s) => aplicarEstado(s)).catch(() => {});
  }
});

function tocarLance(p) {
  animando = true;
  armarVigia();
  cena.destacar([]);
  const gol = p.lastMove?.goal || null;
  // A força vai junto porque quem toca o estalo agora é a cena: aqui o lance
  // só chegou do broker, e o taco só encosta no botão 190 ms depois.
  // O `lastMove` vai junto pelo mesmo motivo que a força: quem toca o som do
  // DESFECHO agora é a cena. Só ela sabe em que instante da fita a bola cruzou
  // a linha, saiu pelo fundo ou raspou na trave — aqui o lance mal chegou do
  // broker e nada disso aconteceu ainda.
  cena.animar(p.trajectory, () => {
    if (gol && !emReplay) { reprisarGol(p.trajectory, gol); return; }
    terminouAnimacao();
  }, p.lastMove?.palheta?.forca ?? 0.5, p.lastMove || null);
  if (p.lastMove) registrarLance(p.lastMove);
}

/**
 * Fim de animação: solta a trava, mostra o estado de verdade e toca o que
 * ficou na fila. Passa por aqui todo caminho de saída — inclusive os de
 * cancelamento — para a mesa nunca ficar travada.
 */
function terminouAnimacao() {
  if (!animando) return;                       // a trava já foi solta
  const proximo = filaLance;
  abortarAnimacao();
  if (proximo && !emReplay && cena) { tocarLance(proximo); return; }
  if (!gameId) return;
  net.estado(gameId).then((s) => aplicarEstado(s, true)).catch(() => {});
}

/** Solta a trava e limpa a tela, sem tocar nada em seguida. */
function abortarAnimacao() {
  clearTimeout(vigiaAnim);
  filaLance = null;
  animando = false;
  esconderComemoracao();
  $('#selo').classList.remove('visivel');
  cena?.destravar();
}

/** Rede de segurança: nenhuma animação segura a mesa por mais de 30s. */
function armarVigia() {
  clearTimeout(vigiaAnim);
  vigiaAnim = setTimeout(() => {
    if (!animando) return;
    console.warn('animação passou do tempo: destravando a mesa');
    terminouAnimacao();
  }, 30000);
}

net.addEventListener('vez', () => {
  if (!gameId || animando || emReplay) return;
  net.estado(gameId).then((s) => aplicarEstado(s)).catch(() => {});
});

net.addEventListener('mira', (ev) => {
  const aim = ev.detail;
  if (aim.gameId !== gameId || emReplay) return;
  ultimoAim = aim;

  // O servidor devolveu a mira que eu tinha antes de declarar o chute: os
  // controles voltam ao ponto exato de onde eu vi que dava gol.
  if (aim.restaurada && aim.playerId === net.playerId && aim.palheta) {
    if (aim.buttonId && cena?.selecionado !== aim.buttonId) cena?.selecionar(aim.buttonId);
    definirPalheta(aim.palheta);
    // A câmera volta junto com a palheta: o jogador retoma exatamente a vista
    // de onde tinha visto a chance.
    const voltou = cena?.restaurarCamera();
    aviso(voltou
      ? 'Sua palheta e sua vista voltaram como estavam antes de declarar.'
      : 'Palheta restaurada como estava antes de você declarar.', 'ok');
  }

  const faixa = $('#faixaPalheta');
  if (aim.limpar || !aim.palheta) {
    cena?.esconderPalheta();
    faixa.classList.remove('visivel');
    if (!aim.limpar) return;
    mostrarDiagnostico(null);
    return;
  }

  cena?.mostrarPalheta(aim);
  faixa.classList.add('visivel');
  faixa.classList.toggle('ruim', !!aim.escorregou);
  $('#fpNome').textContent = aim.playerName;
  $('#fpDetalhe').textContent =
    `${aim.buttonId} · aro ${Math.round(aim.palheta.anguloAro)}° · incl ${Math.round(aim.palheta.inclinacao)}° · ` +
    `av ${Number(aim.palheta.avanco).toFixed(2)} · força ${Number(aim.palheta.forca).toFixed(2)} → ${aim.aviso}`;

  if (aim.playerId === net.playerId) mostrarDiagnostico(aim);
});

net.addEventListener('cobranca', (ev) => {
  const p = ev.detail;
  if (p.gameId !== gameId || emReplay || !p.botao) return;
  // O botão da cobrança se movendo ao vivo.
  const peca = cena?.pecas.get(p.botao.id);
  if (peca) peca.mesh.position.copy(cena.cena(p.botao.x, p.botao.y, 0));

  const faixa = $('#faixaPalheta');
  if (!p.confirmado && p.playerName) {
    faixa.classList.add('visivel');
    faixa.classList.remove('ruim');
    $('#fpNome').textContent = p.playerName;
    $('#fpDetalhe').textContent = `cobrando ${p.tipo} com ${p.botao.id} em (${p.botao.x}, ${p.botao.y})`;
  } else {
    faixa.classList.remove('visivel');
  }
});

net.addEventListener('goleiro', (ev) => {
  const p = ev.detail;
  if (p.gameId !== gameId || emReplay || !p.goleiro) return;
  // A caixa se mexendo ao vivo, para quem assiste.
  const peca = cena?.pecas.get(p.goleiro.id);
  if (peca) {
    peca.mesh.position.copy(cena.cena(p.goleiro.x, p.goleiro.y, 0));
    peca.mesh.rotation.y = (p.goleiro.anguloDeg * Math.PI) / 180;
  }
  const faixa = $('#faixaPalheta');
  if (!p.confirmado && p.playerName) {
    faixa.classList.add('visivel');
    faixa.classList.remove('ruim');
    $('#fpNome').textContent = p.playerName;
    $('#fpDetalhe').textContent = `posicionando o goleiro ${p.goleiro.id} em (${p.goleiro.x}, ${p.goleiro.y}) a ${p.goleiro.anguloDeg}°`;
  } else if (p.confirmado) {
    faixa.classList.remove('visivel');
  }
});

/* Quanto o apito da falta espera antes de sair.
 *
 * A falta é o único desfecho que o servidor já entregava tipado, e o apito já
 * estava pronto — só ninguém tinha ligado os dois. O atraso existe porque o
 * evento chega ANTES da trajetória: sem ele o juiz apitaria com a palheta
 * ainda no ar. 0,19 s é o tempo do taco descer (ver `golpear` em scene3d.js) e
 * o resto é o botão andando até o adversário — é quando o juiz veria a falta. */
const APITO_DA_FALTA = 0.35;

net.addEventListener('evento', (ev) => {
  const p = ev.detail;
  if (p.gameId !== gameId) return;
  logar(p.texto || p.type, p.type);
  if (p.type === 'goal') comemorar(p);
  if (p.type === 'foul') som.apito(APITO_DA_FALTA);
  if (p.type === 'finish') aviso('Fim de jogo — o replay já está disponível.');
});

net.addEventListener('chat', (ev) => logar(`${nomeCurto(ev.detail.playerId)}: ${ev.detail.texto}`, 'chat'));
net.addEventListener('lobby', (ev) => logar(`${nomeCurto(ev.detail.playerId)} ${ev.detail.tipo} (time ${ev.detail.team})`, 'lobby'));
net.addEventListener('partidas', () => { if ($('[data-tela=lobby]').classList.contains('ativa')) recarregarLobby(); });
net.addEventListener('desconectado', () => { $('#statusConexao').className = 'off'; });
net.addEventListener('conectado', () => { $('#statusConexao').className = 'on'; });

function registrarLance(m) {
  const quem = m.playerId === net.playerId ? 'você' : (nomePorId(m.playerId) || nomeCurto(m.playerId));
  const extra = m.palheta?.cavada ? ' ↑' : m.palheta?.escorregou ? ' ~' : '';
  // Só o desfecho, sem a explicação: ela é longa e joga a linha para fora da
  // tela. O detalhe fica no `title`, para quem quiser passar o mouse.
  const curto = String(m.outcome || '').split(/ — | \(/)[0];
  logar(`${quem} ${m.buttonId}${extra} · ${curto}`, m.goal ? 'goal' : m.foul ? 'foul' : 'move', m.outcome);

  // A declaração vale por um chute só. Quem chutou precisa saber que, para
  // tentar de novo, tem que declarar de novo — e dar ao adversário a chance
  // de rearrumar a caixa do goleiro.
  if (m.declaracaoConsumida && m.playerId === net.playerId) {
    aviso('Chute declarado sem gol: para chutar a gol de novo, declare outra vez.', 'ok');
  }
}

/**
 * Escreve na narração, com hora e do mais NOVO para o mais velho.
 *
 * A ordem invertida não é gosto: com a lista crescendo para baixo, o lance
 * que acabou de acontecer ia parar fora da tela e só aparecia para quem
 * rolasse. O que importa é sempre o último, então ele fica em cima.
 */
function logar(texto, tipo = 'info', completo = null) {
  const el = $('#registro');
  const linha = document.createElement('div');
  linha.className = 'linha ' + tipo;

  const agora = new Date();
  const hora = document.createElement('span');
  hora.className = 'hora';
  hora.textContent = `${String(agora.getHours()).padStart(2, '0')}:`
    + `${String(agora.getMinutes()).padStart(2, '0')}:`
    + `${String(agora.getSeconds()).padStart(2, '0')}`;

  const corpo = document.createElement('span');
  corpo.textContent = texto;
  if (completo && completo !== texto) linha.title = completo;

  linha.append(hora, corpo);
  el.prepend(linha);
  // Some pelo fim, que agora é o passado distante.
  while (el.children.length > 80) el.removeChild(el.lastChild);
  el.scrollTop = 0;
}

function comemorar(p) {
  const el = $('#comemoracao');
  el.innerHTML = p.ownGoal
    ? '<span class="gol-texto">GOL CONTRA!</span>'
    : '<span class="gol-texto">GOOOOOOOOOL!</span>'
      + `<span class="gol-time">${escapar(estado?.teams?.[p.team]?.name || 'time ' + p.team)}</span>`
      + `<span class="gol-placar">${p.scoreA} — ${p.scoreB}</span>`;
  el.className = 'comemoracao visivel time-' + p.team.toLowerCase();
  // O estádio inteiro reage: quem marcou pula mais, e depois vem a ola.
  cena?.festa(p.ownGoal ? (p.team === 'A' ? 'A' : 'B') : p.team);
  // O rugido NÃO sai daqui. Este evento chega antes da trajetória, e a bola só
  // cruza a linha 0,46 s dentro da fita — que por sua vez só começa quando o
  // taco encosta. A torcida gritava ~0,65 s antes do gol. Agora quem toca é
  // `_agendarDesfecho` da cena, no `t` do evento `goal` da fita.
}

function esconderComemoracao() {
  $('#comemoracao').classList.remove('visivel');
}

/**
 * Depois do lance ao vivo, reprisa o gol com a câmera em movimento.
 * O selo REPLAY deixa explícito que não é o jogo acontecendo de novo.
 */
/**
 * Reprisa o gol e PARA no plano de 3/4.
 *
 * A reprise antes voltava a câmera para onde ela estava (podia ser a nuca de
 * um botão), e só então alguém a jogava para o 3/4. Eram três movimentos
 * emendados, e no fim deles o adversário já estava jogando sem que desse para
 * acompanhar. Agora ela pousa no 3/4 e fica parada ali.
 */
function reprisarGol(traj, gol) {
  const selo = $('#selo');
  setTimeout(() => {
    // O jogador pode ter aberto o replay da partida nesse meio tempo.
    if (emReplay || !cena) { terminouAnimacao(); return; }
    esconderComemoracao();
    selo.classList.add('visivel');
    armarVigia();
    cena.replayDoGol(traj, gol.team, () => terminouAnimacao(),
      { cameraFinal: Cena3D.PLANOS.tresQuartos });
  }, 1900);
}

/* ------------------------------------------------------------------ */
/* Aba de depuração: o que o broker publica                            */
/* ------------------------------------------------------------------ */

/**
 * Mostra os tópicos que chegam do servidor, um por linha, o mais novo em
 * cima. Serve para entender o que o jogo publica depois de cada jogada sem
 * abrir o DevTools — é onde se descobre que uma atualização não chegou.
 *
 * `state` e `aim` ficam de fora por padrão: eles chegam às dezenas por
 * segundo enquanto alguém arrasta um slider e afogam o resto.
 */
const RUIDOSOS = /\/(state|aim)$/;
let topicosVistos = 0;

/** Uma frase curta que diga o que aquele tópico trouxe. */
function resumoDoTopico(topic, p) {
  if (!p || typeof p !== 'object') return String(p ?? '');
  if (topic.endsWith('/event')) return p.texto || p.type || '';
  if (topic.endsWith('/turn')) return `vez de ${p.playerName || p.playerId || '?'}`;
  if (topic.endsWith('/state')) {
    return `turno ${p.turnNo ?? '?'} · ${p.scoreA ?? 0}x${p.scoreB ?? 0} · ${p.fase ?? ''}`
      + (p.trajectory ? ` · ${p.trajectory.frames?.length ?? 0} quadros` : '');
  }
  if (topic.endsWith('/aim')) {
    return p.limpar ? 'mira apagada'
      : `${p.buttonId} aro ${Math.round(p.palheta?.anguloAro ?? 0)}° força ${p.palheta?.forca ?? '?'}`;
  }
  if (topic.endsWith('/keeper')) return `goleiro ${p.confirmado ? 'confirmado' : 'movendo'}`;
  if (topic.endsWith('/place')) return `${p.botao?.id ?? '?'} em (${p.botao?.x ?? '?'}, ${p.botao?.y ?? '?'})`;
  if (topic.endsWith('/chat')) return `${p.name || p.playerId}: ${p.texto || ''}`;
  if (topic.endsWith('/lobby')) return `${p.tipo ?? ''} ${p.playerId ?? ''}`;
  const chaves = Object.keys(p).slice(0, 4).join(', ');
  return chaves;
}

function ligarAbaDeTopicos() {
  const lista = $('#tpLista');

  $('#tpLimpar').onclick = () => { lista.innerHTML = ''; topicosVistos = 0; $('#tpConta').textContent = '0'; };

  net.addEventListener('topico', (ev) => {
    const { topic, payload, t } = ev.detail;
    if ($('#tpPausa').checked) return;
    if (RUIDOSOS.test(topic) && !$('#tpRuido').checked) return;

    topicosVistos++;
    $('#tpConta').textContent = String(topicosVistos);

    // Com a aba fechada só contamos: montar DOM que ninguém vê é desperdício.
    if (!$('#abaTopicos').open) return;

    const d = new Date(t);
    const hora = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const curto = topic.replace(/^game\/[^/]+\//, '').replace(/^lobby\//, 'lobby/');

    const item = document.createElement('div');
    item.className = 'tp-item';
    item.innerHTML = `<span class="tp-hora">${hora}</span> `
      + `<span class="tp-nome">${escapar(curto)}</span> `
      + `<span class="tp-resumo">${escapar(resumoDoTopico(topic, payload))}</span>`;

    // Clicar abre o payload cru: é onde se confere se o campo chegou mesmo.
    item.onclick = () => {
      const jaAberto = item.nextElementSibling?.classList.contains('tp-cru');
      if (jaAberto) { item.nextElementSibling.remove(); return; }
      const cru = document.createElement('pre');
      cru.className = 'tp-cru';
      cru.textContent = JSON.stringify(payload, null, 1);
      item.after(cru);
    };

    lista.prepend(item);
    while (lista.children.length > 120) lista.removeChild(lista.lastChild);
  });
}
/* ------------------------------------------------------------------ */
/* Preferências                                                        */
/* ------------------------------------------------------------------ */

/**
 * Guarda o que a pessoa costuma escolher e devolve na próxima visita.
 *
 * Ninguém quer remarcar "sem limite de tempo" e redigitar o nome dos times a
 * cada partida. Vale para o formulário de nova partida, o som da torcida e a
 * velocidade do replay — tudo que é gosto, não estado de jogo.
 *
 * Fica no localStorage porque é preferência DESTE navegador: não faz sentido
 * sincronizar entre máquinas, e some junto com os dados do site se a pessoa
 * limpar tudo, que é o comportamento esperado.
 */
const PREFS = 'fb_prefs';

/** Os controles lembrados, e como ler/escrever cada um. */
const LEMBRADOS = [
  '#novoNome', '#novoTimeA', '#novoTimeB', '#novoSlotsA', '#novoSlotsB',
  '#novoComoEntrar', '#novoBotoes',
  '#novoSemFim', '#novoTurnos',
  '#novoSemRelogio', '#novoTempo',
  '#novoLimiteToques', '#novoToques',
  '#rpVelocidade',
];

function lerPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS)) || {}; } catch { return {}; }
}

function gravarPrefs(mudanca) {
  try {
    localStorage.setItem(PREFS, JSON.stringify({ ...lerPrefs(), ...mudanca }));
  } catch { /* modo privado ou disco cheio: preferência não vale um erro */ }
}

/** Aplica o que estava guardado e passa a guardar cada mudança. */
function ligarPreferencias() {
  const salvo = lerPrefs();

  for (const sel of LEMBRADOS) {
    const el = $(sel);
    if (!el) continue;
    const chave = sel.slice(1);
    const ehCheck = el.type === 'checkbox';

    if (chave in salvo) {
      if (ehCheck) el.checked = !!salvo[chave];
      else el.value = salvo[chave];
    }

    // `change` e não `input`: guardar a cada tecla digitada é ruído.
    el.addEventListener('change', () => {
      gravarPrefs({ [chave]: ehCheck ? el.checked : el.value });
    });
  }

  // Os campos numéricos ligados a um "sem limite" precisam refletir a caixa
  // restaurada, senão voltam habilitados com a caixa marcada.
  for (const cx of ['#novoSemFim', '#novoSemRelogio', '#novoLimiteToques']) {
    $(cx)?.dispatchEvent(new Event('change'));
  }

  // O som é o único que não é um <input>: o estado dele mora no botão.
  if (salvo.som) {
    // Não dá para ligar áudio sem gesto do usuário, então só deixamos o botão
    // avisando que era assim que ele estava — um clique retoma.
    $('#btnSom').textContent = '🔇 Torcida';
    $('#btnSom').title = 'Você costuma jogar com som — clique para ligar';
  }

  // A música tem o mesmo impedimento, e mais um: o volume guardado tem que
  // chegar ao grafo de áudio ANTES de a faixa começar, senão a primeira nota
  // sai no volume de fábrica.
  if (salvo.volMusica != null) $('#volMusica').value = salvo.volMusica;
  som.definirVolumeMusica(Number($('#volMusica').value) / 100);
  $('#volMusica').hidden = true;
  if (salvo.musica) {
    $('#btnMusica').title = 'Você costuma jogar com música — clique para ligar';
  }
}
/* ------------------------------------------------------------------ */
/* Ligações do DOM                                                     */
/* ------------------------------------------------------------------ */

$('#btnRegistrar').onclick = () => autenticar('registrar');
$('#btnEntrar').onclick = () => autenticar('entrar');
$('#formAuth').onsubmit = (e) => { e.preventDefault(); autenticar('entrar'); };
$('#btnSair').onclick = () => { net.sair(); location.href = '/'; };
$('#formNovaPartida').onsubmit = criarPartida;
$('#novoComoEntrar').onchange = (ev) => {
  $('#dicaAssistir').style.display = ev.target.value === 'assistir' ? '' : 'none';
};

// Cada "sem limite" liga/desliga o campo numérico correspondente.
for (const [caixa, campo, invertido] of [
  ['#novoSemFim', '#novoTurnos', true],
  ['#novoSemRelogio', '#novoTempo', true],
  ['#novoLimiteToques', '#novoToques', false],
]) {
  const c = $(caixa), n = $(campo);
  const sincronizar = () => { n.disabled = invertido ? c.checked : !c.checked; };
  c.addEventListener('change', sincronizar);
  sincronizar();
}
$('#btnAtualizarLobby').onclick = recarregarLobby;

$('#btnVoltarLobby').onclick = () => {
  if (emReplay) fecharReplay();
  if (gameId) net.desassinar(TOPICOS(gameId));
  gameId = null;
  document.title = 'Futebotão';
  history.replaceState(null, '', '/');
  mostrarTela('lobby');
  recarregarLobby();
};
$('#btnIniciar').onclick = async () => { try { await net.iniciar(gameId); } catch (e) { aviso(e.message, 'erro'); } };
$('#btnIAvsIA').onclick = async (ev) => {
  const b = ev.currentTarget;
  try {
    b.disabled = true;
    // Uma IA por vaga, uma de cada vez: a última a entrar dispara o começo.
    for (const t of ['A', 'B']) {
      const time = estado?.teams?.[t];
      if (!time) continue;
      let falta = time.slots - time.players.length;
      while (falta-- > 0) await net.chamarIA(gameId, t);
    }
    aviso('Mesa cheia de IA. Sente e assista.', 'ok');
  } catch (e) { aviso(e.message, 'erro'); } finally { b.disabled = false; }
};

/* ------------------------------------------------------------------ */
/* Esperar uma IA de fora (LLM, subagente)                             */
/* ------------------------------------------------------------------ */

/**
 * Os convites que ESTA sessão pediu, por time. O convite é secreto: quem o
 * tem entra na vaga guardada. Quem abriu a partida noutra aba vê que existe
 * uma espera, mas não vê o convite.
 */
const convites = { A: null, B: null };

/** Um botão de espera por time que ainda tem vaga e ninguém esperando. */
function desenharEsperas(st) {
  const alvo = $('#esperaLLM');
  const podePedir = st.status === 'lobby';

  const times = ['A', 'B'].filter((t) => {
    const time = st.teams[t];
    return podePedir && !st.reservas?.[t] && time.slots - time.players.length > 0;
  });

  alvo.innerHTML = times.map((t) =>
    `<button class="secundario" data-espera="${t}">Esperar uma IA (LLM) no ${escapar(st.teams[t].name)}</button>`).join('');
  alvo.onclick = (ev) => {
    const b = ev.target.closest('[data-espera]');
    if (b) pedirEspera(b.dataset.espera, b);
  };

  desenharConvites(st);
}

async function pedirEspera(team, botao) {
  try {
    botao.disabled = true;
    convites[team] = await net.esperarIA(gameId, team);
    if (estado) desenharConvites(estado);
    aviso('Vaga guardada. Entregue o convite à sua IA.', 'ok');
  } catch (e) { aviso(e.message, 'erro'); } finally { botao.disabled = false; }
}

async function cancelarEspera(team) {
  try {
    await net.cancelarEspera(gameId, team);
    convites[team] = null;
    if (estado) desenharConvites(estado);
    aviso('Espera cancelada: a vaga voltou para o lobby.');
  } catch (e) { aviso(e.message, 'erro'); }
}

/** Um bloco por vaga guardada, com o texto e o comando prontos para copiar. */
function desenharConvites(st) {
  const alvo = $('#painelConvite');
  const ativos = ['A', 'B'].filter((t) => st.reservas?.[t]);

  if (!ativos.length) {
    alvo.innerHTML = '';
    return;
  }

  alvo.innerHTML = ativos.map((t) => {
    const c = convites[t];
    const nome = escapar(st.teams[t].name);
    // Sem o convite em mãos (outra aba, outra pessoa) só dá para avisar.
    if (!c) {
      return `<div class="convite">
        <div class="bloco-topo"><h4>Esperando uma IA · <span class="cv-time">${nome}</span></h4></div>
        <p class="mini">Alguém guardou esta vaga para uma IA. O convite está com quem pediu.</p>
      </div>`;
    }
    return `<div class="convite">
      <div class="bloco-topo">
        <h4>Esperando uma IA · <span class="cv-time">${nome}</span></h4>
        <button class="pequeno secundario" data-cancelar="${t}">Cancelar</button>
      </div>
      <p class="mini">A vaga está guardada. Entregue isto à sua LLM ou subagente — quem tiver o convite entra, mais ninguém.</p>
      <label class="mini">Cole num agente</label>
      <textarea class="convite-texto" rows="8" readonly data-prompt="${t}">${escapar(c.prompt)}</textarea>
      <button class="pequeno" data-copiar="prompt" data-time="${t}">Copiar o texto</button>
      <label class="mini">Ou rode o bot do repositório</label>
      <input class="convite-texto" readonly data-comando="${t}" value="${escapar(c.comando)}">
      <button class="pequeno" data-copiar="comando" data-time="${t}">Copiar o comando</button>
    </div>`;
  }).join('');

  alvo.onclick = (ev) => {
    const cancelar = ev.target.closest('[data-cancelar]');
    if (cancelar) return cancelarEspera(cancelar.dataset.cancelar);
    const copiar = ev.target.closest('[data-copiar]');
    if (!copiar) return;
    const t = copiar.dataset.time;
    const campo = copiar.dataset.copiar === 'prompt'
      ? alvo.querySelector(`[data-prompt="${t}"]`)
      : alvo.querySelector(`[data-comando="${t}"]`);
    if (campo) copiarTexto(campo.value, copiar);
  };
}

async function copiarTexto(texto, botao) {
  try {
    await navigator.clipboard.writeText(texto);
    const antes = botao.textContent;
    botao.textContent = 'Copiado';
    setTimeout(() => { botao.textContent = antes; }, 1400);
  } catch { aviso('O navegador não deixou copiar. Selecione e copie à mão.', 'erro'); }
}
$('#btnChamarIA').onclick = async (ev) => {
  const b = ev.currentTarget;
  try {
    b.disabled = true;
    await net.chamarIA(gameId, b.dataset.time);
    aviso('IA na mesa. Boa sorte.');
  } catch (e) { aviso(e.message, 'erro'); } finally { b.disabled = false; }
};
$('#btnEncerrar').onclick = async () => {
  const nome = estado?.name || 'esta partida';
  if (!confirm(`Encerrar ${nome} agora? O placar fica como está e ninguém joga mais nela.`)) return;
  try {
    const r = await net.encerrar(gameId);
    const v = r.result?.winner;
    aviso(v ? `Partida encerrada. Vitória do time ${v}.` : 'Partida encerrada.', 'ok');
  } catch (e) { aviso(e.message, 'erro'); }
};
$('#btnSairPartida').onclick = async () => { try { await net.sairPartida(gameId); aviso('Você saiu da partida.'); } catch (e) { aviso(e.message, 'erro'); } };
$('#btnChutar').onclick = enviarJogada;
$('#btnMirarBola').onclick = apontarNaBola;
$('#btnOtimo').onclick = () => definirPalheta({ inclinacao: 45, avanco: 0.35 });
$$('[data-camera]').forEach((b) => { b.onclick = () => cena?.camera_preset(b.dataset.camera); });
$('#formChat').onsubmit = (e) => {
  e.preventDefault();
  const t = $('#chatTexto').value.trim();
  if (t && gameId) { net.mandarChat(gameId, t); $('#chatTexto').value = ''; }
};

$('#btnDeclarar').onclick = declararChute;
$('#btnConfirmarGoleiro').onclick = confirmarGoleiro;
$('#btnConfirmarCobranca').onclick = confirmarCobranca;
ligarControlesGoleiro();
ligarControlesCobranca();

$('#btnSom').onclick = async () => {
  const ligado = som.ligado ? (som.desligar(), false) : await som.ligar();
  $('#btnSom').textContent = ligado ? '🔊 Torcida' : '🔇 Torcida';
  $('#btnSom').classList.toggle('ativo', ligado);
  gravarPrefs({ som: ligado });
  if (ligado) som.apito(0.1);
};

/* ---------------- música de fundo ---------------- */

/** Deixa botão e régua de acordo com o que está tocando. */
function pintarMusica(tocando, faltou = false) {
  const b = $('#btnMusica');
  b.textContent = tocando ? '🎵 Música' : '🔇 Música';
  b.classList.toggle('ativo', tocando);
  $('#volMusica').hidden = !tocando;
  if (faltou) {
    // O arquivo é do jogador, não do repositório: se ele não colocou nada em
    // public/audio/, o botão tem que dizer isso em vez de não fazer nada.
    b.title = 'Nenhuma faixa em public/audio/maracana.mp3';
    aviso('Coloque a música em public/audio/maracana.mp3', 'erro');
  }
}

$('#btnMusica').onclick = async () => {
  if (som.tocando) {
    som.pararMusica();
    gravarPrefs({ musica: false });
    return pintarMusica(false);
  }
  const ok = await som.musica();
  gravarPrefs({ musica: ok });
  pintarMusica(ok, !ok);
};

$('#volMusica').oninput = (e) => {
  const v = Number(e.target.value) / 100;
  som.definirVolumeMusica(v);
  gravarPrefs({ volMusica: e.target.value });
};

$('#btnAbrirReplay').onclick = abrirReplay;
$('#btnFecharReplay').onclick = fecharReplay;
$('#rpPlay').onclick = () => (cena.replay?.tocando ? cena.pausarReplay() : cena.tocarReplay());
$('#rpQuadroAnt').onclick = () => cena.passoQuadro(-1);
$('#rpQuadroProx').onclick = () => cena.passoQuadro(1);
$('#rpPrimeiro').onclick = () => cena.primeiroLance();
$('#rpUltimo').onclick = () => cena.ultimoLance();
$('#rpLanceAnt').onclick = () => cena.passoLance(-1);
$('#rpLanceProx').onclick = () => cena.passoLance(1);
$('#rpQuadro').oninput = (e) => { cena.pausarReplay(); cena.irPara(cena.replay.lance, Number(e.target.value)); };
$('#rpVelocidade').onchange = (e) => { if (cena.replay) cena.replay.velocidade = Number(e.target.value); };

/**
 * Teclado da mesa: com o foco fora de qualquer controle, as setas (ou WASD)
 * mexem na palheta, os números escolhem o botão e o espaço aperta. Assim dá
 * para mirar sem tirar a mão do teclado.
 */
addEventListener('keydown', (ev) => {
  if (emReplay) return;                       // o replay tem os atalhos dele
  // Se o foco está num controle, quem manda é o controle.
  if (focoEmControle(ev.target)) return;
  if (!estado?.podeJogar) return;

  if (ev.key === ' ') {
    ev.preventDefault();
    if (cena?.selecionado) enviarJogada();
    else aviso('Escolha um botão antes de apertar a palheta.', 'erro');
    return;
  }
  // Números escolhem o botão: 1 é o primeiro jogador, 2 o segundo, 0 o décimo.
  const nBotao = atalhoBotao(ev.key, { ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey });
  if (nBotao !== null) {
    const ids = estado?.controllable || [];
    if (ids[nBotao]) { ev.preventDefault(); cena?.selecionar(ids[nBotao]); }
    return;
  }
  if (!cena?.selecionado) return;

  // Ctrl não é nosso: Ctrl+W fecha a aba e não dá para impedir. Se alguém
  // apertar, o atalho passa direto para o navegador.
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

  // Tecla segurada acelera. `ev.repeat` já vem do navegador; contamos quantas
  // repetições seguidas para o passo ir crescendo.
  repeticoes = ev.repeat && ev.key === ultimaTecla ? repeticoes + 1 : 0;
  ultimaTecla = ev.key;

  const mudanca = atalhoPalheta(ev.key, { shift: ev.shiftKey, repeticao: repeticoes }, palheta);
  if (!mudanca) return;
  ev.preventDefault();
  definirPalheta(mudanca);
});

// Soltou a tecla, o contador de aceleração zera.
addEventListener('keyup', () => { repeticoes = 0; ultimaTecla = null; });

// Atalhos de teclado no replay.
addEventListener('keydown', (ev) => {
  if (!emReplay || ev.target.tagName === 'INPUT') return;
  if (ev.key === ' ') { ev.preventDefault(); cena.replay?.tocando ? cena.pausarReplay() : cena.tocarReplay(); }
  else if (ev.key === 'ArrowRight') cena.passoQuadro(ev.shiftKey ? 5 : 1);
  else if (ev.key === 'ArrowLeft') cena.passoQuadro(ev.shiftKey ? -5 : -1);
  else if (ev.key === 'ArrowDown') cena.passoLance(1);
  else if (ev.key === 'ArrowUp') cena.passoLance(-1);
  else if (ev.key === 'Home') { ev.preventDefault(); cena.primeiroLance(); }
  else if (ev.key === 'End') { ev.preventDefault(); cena.ultimoLance(); }
});

ligarControles();

ligarPreferencias();
ligarAbaDeTopicos();

// Antes de qualquer login: quem abre a página já vê como o servidor está posto.
mostrarAvisosDeSeguranca();

/* ------------------------------------------------------------------ */

if (net.token) net.me().then(depoisDeEntrar).catch(() => { net.sair(); mostrarTela('auth'); });
else mostrarTela('auth');
