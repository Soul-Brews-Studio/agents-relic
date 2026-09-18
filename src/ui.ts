import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { LanceStore } from "./store/lance.js";
import { listShards, defaultRoot } from "./repo.js";
import { dedupeHits } from "./query.js";

/**
 * A local viewer. One file, no build step, no client framework.
 *
 * Design: search is fleet-wide by DEFAULT and the shard list is a filter, not a
 * gate. Making you pick a repo before you can search would be wrong — the common
 * question is "where did I say this", and you usually do not know which repo the
 * answer is in. That is the whole point of having an index.
 */

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>relic</title>
<style>
 :root{--bg:#0a0a0f;--panel:#12121a;--line:#23232e;--fg:#e6e6ea;--dim:#9a9aa8;--accent:#64b5f6;--hit:#ffd479}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
 header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
 h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.02em}
 h1 span{color:var(--accent)}
 #q{flex:1;min-width:240px;background:var(--panel);border:1px solid var(--line);color:var(--fg);
    padding:9px 12px;border-radius:7px;font:inherit}
 #q:focus{outline:none;border-color:var(--accent)}
 select{background:var(--panel);border:1px solid var(--line);color:var(--fg);padding:8px;border-radius:7px;font:inherit}
 .meta{color:var(--dim);font-size:12px}
 main{display:flex;align-items:flex-start;gap:0}
 aside{width:290px;flex:none;border-right:1px solid var(--line);height:calc(100vh - 59px);overflow:auto;padding:10px}
 aside h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:6px 8px 10px}
 .shard{display:flex;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer}
 .shard:hover{background:var(--panel)}
 .shard.on{background:var(--panel);box-shadow:inset 2px 0 0 var(--accent)}
 .shard b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .shard i{font-style:normal;color:var(--dim);font-size:12px;flex:none}
 section{flex:1;height:calc(100vh - 59px);overflow:auto;padding:14px 18px}
 .hit{border:1px solid var(--line);border-radius:9px;padding:11px 13px;margin-bottom:10px;background:var(--panel)}
 .hit .top{display:flex;gap:9px;flex-wrap:wrap;font-size:12px;color:var(--dim);margin-bottom:7px}
 .tag{background:#1b1b26;border:1px solid var(--line);border-radius:5px;padding:1px 7px}
 .tag.wt{color:var(--accent);border-color:#2b3c50}
 .snip{white-space:pre-wrap;word-break:break-word}
 mark{background:transparent;color:var(--hit);font-weight:600}
 .hit button{margin-top:8px;background:none;border:1px solid var(--line);color:var(--dim);
   border-radius:6px;padding:4px 9px;cursor:pointer;font:inherit;font-size:12px}
 .hit button:hover{color:var(--fg);border-color:var(--accent)}
 pre.ctx{margin:9px 0 0;padding:9px;background:#0d0d14;border:1px solid var(--line);border-radius:7px;
   overflow:auto;font-size:12px;color:var(--dim);max-height:340px}
 pre.ctx b{color:var(--fg);font-weight:600}
 .empty{color:var(--dim);padding:26px 4px}
 @media(max-width:760px){main{flex-direction:column}aside{width:100%;height:auto;border-right:0;border-bottom:1px solid var(--line)}
   section{height:auto}}
</style></head><body>
<header>
  <h1>🏺 <span>relic</span></h1>
  <input id="q" placeholder="search every session…  (Thai works, 2 chars work)" autofocus>
  <select id="tier"><option value="">any tier</option><option>session</option><option>subagent</option><option>workflow_agent</option></select>
  <select id="source"><option value="">any agent</option></select>
  <span class="meta" id="stat"></span>
</header>
<main>
  <aside><h2 id="shardhead">repos</h2><div id="shards"></div></aside>
  <section><div id="out" class="empty">Type to search. Click a repo to narrow.</div></section>
</main>
<script>
const $=s=>document.querySelector(s);
let repo="", shards=[];
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

async function loadShards(){
  const r=await fetch('/api/shards').then(r=>r.json());
  shards=r.shards;
  $('#shardhead').textContent='repos · '+r.totals.events.toLocaleString()+' events';
  const srcs=[...new Set(r.sources)];
  $('#source').innerHTML='<option value="">any agent</option>'+srcs.map(s=>'<option>'+esc(s)+'</option>').join('');
  draw();
}
function draw(){
  $('#shards').innerHTML=['<div class="shard'+(repo===''?' on':'')+'" data-k=""><b>all repos</b><i>'+shards.length+'</i></div>']
    .concat(shards.map(s=>'<div class="shard'+(repo===s.key?' on':'')+'" data-k="'+esc(s.key)+'"><b>'+
      esc(s.key.replace('github.com/',''))+'</b><i>'+s.events.toLocaleString()+'</i></div>')).join('');
  document.querySelectorAll('.shard').forEach(el=>el.onclick=()=>{repo=el.dataset.k;draw();run()});
}
let timer;
const run=async()=>{
  const q=$('#q').value.trim();
  if(!q){$('#out').innerHTML='<div class="empty">Type to search. Click a repo to narrow.</div>';$('#stat').textContent='';return}
  $('#stat').textContent='searching…';
  const p=new URLSearchParams({q,limit:'40'});
  if(repo)p.set('repo',repo); if($('#tier').value)p.set('tier',$('#tier').value);
  if($('#source').value)p.set('source',$('#source').value);
  const r=await fetch('/api/search?'+p).then(r=>r.json());
  $('#stat').textContent=r.total+' hits · '+r.shards+' shards · '+r.ms+' ms';
  if(!r.hits.length){$('#out').innerHTML='<div class="empty">no matches for '+esc(q)+'</div>';return}
  $('#out').innerHTML=r.hits.map((h,i)=>{
    const i0=h.text.toLowerCase().indexOf(q.toLowerCase());
    const s=i0<0?h.text.slice(0,300):h.text.slice(Math.max(0,i0-140),i0+q.length+220);
    const marked=i0<0?esc(s):esc(s).split(new RegExp('('+q.split('').map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+')','ig')).map((p,j)=>j%2?'<mark>'+p+'</mark>':p).join('');
    return '<div class="hit"><div class="top"><span class="tag">'+esc(h.repo.replace('github.com/',''))+'</span>'+
      (h.worktree?'<span class="tag wt">'+esc(h.worktree)+'</span>':'')+
      '<span class="tag">'+esc(h.source)+'/'+esc(h.tier)+'</span><span class="tag">'+esc(h.role)+'</span>'+
      '<span>'+esc(h.ts||'')+'</span></div>'+
      '<div class="snip">…'+marked+'…</div>'+
      '<button data-i="'+i+'">show context</button><div id="c'+i+'"></div></div>'}).join('');
  document.querySelectorAll('.hit button').forEach(b=>b.onclick=async()=>{
    const h=r.hits[+b.dataset.i], box=$('#c'+b.dataset.i);
    if(box.innerHTML){box.innerHTML='';return}
    const c=await fetch('/api/context?file='+encodeURIComponent(h.file_path)+'&seq='+h.seq).then(r=>r.json());
    box.innerHTML='<pre class="ctx">'+c.lines.map(l=>(l.seq===h.seq?'<b>&gt;&gt; ':'   ')+
      '#'+l.seq+' '+esc(l.role)+': '+esc(l.text)+(l.seq===h.seq?'</b>':'')).join('\n')+'</pre>'});
};
$('#q').oninput=()=>{clearTimeout(timer);timer=setTimeout(run,180)};
$('#tier').onchange=run; $('#source').onchange=run;
loadShards();
</script></body></html>`;

async function readContext(file: string, seq: number, span = 3) {
  const out: { seq: number; role: string; text: string }[] = [];
  const rl = createInterface({ input: createReadStream(file, "utf8") });
  let n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    n++;
    if (n < seq - span) continue;
    if (n > seq + span) break;
    let role = "?", text = line.slice(0, 500);
    try {
      const rec = JSON.parse(line);
      role = rec.message?.role ?? rec.type ?? "?";
      const c = rec.message?.content ?? rec.payload?.content ?? rec.content;
      text = typeof c === "string" ? c : JSON.stringify(c ?? rec);
    } catch { /* keep the raw line */ }
    out.push({ seq: n, role, text: String(text).replace(/\s+/g, " ").slice(0, 700) });
  }
  return out;
}

export async function serve(opts: { port: number; dataRoot: string | null; inRepo: boolean }) {
  const where = opts.dataRoot ?? (opts.inRepo ? "in-repo" : defaultRoot());

  Bun.serve({
    port: opts.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });

      if (url.pathname === "/api/shards") {
        const list = listShards(opts.dataRoot, opts.inRepo);
        const shards: { key: string; events: number }[] = [];
        const sources = new Set<string>();
        for (const s of list) {
          try {
            const store = await LanceStore.open(s.dir);
            const c = await store.counts();
            if (c.events) shards.push({ key: s.key, events: c.events });
            for (const st of await store.sessionStats()) sources.add(st.source);
          } catch { /* skip unreadable shard */ }
        }
        shards.sort((a, b) => b.events - a.events);
        return Response.json({
          shards, sources: [...sources],
          totals: { events: shards.reduce((a, s) => a + s.events, 0), shards: shards.length },
        });
      }

      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        if (!q) return Response.json({ hits: [], total: 0, shards: 0, ms: 0 });
        const limit = Number(url.searchParams.get("limit") ?? 40);
        const repo = url.searchParams.get("repo") ?? "";
        let list = listShards(opts.dataRoot, opts.inRepo);
        if (repo) list = list.filter(s => s.key === repo);

        const t0 = performance.now();
        const hits: any[] = [];
        let searched = 0;
        for (const s of list) {
          try {
            const store = await LanceStore.open(s.dir);
            for (const h of await store.search(q, {
              limit,
              tier: url.searchParams.get("tier") ?? undefined,
              source: url.searchParams.get("source") ?? undefined,
            })) hits.push({ ...h, repo: s.key });
            searched++;
          } catch { /* a shard mid-write can throw; skip it */ }
        }
        // Same dedup rule as searchEvents, which this path does NOT go through: with a
        // bank per source root, one event indexed under three roots returns three
        // identical rows and the viewer shows it three times.
        hits.sort((a, b) => Number(b._score ?? 0) - Number(a._score ?? 0));
        const deduped = dedupeHits(hits);
        return Response.json({
          hits: deduped.slice(0, limit), total: deduped.length, shards: searched,
          ms: Math.round(performance.now() - t0),
        });
      }

      if (url.pathname === "/api/context") {
        const file = url.searchParams.get("file");
        const seq = Number(url.searchParams.get("seq") ?? 1);
        // Context comes from the source .jsonl, never the index — the index stores a
        // pointer, and re-reading the file is ~2 ms.
        if (!file) return Response.json({ lines: [] });
        try { return Response.json({ lines: await readContext(file, seq) }); }
        catch (e) { return Response.json({ lines: [], error: String(e).slice(0, 200) }); }
      }

      return new Response("not found", { status: 404 });
    },
  });

  console.log(`🏺 relic ui   http://127.0.0.1:${opts.port}`);
  console.log(`   reading    ${where}`);
  console.log(`   ctrl-c to stop`);
}
