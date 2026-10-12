// `graph` command: serves a self-contained force-directed view of .memory/graph.json. No AI, no tokens.
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { platform } from "node:os"
import { loadGraph, memoryRoot, staleMap } from "./store.ts"

const PAGE = String.raw`<!doctype html><meta charset=utf-8><title>project memory</title>
<style>
:root{--bg:#0f1115;--fg:#e6e6e6;--mut:#8b93a1;--pan:#171a21;--line:#2a2f3a}
@media(prefers-color-scheme:light){:root{--bg:#fafafa;--fg:#1b1d22;--mut:#6b7280;--pan:#fff;--line:#d8dbe2}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px system-ui;display:flex;height:100vh}
#main{flex:1;min-width:0;position:relative}#c{position:absolute;inset:0;width:100%;height:100%;display:block}#side{width:320px;background:var(--pan);border-left:1px solid var(--line);padding:14px;overflow:auto}
h1{font-size:15px;margin:0 0 8px}.k{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
input[type=text]{width:100%;padding:6px 8px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px}
input[type=range]{width:100%}.mut{color:var(--mut);font-size:12px}pre{white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace}
.row{margin:10px 0}.warn{color:#f59e0b}</style>
<div id=main><canvas id=c></canvas></div>
<div id=side><h1>Project memory</h1><div class=row><input id=q type=text placeholder="filter…"></div>
<div class=row><div class=mut>time travel: <span id=when></span></div><input id=t type=range min=0 max=1000 value=1000></div>
<div class=row id=legend></div><div class=row id=info class=mut>Click a node. Drag to move. Orange ring = linked files changed since (possibly outdated).</div></div>
<script>
const COL={decision:'#6aa9ff',note:'#7ee0a0',task:'#f0c36a',session:'#c08bff',file:'#8b93a1'};
let G,stale={},nodes=[],edges=[],sel=null,hov=null,drag=null,maxT,minT;
const cv=document.getElementById('c'),cx=cv.getContext('2d');
function size(){cv.width=cv.clientWidth*devicePixelRatio;cv.height=cv.clientHeight*devicePixelRatio;cx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0)}
addEventListener('resize',size);
async function load(){const r=await (await fetch('/graph.json')).json();G=r.graph;stale=r.stale;
 const old=new Map(nodes.map(n=>[n.id,n]));
 nodes=G.nodes.map(n=>Object.assign(old.get(n.id)||{x:cv.clientWidth/2+Math.random()*200-100,y:cv.clientHeight/2+Math.random()*200-100,vx:0,vy:0},n));
 const by=new Map(nodes.map(n=>[n.id,n]));edges=G.edges.map(e=>({a:by.get(e.from),b:by.get(e.to),type:e.type})).filter(e=>e.a&&e.b);
 const ts=nodes.map(n=>n.at);minT=Math.min(...ts,Date.now());maxT=Math.max(...ts,Date.now());
 document.getElementById('legend').innerHTML=Object.entries(COL).map(([k,c])=>'<span style="margin-right:10px"><i class=k style="background:'+c+'"></i>'+k+'</span>').join('')}
const T=()=>minT+(maxT-minT)*document.getElementById('t').value/1000;
const vis=n=>n.at<=T()&&(!q.value||(n.title+' '+(n.why||'')).toLowerCase().includes(q.value.toLowerCase())||n.kind==='file'&&edges.some(e=>(e.a===n||e.b===n)&&(e.a.title+e.b.title).toLowerCase().includes(q.value.toLowerCase())));
const q=document.getElementById('q');
function step(){const v=nodes.filter(vis),vs=new Set(v),W=cv.clientWidth,H=cv.clientHeight;
 for(const a of v){a.vx+=(W/2-a.x)*0.0008;a.vy+=(H/2-a.y)*0.0008;for(const b of v){if(a===b)continue;let dx=a.x-b.x,dy=a.y-b.y,d=dx*dx+dy*dy+0.1;if(d<120000){const f=4200/d;a.vx+=dx*f*0.02;a.vy+=dy*f*0.02}}}
 for(const e of edges){if(!vs.has(e.a)||!vs.has(e.b))continue;const dx=e.b.x-e.a.x,dy=e.b.y-e.a.y,d=Math.hypot(dx,dy)||1,f=(d-120)*0.004;e.a.vx+=dx/d*f;e.a.vy+=dy/d*f;e.b.vx-=dx/d*f;e.b.vy-=dy/d*f}
 for(const n of v){if(n===drag)continue;n.vx*=0.85;n.vy*=0.85;n.x+=n.vx;n.y+=n.vy}
 cx.clearRect(0,0,W,H);const fg=getComputedStyle(document.body).color;
 const near=new Set();if(hov||sel){const f=hov||sel;near.add(f);for(const e of edges){if(e.a===f)near.add(e.b);if(e.b===f)near.add(e.a)}}
 for(const e of edges){if(!vs.has(e.a)||!vs.has(e.b))continue;cx.globalAlpha=near.size&&!(near.has(e.a)&&near.has(e.b))?0.08:0.45;cx.strokeStyle=fg;cx.beginPath();cx.moveTo(e.a.x,e.a.y);cx.lineTo(e.b.x,e.b.y);cx.stroke()}
 for(const n of v){const r=n.kind==='file'?5:n.kind==='session'?9:8;cx.globalAlpha=near.size&&!near.has(n)?0.15:1;cx.fillStyle=COL[n.kind];cx.beginPath();cx.arc(n.x,n.y,r,0,7);cx.fill();
  if(stale[n.id]){cx.strokeStyle='#f59e0b';cx.lineWidth=2.5;cx.beginPath();cx.arc(n.x,n.y,r+4,0,7);cx.stroke();cx.lineWidth=1}
  if(n===sel){cx.strokeStyle=fg;cx.beginPath();cx.arc(n.x,n.y,r+2,0,7);cx.stroke()}
  if(n.kind!=='file'||n===hov||n===sel){cx.fillStyle=fg;cx.font='11px system-ui';cx.fillText(n.title.length>28?n.title.slice(0,27)+'…':n.title,n.x+r+4,n.y+4)}}
 cx.globalAlpha=1;document.getElementById('when').textContent=new Date(T()).toLocaleDateString();requestAnimationFrame(step)}
const pick=(x,y)=>nodes.filter(vis).find(n=>Math.hypot(n.x-x,n.y-y)<12);
cv.onmousemove=e=>{const p=[e.offsetX,e.offsetY];if(drag){drag.x=p[0];drag.y=p[1];drag.vx=drag.vy=0}else hov=pick(...p)};
cv.onmousedown=e=>{drag=pick(e.offsetX,e.offsetY);if(drag)show(drag)};cv.onmouseup=()=>drag=null;
function show(n){sel=n;const links=edges.filter(e=>e.a===n||e.b===n).map(e=>(e.a===n?'→ ':'← ')+e.type+' '+(e.a===n?e.b:e.a).title);
 document.getElementById('info').innerHTML='<h1><i class=k style="background:'+COL[n.kind]+'"></i>'+esc(n.title)+'</h1><div class=mut>'+n.kind+' · '+new Date(n.at).toLocaleString()+'</div>'+
 (stale[n.id]?'<div class=warn>⚠ linked files changed in '+stale[n.id]+' commit(s) since this was recorded</div>':'')+
 (n.why?'<pre>why: '+esc(n.why)+'</pre>':'')+(n.rejected?'<pre>rejected: '+esc(n.rejected.join('; '))+'</pre>':'')+'<pre>'+esc(links.join('\n'))+'</pre>'}
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
size();load().then(step);setInterval(load,4000);
</script>`

export async function viewGraph(port = 4747): Promise<void> {
  const root = memoryRoot()
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/graph.json")) {
      const graph = loadGraph(root)
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ graph, stale: staleMap(root, graph) }))
    } else {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end(PAGE)
    }
  })
  // Loopback only: the graph can contain private project notes.
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${port}`
  console.log(`project memory graph → ${url}  (Ctrl+C to stop)`)
  const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open"
  execFile(opener, platform() === "win32" ? ["/c", "start", "", url] : [url], () => {})
}
