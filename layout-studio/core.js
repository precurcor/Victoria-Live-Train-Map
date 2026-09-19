/* Victoria Rail Layout Studio — GPL-3.0-or-later. Geometry in millimetres. */
(function (global) {
  'use strict';
  const clone = x => JSON.parse(JSON.stringify(x));
  const rad = a => a * Math.PI / 180;
  const distance = (a,b) => Math.hypot(b.x-a.x,b.y-a.y);
  const norm = s => s.toLowerCase().replace(/\s+/g,' ').trim();
  const finite = (v,lo,hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const COLORS = ['#82b6ff','#ffb66b','#91d9bb','#c4a4ef','#ebbf65','#7ddce6','#ef98b5','#b1c6cf'];
  const id = prefix => prefix + '-' + (global.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
  function point(n, lane) {
    const o = ((lane-(n.tracks-1)/2)-n.offset)*n.pitch;
    return {x:n.x+Math.sin(rad(n.angle))*o,y:n.y-Math.cos(rad(n.angle))*o};
  }
  function curve(model,e,lane) {
    const a = model.nodes.find(n=>n.id===e.a), b = model.nodes.find(n=>n.id===e.b);
    if (!a || !b) return null;
    const p0=point(a,lane[0]), p3=point(b,lane[1]);
    const length=distance(p0,p3)/3;
    if(e.handles)return [p0,{x:p0.x+e.handles[0].x,y:p0.y+e.handles[0].y},{x:p3.x+e.handles[1].x,y:p3.y+e.handles[1].y},p3];
    if(e.waypoint) {
      const mid={x:e.waypoint.x,y:e.waypoint.y};
      // Offset the bend in the stations' physical frame, independent of edge direction.
      const ca=point(a,(a.tracks-1)/2),cb=point(b,(b.tracks-1)/2);
      mid.x+=((p0.x-ca.x)+(p3.x-cb.x))/2;mid.y+=((p0.y-ca.y)+(p3.y-cb.y))/2;
      return [p0,{x:p0.x+(mid.x-p0.x)*(4/3),y:p0.y+(mid.y-p0.y)*(4/3)},
        {x:p3.x+(mid.x-p3.x)*(4/3),y:p3.y+(mid.y-p3.y)*(4/3)},p3];
    }
    const direction=n=>(Math.cos(rad(n.angle))*(p3.x-p0.x)+Math.sin(rad(n.angle))*(p3.y-p0.y)<0?-1:1);
    return [p0,{x:p0.x+Math.cos(rad(a.angle))*length*direction(a),y:p0.y+Math.sin(rad(a.angle))*length*direction(a)},
      {x:p3.x-Math.cos(rad(b.angle))*length*direction(b),y:p3.y-Math.sin(rad(b.angle))*length*direction(b)},p3];
  }
  function bezier(c,t) {
    const u=1-t;
    return {x:u*u*u*c[0].x+3*u*u*t*c[1].x+3*u*t*t*c[2].x+t*t*t*c[3].x,
      y:u*u*u*c[0].y+3*u*u*t*c[1].y+3*u*t*t*c[2].y+t*t*t*c[3].y};
  }
  function sample(c) {
    let total=0, prev=c[0];
    const pts=[{...prev,t:0,d:0}];
    const steps=100;
    for(let i=1;i<=steps;i++){const p=bezier(c,i/steps);total+=distance(prev,p);pts.push({...p,t:i/steps,d:total});prev=p;}
    return {pts,total};
  }
  function along(s,f) {
    const target=f*s.total;
    let hi=s.pts.findIndex(p=>p.d>=target); if(hi<1)hi=1;
    const a=s.pts[hi-1],b=s.pts[hi],r=(target-a.d)/(b.d-a.d||1);
    return {x:a.x+(b.x-a.x)*r,y:a.y+(b.y-a.y)*r,t:a.t+(b.t-a.t)*r,angle:Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI};
  }
  function registry(model,key,preferred) {
    if(model.registry[key]!==undefined)return model.registry[key];
    if(preferred!==undefined && preferred!==null) return model.registry[key]=preferred;
    if(model.nextBlock>65000) throw Error('Block-number capacity reached (65,000).');
    return model.registry[key]=model.nextBlock++;
  }
  function generate(model) {
    const leds=[],paths=[],nodes=new Map(model.nodes.map(n=>[n.id,n]));
    for(const n of model.nodes)for(let i=0;i<n.tracks;i++)if(n.ledIds[i]!==null){
      const p=point(n,i),key=`${n.id}/lane/${i}`,block=registry(model,key,n.ledIds[i]);
      leds.push({...p,key,block,ref:'D'+block,nodeId:n.id,edgeId:null,lane:i,station:n.name,
        stationId:n.stationId||null,channel:n.channel,angle:n.angle,rotation:(n.tracks===1?180:0)-n.angle,order:block,power:n.power||'auto',geographicStatus:n.original&&block<2000?'original-block':'unmapped'});
    }
    for(const e of model.edges) {
      const a=nodes.get(e.a),b=nodes.get(e.b); if(!a||!b)continue;
      // One count for the whole bundle: parallel lanes keep aligned LED columns.
      const centerLane=e.lanes[Math.floor(e.lanes.length/2)]; if(!centerLane)continue;
      const center=sample(bundleCurve(model,e));
      const count=e.mode==='pitch'?Math.max(0,Math.min(300,Math.floor(center.total/e.pitch)-1)):e.count;
      if(leds.length+count*e.lanes.length>20000)throw Error('This project exceeds the 20,000 LED editor limit. Reduce density.');
      for(let li=0;li<e.lanes.length;li++){
        const lane=e.lanes[li],c=curve(model,e,lane),s=sample(c);
        paths.push({e,lane,li,c,s,count});
        for(let j=0;j<count;j++) {
          const f=(j+1)/(count+1),t=along(center,f).t,p=atCurve(c,t),key=`${e.id}/lane/${lane[0]}-${lane[1]}/led/${j}`;
          const block=registry(model,key);
          const base=a.ledIds.find(v=>v!==null)??a.order??2000;
          leds.push({...p,key,block,ref:'D'+block,nodeId:null,edgeId:e.id,lane:li,station:'',channel:e.channel,rotation:-p.angle,
            order:base+0.01+(j*e.lanes.length+li)*0.000001,fromNode:e.a,toNode:e.b,fraction:f,power:e.power||'auto',geographicStatus:'unmapped'});
        }
      }
    }
    if(leds.length>20000)throw Error('This project exceeds the 20,000 LED editor limit. Reduce density.');
    const channelCounts=Array(8).fill(0);
    leds.sort((a,b)=>a.channel-b.channel||a.order-b.order||a.key.localeCompare(b.key));
    // Read against every source LED pad: chains 1/5/6 use CH2; all others CH1.
    for(const l of leds){l.index=channelCounts[l.channel-1]++;l.supply=l.power==='auto'?([1,5,6].includes(l.channel)?'+5V_CH2':'+5V_CH1'):l.power;}
    const caps=[];
    for(let ch=1;ch<=8;ch++) {
      const cl=leds.filter(l=>l.channel===ch);
      for(let j=0;j<cl.length;j+=model.board.capEvery){const l=cl[j],id='cap-'+ch+'-'+l.block,override=model.capPositions?.[id]||{};
        caps.push({id,kind:'capacitor',ref:'C'+(100+caps.length),x:l.x,y:l.y+3.2,angle:0,...override,supply:l.supply,channel:ch,firstLed:l.ref,w:1,h:.5});}
    }
    return {leds,paths,caps,channelCounts};
  }
  function atCurve(c,t){const p=bezier(c,t),u=1-t;
    const dx=3*u*u*(c[1].x-c[0].x)+6*u*t*(c[2].x-c[1].x)+3*t*t*(c[3].x-c[2].x);
    const dy=3*u*u*(c[1].y-c[0].y)+6*u*t*(c[2].y-c[1].y)+3*t*t*(c[3].y-c[2].y);
    return {...p,t,angle:Math.atan2(dy,dx)*180/Math.PI};
  }
  function bundleCurve(m,e){const cs=e.lanes.map(l=>curve(m,e,l));return [0,1,2,3].map(i=>({x:cs.reduce((s,c)=>s+c[i].x,0)/cs.length,y:cs.reduce((s,c)=>s+c[i].y,0)/cs.length}));}
  function translate(m,ids,dx,dy){
    const chosen=new Set(ids),moved=new Set(),caps=generate(m).caps;
    for(const n of [...m.nodes,...m.hardware])if(chosen.has(n.id)&&!n.locked){n.x+=dx;n.y+=dy;moved.add(n.id);}
    for(const e of m.edges)if(e.waypoint&&moved.has(e.a)&&moved.has(e.b)){e.waypoint.x+=dx;e.waypoint.y+=dy;}
    for(const cap of caps)if(chosen.has(cap.id)&&!cap.locked){m.capPositions??={};m.capPositions[cap.id]={x:cap.x+dx,y:cap.y+dy,angle:cap.angle};}
  }
  function insertStation(m,e){
    if(e.lanes.length>24)throw Error('This junction has more than 24 paths. Split its individual connections first.');
    const c=bundleCurve(m,e),s=sample(c),count=e.mode==='pitch'?Math.max(0,Math.min(300,Math.floor(s.total/e.pitch)-1)):e.count;
    // Replace the central LED column where one exists, preserving the total count.
    const before=Math.floor(Math.max(0,count-1)/2),t=along(s,count?(before+1)/(count+1):.5).t,p=atCurve(c,t);
    const n=makeNode('New station',p.x,p.y,e.lanes.length,e.channel);n.angle=p.angle;
    const a=m.nodes.find(n=>n.id===e.a),b=m.nodes.find(n=>n.id===e.b);n.pitch=(a.pitch+b.pitch)/2;
    addNode(m,n);
    const mix=(a,b)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
    const p01=mix(c[0],c[1]),p12=mix(c[1],c[2]),p23=mix(c[2],c[3]),p012=mix(p01,p12),p123=mix(p12,p23);
    const delta=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
    const one=makeEdge(a,n,e.channel),two=makeEdge(n,b,e.channel);
    one.lanes=e.lanes.map(([a],i)=>[a,i]);two.lanes=e.lanes.map(([,b],i)=>[i,b]);
    one.count=before;two.count=Math.max(0,count-1-before);
    one.handles=[delta(p01,c[0]),delta(p012,p)];two.handles=[delta(p123,p),delta(p23,c[3])];
    for(const edge of [one,two]){edge.dotted=e.dotted;edge.power=e.power||'auto';edge.region=e.region||'Custom';}
    m.edges=m.edges.filter(x=>x.id!==e.id);m.edges.push(one,two);return n;
  }
  function makeNode(name,x,y,tracks=2,channel=1) {
    return {id:id('n'),name,x,y,angle:0,pitch:2.5,offset:0,tracks,ledIds:Array(tracks).fill(undefined).map(()=>-1),channel,
      labelDx:0,labelDy:-4,labelAngle:0,labelSize:1.8,locked:false,region:'Custom',stationId:'',platforms:[],original:false};
  }
  function addNode(model,node) {
    node.ledIds=node.ledIds.map((v,i)=>v===-1?registry(model,`${node.id}/lane/${i}`):v);
    node.order=node.ledIds.find(v=>v!==null)??model.nextBlock;
    model.nodes.push(node);return node;
  }
  function makeEdge(a,b,channel=a.channel) {
    const lanes=[];
    for(let i=0;i<Math.max(a.tracks,b.tracks);i++)lanes.push([Math.min(i,a.tracks-1),Math.min(i,b.tracks-1)]);
    return {id:id('e'),a:a.id,b:b.id,lanes,count:3,mode:'count',pitch:3,channel,dotted:false,waypoint:null};
  }
  function changeTracks(model,n,tracks){
    const old=n.tracks;n.tracks=tracks;
    n.ledIds=n.ledIds.slice(0,tracks);
    while(n.ledIds.length<tracks)n.ledIds.push(registry(model,`${n.id}/lane/${n.ledIds.length}`));
    for(const e of model.edges){
      e.lanes=e.lanes.filter(l=>(e.a!==n.id||l[0]<tracks)&&(e.b!==n.id||l[1]<tracks));
      // Only extend simple equal-lane connections; junction topology stays explicit.
      const other=model.nodes.find(x=>x.id===(e.a===n.id?e.b:e.b===n.id?e.a:''));
      if(other && old<tracks)for(let i=old;i<Math.min(tracks,other.tracks);i++)e.lanes.push([i,i]);
    }
    model.edges=model.edges.filter(e=>e.lanes.length);
  }
  function collapseSpan(model,start,end,count) {
    const queue=[[start.id,[],[]]],seen=new Set();let found;
    while(queue.length){
      const [nid,ns,es]=queue.shift();if(seen.has(nid))continue;seen.add(nid);
      if(nid===end.id){found={ns,es};break;}
      for(const e of model.edges.filter(e=>e.a===nid||e.b===nid)){
        const next=e.a===nid?e.b:e.a,n=model.nodes.find(n=>n.id===next);
        if(!n||seen.has(next)||(n.name&&next!==end.id))continue;
        if(next!==end.id&&model.edges.filter(x=>x.a===next||x.b===next).length!==2)continue;
        queue.push([next,[...ns,next],[...es,e.id]]);
      }
    }
    if(!found)throw Error('Select two consecutive stations on an unbranched span. Junctions are deliberately protected.');
    const internal=new Set(found.ns.filter(n=>n!==end.id));
    // Preserve the lane mapping through every intermediate node, including crossovers.
    let mappings=Array.from({length:start.tracks},(_,i)=>[i,i]);let current=start.id;
    for(const eid of found.es){const e=model.edges.find(e=>e.id===eid),forward=e.a===current;
      const step=forward?e.lanes:e.lanes.map(([a,b])=>[b,a]);
      mappings=mappings.flatMap(([source,lane])=>step.filter(([a])=>a===lane).map(([,b])=>[source,b]));
      current=forward?e.b:e.a;
    }
    mappings=Array.from(new Map(mappings.map(x=>[x.join(','),x])).values());
    model.nodes=model.nodes.filter(n=>!internal.has(n.id));
    model.edges=model.edges.filter(e=>!found.es.includes(e.id));
    const edge=makeEdge(start,end);edge.lanes=mappings;edge.count=count;model.edges.push(edge);return edge;
  }
  function validateSchema(m) {
    const fail=s=>{throw Error('Invalid project: '+s);};
    if(!m||m.schemaVersion!==1||!m.board||!Array.isArray(m.nodes)||!Array.isArray(m.edges)||!Array.isArray(m.hardware))fail('unsupported format');
    if(typeof m.name!=='string'||!m.name.trim()||m.name.length>150)fail('project name');
    const safeId=s=>typeof s==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(s);
    if(m.nodes.length>4000||m.edges.length>6000||m.hardware.length>1000)fail('too many objects');
    for(const k of ['width','height'])if(!finite(m.board[k],20,2000))fail('board size');
    if(!finite(m.board.grid,.1,20))fail('snap grid');
    if(!finite(m.board.capEvery,1,100)||!Number.isInteger(m.board.capEvery))fail('capacitor grouping');
    if(!finite(m.nextBlock,2000,65001)||!Number.isInteger(m.nextBlock)||!m.registry||typeof m.registry!=='object'||Array.isArray(m.registry))fail('LED registry');
    const ids=new Set(),blocks=new Set(),nodeBlocks=new Set();
    if(Object.keys(m.registry).length>65000)fail('LED registry capacity');
    for(const [key,v] of Object.entries(m.registry)){
      if(!/^[A-Za-z0-9_\/-]{1,180}$/.test(key)||['__proto__','constructor','prototype'].includes(key))fail('registry key');
      if(!finite(v,1,65000)||!Number.isInteger(v)||blocks.has(v))fail('duplicate or invalid block ID');
      blocks.add(v);
      if(v>=m.nextBlock)fail('next block must exceed all allocated block IDs');
    }
    for(const n of m.nodes){
      if(!safeId(n.id)||ids.has(n.id)||typeof n.name!=='string'||n.name.length>150||typeof n.region!=='string'||typeof n.stationId!=='string')fail('node ID/name');ids.add(n.id);
      if(n.labelText!==undefined&&(typeof n.labelText!=='string'||n.labelText.length>250))fail('label text');
      for(const k of ['x','y','labelDx','labelDy'])if(!finite(n[k],-4000,4000))fail('node coordinate');
      if(!finite(n.angle,-360,360)||!finite(n.labelAngle,-360,360)||!finite(n.labelSize,.5,20)||!finite(n.pitch,1.7,20)||!finite(n.offset,-30,30))fail('node geometry');
      if(!finite(n.tracks,1,24)||!Number.isInteger(n.tracks)||!Array.isArray(n.ledIds)||n.ledIds.length!==n.tracks)fail('track count');
      if(!Number.isInteger(n.channel)||!finite(n.channel,1,8))fail('channel');
      if(n.power&&!['auto','+5V_CH1','+5V_CH2'].includes(n.power))fail('power supply');
      for(let i=0;i<n.ledIds.length;i++){const b=n.ledIds[i];if(b===null)continue;
        if(!finite(b,1,65000)||!Number.isInteger(b)||nodeBlocks.has(b)||m.registry[`${n.id}/lane/${i}`]!==b)fail('LED ID or registry disagreement');
        nodeBlocks.add(b);
      }
    }
    const edgeIds=new Set();
    for(const e of m.edges){
      if(!safeId(e.id)||ids.has(e.id)||!ids.has(e.a)||!ids.has(e.b)||e.a===e.b||edgeIds.has(e.id))fail('corridor references');edgeIds.add(e.id);
      if(e.power&&!['auto','+5V_CH1','+5V_CH2'].includes(e.power))fail('power supply');
      if(!['count','pitch'].includes(e.mode)||!finite(e.count,0,300)||!Number.isInteger(e.count)||!finite(e.pitch,1.7,100)||!finite(e.channel,1,8)||!Number.isInteger(e.channel))fail('corridor settings');
      if(e.handles&&(!Array.isArray(e.handles)||e.handles.length!==2||e.handles.some(p=>!finite(p.x,-8000,8000)||!finite(p.y,-8000,8000))))fail('curve handles');
      if(e.waypoint&&(!finite(e.waypoint.x,-4000,4000)||!finite(e.waypoint.y,-4000,4000)))fail('curve control');
      const a=m.nodes.find(n=>n.id===e.a),b=m.nodes.find(n=>n.id===e.b);
      if(!Array.isArray(e.lanes)||!e.lanes.length||e.lanes.length>60)fail('lane mapping');
      const pairs=new Set();for(const pair of e.lanes){
        if(!Array.isArray(pair)||pair.length!==2||!Number.isInteger(pair[0])||!Number.isInteger(pair[1])||!finite(pair[0],0,a.tracks-1)||!finite(pair[1],0,b.tracks-1)||pairs.has(pair.join()))fail('lane endpoint');
        pairs.add(pair.join());
      }
    }
    if(m.capPositions!==undefined){
      if(!m.capPositions||typeof m.capPositions!=='object'||Array.isArray(m.capPositions)||Object.keys(m.capPositions).length>20000)fail('capacitor positions');
      for(const [id,p] of Object.entries(m.capPositions))if(!/^cap-[1-8]-[0-9]+$/.test(id)||!p||!finite(p.x,-4000,4000)||!finite(p.y,-4000,4000)||!finite(p.angle,-360,360))fail('capacitor position');
    }
    const hwIds=new Set(),customRefs=new Set();for(const h of m.hardware){
      if(!safeId(h.id)||hwIds.has(h.id)||ids.has(h.id)||edgeIds.has(h.id))fail('hardware ID');hwIds.add(h.id);
      if(!['existing','oled','encoder','hole','custom'].includes(h.kind)||typeof h.ref!=='string'||typeof h.name!=='string'||h.name.length>200)fail('hardware type/name');
      for(const k of ['x','y'])if(!finite(h[k],-4000,4000))fail('hardware location');
      if(!finite(h.angle,-360,360)||!finite(h.w,.1,500)||!finite(h.h,.1,500))fail('hardware size');
      if(h.kind==='oled'&&(!finite(h.activeW,.1,h.w)||!finite(h.activeH,.1,h.h)))fail('OLED window must fit inside its body');
      if(h.kind!=='existing'){
        if(!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(h.ref)||customRefs.has(h.ref)||m.hardware.some(o=>o.kind==='existing'&&o.ref===h.ref))fail('component reference');customRefs.add(h.ref);
      }
      if(h.pinNets!==undefined){
        if(!h.pinNets||typeof h.pinNets!=='object'||Array.isArray(h.pinNets)||Object.keys(h.pinNets).length>160)fail('component pin assignments');
        for(const [pin,net] of Object.entries(h.pinNets))if(!/^[A-Za-z0-9_+.-]{1,20}$/.test(pin)||typeof net!=='string'||net.length>100||/[\x00-\x1f]/.test(net))fail('component pin assignment');
      }
      if(h.raw && (typeof h.raw!=='string'||h.raw.length>500000))fail('footprint size');
    }
    return m;
  }
  function checks(m,g) {
    const issues=[],outside=[],overlaps=[];
    const add=(level,message,target)=>issues.push({level,message,target});
    for(const l of g.leds)if(l.x<1||l.y<1||l.x>m.board.width-1||l.y>m.board.height-1)outside.push(l);
    if(outside.length)add('error',`${outside.length} LEDs cross the board edge or 1 mm margin.`,outside[0].nodeId||outside[0].edgeId);
    const cells=new Map();
    for(const l of g.leds){
      const x=Math.floor(l.x/2),y=Math.floor(l.y/2);
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const p of cells.get(`${x+dx},${y+dy}`)||[]){
        if(distance(p,l)<1.75)overlaps.push([p,l]);
      }
      const k=`${x},${y}`;if(!cells.has(k))cells.set(k,[]);cells.get(k).push(l);
    }
    if(overlaps.length)add('error',`${overlaps.length} LED pairs are closer than 1.75 mm. Review pad/courtyard clearance.`,overlaps[0][1].nodeId||overlaps[0][1].edgeId);
    for(const h of m.hardware){
      const a=rad(h.angle),w=Math.abs(Math.cos(a))*h.w+Math.abs(Math.sin(a))*h.h,ht=Math.abs(Math.sin(a))*h.w+Math.abs(Math.cos(a))*h.h;
      if(h.x-w/2<0||h.y-ht/2<0||h.x+w/2>m.board.width||h.y+ht/2>m.board.height)add('error',`${h.ref||h.name}: body outside board.`,h.id);
      if(h.kind==='oled'||h.kind==='encoder'){
        add('warning',h.raw?`${h.name}: assigned footprint and pin nets need part-datasheet and circuit review.`:`${h.name}: mechanical reservation only; exact part, pads and interface circuitry are not assigned.`,h.id);
        const hits=g.leds.filter(l=>{const dx=l.x-h.x,dy=l.y-h.y;return Math.abs(dx*Math.cos(a)+dy*Math.sin(a))<h.w/2+1&&Math.abs(-dx*Math.sin(a)+dy*Math.cos(a))<h.h/2+1;});
        if(hits.length)add('error',`${h.name} reservation overlaps ${hits.length} LEDs.`,h.id);
      }
    }
    const orphan=m.nodes.filter(n=>n.name&&!m.edges.some(e=>e.a===n.id||e.b===n.id));
    if(orphan.length)add('warning',`${orphan.length} stations have no track connection yet.`,orphan[0].id);
    const unlinked=m.nodes.filter(n=>n.name&&!n.stationId);
    if(unlinked.length)add('warning',`${unlinked.length} stations have no source GTFS identity; assign verified feed IDs before live integration.`,unlinked[0].id);
    const fresh=g.leds.filter(l=>l.geographicStatus==='unmapped').length;
    if(fresh)add('warning',`${fresh} new LED blocks need geographic/backend mapping. Screen positions are not GPS coordinates.`);
    add('info','PCB exports preserve the controller circuit but remove all copper routing. Complete routing and run KiCad ERC/DRC.');
    if(g.channelCounts.some(n=>n>1024))add('warning','A data chain exceeds 1,024 LEDs. Review refresh time and firmware buffers.');
    if(m.preset==='demo')add('warning','Spacing study: exported LED chains require an external controller and power supply.');
    return issues;
  }
  function baseProject(assets) {
    const m={schemaVersion:1,name:'Victoria rail map',preset:'kea',board:{width:700,height:540,capEvery:12,grid:1},
      nodes:clone(assets.nodes),edges:clone(assets.edges),hardware:assets.hardware.map(h=>{const copy=clone(h);delete copy.raw;return copy;}),capPositions:{},
      registry:{},nextBlock:2000,source:assets.source};
    for(const n of m.nodes){n.x+=110;n.y+=145;n.order=n.ledIds.find(x=>x!==null)??2000;}
    for(const h of m.hardware){h.x+=110;h.y+=145;}
    generate(m);
    m.hardware.push({id:'oled1',kind:'oled',ref:'OLED1',name:'Bare OLED · part pending',x:530,y:405,w:35,h:25,angle:0,activeW:29,activeH:14,locked:false});
    m.hardware.push({id:'encoder1',kind:'encoder',ref:'ENC1',name:'Push rotary encoder · part pending',x:580,y:405,w:16,h:16,angle:0,locked:false});
    return m;
  }
  function addRegional(m,assets) {
    const branches=[
      ['Geelong / Warrnambool','Sunshine',['Ardeer','Deer Park','Tarneit','West Tarneit','Wyndham Vale','Little River','Lara','Corio','North Shore','North Geelong','Geelong','South Geelong','Marshall','Waurn Ponds','Winchelsea','Birregurra','Colac','Camperdown','Terang','Sherwood Park','Warrnambool'],[25,485],4],
      ['Ballarat / Ararat','Deer Park',['Caroline Springs','Rockbank','Cobblebank','Melton','Bacchus Marsh','Ballan','Ballarat','Wendouree','Beaufort','Ararat'],[20,175],4],
      ['Maryborough','Ballarat',['Creswick','Clunes','Talbot','Maryborough'],[35,110],4],
      ['Bendigo','Sunbury',['Clarkefield','Riddells Creek','Gisborne','Macedon','Woodend','Kyneton','Malmsbury','Castlemaine','Kangaroo Flat','Bendigo'],[95,60],5],
      ['Echuca','Bendigo',['Epsom','Huntly','Goornong','Elmore','Rochester','Echuca'],[20,20],5],
      ['Swan Hill','Bendigo',['Eaglehawk','Raywood','Dingee','Pyramid','Kerang','Swan Hill'],[20,85],5],
      ['Seymour','Craigieburn',['Donnybrook','Wallan','Heathcote Junction','Wandong','Kilmore East','Broadford','Tallarook','Seymour'],[215,70],5],
      ['Shepparton','Seymour',['Nagambie','Murchison East','Mooroopna','Shepparton'],[330,30],5],
      ['Albury','Seymour',['Avenel','Euroa','Violet Town','Benalla','Wangaratta','Springhurst','Chiltern','Wodonga','Albury'],[480,70],5],
      ['Bairnsdale','East Pakenham',['Nar Nar Goon','Tynong','Garfield','Bunyip','Longwarry','Drouin','Warragul','Yarragon','Trafalgar','Moe','Morwell','Traralgon','Rosedale','Sale','Stratford','Bairnsdale'],[650,175],2]
    ];
    for(const [region,start,names,end,ch] of branches){
      let prev=m.nodes.find(n=>norm(n.name)===norm(start));if(!prev)continue;
      const startPoint={x:prev.x,y:prev.y};
      for(let i=0;i<names.length;i++){
        const name=names[i];let n=m.nodes.find(n=>norm(n.name)===norm(name));
        if(!n){
          const t=(i+1)/names.length,s=assets.catalog.find(s=>norm(s.name)===norm(name));
          let x=startPoint.x+(end[0]-startPoint.x)*t,y=startPoint.y+(end[1]-startPoint.y)*t;
          if(region==='Geelong / Warrnambool'){
            if(i<2){x=[133,111][i];y=[237,225][i];}
            else{x=111+(end[0]-111)*(i-1)/(names.length-2);y=225+(end[1]-225)*(i-1)/(names.length-2);}
          }
          n=makeNode(name,x,y,2,ch);n.id='regional-'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
          n.angle=Math.atan2(end[1]-startPoint.y,end[0]-startPoint.x)*180/Math.PI;if(region==='Geelong / Warrnambool')n.angle=i<2?180:Math.atan2(260,-86)*180/Math.PI;n.region=region;
          n.stationId=s?.stationId||'';n.platforms=s?.platforms||[];n.labelDx=6;n.labelDy=0;n.labelSize=1.7;
          addNode(m,n);
        }
        const e=makeEdge(prev,n,ch);e.id='regional-link-'+n.id.slice(9);e.count=2;e.region=region;
        const startLane=Math.floor((prev.tracks-2)/2),reverse=Math.cos(rad(prev.angle-n.angle))<0;
        e.lanes=[[Math.max(0,startLane),reverse?1:0],[Math.max(0,startLane+1),reverse?0:1]];
        if(i===0&&['Maryborough','Swan Hill','Shepparton'].includes(region))e.count=1;m.edges.push(e);prev=n;
      }
    }
    m.preset='victoria';return m;
  }
  function example(m) {
    m.nodes=[];m.edges=[];m.registry={};m.capPositions={};m.nextBlock=2000;m.board.width=180;m.board.height=90;m.hardware=[];
    let last=null;
    ['Camberwell','East Camberwell','Canterbury','Chatham','Union','Box Hill'].forEach((name,i)=>{
      const n=addNode(m,makeNode(name,15+i*29,32,3));n.labelDy=i%2?-8:10;n.labelSize=2;
      if(last){const e=makeEdge(last,n);e.count=7;m.edges.push(e);}last=n;
    });
    m.hardware.push({id:'oled1',kind:'oled',ref:'OLED1',name:'Bare OLED · part pending',x:45,y:67,w:35,h:25,angle:0,activeW:29,activeH:14,locked:false},
      {id:'encoder1',kind:'encoder',ref:'ENC1',name:'Push encoder · part pending',x:90,y:65,w:16,h:16,angle:0,locked:false});
    m.name='Camberwell three-track study';m.preset='demo';return m;
  }
  global.RailCore={clone,rad,distance,norm,id,COLORS,point,curve,bundleCurve,bezier,atCurve,sample,along,generate,translate,insertStation,makeNode,addNode,makeEdge,changeTracks,collapseSpan,validateSchema,checks,baseProject,addRegional,example};
})(globalThis);
