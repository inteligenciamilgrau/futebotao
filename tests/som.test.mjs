// As duas decisões do som de impacto que dá para conferir SEM ouvido: quanta
// força cada velocidade vira, e quantas pancadas de uma carambola realmente
// tocam. O resto (timbre, envelope, brilho) se mede com `scripts/ouvir.py`.
import { ganhoDeImpacto, ganhoDePalheta, timbreDoPar, impactosAudiveis, travesAudiveis } from '../public/js/torcida-som.js';

let fails=0;
const ok=(n,c,i='')=>{console.log((c?'PASS ':'FAIL ')+n+(i?'  -> '+i:''));if(!c)fails++;};

// 1) Intensidade: cresce sempre, e só dentro da faixa que o servidor manda
{
  let cresce = true, onde = '';
  for (let v = 12; v < 137; v += 0.5) {
    if (!(ganhoDeImpacto(v + 0.5) > ganhoDeImpacto(v))) { cresce = false; onde = `em ${v}`; break; }
  }
  ok('mais rápido é sempre mais forte, de 12 a 137', cresce, onde);

  // Fora da faixa o ganho grampeia: uma pancada não fica infinitamente mais
  // alta só porque a simulação passou do que já se mediu.
  ok('grampeia embaixo', ganhoDeImpacto(0) === ganhoDeImpacto(12), ganhoDeImpacto(0));
  ok('grampeia em cima', ganhoDeImpacto(500) === ganhoDeImpacto(137), ganhoDeImpacto(500));
  ok('velocidade sem sentido cai no piso', ganhoDeImpacto(NaN) === ganhoDeImpacto(12));

  // A faixa toda tem que caber num jogo só: menos de 3x ninguém distingue o
  // toque de leve da paulada, mais de 8x a paulada vira outro jogo.
  const faixa = ganhoDeImpacto(137) / ganhoDeImpacto(12);
  ok('a paulada é de 3x a 8x o toque de leve', faixa > 3 && faixa < 8, faixa.toFixed(2) + 'x');
}

// 1b) O estalo da palheta: o nível subiu, a razão entre leve e paulada ficou
{
  let cresce = true, onde = '';
  for (let f = 0.05; f < 1; f += 0.01) {
    if (!(ganhoDePalheta(f + 0.01) > ganhoDePalheta(f))) { cresce = false; onde = `em ${f.toFixed(2)}`; break; }
  }
  ok('bater mais forte estala mais alto, de 0,05 a 1,00', cresce, onde);

  // O nível do estalo já foi multiplicado por 2,3 para ele parar de sumir
  // debaixo da torcida. Esta razão é o que sobreviveu à subida, e tem que
  // sobreviver à próxima: menos de 2,2x e o toque de leve soa igual à paulada.
  const razao = ganhoDePalheta(1.00) / ganhoDePalheta(0.05);
  ok('a paulada estala de 2,2x a 3,2x o toque de leve',
     razao > 2.2 && razao < 3.2, razao.toFixed(2) + 'x');

  ok('grampeia nas duas pontas',
     ganhoDePalheta(-1) === ganhoDePalheta(0) && ganhoDePalheta(9) === ganhoDePalheta(1));
  ok('força sem sentido cai no meio da faixa', ganhoDePalheta(NaN) === ganhoDePalheta(0.5));
}

// 2) Timbre pelo par que bateu
{
  ok('acrílico contra acrílico', timbreDoPar('button','button') === 'botão+botão');
  ok('bola contra botão', timbreDoPar('ball','button') === 'bola+botão');
  ok('a caixa do goleiro manda no timbre', timbreDoPar('ball','keeper') === 'caixa'
     && timbreDoPar('keeper','button') === 'caixa');
  ok('a ordem do par não muda o timbre', timbreDoPar('button','ball') === timbreDoPar('ball','button'));
}

