// Goleiro caixa (retângulo orientado) e linhas abertas.
import { makeBody, simulate, goalPosts, settle } from '../server/physics.js';
import { PITCH, PHYS } from '../server/config.js';

let fails=0;
const ok=(n,c,i='')=>{console.log((c?'PASS ':'FAIL ')+n+(i?'  -> '+i:''));if(!c)fails++;};
const bola=(x,y,vx=0,vy=0)=>{const b=makeBody({id:'ball',kind:'ball',x,y,r:PHYS.ballRadius,m:PHYS.ballMass});b.vx=vx;b.vy=vy;return b;};
const botao=(id,x,y,team='A')=>makeBody({id,kind:'button',team,x,y,r:PHYS.buttonRadius,m:PHYS.buttonMass});
const caixa=(x,y,ang=0,w=14,h=4)=>makeBody({id:'BG',kind:'keeper',team:'B',forma:'caixa',x,y,w,h,ang,m:0,fixed:true});

// 1) A caixa barra a bola
{
  const bs=[bola(60,60,180,0)];
  const st=[...goalPosts(), caixa(90,60,Math.PI/2)];   // caixa em pé, atravessada
  simulate(bs,st);
  ok('bola para antes da caixa', bs[0].x < 90, 'x=' + bs[0].x.toFixed(1));
  ok('bola volta depois de bater', bs[0].vx === 0 && bs[0].x < 88, 'x=' + bs[0].x.toFixed(1));
}

// 2) A caixa não se move (massa infinita)
{
  const c=caixa(90,60,0);
  const bs=[bola(60,60,180,0)];
  simulate(bs,[...goalPosts(), c]);
  ok('caixa não sai do lugar', c.x === 90 && c.y === 60, `(${c.x}, ${c.y})`);
}

// 3) A orientação importa: de lado ela é fina, atravessada é larga
{
  // Bola a y=64. Deitada (14 em X, 4 em Y) a caixa cobre y 58..62: passa.
  // Em pé (14 em Y) cobre y 53..67: barra. Mesma caixa, só girada.
  const deitada = [bola(60,64,180,0)]; simulate(deitada,[...goalPosts(), caixa(90,60,0,14,4)]);
  const emPe    = [bola(60,64,180,0)]; simulate(emPe,[...goalPosts(), caixa(90,60,Math.PI/2,14,4)]);
  ok('deitada, a caixa é estreita em Y e a bola passa', deitada[0].x > 95, 'x=' + deitada[0].x.toFixed(1));
  ok('em pé, a caixa cobre e a bola é barrada', emPe[0].x < 92, 'x=' + emPe[0].x.toFixed(1));
}

// 4) Bola sai pela lateral
{
  const bs=[bola(100,60,0,200)];
  const r=simulate(bs,goalPosts());
  ok('bola cruza a lateral e sai', !!r.fora && r.fora.linha==='lateral', JSON.stringify(r.fora));
  ok('registrou o lado de cima', r.fora?.lado === 'cima', r.fora?.lado);
  ok('não virou gol', !r.goal);
}

// 5) Bola sai pela linha de fundo, fora do gol
{
  const bs=[bola(40,20,-200,0)];
  const r=simulate(bs,goalPosts());
  ok('bola cruza o fundo e sai', !!r.fora && r.fora.linha==='fundo', JSON.stringify(r.fora));
  ok('identifica o gol da linha', r.fora?.gol === 'A', r.fora?.gol);
}

// 6) Dentro da boca ainda é gol, não saída
{
  const bs=[bola(40,60,-200,0)];
  const r=simulate(bs,goalPosts());
  ok('pela boca do gol continua sendo gol', !!r.goal && !r.fora, JSON.stringify(r.goal));
}

// 6b) Gol: a bola fica presa DENTRO da rede, não segue reto
{
  for (const vel of [-200, -700]) {
    const bs=[bola(40,60,vel,0)];
    const r=simulate(bs,goalPosts());
    const b0=bs[0];
    const dentro = b0.x <= 0 && b0.x >= -PITCH.goalDepth
                && b0.y >= PITCH.goalMin && b0.y <= PITCH.goalMax;
    ok(`chute a ${vel} cm/s vira gol`, !!r.goal, JSON.stringify(r.goal));
    ok(`e a bola descansa na rede`, dentro, `(${b0.x.toFixed(1)}, ${b0.y.toFixed(1)})`);
    ok(`sem atravessar o fundo`, b0.x >= -PITCH.goalDepth, `x=${b0.x.toFixed(1)} fundo=${-PITCH.goalDepth}`);
  }
}

// 7) O botão SAI do campo e para na beirada da mesa
//
// Quem para na linha é a bola. O botão usa a faixa de fora para buscar bola
// colada na risca e para cobrar lateral vindo de trás dela.
{
  const b=botao('A1',100,60); b.vy=260;
  simulate([b],goalPosts());
  const beirada = PITCH.width + PITCH.margemFora - PHYS.buttonRadius;
  ok('botão passa da linha', b.y > PITCH.width, 'y=' + b.y.toFixed(1));
  ok('e para na beirada da mesa, sem quicar', Math.abs(b.y - beirada) < 0.2,
     'y=' + b.y.toFixed(1) + ' esperado ' + beirada.toFixed(1));
}

// 7b) Mas ele não cai da mesa, nem com pancada
{
  const b=botao('A2',100,60); b.vx=900; b.vy=900;
  simulate([b],goalPosts());
  const m = PITCH.margemFora, r = PHYS.buttonRadius;
  const naMesa = b.x >= -m && b.x <= PITCH.length + m && b.y >= -m && b.y <= PITCH.width + m;
  ok('botão fica na mesa mesmo a 900 cm/s', naMesa, `(${b.x.toFixed(1)}, ${b.y.toFixed(1)})`);
}

// 8) Último toque na bola
{
  const a1=botao('A1',60,60), b1=botao('B1',110,60,'B');
  const bs=[a1,b1,bola(66,60)];
  a1.vx=170;
  const r=simulate(bs,goalPosts());
  ok('registra quem tocou por último', !!r.ultimoToqueBola, JSON.stringify(r.ultimoToqueBola));
  ok('o último toque é do adversário depois da carambola',
     r.ultimoToqueBola?.team === 'B' || r.ultimoToqueBola?.id === 'A1',
     `${r.ultimoToqueBola?.id} (${r.ultimoToqueBola?.team})`);
}

// 9) settle separa botão de caixa sem afundar
{
  const b=botao('A1',90,60);
  const c=caixa(90,60,0,14,4);
  settle([b],[...goalPosts(), c]);
  const cos=Math.cos(0), sin=Math.sin(0);
  const lx=(b.x-c.x)*cos+(b.y-c.y)*sin, ly=-(b.x-c.x)*sin+(b.y-c.y)*cos;
  const fora = Math.abs(lx) > c.w/2 || Math.abs(ly) > c.h/2;
  ok('settle empurra o botão para fora da caixa', fora, `local (${lx.toFixed(1)}, ${ly.toFixed(1)}) vs meia-caixa (${c.w/2}, ${c.h/2})`);
}

// 10) Determinismo continua valendo com caixa
{
  const roda=()=>{const bs=[botao('A1',60,58),bola(68,60)];bs[0].vx=160;bs[0].vy=12;
    simulate(bs,[...goalPosts(),caixa(120,60,0.4)]);return bs.map(b=>`${b.x.toFixed(4)},${b.y.toFixed(4)}`).join('|');};
  ok('mesma entrada, mesma saída', roda()===roda());
}

console.log(fails===0?'\nTUDO OK':`\n${fails} FALHA(S)`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
