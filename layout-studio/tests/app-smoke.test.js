/* DOM-contract smoke tests. No browser/layout engine: visual browser QA is separate. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function launch(){
  const downloads=[],blobs=new Map(),local=new Map(),windowHandlers={};let confirmResult=true;
  class El{
    constructor(id=''){this.id=id;this.attrs={};this.innerHTML='';this.children=[];this.dataset={};this.style={};this.value='';this.type='';this.min='';this.max='';this.handlers={};this.clientWidth=1100;this.classList={add(){},remove(){},toggle(){}};}
    querySelector(){return null;}setAttribute(k,v){this.attrs[k]=v;}getBoundingClientRect(){return {x:0,y:0,left:0,top:0,width:1100,height:760};}
    addEventListener(k,fn){this.handlers[k]=fn;}focus(){}click(){if(this.download)downloads.push({name:this.download,blob:blobs.get(this.href)});}setPointerCapture(){}cloneNode(){const n=new El();n.attrs={...this.attrs};n.innerHTML=this.innerHTML;return n;}
    prepend(el){this.innerHTML='<style>'+el.textContent+'</style>'+this.innerHTML;}
  }
  const elements=new Map(),handlers={},timers=[];
  const find=s=>{if(!elements.has(s))elements.set(s,new El(s.slice(1)));return elements.get(s);};
  const document={activeElement:null,querySelector:find,querySelectorAll:()=>[],createElement:()=>new El(),createElementNS:()=>new El(),addEventListener:(k,fn)=>handlers[k]=fn};
  const context={console,document,STUDIO_ASSETS:JSON.parse(fs.readFileSync(path.join(root,'assets.json'))),setTimeout:(fn,delay)=>{if(delay===50)return setTimeout(fn,0);timers.push(fn);return timers.length;},clearTimeout(id){if(Number.isInteger(id))timers[id-1]=null;},
    Blob,URL:{createObjectURL:blob=>{const id='blob:'+blobs.size;blobs.set(id,blob);return id;},revokeObjectURL:id=>blobs.delete(id)},JSZip:require('../vendor/jszip.min.js'),
    localStorage:{getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value)},confirm:()=>confirmResult,ResizeObserver:class{observe(){}},
    XMLSerializer:class{serializeToString(el){return '<svg xmlns="http://www.w3.org/2000/svg" '+Object.entries(el.attrs).map(([k,v])=>`${k}="${v}"`).join(' ')+'>'+el.innerHTML+'</svg>';}}};
  context.window={addEventListener:(k,fn)=>windowHandlers[k]=fn};vm.createContext(context);
  for(const f of ['core.js','cad.js','app.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),context,{filename:f});
  function field(name,value,type='number'){const el=new El();el.dataset.field=name;el.value=value;el.type=type;handlers.change({target:el});}
  const app=context.RailStudio;
  function pointer(type,p,dataset={},extra={}){const v=app.view;find('#canvas').handlers[type]({clientX:(p.x-v.x)/v.w*1100,clientY:(p.y-v.y)/v.h*760,button:0,pointerId:1,preventDefault(){},target:{closest:()=>Object.keys(dataset).length?{dataset}:null},...extra});}
  function key(key,extra={}){handlers.keydown({key,code:key===' '?'Space':key,preventDefault(){},...extra});}
  return {context,app,find,field,handlers,pointer,key,downloads,local,windowHandlers,timers,setConfirm:value=>confirmResult=value};
}
test('app boot, station editing, undo/redo, board size, hardware movement and density actions',()=>{
  const {app,find,field}=launch();assert.equal(app.model.nodes.filter(n=>n.name).length,321);assert.ok(find('#canvas').innerHTML.includes('Bairnsdale'));
  const station=app.model.nodes.find(n=>n.name==='Canterbury'),id=station.id,old=station.x;app.select(id);field('x',old+12);
  assert.equal(app.model.nodes.find(n=>n.id===id).x,old+12);app.actions.undo();assert.equal(app.model.nodes.find(n=>n.id===id).x,old);
  app.actions.redo();assert.equal(app.model.nodes.find(n=>n.id===id).x,old+12);
  field('board.width',750);assert.equal(app.model.board.width,750);assert.ok(find('#canvas').innerHTML.includes('width="750"'));
  app.select('oled1');field('x',600);field('w',40);assert.equal(app.model.hardware.find(h=>h.id==='oled1').x,600);
  assert.ok(find('#canvas').innerHTML.includes('translate(600 405)'));
  const b=app.model.nodes.find(n=>n.name==='East Camberwell');app.select(b.id);app.select(id,true);find('#spanCount').value='7';app.actions.rebuildSpan();
  const span=app.model.edges.find(e=>e.a===b.id&&e.b===id);assert.ok(span);assert.equal(app.generated.leds.filter(l=>l.edgeId===span.id).length,21);
  assert.ok(find('#inspector').innerHTML.includes('Added LEDs'));assert.ok(!find('#canvas').innerHTML.includes('NaN'));
});
test('invalid edits roll back; all preset actions produce valid projects; import/export data round-trips',()=>{
  const {app,field,context,find}=launch();field('board.grid',0);assert.equal(app.model.board.grid,1);assert.match(find('#toast').textContent,/Invalid project/);
  for(const preset of ['kea','demo','victoria']){app.loadPreset(preset);context.RailCore.validateSchema(app.model);assert.ok(app.generated.leds.length);}
  const json=JSON.stringify(app.model);app.loadModel(JSON.parse(json));assert.equal(JSON.stringify(app.model),json);
  app.actions.addHole();assert.ok(app.model.hardware.some(h=>h.kind==='hole'));app.actions.addStation();assert.ok(app.model.nodes.some(n=>n.name==='New station'));
});
// Optional static SVG from the actual app renderer, for geometry inspection only.
if(process.env.RAIL_STUDIO_RENDER){const {app,find}=launch();app.loadPreset('demo');app.actions.fit();app.actions.preview();
  const svg=find('#canvas');fs.writeFileSync(process.env.RAIL_STUDIO_RENDER,`<svg xmlns="http://www.w3.org/2000/svg" width="1320" height="912" viewBox="${svg.attrs.viewBox}"><style>.pending-shape{stroke:#f8c788;stroke-width:.35;stroke-dasharray:1.6 .8;fill:#735a2320}</style>${svg.innerHTML}</svg>`);}


test('pointer group drag, marquee selection, keyboard nudge, cancel and undo retain exact spacing',()=>{
  const {app,pointer,key}=launch();app.loadPreset('demo');const [a,b]=app.model.nodes;a.x+=.3;b.x+=.6;app.model.edges[0].waypoint={x:29.5,y:22};app.regenerate();
  pointer('pointerdown',{x:10,y:25});pointer('pointermove',{x:46,y:35});pointer('pointerup',{x:46,y:35});
  assert.equal(app.selection.length,2);assert.ok(app.selection.includes(a.id)&&app.selection.includes(b.id));
  const original=app.model.nodes.slice(0,2).map(n=>({id:n.id,x:n.x,y:n.y}));
  pointer('pointerdown',a,{node:a.id});pointer('pointermove',{x:a.x+3.1,y:a.y+4.2});pointer('pointerup',{x:a.x+3.1,y:a.y+4.2});
  for(const n of original){const now=app.model.nodes.find(x=>x.id===n.id);assert.ok(Math.abs(now.x-n.x-3)<1e-8);assert.ok(Math.abs(now.y-n.y-4)<1e-8);}
  assert.equal(app.model.edges[0].waypoint.x,32.5);assert.equal(app.model.edges[0].waypoint.y,26);
  key('ArrowRight',{shiftKey:true});assert.equal(app.model.edges[0].waypoint.x,42.5);app.actions.undo();assert.equal(app.model.edges[0].waypoint.x,32.5);
  const before=JSON.stringify(app.model),n=app.model.nodes[0];pointer('pointerdown',n,{node:n.id});pointer('pointermove',{x:n.x+8,y:n.y+1});pointer('pointercancel',n);assert.equal(JSON.stringify(app.model),before);
  const labelBefore={x:n.labelDx,y:n.labelDy};app.select(n.id);pointer('pointerdown',n,{label:n.id});pointer('pointermove',{x:n.x+2,y:n.y+3});pointer('pointerup',n);
  assert.equal(app.model.nodes[0].labelDx,labelBefore.x+2);assert.equal(app.model.nodes[0].labelDy,labelBefore.y+3);
});

test('capacitor edits, station insertion and part references survive save and reload',()=>{
  const {app,field}=launch();app.loadPreset('demo');const old=app.generated.leds.length;app.select(app.model.edges[0].id);app.actions.insertStation();assert.equal(app.generated.leds.length,old);
  const cap=app.generated.caps[0];app.select(cap.id);field('x',12.5);field('angle',90);assert.equal(app.generated.caps.find(c=>c.id===cap.id).x,12.5);
  const save=JSON.stringify(app.model);app.loadModel(JSON.parse(save));assert.equal(app.generated.caps.find(c=>c.id===cap.id).angle,90);
  app.select(cap.id);app.actions.resetCap();assert.equal(app.model.capPositions[cap.id],undefined);
  app.actions.addHole();const id=app.selection[0];app.actions.addHole();app.select(id);app.actions.delete();app.actions.addHole();
  const refs=app.model.hardware.map(h=>h.ref);assert.equal(new Set(refs).size,refs.length);
});

test('footprint assignment and pad-net edits flow through the same UI handlers used by file import',async()=>{
  const {app,find,handlers}=launch();app.loadPreset('demo');app.select('encoder1');app.actions.assignFootprint();
  const raw='(footprint "Test:Encoder" (layer "F.Cu") (pad "A" thru_hole circle (at -2 0) (size 1.5 1.5) (drill .8) (layers "*.Cu" "*.Mask")) (pad "B" thru_hole circle (at 2 0) (size 1.5 1.5) (drill .8) (layers "*.Cu" "*.Mask")))';
  await find('#footprintFile').handlers.change({target:{files:[{size:raw.length,text:async()=>raw}],value:'import'}});
  const h=app.model.hardware.find(h=>h.id==='encoder1');assert.equal(h.raw,raw);assert.ok(find('#inspector').innerHTML.includes('data-pin="A"'));
  handlers.change({target:{dataset:{pin:'A'},value:'GND'}});assert.equal(h.pinNets.A,'GND');
  handlers.change({target:{dataset:{pin:'B'},value:'NC'}});assert.equal(h.pinNets.B,'NC');
  app.actions.undo();assert.equal(app.model.hardware.find(h=>h.id==='encoder1').pinNets.B,'');
});

test('downloaded JSON reopens, SVG has physical dimensions, actual ZIP contains native projects',async()=>{
  const {app,find,downloads,context}=launch();app.loadPreset('demo');app.select(app.model.nodes[0].id);app.saveProject();
  const saved=downloads.at(-1);assert.match(saved.name,/\.rail\.json$/);const json=await saved.blob.text();app.loadModel(JSON.parse(json));
  app.actions.svgExport();const svg=await downloads.at(-1).blob.text();assert.match(svg,/width="180mm"/);assert.match(svg,/height="90mm"/);assert.ok(!svg.includes('selected-outline'));
  await app.actions.confirmExport();const file=downloads.at(-1);assert.match(file.name,/-kicad.zip$/);
  const zip=await context.JSZip.loadAsync(await file.blob.arrayBuffer());
  for(const name of ['KiCad/Melbourne-Live-Train-Map.kicad_pcb','KiCad/Melbourne-Live-Train-Map.kicad_sch','mapping/led-manifest.json','layout.rail.json','layout-preview.svg'])assert.ok(zip.file(name),name);
  const manifest=JSON.parse(await zip.file('mapping/led-manifest.json').async('string'));assert.equal(manifest.leds.length,123);
  assert.equal(find('#modalHost').innerHTML,'');assert.ok(!find('#toast').textContent.includes('failed'));
});

test('file open and autosave restore protect unsaved edits; malformed imports leave the layout intact',async()=>{
  const {app,find,field,setConfirm,local}=launch();app.loadPreset('demo');const saved=JSON.stringify(app.model);field('board.width',250);setConfirm(false);
  const file={size:saved.length,text:async()=>saved};await find('#openFile').handlers.change({target:{files:[file],value:'open'}});assert.equal(app.model.board.width,250);
  local.set('victoria-rail-layout-v1',saved);app.actions.restore();assert.equal(app.model.board.width,250);
  setConfirm(true);app.actions.restore();assert.equal(app.model.board.width,180);
  const before=JSON.stringify(app.model);await find('#openFile').handlers.change({target:{files:[{size:3,text:async()=>'{]'}],value:'open'}});assert.equal(JSON.stringify(app.model),before);
});
