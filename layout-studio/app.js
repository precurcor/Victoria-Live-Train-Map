(function(){
  'use strict';
  const C=RailCore,K=RailCAD,A=STUDIO_ASSETS,$=s=>document.querySelector(s);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=n=>Number(n).toFixed(2).replace(/\.00$/,'');
  let model=C.addRegional(C.baseProject(A),A),generated,issues=[],selected=new Set(),tab='stations',query='',showUnplaced=false;
  let tool='select',preview=false,showLabels=true,showNodes=false,showHardware=true,showGrid=true,showCaps=false,snap=true;
  let history=[],future=[],view={x:0,y:0,w:700,h:500},drag=null,space=false,connectStart=null,toastTimer,saveTimer,dirty=false,exporting=false,footprintTarget=null;
  const STORE='victoria-rail-layout-v1', svg=$('#canvas'),wrap=$('#canvasWrap');
  const fpCache=new Map();
  const originalBlocks=new Map(A.nodes.flatMap(n=>n.ledIds.filter(v=>v!==null).map(v=>[v,n.id])));
  function toast(s){$('#toast').textContent=s;$('#toast').classList.remove('hide');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.add('hide'),5000);}
  function status(s){$('#status').textContent=s;}
  function node(id){return model.nodes.find(x=>x.id===id);}
  function edge(id){return model.edges.find(x=>x.id===id);}
  function hardware(id){return model.hardware.find(x=>x.id===id);}
  function capacitor(id){return generated?.caps.find(x=>x.id===id);}
  function item(id){return node(id)||edge(id)||hardware(id)||capacitor(id);}
  function editable(id){const c=capacitor(id);if(!c)return item(id);model.capPositions??={};return model.capPositions[id]??={x:c.x,y:c.y,angle:c.angle,locked:!!c.locked};}
  function nextRef(prefix){let i=1;while(model.hardware.some(h=>h.ref===prefix+i))i++;return prefix+i;}
  function replaceAllowed(){return !dirty||confirm('Replace this layout? Save a project copy first to keep your changes.');}
  function moveSelection(dx,dy){C.translate(model,selected,dx,dy);}
  function cancelDrag(){if(drag?.before)model=JSON.parse(drag.before);drag=null;wrap.classList.remove('dragging');regenerate();}

  function snapshot(){return JSON.stringify(model);}
  function changed(before){if(before===snapshot())return;history.push(before);if(history.length>50)history.shift();future=[];dirty=true;regenerate();scheduleSave();}
  function mutate(fn){const before=snapshot();try{fn();C.generate(model);C.validateSchema(model);changed(before);}catch(e){model=JSON.parse(before);regenerate();toast(e.message);}}
  function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{try{localStorage.setItem(STORE,snapshot());status('Autosaved locally · Save project for a portable copy');}catch{status('Autosave unavailable — use Save project');}},500);}
  function undo(redo=false){const from=redo?future:history,to=redo?history:future;if(!from.length)return;to.push(snapshot());model=JSON.parse(from.pop());fpCache.clear();selected.clear();dirty=true;regenerate();scheduleSave();}
  function saveFile(name,text,type='application/octet-stream'){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
  const fileSlug=()=>model.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'rail-layout';
  function saveProject(){saveFile(fileSlug()+'.rail.json',JSON.stringify(model,null,2),'application/json');dirty=false;status('Project downloaded');}
  function boundsFor(ids){
    const ps=[];for(const id of ids){const n=node(id),h=hardware(id)||capacitor(id),e=edge(id);if(n)ps.push({x:n.x-15,y:n.y-15},{x:n.x+15,y:n.y+15});
      if(h)ps.push({x:h.x-h.w,y:h.y-h.h},{x:h.x+h.w,y:h.y+h.h});if(e){for(const l of e.lanes){const c=C.curve(model,e,l);ps.push(...c);}}}
    if(!ps.length)return {x:0,y:0,w:model.board.width,h:model.board.height};
    const xs=ps.map(p=>p.x),ys=ps.map(p=>p.y);return {x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};
  }
  function fit(bounds){const b=bounds||{x:0,y:0,w:model.board.width,h:model.board.height};const r=wrap.getBoundingClientRect(),ar=r.width/r.height;
    let w=Math.max(30,b.w)*1.08,h=Math.max(25,b.h)*1.08;if(w/h<ar)w=h*ar;else h=w/ar;
    view={x:b.x+b.w/2-w/2,y:b.y+b.h/2-h/2,w,h};renderCanvas();}
  function select(id,add=false,focus=false){if(!add)selected.clear();if(add&&selected.has(id))selected.delete(id);else selected.add(id);renderLeft();renderInspector();if(focus)fit(boundsFor([id]));else renderCanvas();}
  function world(e){const r=svg.getBoundingClientRect();return {x:view.x+(e.clientX-r.left)/r.width*view.w,y:view.y+(e.clientY-r.top)/r.height*view.h};}
  function snapped(v){return snap?Math.round(v/model.board.grid)*model.board.grid:v;}
  function regenerate(){try{generated=C.generate(model);issues=C.checks(model,generated);render();}catch(e){toast(e.message);}}
  function render(){renderLeft();renderCanvas();renderInspector();$('#undoButton').disabled=!history.length;$('#redoButton').disabled=!future.length;$('#projectName').textContent=model.name;}
  function input(label,key,value,opts={}){return `<label>${label}<input data-field="${key}" type="${opts.type||'number'}" value="${esc(value)}" ${opts.step?'step="'+opts.step+'"':'step="0.1"'} ${opts.min!==undefined?'min="'+opts.min+'"':''} ${opts.max!==undefined?'max="'+opts.max+'"':''}></label>`;}
  function selectInput(label,key,value,options){return `<label>${label}<select data-field="${key}">${options.map(([v,t])=>`<option value="${esc(v)}" ${String(value)===String(v)?'selected':''}>${esc(t)}</option>`).join('')}</select></label>`;}
  function renderLeft(){
    const host=$('#leftContent'),active=!!document.activeElement&&document.activeElement===host.querySelector('#search'),caret=active?document.activeElement.selectionStart:null;
    document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
    if(tab==='stations'){
      const list=showUnplaced?A.catalog.filter(s=>!model.nodes.some(n=>C.norm(n.name)===C.norm(s.name))):model.nodes.filter(n=>n.name);
      const filtered=list.filter(n=>C.norm(n.name).includes(C.norm(query))||(n.region||'').toLowerCase().includes(query.toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name));
      host.innerHTML=`<h2>Stations & tracks</h2><input id="search" type="search" value="${esc(query)}" placeholder="Find a station or branch…" aria-label="Find a station"><label><input id="unplaced" type="checkbox" ${showUnplaced?'checked':''}> Show unplaced source stations</label>
        <div class="row"><button data-action="addStation">+ Station</button><button data-action="addAll">Add missing</button></div>
        <div class="line-meta" style="margin-top:12px">${filtered.length} ${showUnplaced?'unplaced':'placed'} records ${showUnplaced?'· GTFS source catalogue':'· click to locate'}</div>
        <div class="list">${filtered.map(n=>showUnplaced?`<button data-catalog="${esc(n.stationId)}"><span>${esc(n.name)}</span><span class="hint">+ Place</span></button>`:
          `<button class="${selected.has(n.id)?'selected':''}" data-locate="${n.id}"><span><i class="swatch" style="background:${C.COLORS[n.channel-1]}"></i>${esc(n.name)}</span><span class="hint">${n.tracks} tracks</span></button>`).join('')}</div>`;
      if(active){const el=$('#search');el.focus();if(el.type!=='search')el.setSelectionRange(caret,caret);}
    }else if(tab==='hardware'){
      const key=model.hardware.filter(h=>h.kind!=='existing'||/^[US]/.test(h.ref));
      host.innerHTML=`<h2>Components</h2><p class="muted small">Inherited footprints retain their circuit connections. Assign a real footprint and pin nets to include a new part in both PCB and schematic.</p><div class="actions"><button data-action="addOled">+ Bare OLED</button><button data-action="addEncoder">+ Encoder</button><button data-action="addHole">+ Hole</button><button data-action="importFootprint">Import footprint</button></div><div class="actions"><button data-action="selectController">Select controller group</button><button data-action="selectAllHardware">Select all hardware</button></div><div class="list">${key.map(h=>`<button data-locate="${h.id}" class="${selected.has(h.id)?'selected':''}"><span>${esc(h.ref)}<br><span class="small muted">${esc(h.name)}</span></span></button>`).join('')}</div><details><summary>All ${model.hardware.length} components</summary><div class="list">${model.hardware.filter(h=>!key.includes(h)).map(h=>`<button data-locate="${h.id}">${esc(h.ref)} · ${esc(h.name)}</button>`).join('')}</div></details>`;
    }else{
      host.innerHTML=`<h2>Board setup</h2>${input('Project name','board.name',model.name,{type:'text'})}<div class="two">${input('Width · mm','board.width',model.board.width,{min:20,max:2000,step:1})}${input('Height · mm','board.height',model.board.height,{min:20,max:2000,step:1})}</div>
        ${input('Snap grid · mm','board.grid',model.board.grid,{min:.1,max:20,step:.1})}<label><input type="checkbox" id="snapToggle" ${snap?'checked':''}> Snap objects to grid</label>${input('LEDs per decoupling capacitor','board.capEvery',model.board.capEvery,{min:1,max:100,step:1})}
        <p class="muted small">Board resizing changes the edge only. Components and LED footprints keep their real physical size.</p><hr class="separator"><h3>Display layers</h3><label><input type="checkbox" id="labelsToggle" ${showLabels?'checked':''}> Station names</label><label><input type="checkbox" id="nodesToggle" ${showNodes?'checked':''}> Intermediate nodes / junctions</label><label><input type="checkbox" id="hardwareToggle" ${showHardware?'checked':''}> Hardware</label><label><input type="checkbox" id="capsToggle" ${showCaps?'checked':''}> Capacitors · select and move</label>
        <hr class="separator"><h3>Density tools</h3><p class="muted small">Add LEDs to every existing connection. Prefer editing individual spans for final work.</p><label>Extra LEDs per lane<input id="allDensity" type="number" value="1" min="0" max="30"></label><button data-action="allDensity" class="wide">Apply to every connection</button><div class="note warning">Increasing LEDs also increases power, firmware memory and routing requirements. Live geographic mapping must be extended separately.</div>`;
    }
  }
  function renderInspector(){
    const host=$('#inspector');if(selected.has('__checks')){
      host.innerHTML=`<h2>Design checks</h2><p class="muted small">Layout checks only — not a substitute for KiCad ERC/DRC.</p><hr class="separator">${issues.map(i=>`<button class="check ${i.level}" ${i.target?'data-locate="'+i.target+'"':''}>${esc(i.message)}</button>`).join('')}`;return;
    }
    const items=[...selected].map(item).filter(Boolean);
    if(!items.length){host.innerHTML=`<span class="subtitle">Project overview</span><h2 style="margin-top:8px">Shape your network.</h2><p class="muted">Select a station, track connection or component to edit its dimensions and position.</p><div class="stats" style="margin-top:18px"><div class="stat"><strong>${generated?.leds.length.toLocaleString()}</strong><span>LED footprints</span></div><div class="stat"><strong>${model.nodes.filter(n=>n.name).length}</strong><span>Station labels</span></div></div><h3>Between stations</h3><p class="muted">Shift-select two consecutive stations, then use <strong>Rebuild span</strong> to set the exact number of intermediate LEDs on every parallel track.</p><h3>Keep the original</h3><p class="muted">The Kea controller, USB and power schematics are retained. Your source PCB is never overwritten.</p><div class="note warning">OLED and encoder are reserved shapes until the exact parts are selected. Exported boards are unrouted.</div><button data-action="checks" class="wide">View design checks (${issues.length})</button><div class="actions"><button data-action="help">Quick guide</button><button data-action="new">Project presets</button></div>`;return;}
    if(items.length>1){const nodes=items.filter(i=>node(i.id));host.innerHTML=`<h2>${items.length} objects selected</h2><p class="muted">Drag any selected object to move this group. Arrow keys nudge by the snap grid.</p><div class="two">${input('Move X · mm','group.dx',0)}${input('Move Y · mm','group.dy',0)}</div><div class="actions"><button data-action="alignX">Align X</button><button data-action="alignY">Align Y</button></div><button data-action="fitSelection" class="wide" style="margin-top:8px">Fit selection</button>${nodes.length===2?`<h3>Rebuild station span</h3><p class="muted small">Replaces the unbranched path between these two stations. Preserves lane connectivity. Old intermediate blocks are retired.</p><label>LEDs between stations, per track<input id="spanCount" type="number" value="7" min="0" max="300"></label><button data-action="rebuildSpan" class="primary wide">Rebuild span</button>`:''}<div class="actions"><button data-action="lock">Lock / unlock</button><button data-action="delete">Delete selection</button></div>`;return;}
    const i=items[0],position=`<div class="two">${input('X · mm','x',fmt(i.x))}${input('Y · mm','y',fmt(i.y))}</div>${input('Rotation · degrees','angle',fmt(i.angle),{min:-360,max:360,step:1})}`;
    if(node(i.id)){
      host.innerHTML=`<span class="subtitle">${i.name?'Station':'Track node'}</span><h2 style="margin-top:8px">${esc(i.name||i.id)}</h2>${input('Name','name',i.name,{type:'text'})}${position}<div class="two">${input('Parallel tracks','tracks',i.tracks,{min:1,max:24,step:1})}${input('Track pitch · mm','pitch',i.pitch,{min:1.7,max:20})}</div>${selectInput('LED output chain','channel',i.channel,Array.from({length:8},(_,j)=>[j+1,'Channel '+(j+1)]))}
        <h3>Label placement</h3><label>Label text · line breaks supported<textarea data-field="labelText" rows="2">${esc(i.labelText??i.name)}</textarea></label><div class="two">${input('Offset X · mm','labelDx',i.labelDx)}${input('Offset Y · mm','labelDy',i.labelDy)}</div><div class="two">${input('Text height · mm','labelSize',i.labelSize,{min:.5,max:20})}${input('Label angle','labelAngle',i.labelAngle,{min:-360,max:360,step:1})}</div>
        <div class="actions"><button data-action="selectBranch">Select branch</button><button data-action="fitSelection">Focus</button></div><label><input data-field="locked" type="checkbox" ${i.locked?'checked':''}> Lock station position</label><h3>Track LEDs</h3><p class="small muted">Toggle each lane’s station LED. The track connection remains.</p><div>${i.ledIds.map((v,j)=>`<label class="chip"><input data-lane="${j}" type="checkbox" ${v!==null?'checked':''}> ${j+1}</label>`).join('')}</div><h3>Source identity</h3><p class="small mono">${esc(i.stationId||'Not linked to a GTFS station')}</p><p class="muted small">${esc(i.region)}${i.original?' · original block IDs retained':' · track count is a layout assumption'}</p><div class="actions"><button data-action="duplicate">Duplicate</button><button data-action="delete">Delete</button></div>`;
    }else if(edge(i.id)){
      const a=node(i.a),b=node(i.b),counts=generated.paths.find(p=>p.e.id===i.id)?.count||0;
      host.innerHTML=`<span class="subtitle">Parallel track connection</span><h2 style="margin-top:8px">${esc(a.name||a.id)} → ${esc(b.name||b.id)}</h2><div class="stats"><div class="stat"><strong>${i.lanes.length}</strong><span>Track paths</span></div><div class="stat"><strong>${counts*i.lanes.length}</strong><span>Added LEDs</span></div></div>${selectInput('LED placement','mode',i.mode,[['count','Exact number per track'],['pitch','Target spacing in mm']])}
        ${i.mode==='count'?input('Intermediate LEDs per track','count',i.count,{min:0,max:300,step:1}):input('Target pitch · mm','pitch',i.pitch,{min:1.7,max:100})}<p class="muted small">Excludes the LEDs at either endpoint. All parallel tracks use the same number of columns.</p>${selectInput('Output chain for new LEDs','channel',i.channel,Array.from({length:8},(_,j)=>[j+1,'Channel '+(j+1)]))}<h3>Route shape</h3><p class="muted small">Drag the diamond on the canvas to shape the bend.</p><button data-action="straighten" class="wide">Reset to endpoint tangents</button><label><input data-field="dotted" type="checkbox" ${i.dotted?'checked':''}> Dotted track marking</label><h3>Lane mapping</h3><p class="small muted">One-based lanes: ${i.lanes.map(l=>`${l[0]+1}→${l[1]+1}`).join(', ')}</p><label>Connections (e.g. 1:1, 2:2, 3:3)<input id="laneMapping" value="${i.lanes.map(l=>`${l[0]+1}:${l[1]+1}`).join(', ')}"></label><button data-action="laneMapping" class="wide">Apply lane mapping</button><div class="actions"><button data-action="insertStation">Insert station</button><button data-action="delete">Delete connection</button></div>`;
    }else if(capacitor(i.id)){
      host.innerHTML=`<span class="subtitle">LED decoupling capacitor</span><h2>${esc(i.ref)} · 10 µF / 0402</h2>${position}<p class="muted small">${esc(i.supply)} to GND · grouped from ${esc(i.firstLed)}. Position is saved with this group; changing density can regroup capacitors.</p><button data-action="resetCap" class="wide">Reset automatic placement</button>`;
    }else{
      host.innerHTML=`<span class="subtitle">${i.kind==='existing'?'Inherited component':'Mechanical item'}</span><h2 style="margin-top:8px">${esc(i.ref)} · ${esc(i.name)}</h2>${position}${i.kind!=='existing'?`<div class="two">${input('Width · mm','w',i.w,{min:.1,max:500})}${input('Height · mm','h',i.h,{min:.1,max:500})}</div>${input('Description','name',i.name,{type:'text'})}`:''}${i.kind==='oled'&&!i.raw?`<h3>Display window</h3><div class="two">${input('Active width · mm','activeW',i.activeW,{min:1,max:i.w})}${input('Active height · mm','activeH',i.activeH,{min:1,max:i.h})}</div><div class="note warning">Bare glass / FPC reservation. No daughterboard. Dimensions are editable placeholders, not a verified OLED part.</div>`:''}${i.kind==='encoder'&&!i.raw?'<div class="note warning">Encoder body reservation. Shaft, mounting tabs, switch and pin positions require an exact part.</div>':''}${i.kind==='existing'?'<p class="muted small">Exact source footprint and pin nets are retained. Moving it requires rerouting.</p>':''}${i.kind!=='existing'&&i.kind!=='hole'?`<h3>Real component</h3><button data-action="assignFootprint" class="wide">${i.raw?'Replace':'Assign'} KiCad footprint</button>${i.raw?`<p class="small muted">${esc(K.footprintInfo(i.raw).name)} · Matching numbered-pin symbol is exported. Enter verified net names, leave blank for unconnected, or enter NC for intentionally unused pins.</p><div class="pin-list">${K.footprintInfo(i.raw).pins.map(pin=>`<label>Pad ${esc(pin)}<input data-pin="${esc(pin)}" value="${esc(i.pinNets?.[pin]||'')}" list="netNames" placeholder="Unconnected"></label>`).join('')}</div><datalist id="netNames">${A.nets.map(raw=>K.val(K.parse(raw)[2])).filter(n=>n&&!n.startsWith('Net-')&&!n.startsWith('unconnected-')).map(n=>`<option value="${esc(n)}"></option>`).join('')}</datalist>`:'<p class="small muted">Choose the exact manufacturer part first. A footprint supplies pad geometry; its interface circuit still needs designing.</p>'}`:''}<label><input type="checkbox" data-field="locked" ${i.locked?'checked':''}> Lock placement</label><div class="actions"><button data-action="fitSelection">Focus</button>${i.kind==='existing'?'':'<button data-action="delete">Delete</button>'}</div>`;
    }
  }
  function fpGraphic(h){
    if(!fpCache.has(h.id)){
      const raw=h.raw||A.hardware.find(x=>x.id===h.id)?.raw;
      if(!raw)return '';
      const f=K.parse(raw),graphics=[],sourceAngle=Number(K.child(f,'at')?.[3]||0);
      for(const p of K.children(f,'pad')){
        const at=K.child(p,'at'),s=K.child(p,'size');if(!at||!s)continue;
        const x=Number(at[1]),y=Number(at[2]),w=Number(s[1]),hh=Number(s[2]),angle=-(Number(at[3]||0)-sourceAngle);
        if([x,y,w,hh,angle].every(Number.isFinite))graphics.push(`<rect x="${x-w/2}" y="${y-hh/2}" width="${w}" height="${hh}" transform="rotate(${angle} ${x} ${y})" rx=".12" fill="#baae6d" opacity=".8"/>`);
      }
      for(const p of K.children(f,'fp_line')){
        const a=K.child(p,'start'),b=K.child(p,'end');if(a&&b&&[+a[1],+a[2],+b[1],+b[2]].every(Number.isFinite))graphics.push(`<path d="M${+a[1]} ${+a[2]}L${+b[1]} ${+b[2]}" fill="none" stroke="#b3c3c5" stroke-width=".12"/>`);
      }
      for(const p of K.children(f,'fp_rect')){
        const a=K.child(p,'start'),b=K.child(p,'end');if(a&&b)graphics.push(`<rect x="${Math.min(+a[1],+b[1])}" y="${Math.min(+a[2],+b[2])}" width="${Math.abs(a[1]-b[1])}" height="${Math.abs(a[2]-b[2])}" fill="none" stroke="#a7babc" stroke-width=".1"/>`);
      }
      fpCache.set(h.id,graphics.join(''));
    }
    return fpCache.get(h.id);
  }
  function renderCanvas(){
    if(!generated)return;svg.setAttribute('viewBox',`${view.x} ${view.y} ${view.w} ${view.h}`);svg.setAttribute('preserveAspectRatio','none');
    const px=view.w/(svg.clientWidth||800),hit=6*px,mark=Math.max(1,3*px);
    let s=`<defs><pattern id="grid" width="${model.board.grid*5}" height="${model.board.grid*5}" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="${Math.max(.12,px*.65)}" fill="#668b93" opacity=".38"/></pattern><pattern id="outside" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M0 10L10 0" stroke="#26323a" stroke-width=".25"/></pattern></defs><rect x="${view.x}" y="${view.y}" width="${view.w}" height="${view.h}" fill="url(#outside)"/>
      <rect x="0" y="0" width="${model.board.width}" height="${model.board.height}" rx="1.5" fill="${preview?'#092328':'#11262c'}" stroke="#a8c1c7" stroke-width="${px}"/>
      ${showGrid&&!preview?`<rect x="0" y="0" width="${model.board.width}" height="${model.board.height}" fill="url(#grid)" pointer-events="none"/>`:''}`;
    for(const p of generated.paths){const d=`M${p.c[0].x},${p.c[0].y}C${p.c.slice(1).map(p=>`${p.x},${p.y}`).join(' ')}`,sel=selected.has(p.e.id);
      s+=`<path d="${d}" stroke="${preview?'#c7ccba':sel?'#9becf4':C.COLORS[p.e.channel-1]}" stroke-width="${sel?.65:.23}" fill="none" opacity="${preview?.6:.65}" ${p.e.dotted?'stroke-dasharray="1 .8"':''}/>`;
      if(!preview)s+=`<path class="e-hit" data-edge="${p.e.id}" d="${d}" stroke="transparent" stroke-width="${hit}" fill="none"/>`;
    }
    for(const l of generated.leds){
      const lit=preview&&l.index%13===0,color=lit?C.COLORS[l.channel-1]:'#d5b76e';
      s+=`<g pointer-events="none" transform="translate(${l.x} ${l.y}) rotate(${l.angle})"><rect x="-.8" y="-.75" width="1.6" height="1.5" rx=".18" fill="${preview?(lit?color:'#143237'):'#685532'}" stroke="${color}" stroke-width=".12" ${lit?'style="filter:drop-shadow(0 0 1.7px '+color+')"':''}/><rect x="-.35" y="-.3" width=".7" height=".6" rx=".12" fill="${lit?'#e6faff':'#af9966'}" opacity="${preview&&!lit?.15:.7}"/></g>`;
    }
    if(showCaps&&!preview)for(const c of generated.caps)s+=`<g data-hw="${c.id}" transform="translate(${c.x} ${c.y}) rotate(${-c.angle})"><rect x="-.5" y="-.25" width="1" height=".5" fill="#e49b67"/><rect x="${-Math.max(.8,hit/2)}" y="${-Math.max(.5,hit/2)}" width="${Math.max(1.6,hit)}" height="${Math.max(1,hit)}" fill="transparent" stroke="${selected.has(c.id)?'#b7f9ff':'transparent'}" stroke-width=".2"/></g>`;
    for(const n of model.nodes){
      const sel=selected.has(n.id);if(n.name){const p=C.point(n,(n.tracks-1)/2);
        s+=`<rect data-node="${n.id}" class="n-hit" transform="translate(${p.x} ${p.y}) rotate(${n.angle})" x="-1.25" y="${-(n.tracks-1)*n.pitch/2-1.1}" width="2.5" height="${(n.tracks-1)*n.pitch+2.2}" rx="1" fill="transparent" stroke="${sel?'#b7f9ff':'#d1d9c3'}" stroke-width="${sel?.45:.25}"/>`;
        if(showLabels){const lines=(n.labelText??n.name).split('\n'),x=n.x+n.labelDx,y=n.y+n.labelDy;
          s+=`<text class="canvas-label" data-label="${n.id}" x="${x}" y="${y}" transform="rotate(${n.labelAngle} ${x} ${y})" text-anchor="middle" dominant-baseline="middle" fill="${sel?'#b7f9ff':'#ebefdc'}" font-family="Arial, sans-serif" font-size="${n.labelSize}" font-weight="500">${lines.map((line,j)=>`<tspan x="${x}" y="${y+(j-(lines.length-1)/2)*n.labelSize*1.2}">${esc(line)}</tspan>`).join('')}</text>`;}
      }
      if(!preview&&(showNodes||sel||n.name))s+=`<circle data-node="${n.id}" class="n-hit" cx="${n.x}" cy="${n.y}" r="${mark}" fill="${sel?'#8eebf533':showNodes?'#79adb91a':'transparent'}" stroke="${sel?'#befaff':showNodes?'#79adb9':'transparent'}" stroke-width="${px}"/>`;
    }
    if(showHardware)for(const h of model.hardware){const sel=selected.has(h.id),transform=`translate(${h.x} ${h.y}) rotate(${h.kind==='existing'||h.raw?-h.angle:h.angle})`;
      if(h.kind==='existing'||h.raw)s+=`<g class="hardware-raw" transform="${transform}" data-hw="${h.id}">${fpGraphic(h)}<rect x="${-h.w/2}" y="${-h.h/2}" width="${h.w}" height="${h.h}" fill="transparent" stroke="${sel?'#b7f9ff':'transparent'}" stroke-width=".5"/></g>`;
      else if(h.kind==='hole')s+=`<g data-hw="${h.id}"><circle cx="${h.x}" cy="${h.y}" r="${h.w/2}" fill="#10181e" stroke="${sel?'#b7f9ff':'#bab6a7'}" stroke-width=".4"/></g>`;
      else s+=`<g transform="${transform}" data-hw="${h.id}" style="cursor:move"><rect x="${-h.w/2}" y="${-h.h/2}" width="${h.w}" height="${h.h}" rx=".6" class="pending-shape"/>${h.kind==='oled'?`<rect x="${-h.activeW/2}" y="${-h.activeH/2}" width="${h.activeW}" height="${h.activeH}" fill="#050f14" stroke="#3d8999" stroke-width=".25"/><text x="0" y="-3.3" text-anchor="middle" fill="#9ee3fb" font-size="1.75" font-family="monospace">STATION INFO</text><text x="0" y=".5" text-anchor="middle" fill="#9ee3fb" font-size="1.6" font-family="monospace">OLED reservation</text><text x="0" y="4" text-anchor="middle" fill="#79a6b7" font-size="1.35" font-family="monospace">Part not assigned</text>`:`<circle cx="0" cy="0" r="${Math.min(h.w,h.h)*.3}" fill="#3f5157" stroke="#c9d5d7" stroke-width=".3"/><path d="M0 -${h.h*.26}V-${h.h*.1}" stroke="#dce6e6" stroke-width=".5"/>`}<text x="0" y="${h.h/2+2.5}" text-anchor="middle" fill="#d6c6a4" font-size="1.65">${esc(h.ref)} · ${esc(h.kind)}</text>${sel?`<rect x="${-h.w/2-1}" y="${-h.h/2-1}" width="${h.w+2}" height="${h.h+2}" class="selected-outline"/>`:''}</g>`;
    }
    if(!preview)for(const id of selected){const e=edge(id);if(e){const c=C.curve(model,e,e.lanes[Math.floor(e.lanes.length/2)]),p=e.waypoint||C.bezier(c,.5),r=5*px;
      s+=`<path data-bend="${id}" d="M${p.x},${p.y-r}L${p.x+r},${p.y}L${p.x},${p.y+r}L${p.x-r},${p.y}Z" fill="#d2faff" stroke="#30454d" stroke-width="${px}" style="cursor:move"/>`;}}
    if(drag?.type==='marquee'&&drag.current){const a=drag.p,b=drag.current;s+=`<rect x="${Math.min(a.x,b.x)}" y="${Math.min(a.y,b.y)}" width="${Math.abs(a.x-b.x)}" height="${Math.abs(a.y-b.y)}" fill="#7ce9ed20" stroke="#9af4f7" stroke-width="${px}" pointer-events="none"/>`;}
    svg.innerHTML=s;
    $('#ledCount').textContent=generated.leds.length.toLocaleString();$('#stationCount').textContent=model.nodes.filter(n=>n.name).length;
    $('#boardSize').textContent=`${fmt(model.board.width)} × ${fmt(model.board.height)} mm`;$('#zoomLevel').textContent=`${Math.round(100/px)}%`;
    $('#checksButton').textContent=`${issues.filter(i=>i.level==='error').length} layout issues`;
    $('#viewBadge').textContent=preview?'Appearance preview · sample lights, not live trains':'PCB layout · millimetres';
    wrap.classList.toggle('pan',tool==='pan'||space);
  }
  function setTool(t){tool=t;connectStart=null;document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===t));$('#canvasHelp').textContent=t==='connect'?'Click the first station or node, then the second.':'Drag to move · Wheel to zoom · Space + drag to pan · Drag empty space to select a group · Shift-click to add';renderCanvas();}
  function modal(title,html){$('#modalHost').innerHTML=`<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="close-row"><h2>${title}</h2><button data-action="closeModal" aria-label="Close dialog">×</button></div>${html}</section></div>`;$('#modalHost button')?.focus();}
  function closeModal(){$('#modalHost').innerHTML='';}
  function addStation(catalog){mutate(()=>{
    const n=C.makeNode(catalog?.name||'New station',snapped(view.x+view.w/2),snapped(view.y+view.h/2),2,1);
    if(catalog){n.stationId=catalog.stationId;n.platforms=C.clone(catalog.platforms);}
    C.addNode(model,n);selected=new Set([n.id]);});showUnplaced=false;renderLeft();}
  function addHardware(kind){mutate(()=>{const oled=kind==='oled';const h={id:C.id(kind),kind,ref:nextRef(oled?'OLED':kind==='encoder'?'ENC':'MH'),name:oled?'Bare OLED · part pending':kind==='encoder'?'Push rotary encoder · part pending':'Mounting hole',x:snapped(view.x+view.w/2),y:snapped(view.y+view.h/2),angle:0,w:oled?35:kind==='hole'?3.2:16,h:oled?25:kind==='hole'?3.2:16,locked:false};if(oled){h.activeW=29;h.activeH=14;}model.hardware.push(h);selected=new Set([h.id]);});}
  function deleteSelection(){
    const targets=[...selected].filter(id=>item(id));if(!targets.length)return;
    if(targets.some(id=>capacitor(id))){toast('Capacitors are generated from LED groups. Use Reset automatic placement or change the grouping in Board.');return;}
    if(targets.some(id=>hardware(id)?.kind==='existing')){toast('Inherited circuit components are protected. You can move them, but not silently delete them.');return;}
    if(!confirm(`Delete ${targets.length} selected object(s) and attached connections? Undo will restore them.`))return;
    mutate(()=>{model.nodes=model.nodes.filter(n=>!selected.has(n.id));model.edges=model.edges.filter(e=>!selected.has(e.id)&&!selected.has(e.a)&&!selected.has(e.b));model.hardware=model.hardware.filter(h=>!selected.has(h.id));selected.clear();});
  }
  async function exportProject(){
    if(exporting)return;exporting=true;
    closeModal();modal('Generating KiCad project','<div class="progress">Generating linked PCB, schematics and mapping files…</div>');
    await new Promise(r=>setTimeout(r,50));
    try{
      const out=K.makeExports(model,A),zip=new JSZip();out.files['layout-preview.svg']=previewSvg();
      for(const [name,body] of Object.entries(out.files))zip.file(name,body);
      const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:5}});
      saveFile(fileSlug()+'-kicad.zip',blob,'application/zip');closeModal();toast('KiCad project exported. Read EXPORT-REVIEW.md before editing or ordering.');
    }catch(e){closeModal();toast('Export failed: '+e.message);}finally{exporting=false;}
  }
  function previewSvg(){const old=view,oldPreview=preview,oldSelection=selected;try{
    view={x:0,y:0,w:model.board.width,h:model.board.height};preview=true;selected=new Set();renderCanvas();
    const copy=svg.cloneNode(true);copy.setAttribute('width',model.board.width+'mm');copy.setAttribute('height',model.board.height+'mm');
    const style=document.createElementNS('http://www.w3.org/2000/svg','style');style.textContent='.hardware-raw{opacity:.65}.pending-shape{stroke:#f8c788;stroke-width:.35;stroke-dasharray:1.6 .8;fill:#735a2320}';copy.prepend(style);
    return new XMLSerializer().serializeToString(copy);
    }finally{view=old;preview=oldPreview;selected=oldSelection;renderCanvas();}}
  const actions={
    undo:()=>undo(),redo:()=>undo(true),save:saveProject,open:()=>$('#openFile').click(),fit:()=>fit(),fitSelection:()=>fit(boundsFor([...selected])),
    toggleLibrary:()=>$('#leftPanel').classList.toggle('collapsed'),toggleInspector:()=>$('#rightPanel').classList.toggle('collapsed'),
    closeModal,preview:()=>{preview=!preview;renderCanvas();},checks:()=>{selected=new Set(['__checks']);renderInspector();$('#rightPanel').classList.remove('collapsed');},
    camberwell:()=>{const ns=model.nodes.filter(n=>['camberwell','east camberwell','canterbury','chatham','union','box hill'].includes(C.norm(n.name)));fit(boundsFor(ns.map(n=>n.id)));},
    addStation:()=>addStation(),addOled:()=>addHardware('oled'),addEncoder:()=>addHardware('encoder'),addHole:()=>addHardware('hole'),
    addAll:()=>{const missing=A.catalog.filter(s=>!model.nodes.some(n=>C.norm(n.name)===C.norm(s.name)));if(!missing.length){toast('All source catalogue stations are placed.');return;}
      if(!confirm(`Place ${missing.length} missing source stations in a tray? They will need track connections and layout review.`))return;
      mutate(()=>{missing.forEach((s,i)=>{const n=C.makeNode(s.name,model.board.width-120+(i%4)*30,model.board.height-90+Math.floor(i/4)*15);n.stationId=s.stationId;n.platforms=s.platforms;n.region='Unconnected station tray';C.addNode(model,n);});});toast('Missing stations placed in the lower-right tray. Connect them to the correct route.');},
    allDensity:()=>{const n=Number($('#allDensity').value);if(!Number.isInteger(n)||n<0||n>30)return toast('Enter an integer from 0 to 30.');if(!confirm(`Set ${n} extra LEDs per lane on all ${model.edges.length} connections?`))return;mutate(()=>{model.edges.forEach(e=>{e.count=n;e.mode='count';});});},
    rebuildSpan:()=>{const ns=[...selected].map(node).filter(Boolean),count=Number($('#spanCount').value);if(ns.length!==2||!Number.isInteger(count)||count<0||count>300)return toast('Enter 0–300 intermediate LEDs per track.');mutate(()=>{const e=C.collapseSpan(model,ns[0],ns[1],count);selected=new Set([e.id]);});},
    selectBranch:()=>{const n=node([...selected][0]);if(!n)return;selected=new Set(model.nodes.filter(x=>x.region===n.region&&x.channel===n.channel).map(x=>x.id));render();},
    selectAllHardware:()=>{selected=new Set(model.hardware.map(h=>h.id));render();},
    selectController:()=>{const u=model.hardware.find(h=>h.ref==='U1');if(!u)return;selected=new Set(model.hardware.filter(h=>h.kind==='existing'&&Math.abs(h.x-u.x)<55&&Math.abs(h.y-u.y)<25).map(h=>h.id));render();fit(boundsFor([...selected]));},
    alignX:()=>mutate(()=>{const xs=[...selected].map(item).filter(i=>i.x!==undefined&&!i.locked);const avg=xs.reduce((s,i)=>s+i.x,0)/xs.length;xs.forEach(i=>i.x=snapped(avg));}),
    alignY:()=>mutate(()=>{const xs=[...selected].map(item).filter(i=>i.y!==undefined&&!i.locked);const avg=xs.reduce((s,i)=>s+i.y,0)/xs.length;xs.forEach(i=>i.y=snapped(avg));}),
    lock:()=>mutate(()=>{for(const id of selected){const i=editable(id);if(i)i.locked=!i.locked;}}),delete:deleteSelection,
    duplicate:()=>mutate(()=>{const n=node([...selected][0]);if(!n)return;const copy=C.clone(n);copy.id=C.id('n');copy.x+=10;copy.y+=10;copy.name+=' copy';copy.labelText=copy.name;copy.stationId='';copy.platforms=[];copy.locked=false;copy.ledIds=copy.ledIds.map(x=>x===null?null:-1);copy.original=false;C.addNode(model,copy);selected=new Set([copy.id]);}),
    straighten:()=>mutate(()=>{const e=edge([...selected][0]);if(e){e.waypoint=null;delete e.handles;}}),
    laneMapping:()=>{const text=$('#laneMapping').value;mutate(()=>{const e=edge([...selected][0]);e.lanes=text.split(',').map(s=>s.trim().split(':').map(v=>Number(v)-1));});},
    insertStation:()=>mutate(()=>{const e=edge([...selected][0]);if(e){const n=C.insertStation(model,e);selected=new Set([n.id]);}}),
    resetCap:()=>mutate(()=>{if(model.capPositions)delete model.capPositions[[...selected][0]];}),
    importFootprint:()=>{footprintTarget=null;$('#footprintFile').click();},
    assignFootprint:()=>{footprintTarget=[...selected][0];$('#footprintFile').click();},
    export:()=>modal('Export a real KiCad project',`<div class="note warning">Engineering handoff, not fabrication files. The PCB is unrouted. Exact OLED and encoder parts and their circuits are still required.</div><div class="export-option"><strong>KiCad project ZIP</strong><p class="muted">Placed LED footprints, eight real data chains, regenerated LED/capacitor schematics, preserved main/USB circuit, board edge and station artwork. Includes firmware/backend mapping files.</p><button data-action="confirmExport" class="primary">Download KiCad project</button></div><div class="export-option"><strong>Other formats</strong><div class="actions"><button data-action="svgExport">Appearance SVG</button><button data-action="mappingExport">LED mapping JSON</button><button data-action="save">Editable project JSON</button></div></div><p class="small muted">No native Altium export. KiCad files must be reviewed in KiCad before any manufacturing export. The original files in your forks are not modified.</p>`),
    confirmExport:exportProject,svgExport:()=>saveFile(fileSlug()+'.svg',previewSvg(),'image/svg+xml'),mappingExport:()=>{try{saveFile(fileSlug()+'-leds.json',JSON.stringify(K.mapping(model,A),null,2),'application/json');}catch(e){toast(e.message);}},
    new:()=>modal('Choose a starting project',`<p>Your current project is not replaced until you choose a preset. Save it first if needed.</p><div class="export-option"><strong>Victoria expansion</strong><p class="muted">Kea’s topology plus the regional branches from your reference map. Provisional regional track counts and layout.</p><button data-action="presetVictoria">Open Victoria expansion</button></div><div class="export-option"><strong>Original Kea topology</strong><p class="muted">All 1,042 LEDs and original track connections, with room for expansion.</p><button data-action="presetKea">Open Kea base</button></div><div class="export-option"><strong>Three-track spacing study</strong><p class="muted">Camberwell to Box Hill, seven intermediate LEDs per track. A small layout exercise, not a complete circuit.</p><button data-action="presetDemo">Open spacing study</button></div><button data-action="restore">Restore local autosave</button>`),
    presetVictoria:()=>loadPreset('victoria'),presetKea:()=>loadPreset('kea'),presetDemo:()=>loadPreset('demo'),
    restore:()=>{if(!replaceAllowed())return;try{const raw=localStorage.getItem(STORE);if(!raw)throw Error('No autosave found.');loadModel(JSON.parse(raw));closeModal();toast('Local autosave restored.');}catch(e){toast(e.message);}},
    help:()=>modal('Quick guide',`<p><strong>1. Shape the board.</strong> Open the Board tab, enter width and height in millimetres. Resizing never scales the LED footprints.</p><p><strong>2. Move stations.</strong> Find a station in the left panel. Drag its outlined track column; drag its name separately to position the label. Use Shift-click to select a group.</p><p><strong>3. Add more LEDs.</strong> Select two consecutive stations with Shift-click, then Rebuild span. Enter the number between the stations <em>on each track</em>. Seven intermediate columns on three tracks adds 21 LEDs.</p><p><strong>4. Shape tracks.</strong> Click a connection and drag its diamond. The inspector edits density, output chain and explicit lane mappings. Connect mode joins two existing stations.</p><p><strong>5. Position hardware.</strong> Use Hardware to locate the OLED, encoder, existing buttons, USB sockets and MCU. Select controller group to move its associated parts together. New OLED/encoder shapes do not imply an electrical design.</p><p><strong>6. Save and export.</strong> Save project downloads a reopenable JSON file. Export KiCad downloads a complete project and mapping files. Finish electrical design, routing, ERC and DRC before ordering.</p><table><tr><td>Wheel</td><td>Zoom at pointer</td></tr><tr><td>Space + drag / middle drag</td><td>Pan</td></tr><tr><td>Shift-click</td><td>Multi-select</td></tr><tr><td>Arrow keys / Shift + arrows</td><td>Nudge one / ten grid steps</td></tr><tr><td>Ctrl+Z / Ctrl+Shift+Z</td><td>Undo / redo</td></tr><tr><td>Ctrl+S / Ctrl+O</td><td>Save / open project</td></tr><tr><td>F / Escape</td><td>Fit selection / clear selection</td></tr></table><div class="note">No installation or internet connection is needed. Autosave is convenient but browser-specific; project JSON is your portable backup. Sample lights in Preview are not live data.</div>`)
  };
  function loadPreset(which){if(!replaceAllowed())return;const base=C.baseProject(A);model=which==='victoria'?C.addRegional(base,A):which==='demo'?C.example(base):base;model.preset=which;fpCache.clear();selected.clear();history=[];future=[];dirty=false;closeModal();regenerate();fit();scheduleSave();}
  function loadModel(m){C.validateSchema(m);
    // Inherited circuit geometry comes from the bundled trusted source snapshot.
    for(const h of m.hardware)if(h.kind==='existing'){const source=A.hardware.find(x=>x.id===h.id);if(!source)throw Error('Unknown inherited component '+h.id);delete h.raw;h.ref=source.ref;}
    for(const h of m.hardware)if(h.raw)K.footprintInfo(h.raw);
    C.generate(m);C.validateSchema(m);fpCache.clear();model=m;selected.clear();history=[];future=[];dirty=false;regenerate();fit();scheduleSave();}
  document.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.action){actions[b.dataset.action]?.();return;}
    if(b.dataset.tab){tab=b.dataset.tab;renderLeft();return;}
    if(b.dataset.tool){setTool(b.dataset.tool);return;}
    if(b.dataset.locate){select(b.dataset.locate,e.shiftKey,!e.shiftKey);$('#rightPanel').classList.remove('collapsed');return;}
    if(b.dataset.catalog){addStation(A.catalog.find(s=>s.stationId===b.dataset.catalog));return;}
  });
  document.addEventListener('input',e=>{if(e.target.id==='search'){query=e.target.value;renderLeft();}});
  document.addEventListener('change',e=>{
    const el=e.target,key=el.dataset.field;
    const toggles={unplaced:()=>{showUnplaced=el.checked;renderLeft();},snapToggle:()=>snap=el.checked,labelsToggle:()=>showLabels=el.checked,nodesToggle:()=>showNodes=el.checked,hardwareToggle:()=>showHardware=el.checked,capsToggle:()=>showCaps=el.checked,showGrid:()=>showGrid=el.checked};
    if(toggles[el.id]){toggles[el.id]();renderCanvas();return;}
    if(el.dataset.lane!==undefined){mutate(()=>{const n=node([...selected][0]),i=Number(el.dataset.lane);if(el.checked){const key=`${n.id}/lane/${i}`;n.ledIds[i]=model.registry[key]??model.nextBlock++;model.registry[key]=n.ledIds[i];}else n.ledIds[i]=null;});return;}
    if(el.dataset.pin!==undefined){mutate(()=>{const h=hardware([...selected][0]);if(h){h.pinNets??={};h.pinNets[el.dataset.pin]=el.value.trim();}});return;}
    if(!key)return;const value=el.type==='checkbox'?el.checked:el.type==='number'?Number(el.value):el.value;
    if(el.type==='number'&&(!Number.isFinite(value)||(el.min!==''&&value<Number(el.min))||(el.max!==''&&value>Number(el.max)))){toast('Value is outside the allowed range.');render();return;}
    mutate(()=>{
      if(key.startsWith('board.')){const k=key.slice(6);if(k==='name')model.name=value;else model.board[k]=value;}
      else if(key.startsWith('group.')){moveSelection(key==='group.dx'?Number(value):0,key==='group.dy'?Number(value):0);}
      else {const i=editable([...selected][0]);if(!i)return;if(key==='tracks'){C.changeTracks(model,i,Number(value));}
        else if(key==='name'&&node(i.id)){i.name=value;i.labelText=value;}
        else i[key]=['channel'].includes(key)?Number(value):value;}
    });
  });
  svg.addEventListener('pointerdown',e=>{
    if(e.button===2)e.preventDefault();const p=world(e),el=e.target.closest('[data-node],[data-label],[data-hw],[data-edge],[data-bend]');
    if(tool==='pan'||space||e.button===1||e.button===2){drag={type:'pan',p,view:{...view},client:{x:e.clientX,y:e.clientY}};svg.setPointerCapture(e.pointerId);wrap.classList.add('dragging');return;}
    if(preview)return;
    if(!el){drag={type:'marquee',p,current:p,previous:new Set(e.shiftKey?selected:[])};if(!e.shiftKey)selected.clear();svg.setPointerCapture(e.pointerId);render();return;}
    const d=el.dataset,id=d.node||d.label||d.hw||d.edge||d.bend;
    if(tool==='connect'&&(d.node||d.label)){
      if(!connectStart){connectStart=id;select(id);status('Now click the destination station/node');}
      else if(connectStart!==id){mutate(()=>{const a=node(connectStart),b=node(id);const e=C.makeEdge(a,b);model.edges.push(e);selected=new Set([e.id]);});setTool('select');}
      return;
    }
    if(d.edge){select(id,e.shiftKey);return;}
    if(e.shiftKey){select(id,true);return;}
    if(!selected.has(id))select(id);
    if(item(id)?.locked){toast('This object is locked. Unlock it in the inspector.');return;}
    drag={type:d.bend?'bend':d.label?'label':'move',id,p,before:snapshot(),original:new Map([...selected].filter(id=>item(id)).map(id=>[id,C.clone(item(id))]))};
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove',e=>{
    if(!drag)return;const p=world(e);
    if(drag.type==='pan'){const r=svg.getBoundingClientRect();view.x=drag.view.x-(e.clientX-drag.client.x)/r.width*view.w;view.y=drag.view.y-(e.clientY-drag.client.y)/r.height*view.h;renderCanvas();return;}
    if(drag.type==='marquee'){drag.current=p;const within=i=>i.x>=Math.min(p.x,drag.p.x)&&i.x<=Math.max(p.x,drag.p.x)&&i.y>=Math.min(p.y,drag.p.y)&&i.y<=Math.max(p.y,drag.p.y);
      selected=new Set([...drag.previous,...[...model.nodes,...(showHardware?model.hardware:[]),...(showCaps?generated.caps:[])].filter(within).map(i=>i.id)]);renderCanvas();return;}
    const dx=p.x-drag.p.x,dy=p.y-drag.p.y;
    if(drag.type==='label'){const n=node(drag.id),old=drag.original.get(drag.id);n.labelDx=snapped(old.labelDx+dx);n.labelDy=snapped(old.labelDy+dy);}
    else if(drag.type==='bend'){const e=edge(drag.id);e.waypoint={x:snapped(p.x),y:snapped(p.y)};delete e.handles;}
    else {model=JSON.parse(drag.before);moveSelection(snapped(dx),snapped(dy));}
    try{generated=C.generate(model);renderCanvas();}catch(err){model=JSON.parse(drag.before);drag=null;regenerate();toast(err.message);}
  });
  const dragEnd=()=>{if(!drag)return;const d=drag;drag=null;wrap.classList.remove('dragging');if(d.type==='marquee'){render();return;}if(d.type!=='pan'){try{C.validateSchema(model);changed(d.before);}catch(err){model=JSON.parse(d.before);regenerate();toast(err.message);}renderInspector();}};
  svg.addEventListener('pointerup',dragEnd);svg.addEventListener('pointercancel',cancelDrag);
  svg.addEventListener('contextmenu',e=>e.preventDefault());
  svg.addEventListener('wheel',e=>{e.preventDefault();const p=world(e),factor=Math.exp(Math.sign(e.deltaY)*.13),w=Math.max(12,Math.min(3000,view.w*factor)),actual=w/view.w;view={x:p.x+(view.x-p.x)*actual,y:p.y+(view.y-p.y)*actual,w,h:view.h*actual};renderCanvas();},{passive:false});
  document.addEventListener('keydown',e=>{
    const editing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||'');
    if(e.key==='Escape'){cancelDrag();closeModal();selected.clear();setTool('select');render();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveProject();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='o'){e.preventDefault();$('#openFile').click();return;}
    if(editing||$('#modalHost').children.length)return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo(e.shiftKey);return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();undo(true);return;}
    if(e.code==='Space'){e.preventDefault();space=true;renderCanvas();return;}
    if(e.key.toLowerCase()==='f'){fit(selected.size?boundsFor([...selected]):undefined);return;}
    if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteSelection();return;}
    if(e.key.startsWith('Arrow')){e.preventDefault();const delta=model.board.grid*(e.shiftKey?10:1);mutate(()=>moveSelection(e.key==='ArrowLeft'?-delta:e.key==='ArrowRight'?delta:0,e.key==='ArrowUp'?-delta:e.key==='ArrowDown'?delta:0));}
  });
  document.addEventListener('keyup',e=>{if(e.code==='Space'){space=false;renderCanvas();}});
  window.addEventListener('blur',()=>{space=false;dragEnd();});
  $('#openFile').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>15e6)throw Error('Project exceeds 15 MB.');if(!replaceAllowed())return;loadModel(JSON.parse(await file.text()));toast('Project opened.');}catch(err){toast(err.message);}finally{e.target.value='';}});
  $('#footprintFile').addEventListener('change',async e=>{const file=e.target.files[0],target=footprintTarget;footprintTarget=null;if(!file)return;try{
    if(file.size>500000)throw Error('Footprint exceeds 500 KB.');const raw=await file.text(),info=K.footprintInfo(raw);
    mutate(()=>{let h=target?hardware(target):null;if(target&&!h)throw Error('The selected component no longer exists.');
      if(!h){h={id:C.id('custom'),ref:nextRef('CUSTOM'),kind:'custom',x:snapped(view.x+view.w/2),y:snapped(view.y+view.h/2),angle:0,locked:false};model.hardware.push(h);}
      const oldNets=h.pinNets||{};Object.assign(h,{raw,name:info.name,w:Math.max(info.w,h.kind==='oled'?h.activeW:0),h:Math.max(info.h,h.kind==='oled'?h.activeH:0),pinNets:Object.fromEntries(info.pins.map(p=>[p,oldNets[p]||'']))});
      fpCache.delete(h.id);selected=new Set([h.id]);});toast('Footprint assigned. Set its verified pin nets in the inspector; the matching schematic symbol is included in export.');
    }catch(err){toast(err.message);}finally{e.target.value='';}});
  new ResizeObserver(()=>{const r=wrap.getBoundingClientRect();view.h=view.w*r.height/r.width;renderCanvas();}).observe(wrap);
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  // Exposed for deterministic automated tests and advanced local integrations.
  globalThis.RailStudio={get model(){return model;},get generated(){return generated;},get issues(){return issues;},get selection(){return [...selected];},get view(){return {...view};},previewSvg,select,actions,loadModel,loadPreset,saveProject,regenerate,fit};
  regenerate();fit();
  try{if(localStorage.getItem(STORE))status('Previous autosave available under Projects → Restore local autosave');}catch{}
})();
