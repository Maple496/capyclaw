import { spawn } from 'node:child_process'
function client() {
  const p = spawn('node', ['src/mcp/index.mjs'], { cwd: process.cwd(), stdio: ['pipe','pipe','inherit'] })
  let buf=''; const w=new Map()
  p.stdout.on('data', c => { buf+=c; let i; while((i=buf.indexOf('\n'))>=0){ const l=buf.slice(0,i); buf=buf.slice(i+1); if(!l.trim())continue; try{const m=JSON.parse(l); if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id)}}catch{} } })
  let id=0
  return { rpc:(method,params)=>new Promise(r=>{const my=++id;w.set(my,r);p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:my,method,params})+'\n')}), close:()=>p.kill() }
}
const c=client(); await c.rpc('initialize',{protocolVersion:'2024-11-05'})
async function run(name,args){ const t=performance.now(); const r=await c.rpc('tools/call',{name,arguments:args}); return {ms:performance.now()-t, err:!!r.result?.isError, text:(r.result?.content?.[0]?.text||'').slice(0,80)} }
const one=[], all=[], decks=[]
for(let i=0;i<5;i++) one.push((await run('ppt_style',{background:'#000000',contrast:true,slides:[0]})).ms)
for(let i=0;i<5;i++) all.push((await run('ppt_style',{background:'#000000',contrast:true})).ms)
for(let i=0;i<5;i++) decks.push((await run('ppt_get_deck',{})).ms)
const shot=await run('ppt_screenshot',{})
console.log(JSON.stringify({style_one_slide:one, style_all_slides:all, get_deck:decks, screenshot:shot},null,2))
c.close()
