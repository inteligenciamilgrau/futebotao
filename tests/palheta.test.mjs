import { resolverPalheta, palhetaPara, pontoDeApoio } from '../server/palheta.js';
import { PALHETA, PHYS } from '../server/config.js';

let fails=0;
const ok=(n,c,i='')=>{console.log((c?'PASS ':'FAIL ')+n+(i?'  -> '+i:''));if(!c)fails++;};

// 1) Direção sai oposta ao apoio
{
  const r = resolverPalheta({ anguloAro: 0, inclinacao:45, avanco:0.35, forca:0.8 });
  ok('apoio a 0° lança o botão para 180°', Math.abs(r.direcao-180)<0.01, r.direcao+'°');
  const r2 = resolverPalheta({ anguloAro: 90, inclinacao:45, avanco:0.35, forca:0.8 });
  ok('apoio a 90° lança para 270°', Math.abs(r2.direcao-270)<0.01, r2.direcao+'°');
}

// 2) Configuração ótima entrega rendimento total
{
  const r = resolverPalheta({ anguloAro:0, inclinacao:45, avanco:0.35, forca:1 });
  ok('ótimo tem rendimento 1.0', Math.abs(r.rendimento-1)<0.001, r.rendimento);
  ok('ótimo com força 1 chega na velocidade máxima', Math.abs(r.velocidade-PHYS.maxShotSpeed)<0.5, r.velocidade+' cm/s');
  ok('não escorrega no ótimo', !r.escorregou);
}

// 3) Inclinação errada derruba o rendimento
{
  const deitada = resolverPalheta({ anguloAro:0, inclinacao:12, avanco:0.35, forca:1 });
  const emPe    = resolverPalheta({ anguloAro:0, inclinacao:80, avanco:0.35, forca:1 });
  const boa     = resolverPalheta({ anguloAro:0, inclinacao:45, avanco:0.35, forca:1 });

  // A curva é assimétrica de propósito: deitada PERDE a força (escorrega),
  // em pé ela é REDIRECIONADA para cima em vez de sumir.
  ok('palheta deitada rende bem menos', deitada.rendimento < boa.rendimento*0.2, deitada.rendimento);
  ok('deitada demais escorrega', deitada.escorregou, deitada.aviso);
  ok('palheta em pé mantém rendimento razoável', emPe.rendimento > 0.3 && emPe.rendimento < boa.rendimento,
     emPe.rendimento);
  ok('palheta em pé não escorrega', !emPe.escorregou, emPe.aviso);
  ok('em pé eleva a bola, deitada não', emPe.elevacao > 0.9 && boa.elevacao === 0,
     `emPe ${emPe.elevacao} vs otimo ${boa.elevacao}`);
}

// 4) Avanço errado
{
  const quina  = resolverPalheta({ anguloAro:0, inclinacao:45, avanco:0.0, forca:1 });
  const centro = resolverPalheta({ anguloAro:0, inclinacao:45, avanco:1.0, forca:1 });
  ok('apoio na quina escorrega', quina.escorregou, quina.aviso);
  ok('apoio no centro escorrega', centro.escorregou, centro.aviso);
}

// 5) Avanço exagerado torce a saída, e o lado depende da inclinação
{
  const baixa = resolverPalheta({ anguloAro:0, inclinacao:35, avanco:0.8, forca:1 });
  const alta  = resolverPalheta({ anguloAro:0, inclinacao:55, avanco:0.8, forca:1 });
  ok('avanço exagerado desvia', Math.abs(baixa.desvio)>5, baixa.desvio+'°');
  ok('inclinação decide o lado do desvio', Math.sign(baixa.desvio) !== Math.sign(alta.desvio),
     `${baixa.desvio}° vs ${alta.desvio}°`);
}

// 6) Cavadinha
{
  const cav = resolverPalheta({ anguloAro:0, inclinacao:68, avanco:0.35, forca:0.8 });
  const rasteira = resolverPalheta({ anguloAro:0, inclinacao:45, avanco:0.35, forca:0.8 });
  ok('palheta em pé com força faz cavadinha', cav.cavada, `voo ${cav.duracaoVoo}s`);
  ok('palheta no ângulo normal não cava', !rasteira.cavada);
  ok('cavadinha custa velocidade', cav.velocidade < rasteira.velocidade, `${cav.velocidade} vs ${rasteira.velocidade}`);
}

// 7) Modelo inverso bate com o direto
{
  for (const [dir, vel] of [[0,120],[90,80],[200,160],[315,40]]) {
    const p = palhetaPara(dir, vel);
    const r = resolverPalheta(p);
    const difDir = Math.abs(((r.direcao - dir + 540) % 360) - 180);
    ok(`inverso->direto bate (dir ${dir}°, v ${vel})`,
       difDir < 0.01 && Math.abs(r.velocidade - vel) < 1.5,
       `dir ${r.direcao}° v ${r.velocidade}`);
  }
  const impossivel = palhetaPara(0, PHYS.maxShotSpeed * 2);
  ok('inverso avisa quando é inalcançável', impossivel.alcancavel === false && impossivel.forca === 1);
}

// 8) Ponto de apoio fica dentro do botão
{
  const botao = { x: 100, y: 60, r: 2.4 };
  for (const av of [0, 0.35, 1]) {
    const p = pontoDeApoio(botao, 0, av);
    const d = Math.hypot(p.x-botao.x, p.y-botao.y);
    ok(`apoio com avanco=${av} fica dentro do botão`, d <= botao.r + 1e-9, d.toFixed(2)+' cm do centro');
  }
  const borda = pontoDeApoio(botao, 0, 0);
  const centro = pontoDeApoio(botao, 0, 1);
  ok('avanço maior aproxima do centro', centro.raio < borda.raio, `${borda.raio.toFixed(2)} -> ${centro.raio.toFixed(2)}`);
}

console.log(fails===0?'\nTUDO OK':`\n${fails} FALHA(S)`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
