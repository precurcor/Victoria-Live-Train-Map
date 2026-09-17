/* Run: node --test layout-studio/tests/core.test.js. No npm packages needed. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const A=require('../assets.json');require('../core.js');require('../cad.js');
const C=globalThis.RailCore,K=globalThis.RailCAD;
const prop=(s,key)=>K.val(K.property(s,key)?.[2]);
const close=(a,b,tol=.000003)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
const circular=(a,b)=>((a-b+540)%360)-180;

test('all 1,042 source LEDs retain exact geometry, rotation, IDs and supply domains',()=>{
  const m=C.baseProject(A);C.validateSchema(m);const g=C.generate(m);
  assert.equal(g.leds.length,1042);assert.deepEqual(g.channelCounts,[217,150,154,147,117,160,75,22]);
  assert.equal(new Set(g.leds.map(l=>l.block)).size,1042);
  for(const l of g.leds){const o=A.originalLeds.find(o=>o.ref===l.ref);assert.ok(o,l.ref);
    close(l.x,o.at[0]+110);close(l.y,o.at[1]+145);close(circular(l.rotation,o.at[2]||0),0);assert.equal(l.supply,o.supply);}
});

test('Victoria includes the full 320-station source catalogue and West Tarneit from the reference map',()=>{
  const m=C.addRegional(C.baseProject(A),A);C.generate(m);C.validateSchema(m);
  assert.equal(m.nodes.filter(n=>n.name).length,321);
  for(const s of A.catalog)assert.ok(m.nodes.some(n=>n.stationId===s.stationId),s.name);
  const west=m.nodes.find(n=>n.name==='West Tarneit');assert.equal(west.stationId,'');assert.equal(west.original,false);
  assert.ok(m.nodes.find(n=>n.name==='Bairnsdale'));assert.ok(m.nodes.find(n=>n.name==='Warrnambool'));assert.ok(m.nodes.find(n=>n.name==='Albury'));
});

test('three tracks with seven intermediate columns create 21 LEDs per span',()=>{
  const m=C.example(C.baseProject(A)),g=C.generate(m);C.validateSchema(m);
  assert.equal(g.leds.length,123);assert.equal(g.leds.filter(l=>l.edgeId===m.edges[0].id).length,21);
  for(const e of m.edges){const ls=g.leds.filter(l=>l.edgeId===e.id);
    for(let i=0;i<7;i++){const col=ls.filter(l=>Math.abs(l.fraction-(i+1)/8)<1e-9);assert.equal(col.length,3);
      close(col[0].x,col[1].x);close(col[1].x,col[2].x);close(Math.abs(col[0].y-col[1].y),2.5);}}
});

test('changing density, moving, saving and reopening retain allocated identities and retired IDs',()=>{
  const m=C.example(C.baseProject(A));let g=C.generate(m);const e=m.edges[0],old=g.leds.filter(l=>l.edgeId===e.id),allIds=new Set(g.leds.map(l=>l.block));
  e.count=3;C.generate(m);e.count=9;g=C.generate(m);
  for(const l of old)assert.equal(g.leds.find(n=>n.key===l.key).block,l.block);
  for(const l of g.leds.filter(l=>l.edgeId===e.id&&l.fraction>7/10))assert.ok(!allIds.has(l.block));
  m.nodes[1].x+=10;C.generate(m);const restored=JSON.parse(JSON.stringify(m));C.validateSchema(restored);
  assert.deepEqual(C.generate(restored),C.generate(m));
  e.mode='pitch';e.pitch=4;const counts=C.generate(m).paths.filter(p=>p.e.id===e.id).map(p=>p.count);
  assert.equal(new Set(counts).size,1);
});

test('curved bundles preserve lane order instead of swapping lanes at their midpoint',()=>{
  const m=C.example(C.baseProject(A)),e=m.edges[0];e.waypoint={x:29.5,y:22};
  const pts=e.lanes.map(l=>C.bezier(C.curve(m,e,l),.5));
  assert.ok(pts[0].y>pts[1].y&&pts[1].y>pts[2].y);
  assert.ok(C.generate(m).leds.every(l=>Number.isFinite(l.x)&&Number.isFinite(l.y)));
});

test('rebuilding a real three-track span preserves station blocks and protects the Camberwell junction',()=>{
  const m=C.baseProject(A),a=m.nodes.find(n=>n.name==='East Camberwell'),b=m.nodes.find(n=>n.name==='Canterbury');
  const kept=[...a.ledIds,...b.ledIds];const e=C.collapseSpan(m,a,b,7),g=C.generate(m);C.validateSchema(m);
  assert.equal(e.lanes.length,3);assert.equal(g.leds.filter(l=>l.edgeId===e.id).length,21);
  for(const block of kept.filter(v=>v!==null))assert.ok(g.leds.some(l=>l.block===block));
  assert.throws(()=>C.collapseSpan(m,m.nodes.find(n=>n.name==='Camberwell'),a,7),/Junctions/);
  assert.throws(()=>C.collapseSpan(m,a,m.nodes.find(n=>n.name==='Geelong')||m.nodes.find(n=>n.name==='Richmond'),4),/consecutive stations/);
});

test('track count changes and explicit junction mappings stay consistent',()=>{
  const m=C.example(C.baseProject(A));C.changeTracks(m,m.nodes[0],2);C.generate(m);C.validateSchema(m);assert.deepEqual(m.edges[0].lanes,[[0,0],[1,1]]);
  C.changeTracks(m,m.nodes[0],3);C.generate(m);C.validateSchema(m);assert.deepEqual(m.edges[0].lanes,[[0,0],[1,1],[2,2]]);
});

test('invalid projects and capacity overruns are rejected before export',()=>{
  const cases=[m=>m.board.grid=0,m=>m.nodes[0].id='"><script>',m=>m.nextBlock=2000,m=>m.nodes[0].ledIds[0]=100,m=>m.edges[0].lanes=[[0,9]],m=>m.hardware[0].activeW=999];
  for(const f of cases){const m=C.example(C.baseProject(A));C.generate(m);f(m);assert.throws(()=>C.validateSchema(m),/Invalid project/);}
  const m=C.addRegional(C.baseProject(A),A);m.edges.forEach(e=>e.count=300);assert.throws(()=>C.generate(m),/20,000 LED/);
  assert.throws(()=>K.makeExports(C.example(C.baseProject(A)),A),/complete KiCad export/);
});

test('rotation-aware boundary and OLED overlap checks find real mechanical conflicts',()=>{
  const m=C.example(C.baseProject(A));const oled=m.hardware[0];oled.x=12;oled.angle=90;
  assert.ok(C.checks(m,C.generate(m)).some(i=>i.target===oled.id&&/outside board/.test(i.message)));
  oled.x=30;oled.y=32;assert.ok(C.checks(m,C.generate(m)).some(i=>/reservation overlaps/.test(i.message)));
});

test('native project: complete hierarchy, matching pin nets/UUID paths, portable libraries, unchanged circuit',()=>{
  const m=C.addRegional(C.baseProject(A),A);const out=K.makeExports(m,A),files=out.files;
  assert.equal(files['KiCad/Melbourne-Live-Train-Map.kicad_sch'],A.rootSchematic);
  assert.equal(files['KiCad/USB.kicad_sch'],A.usbSchematic);
  const trees=new Map();for(const [name,s] of Object.entries(files))if(/\.kicad_(sch|pcb|mod|sym)$/.test(name)||name.endsWith('lib-table'))trees.set(name,K.parse(s));
  const pcb=trees.get('KiCad/Melbourne-Live-Train-Map.kicad_pcb'),fps=K.children(pcb,'footprint');
  assert.equal(K.children(pcb,'segment').length+K.children(pcb,'via').length+K.children(pcb,'zone').length,0);
  const generatedRefs=new Set([...out.g.leds,...out.g.caps].map(l=>l.ref));
  assert.equal(fps.length,out.g.leds.length+out.g.caps.length+A.hardware.length);
  const refs=new Map(fps.filter(f=>generatedRefs.has(prop(f,'Reference'))).map(f=>[prop(f,'Reference'),f]));
  assert.equal(refs.size,generatedRefs.size);
  const pinNet=(f,p)=>K.val(K.child(K.children(f,'pad').find(x=>K.val(x[1])===p),'net')[2]);
  for(let ch=1;ch<=8;ch++){const chain=out.manifest.filter(l=>l.channel===ch);
    chain.forEach((l,i)=>{assert.equal(l.index,i);const f=refs.get(l.ref);assert.equal(pinNet(f,'4'),i?chain[i-1].dout:`LED_DATA_5V_CH${ch}`);
      assert.equal(pinNet(f,'1'),l.dout);assert.equal(pinNet(f,'2'),l.supply);assert.equal(pinNet(f,'3'),'GND');
      assert.equal(K.val(K.child(f,'path')[1]),l.schematicPath);assert.equal(K.val(f[1]),'Studio:XL1615');});}
  const hierarchy=new Map();
  function walk(file,instance){const tree=trees.get('KiCad/'+file);assert.ok(tree,file);
    for(const sym of K.children(tree,'symbol'))hierarchy.set(instance+'/'+K.val(K.child(sym,'uuid')[1]),{sym,tree,instance});
    for(const sheet of K.children(tree,'sheet'))walk(prop(sheet,'Sheetfile'),instance+'/'+K.val(K.child(sheet,'uuid')[1]));}
  walk('Melbourne-Live-Train-Map.kicad_sch','/'+A.rootUuid);
  for(const [ref,f] of refs){const p=K.val(K.child(f,'path')[1]),target=hierarchy.get(p);assert.ok(target,ref+' linked symbol');assert.equal(prop(target.sym,'Reference'),ref);
    assert.equal(prop(target.sym,'Footprint'),K.val(f[1]));const at=K.child(target.sym,'at'),x=+at[1],y=+at[2];
    const library=K.children(K.child(target.tree,'lib_symbols'),'symbol').find(s=>K.val(s[1])===K.val(K.child(target.sym,'lib_id')[1]));
    const pins=K.children(library,'symbol').flatMap(s=>K.children(s,'pin'));
    for(const pin of pins){const local=K.child(pin,'at'),number=K.val(K.child(pin,'number')[1]),px=x+(+local[1]),py=y-(+local[2]);
      const label=K.children(target.tree,'global_label').find(l=>{const at=K.child(l,'at');return Math.abs(+at[1]-px)<.00001&&Math.abs(+at[2]-py)<.00001;});
      assert.ok(label,ref+' pin '+number+' has label at its electrical endpoint');assert.equal(K.val(label[1]),pinNet(f,number));}}
  for(const h of A.hardware){const source=K.parse(h.raw),uuid=K.val(K.child(source,'uuid')[1]),f=fps.find(f=>K.val(K.child(f,'uuid')[1])===uuid);assert.ok(f,h.id);
    assert.deepEqual(K.children(f,'pad').map(p=>K.child(p,'net')),K.children(source,'pad').map(p=>K.child(p,'net')));}
  const lib=trees.get('KiCad/Studio.pretty/XL1615.kicad_mod');assert.equal(K.child(lib,'at'),undefined);
  for(const pad of K.children(lib,'pad')){close(+K.child(pad,'at')[3],180);assert.equal(K.child(pad,'net'),undefined);}
  // UUIDs must be unique within each generated sheet and across generated pages.
  const seen=new Set();function uuids(tree){for(const node of tree)if(Array.isArray(node)){if(node[0]==='uuid'){const u=K.val(node[1]);assert.ok(!seen.has(u),'duplicate UUID '+u);seen.add(u);}else uuids(node);}}
  for(const [file,tree] of trees)if(/\/(LEDs|Capacitors).*\.kicad_sch$/.test(file))uuids(tree);
  assert.deepEqual(K.mapping(m,A).leds.map(l=>[l.ref,l.index,l.din,l.dout]),out.manifest.map(l=>[l.ref,l.index,l.din,l.dout]));
  const root=path.resolve(__dirname,'../..');if(fs.existsSync(path.join(root,'PCB/Melbourne-Live-Train-Map.kicad_sch')))assert.equal(A.rootSchematic,fs.readFileSync(path.join(root,'PCB/Melbourne-Live-Train-Map.kicad_sch'),'utf8'));
});
