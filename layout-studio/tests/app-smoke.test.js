/* DOM-contract smoke tests. No browser/layout engine: visual browser QA is separate. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function launch(){
  class El{
    constructor(id=''){this.id=id;this.attrs={};this.innerHTML='';this.children=[];this.dataset={};this.style={};this.value='';this.type='';this.min='';this.max='';this.handlers={};this.clientWidth=1100;this.classList={add(){},remove(){},toggle(){}};}
    querySelector(){return null;}setAttribute(k,v){this.attrs[k]=v;}getBoundingClientRect(){return {x:0,y:0,left:0,top:0,width:1100,height:760};}
    addEventListener(k,fn){this.handlers[k]=fn;}focus(){}click(){}setPointerCapture(){}cloneNode(){const n=new El();n.attrs={...this.attrs};n.innerHTML=this.innerHTML;return n;}
    prepend(el){this.innerHTML='<style>'+el.textContent+'</style>'+this.innerHTML;}
  }
  const elements=new Map(),handlers={},timers=[];
  const find=s=>{if(!elements.has(s))elements.set(s,new El(s.slice(1)));return elements.get(s);};
  const document={activeElement:null,querySelector:find,querySelectorAll:()=>[],createElement:()=>new El(),createElementNS:()=>new El(),addEventListener:(k,fn)=>handlers[k]=fn};
  const context={console,document,STUDIO_ASSETS:JSON.parse(fs.readFileSync(path.join(root,'assets.json'))),setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},
    localStorage:{getItem:()=>null,setItem(){}},confirm:()=>true,ResizeObserver:class{observe(){}},
    XMLSerializer:class{serializeToString(el){return '<svg xmlns="http://www.w3.org/2000/svg" '+Object.entries(el.attrs).map(([k,v])=>`${k}="${v}"`).join(' ')+'>'+el.innerHTML+'</svg>';}}};
  context.window={addEventListener(){}};vm.createContext(context);
  for(const f of ['core.js','cad.js','app.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),context,{filename:f});
  function field(name,value,type='number'){const el=new El();el.dataset.field=name;el.value=value;el.type=type;handlers.change({target:el});}
  return {context,app:context.RailStudio,find,field,handlers};
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
