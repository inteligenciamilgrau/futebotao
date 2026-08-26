// Atalhos de teclado da palheta. `atalhoPalheta` é pura, então testa sem DOM.
import { atalhoPalheta, atalhoBotao, focoEmControle, multiplicador, PASSOS } from '../public/js/teclado.js';

let fails=0;
const ok=(n,c,i='')=>{console.log((c?'PASS ':'FAIL ')+n+(i?'  -> '+i:''));if(!c)fails++;};
const secao=(t)=>console.log('\n== '+t+' ==');
const P = () => ({ anguloAro: 180, inclinacao: 45, avanco: 0.35, forca: 0.6 });

secao('Setas: ângulo e inclinação');
{
  // A seta aponta para onde a MIRA vira, e o apoio da palheta fica do lado
  // oposto (`direção = anguloAro + 180`). Por isso a esquerda SOMA no ângulo:
  // é o que faz o botão sair para a esquerda de quem está olhando.
  ok('esquerda vira a mira para a esquerda', atalhoPalheta('ArrowLeft', {}, P()).anguloAro === 181);
  ok('direita vira a mira para a direita', atalhoPalheta('ArrowRight', {}, P()).anguloAro === 179);
  ok('cima aumenta a inclinação', atalhoPalheta('ArrowUp', {}, P()).inclinacao === 46);
  ok('baixo diminui a inclinação', atalhoPalheta('ArrowDown', {}, P()).inclinacao === 44);
  ok('setas não mexem em avanço nem força',
     !('avanco' in atalhoPalheta('ArrowLeft', {}, P())) && !('forca' in atalhoPalheta('ArrowUp', {}, P())));
}

secao('Shift + direção: avanço e força');
{
  const sh = { shift: true };
  ok('shift+esquerda diminui o avanço', atalhoPalheta('ArrowLeft', sh, P()).avanco === 0.34);
  ok('shift+direita aumenta o avanço', atalhoPalheta('ArrowRight', sh, P()).avanco === 0.36);
  ok('shift+cima aumenta a força', atalhoPalheta('ArrowUp', sh, P()).forca === 0.61);
  ok('shift+baixo diminui a força', atalhoPalheta('ArrowDown', sh, P()).forca === 0.59);
  ok('shift não mexe no ângulo', !('anguloAro' in atalhoPalheta('ArrowLeft', sh, P())));

  // Com letra o `event.key` já chega maiúsculo — tem que valer igual.
  ok('shift+A é o mesmo que shift+esquerda', atalhoPalheta('A', sh, P()).avanco === 0.34);
  ok('shift+D aumenta o avanço', atalhoPalheta('D', sh, P()).avanco === 0.36);
  ok('shift+W aumenta a força', atalhoPalheta('W', sh, P()).forca === 0.61);
  ok('shift+S diminui a força', atalhoPalheta('S', sh, P()).forca === 0.59);
}

secao('WASD faz o mesmo que as setas');
{
  ok('A é seta esquerda', atalhoPalheta('a', {}, P()).anguloAro === atalhoPalheta('ArrowLeft', {}, P()).anguloAro);
  ok('D é seta direita', atalhoPalheta('d', {}, P()).anguloAro === atalhoPalheta('ArrowRight', {}, P()).anguloAro);
  ok('W é seta para cima', atalhoPalheta('w', {}, P()).inclinacao === atalhoPalheta('ArrowUp', {}, P()).inclinacao);
  ok('S é seta para baixo', atalhoPalheta('s', {}, P()).inclinacao === atalhoPalheta('ArrowDown', {}, P()).inclinacao);
}

secao('Q/E e F/R ajustam avanço e força, sem modificador');
{
  ok('E aumenta o avanço', atalhoPalheta('e', {}, P()).avanco === 0.36);
  ok('Q diminui o avanço', atalhoPalheta('q', {}, P()).avanco === 0.34);
  ok('R aumenta a força', atalhoPalheta('r', {}, P()).forca === 0.61);
  ok('F diminui a força', atalhoPalheta('f', {}, P()).forca === 0.59);
  ok('maiúsculas valem igual', atalhoPalheta('E', {}, P()).avanco === 0.36);
  ok('E não mexe no ângulo', !('anguloAro' in atalhoPalheta('e', {}, P())));
  ok('Q respeita o limite', atalhoPalheta('q', {}, { ...P(), avanco: 0 }).avanco === 0);
  ok('F respeita o limite', atalhoPalheta('f', {}, { ...P(), forca: 0.05 }).forca === 0.05);
}

