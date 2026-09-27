import fs from 'node:fs';
import { calculate } from '../../src/engine.ts';
const d = JSON.parse(fs.readFileSync('data/llm-info.json','utf8'));
let s=7; const rnd=()=>{s|=0;s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
const pick=a=>a[Math.floor(rnd()*a.length)];
const keys=['input_tokens','cache_read_tokens','cache_write_tokens','cache_write_1h_tokens','input_audio_tokens','input_image_tokens','input_video_tokens','cache_audio_read_tokens','cache_image_read_tokens','cache_audio_write_tokens','output_tokens','output_audio_tokens','output_image_tokens','output_reasoning_tokens','reasoning_tokens','output_images','output_video_seconds','web_searches'];
const cases=[];
for(let i=0;i<20000;i++){ const m=pick(d.models); const u={}; for(const k of keys) if(rnd()<0.35) u[k]=Math.floor(rnd()*pick([10,1000,300000,1e6])); 
 const mode=pick(['standard','standard','fast','priority','flex','batch']); const region=pick(['global','us','eu']); const opt=rnd()<0.5?{size:'1024x1024',quality:pick(['high','low']),resolution:pick(['4k','720p'])}:{};
 const r=calculate(m,u,opt,mode,region); cases.push({p:m.provider,id:m.id,u,mode,region,opt,t:r.totalUsd,w:r.warnings});
 if (r.totalUsd<0||!Number.isFinite(r.totalUsd)) console.log('BAD',m.id,u,r);
}
fs.writeFileSync('.work/review5/cases.json',JSON.stringify(cases));
console.log('cases',cases.length);