// 3) Carambola: sete contatos não viram sete pancadas
{
  const t = [0.00, 0.01, 0.05, 0.30, 0.31, 0.60, 0.90];
  const eventos = t.map((t) => ({ t, type:'contact', speed:60, aKind:'ball', bKind:'button' }));
  const saiu = impactosAudiveis(eventos);
  ok('dos 7 contatos sobram 4', saiu.length === 4, saiu.map((i)=>i.t).join(' '));
  ok('sobram os primeiros de cada agrupamento', saiu.map((i)=>i.t).join(' ') === '0 0.3 0.6 0.9');

  // Sem o teto, sete vozes no mesmo instante somam e o pico vai a 1,0 — que
  // não é "alto", é distorção.
  const juntos = Array.from({length:20}, (_,i) => ({ t:i*0.001, type:'contact', speed:120, aKind:'ball', bKind:'button' }));
  ok('vinte contatos no mesmo milissegundo viram um', impactosAudiveis(juntos).length === 1);
}

// 4) O que entra e o que não entra na lista
{
  const eventos = [
    { t:0.0, type:'contact', speed:80, aKind:'ball', bKind:'button' },
    { t:0.2, type:'goal', team:'A' },
    { t:0.4, type:'fora' },
    { t:0.6, type:'mesa', body:'A1' },
    { t:0.8, type:'quique', body:'ball', forca:40 },
  ];
  const saiu = impactosAudiveis(eventos);
  ok('gol e bola fora não são pancada', saiu.length === 3, saiu.map((i)=>i.tipo).join(' '));
  ok('mesa e quique entram como variantes surdas',
     saiu[1].tipo === 'mesa' && saiu[2].tipo === 'quique');
  ok('o contato leva a velocidade que o servidor mandou', saiu[0].velocidade === 80);

  // O replay guarda quadros mas não guarda eventos: ali a lista some, e isso
  // não pode derrubar a animação.
  ok('sem eventos não quebra', impactosAudiveis(undefined).length === 0
     && impactosAudiveis(null).length === 0 && impactosAudiveis([]).length === 0);
  ok('evento torto é ignorado', impactosAudiveis([null, { type:'contact' }]).length === 0);
}

// 4b) A trave tem fila própria: rabo de 0,6 s não cabe na janela das pancadas
{
  const eventos = [
    { t:0.10, type:'contact', speed:80, aKind:'ball',   bKind:'button' },
    { t:0.20, type:'contact', speed:90, aKind:'ball',   bKind:'post'   },
    { t:0.25, type:'contact', speed:70, aKind:'button', bKind:'post'   },
    { t:0.60, type:'contact', speed:60, aKind:'post',   bKind:'button' },
    { t:0.80, type:'fora' },
  ];
  const saiu = travesAudiveis(eventos);
  ok('só o que encostou na trave entra', saiu.length === 2, saiu.map((i)=>i.t).join(' '));
  ok('a raspada nos dois postes vira uma', saiu.map((i)=>i.t).join(' ') === '0.2 0.6');
  ok('bola na trave e botão na trave não são a mesma coisa',
     saiu[0].bola === true && saiu[1].bola === false);

  // A janela das pancadas descartaria a trave de 0,25 s por causa do contato
  // de 0,20 s; a da trave descarta a de 0,25 s por causa da trave de 0,20 s.
  // São duas filas, e é por isso que são duas funções.
  ok('a trave não some porque um botão encostou antes',
     travesAudiveis([{ t:0.10, type:'contact', speed:80, aKind:'ball', bKind:'button' },
                     { t:0.13, type:'contact', speed:80, aKind:'ball', bKind:'post' }]).length === 1);

  ok('sem eventos não quebra', travesAudiveis(undefined).length === 0
     && travesAudiveis(null).length === 0 && travesAudiveis([]).length === 0);
  ok('evento torto é ignorado', travesAudiveis([null, { type:'contact', aKind:'post' }]).length === 0);
}

// 5) A ordem do tempo manda, mesmo se a lista vier bagunçada
{
  const eventos = [0.9, 0.0, 0.5].map((t) => ({ t, type:'contact', speed:50, aKind:'ball', bKind:'button' }));
  ok('sai em ordem de tempo', impactosAudiveis(eventos).map((i)=>i.t).join(' ') === '0 0.5 0.9');
}

console.log(fails ? `\n${fails} FALHA(S)` : '\ntudo certo');
process.exit(fails ? 1 : 0);
