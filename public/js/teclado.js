// Atalhos de teclado da palheta.
//
// Fica num módulo próprio, sem dependência nenhuma, por dois motivos: é lógica
// pura (entra tecla, sai a mudança) e assim dá para testá-la sem navegador —
// o app.js importa three.js, que só resolve dentro do browser.
//
// CTRL NÃO É USADO AQUI, de propósito. Ctrl+W fecha a aba, Ctrl+A seleciona a
// página, Ctrl+S salva — e `preventDefault` não segura nenhum dos três. Shift
// com letra é só a maiúscula, então o modificador é ele.

const limitar = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const arred = (v, casas) => Math.round(v * 10 ** casas) / 10 ** casas;

/** Passos de cada controle, no toque avulso. */
export const PASSOS = {
  angulo: 1,
  inclinacao: 1,
  avanco: 0.01,
  forca: 0.01,
  // Segurar a tecla acelera: a cada `repeticoesPorDegrau` repetições o passo
  // sobe um degrau, até `multiplicadorMax`. É o que fazia o Shift, sem gastar
  // um modificador com isso.
  repeticoesPorDegrau: 4,
  multiplicadorMax: 5,
};

/** De quanto anda cada toque, contando a aceleração de tecla segurada. */
export function multiplicador(repeticao = 0) {
  const degraus = Math.floor(Math.max(0, repeticao) / PASSOS.repeticoesPorDegrau);
  return Math.min(PASSOS.multiplicadorMax, 1 + degraus);
}

/**
 * WASD faz o mesmo que as setas — a mão esquerda no teclado, a direita no
 * mouse girando a câmera. Qualquer outra tecla passa batido.
 */
function comoSeta(tecla) {
  switch (tecla) {
    case 'w': case 'W': return 'ArrowUp';
    case 's': case 'S': return 'ArrowDown';
    case 'a': case 'A': return 'ArrowLeft';
    case 'd': case 'D': return 'ArrowRight';
    default: return tecla;
  }
}

/** Avanço e força também nas letras à volta do WASD, sem modificador nenhum. */
function letraDeAjuste(tecla) {
  switch (tecla) {
    case 'q': case 'Q': return { campo: 'avanco', sinal: -1 };
    case 'e': case 'E': return { campo: 'avanco', sinal: +1 };
    case 'f': case 'F': return { campo: 'forca', sinal: -1 };
    case 'r': case 'R': return { campo: 'forca', sinal: +1 };
    default: return null;
  }
}

/**
 * Traduz uma tecla na mudança que ela faz na palheta.
 *
 *   setas / WASD           -> ângulo no aro (←/→, A/D) e inclinação (↑/↓, W/S)
 *   shift + setas/WASD     -> avanço (←/→, A/D) e força (↑/↓, W/S)
 *   Q/E e F/R              -> avanço e força, sem tirar a mão do WASD
 *   segurar a tecla        -> o passo acelera
 *
 * @param {string} tecla   `event.key`
 * @param {{shift?:boolean, repeticao?:number}} mods
 * @param {{anguloAro:number, inclinacao:number, avanco:number, forca:number}} p
 * @returns {object|null} o que mudar, ou null se a tecla não é nossa
 */
export function atalhoPalheta(tecla, { shift = false, repeticao = 0 } = {}, p) {
  const k = multiplicador(repeticao);
  const passo = PASSOS.angulo * k;
  const fino = arred(PASSOS.avanco * k, 4);

  const ajustar = (campo, sinal) => (campo === 'avanco'
    ? { avanco: arred(limitar(p.avanco + sinal * fino, 0, 1), 2) }
    : { forca: arred(limitar(p.forca + sinal * fino, 0.05, 1), 2) });

  // As letras dedicadas valem em qualquer caso: Q/E/F/R não colidem com nada.
  const letra = letraDeAjuste(tecla);
  if (letra) return ajustar(letra.campo, letra.sinal);

  const t = comoSeta(tecla);

  if (shift) {
    switch (t) {
      case 'ArrowLeft': return ajustar('avanco', -1);
      case 'ArrowRight': return ajustar('avanco', +1);
      case 'ArrowUp': return ajustar('forca', +1);
      case 'ArrowDown': return ajustar('forca', -1);
      default: return null;
    }
  }

  switch (t) {
    // ESQUERDA SOMA E DIREITA SUBTRAI, e isso é de propósito.
    //
    // `anguloAro` é onde a PALHETA se apoia na borda, e o botão sai para o
    // lado oposto: a direção do chute é `anguloAro + 180`. Somando o ângulo, a
    // palheta anda no sentido anti-horário e o botão vira junto — ou seja, a
    // seta da direita mandava o botão para a esquerda.
    //
    // Quem joga não pensa na palheta, pensa em para onde quer mandar o botão.
    // Aqui a seta aponta o lado para o qual a MIRA vira, e o apoio da palheta
    // vai atrás. O ângulo dá a volta: 359 + 1 = 0, é circular, não tem parede.
    case 'ArrowLeft': return { anguloAro: (arred(p.anguloAro, 0) + passo) % 360 };
    case 'ArrowRight': return { anguloAro: (arred(p.anguloAro, 0) - passo + 360) % 360 };
    case 'ArrowUp': return { inclinacao: arred(limitar(p.inclinacao + passo, 10, 80), 0) };
    case 'ArrowDown': return { inclinacao: arred(limitar(p.inclinacao - passo, 10, 80), 0) };
    default: return null;
  }
}

/**
 * Número da tecla -> qual botão pegar. 1 é o primeiro jogador, 2 o segundo…
 * e 0 é o décimo, que é onde o teclado acaba.
 *
 * @returns {number|null} índice a partir de 0, ou null se não for número
 */
export function atalhoBotao(tecla, { ctrl = false, alt = false, meta = false } = {}) {
  // Ctrl+1 / Alt+1 são do navegador (trocar de aba): não roubamos.
  if (ctrl || alt || meta) return null;
  if (typeof tecla !== 'string' || tecla.length !== 1) return null;
  if (tecla < '0' || tecla > '9') return null;
  return tecla === '0' ? 9 : Number(tecla) - 1;
}

/** O foco está num controle? Aí quem manda é o controle, não o atalho. */
export function focoEmControle(alvo) {
  const t = alvo?.tagName;
  return t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || t === 'BUTTON';
}
