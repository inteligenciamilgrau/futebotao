import { makeBody, simulate, goalPosts } from '../server/physics.js';
import { PHYS } from '../server/config.js';
const B=(x,y,vx)=>{const b=makeBody({id:'A1',kind:'button',team:'A',x,y,r:PHYS.buttonRadius,m:PHYS.buttonMass});b.vx=vx;return b;};
const ball=(x,y)=>makeBody({id:'ball',kind:'ball',x,y,r:PHYS.ballRadius,m:PHYS.ballMass});
console.log('força  corrida_disco  corrida_bola  (cm)');
for (const p of [0.3,0.5,0.7,0.85,1.0]) {
  const v = PHYS.minShotSpeed + p*(PHYS.maxShotSpeed-PHYS.minShotSpeed);
  const a=[B(10,30,v)]; simulate(a,goalPosts());
  const bs=[B(10,90,v), ball(10+PHYS.buttonRadius+PHYS.ballRadius+0.2,90)]; simulate(bs,goalPosts());
  console.log(`${p.toFixed(2)}   ${(a[0].x-10).toFixed(0).padStart(8)}      ${(bs[1].x-10).toFixed(0).padStart(8)}`);
}