secao('Segurar a tecla acelera o passo');
{
  ok('toque avulso anda 1', multiplicador(0) === 1);
  ok('ainda anda 1 nas primeiras repetições', multiplicador(PASSOS.repeticoesPorDegrau - 1) === 1);
  ok('depois de um degrau anda o dobro', multiplicador(PASSOS.repeticoesPorDegrau) === 2);
  ok('e vai subindo', multiplicador(PASSOS.repeticoesPorDegrau * 3) === 4);
  ok('mas tem teto', multiplicador(10000) === PASSOS.multiplicadorMax);

  ok('o ângulo anda mais com a tecla segurada',
     atalhoPalheta('ArrowRight', { repeticao: 40 }, P()).anguloAro === 175,
     String(atalhoPalheta('ArrowRight', { repeticao: 40 }, P()).anguloAro));
  ok('o avanço também',
     atalhoPalheta('ArrowRight', { shift: true, repeticao: 40 }, P()).avanco === 0.4,
     String(atalhoPalheta('ArrowRight', { shift: true, repeticao: 40 }, P()).avanco));
}

secao('O ângulo dá a volta, os outros batem no limite');
{
  ok('359 + 1 = 0', atalhoPalheta('ArrowLeft', {}, { ...P(), anguloAro: 359 }).anguloAro === 0);
  ok('0 - 1 = 359', atalhoPalheta('ArrowRight', {}, { ...P(), anguloAro: 0 }).anguloAro === 359);
  ok('inclinação para em 80', atalhoPalheta('ArrowUp', {}, { ...P(), inclinacao: 80 }).inclinacao === 80);
  ok('inclinação para em 10', atalhoPalheta('ArrowDown', {}, { ...P(), inclinacao: 10 }).inclinacao === 10);
  ok('avanço para em 1', atalhoPalheta('ArrowRight', { shift: true }, { ...P(), avanco: 1 }).avanco === 1);
  ok('avanço para em 0', atalhoPalheta('ArrowLeft', { shift: true }, { ...P(), avanco: 0 }).avanco === 0);
  ok('força para em 1', atalhoPalheta('ArrowUp', { shift: true }, { ...P(), forca: 1 }).forca === 1);
  ok('força para em 0.05', atalhoPalheta('ArrowDown', { shift: true }, { ...P(), forca: 0.05 }).forca === 0.05);
}

secao('Sem erro de ponto flutuante');
{
  let p = P();
  for (let i = 0; i < 30; i++) p = { ...p, ...atalhoPalheta('ArrowRight', { shift: true }, p) };
  ok('30 passos de 0.01 dão exatamente 0.65', p.avanco === 0.65, String(p.avanco));
  let q = P();
  for (let i = 0; i < 17; i++) q = { ...q, ...atalhoPalheta('ArrowDown', { shift: true }, q) };
  ok('17 passos para baixo dão exatamente 0.43', q.forca === 0.43, String(q.forca));
}

secao('Números escolhem o botão');
{
  ok('1 é o primeiro', atalhoBotao('1', {}) === 0);
  ok('2 é o segundo', atalhoBotao('2', {}) === 1);
  ok('9 é o nono', atalhoBotao('9', {}) === 8);
  ok('0 é o décimo', atalhoBotao('0', {}) === 9);
  ok('letra não é número', atalhoBotao('a', {}) === null);
  ok('seta não é número', atalhoBotao('ArrowLeft', {}) === null);
  ok('ctrl+1 é do navegador, não nosso', atalhoBotao('1', { ctrl: true }) === null);
  ok('alt+1 também', atalhoBotao('1', { alt: true }) === null);
  ok('nada quebra com entrada esquisita', atalhoBotao(undefined, {}) === null && atalhoBotao('12', {}) === null);
}

secao('Teclas que não são nossas');
{
  for (const t of ['z', 'Enter', 'Escape', ' ', 'Tab', 'ArrowUpLeft']) {
    ok(`"${t}" é ignorada`, atalhoPalheta(t, {}, P()) === null);
  }
  ok('shift numa tecla estranha também é ignorada', atalhoPalheta('z', { shift: true }, P()) === null);
}

secao('Foco em controle desliga os atalhos');
{
  for (const t of ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']) {
    ok(`foco em ${t} bloqueia o atalho`, focoEmControle({ tagName: t }) === true);
  }
  for (const t of ['CANVAS', 'BODY', 'DIV']) {
    ok(`foco em ${t} libera o atalho`, focoEmControle({ tagName: t }) === false);
  }
  ok('alvo nulo libera', focoEmControle(null) === false);
}

console.log(fails===0?'\nTUDO OK':`\n${fails} FALHA(S)`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
