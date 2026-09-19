/* Native KiCad 9 writers. No pretend routing, fabricated OLED pads or Gerbers. */
(function(global){
  'use strict';
  const C=global.RailCore;
  const q=s=>JSON.stringify(String(s)),num=n=>String(+Number(n).toFixed(6));
  function parse(text){
    const tokens=text.match(/"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g)||[];const stack=[];let root;
    for(const t of tokens){if(t==='('){const n=[];if(stack.length)stack.at(-1).push(n);else if(root)throw Error('Multiple S-expression roots');else root=n;stack.push(n);}
      else if(t===')'){if(!stack.length)throw Error('Unexpected closing parenthesis');stack.pop();}
      else {if(!stack.length)throw Error('Atom outside root');stack.at(-1).push(t);}}
    if(stack.length||!root)throw Error('Incomplete S-expression');return root;
  }
  const val=t=>t?.startsWith('"')?JSON.parse(t):t;
  const children=(a,k)=>a.filter(x=>Array.isArray(x)&&x[0]===k);
  const child=(a,k)=>a.find(x=>Array.isArray(x)&&x[0]===k);
  const dump=a=>Array.isArray(a)?'('+a.map(dump).join(' ')+')':a;
  function set(a,k,value){const i=a.findIndex(x=>Array.isArray(x)&&x[0]===k);if(i<0)a.push(value);else a[i]=value;}
  function remove(a,keys){return a.filter(x=>!Array.isArray(x)||!keys.includes(x[0]));}
  function property(a,k){return children(a,'property').find(p=>val(p[1])===k);}
  function uuid(seed){
    const s=String(seed);let a=2166136261,b=0x12345678,c=0x9e3779b9,d=0x811c9dc5;
    for(let i=0;i<s.length;i++){const v=s.charCodeAt(i);a=Math.imul(a^v,16777619);b=Math.imul(b^v,2246822519);c=Math.imul(c^v,3266489917);d=Math.imul(d^v,668265263);}
    const h=[a,b,c,d].map(x=>(x>>>0).toString(16).padStart(8,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
  }
  function renewUuids(a,seed){let i=0;function walk(n){for(const v of n)if(Array.isArray(v)){if(v[0]==='uuid')v[1]=q(uuid(seed+'/'+i++));else walk(v);}}walk(a);}
  function poseFootprint(raw,p,ref,path,pads,netId){
    let f=parse(raw),oldAt=child(f,'at'),oldAngle=Number(oldAt?.[3]||0),angle=p.angle||0;
    const clearCache=a=>a.filter(x=>!Array.isArray(x)||x[0]!=='render_cache').map(x=>Array.isArray(x)?clearCache(x):x);
    f=clearCache(remove(f,['model','zone','embedded_fonts'])); // Optional 3D paths are not portable.
    set(f,'at',['at',num(p.x),num(p.y),num(angle)]);
    for(const node of children(f,'pad')){
      const at=child(node,'at');if(at)at[3]=num(Number(at[3]||0)-oldAngle+angle);
      if(pads){const name=pads[val(node[1])];if(name===null){set(node,'net',['net','0',q('')]);}
        else if(name!==undefined)set(node,'net',['net',String(netId(name)),q(name)]);}
    }
    for(const pp of children(f,'property')){const at=child(pp,'at');if(at)at[3]=num(Number(at[3]||0)-oldAngle+angle);}
    for(const text of children(f,'fp_text')){const at=child(text,'at');if(at)at[3]=num(Number(at[3]||0)-oldAngle+angle);}
    if(ref){const pr=property(f,'Reference');if(pr)pr[2]=q(ref);else f.push(['property',q('Reference'),q(ref),['at','0','-3','0'],['layer',q('F.SilkS')],['effects',['font',['size','1','1'],['thickness','.15']]]]);}
    if(path)set(f,'path',['path',q(path)]);
    if(pads)renewUuids(f,ref);
    return f;
  }
  function line(a,b,layer='F.SilkS',width=.18,seed=''){
    return `(gr_line (start ${num(a.x)} ${num(a.y)}) (end ${num(b.x)} ${num(b.y)}) (stroke (width ${width}) (type default)) (layer ${q(layer)}) (uuid ${q(uuid('line'+seed))}))`;
  }
  function rect(x,y,w,h,layer,seed){return `(gr_rect (start ${num(x)} ${num(y)}) (end ${num(x+w)} ${num(y+h)}) (stroke (width 0.15) (type default)) (fill none) (layer ${q(layer)}) (uuid ${q(uuid('rect'+seed))}))`;}
  function pcbText(text,x,y,size=1.6,angle=0,layer='F.SilkS',seed=''){
    return `(gr_text ${q(text)} (at ${num(x)} ${num(y)} ${num(angle)}) (layer ${q(layer)}) (uuid ${q(uuid('text'+seed))}) (effects (font (size ${num(size)} ${num(size)}) (thickness 0.18))))`;
  }
  function effects(size=1,justify=''){return `(effects (font (size ${size} ${size}))${justify?' (justify '+justify+')':''})`;}
  function globalLabel(name,x,y,angle=0,scope=''){return `(global_label ${q(name)} (shape passive) (at ${num(x)} ${num(y)} ${angle}) ${effects(.75,angle===180?'right':'left')} (uuid ${q(uuid(`label/${scope}/${name}/${x}/${y}`))}))`;}
  function sym(ref,value,lib,x,y,path,footprint,seed,pinCount=4){
    return `(symbol (lib_id ${q(lib)}) (at ${num(x)} ${num(y)} 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid ${q(uuid(seed))})
      (property "Reference" ${q(ref)} (at ${num(x+3)} ${num(y-4)} 0) ${effects(1)})
      (property "Value" ${q(value)} (at ${num(x+5)} ${num(y+4)} 0) (effects (font (size .8 .8)) (hide yes)))
      (property "Footprint" ${q(footprint)} (at ${num(x)} ${num(y)} 0) (effects (font (size .8 .8)) (hide yes)))
      ${Array.from({length:pinCount},(_,i)=>`(pin "${i+1}" (uuid ${q(uuid(seed+'/pin/'+(i+1)))}))`).join(' ')}
      (instances (project "Melbourne-Live-Train-Map" (path ${q(path)} (reference ${q(ref)}) (unit 1)))))`;
  }
  function schWrap(uid,lib,body,title){return `(kicad_sch (version 20250114) (generator "rail_layout_studio") (uuid ${q(uid)}) (paper "A3")
    (title_block (title ${q(title)}) (company "Victoria Rail Layout Studio / Kea Studios") (comment 1 "GPL-3.0-or-later · Electrical review required")) ${lib} ${body.join('\n')} (embedded_fonts no))`;}
  function sheet(name,file,uid,x,y,page,path){return `(sheet (at ${x} ${y}) (size 65 14) (stroke (width .15) (type default)) (fill (color 0 0 0 0)) (uuid ${q(uid)})
    (property "Sheetname" ${q(name)} (at ${x} ${y-1} 0) ${effects(1,'left bottom')})
    (property "Sheetfile" ${q(file)} (at ${x} ${y+15} 0) ${effects(1,'left top')})
    (instances (project "Melbourne-Live-Train-Map" (path ${q(path)} (page ${q(page)})))))`;}
  function footprintInfo(raw){
    if(typeof raw!=='string'||raw.length>500000)throw Error('Footprint exceeds 500 KB.');
    const f=parse(raw);if(f[0]!=='footprint')throw Error('Choose a KiCad .kicad_mod footprint.');
    const pads=children(f,'pad'),pins=[...new Set(pads.map(p=>val(p[1])).filter(Boolean))];
    if(pins.length>160||pins.some(p=>!/^[A-Za-z0-9_+.-]{1,20}$/.test(p)))throw Error('Supported footprints have at most 160 numbered pads with simple pad identifiers.');
    let ex=1,ey=1;
    for(const pad of pads){const at=child(pad,'at'),size=child(pad,'size');if(!at||!size)throw Error('Footprint pad is missing its position or size.');
      const x=+at[1],y=+at[2],w=+size[1],h=+size[2],a=C.rad(+(at[3]||0));
      if(![x,y,w,h,a].every(Number.isFinite)||w<=0||h<=0||Math.max(Math.abs(x),Math.abs(y),w,h)>500)throw Error('Footprint has unsupported pad geometry.');
      ex=Math.max(ex,Math.abs(x)+(Math.abs(w*Math.cos(a))+Math.abs(h*Math.sin(a)))/2);
      ey=Math.max(ey,Math.abs(y)+(Math.abs(w*Math.sin(a))+Math.abs(h*Math.cos(a)))/2);
    }
    for(const name of ['fp_line','fp_rect','fp_circle'])for(const part of children(f,name))for(const tag of ['start','end','center']){
      const a=child(part,tag);if(a&&Number.isFinite(+a[1])&&Number.isFinite(+a[2])){ex=Math.max(ex,Math.abs(+a[1]));ey=Math.max(ey,Math.abs(+a[2]));}}
    if(ex*2>500||ey*2>500)throw Error('Footprint exceeds the editor’s 500 mm component limit.');
    return {name:val(f[1]),pins:pins.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})),w:Math.ceil(ex*20)/10,h:Math.ceil(ey*20)/10};
  }
  function customPart(h,path){
    const pins=footprintInfo(h.raw).pins,n=Math.ceil(pins.length/2),bodyH=Math.max(5.08,(n+1)*2.54);
    const name='Part_'+h.id,libId='StudioParts:'+name,fpName='Part_'+h.id;
    const x=203.2,y=148.59,uid=uuid('sym/'+h.id),locations=[];
    const geometry=pins.map((pin,i)=>{const left=i<n,row=left?i:i-n,px=left?-15.24:15.24,py=(n-1)*1.27-row*2.54;
      locations.push({pin,x:x+px,y:y-py,angle:left?0:180});
      return `(pin passive line (at ${num(px)} ${num(py)} ${left?0:180}) (length 5.08) (name ${q(pin)} ${effects(1)}) (number ${q(pin)} ${effects(1)}))`;}).join(' ');
    const library=`(symbol ${q(libId)} (pin_names (offset 1.016)) (in_bom yes) (on_board yes)
      (property "Reference" "U" (at 0 ${num(bodyH/2+2.54)} 0) ${effects(1)})
      (property "Value" ${q(h.name)} (at 0 ${num(-bodyH/2-2.54)} 0) ${effects(1)})
      (symbol ${q(name+'_0_1')} (rectangle (start -10.16 ${num(bodyH/2)}) (end 10.16 ${num(-bodyH/2)}) (stroke (width .254) (type default)) (fill (type background))))
      (symbol ${q(name+'_1_1')} ${geometry}))`;
    let instance=parse(sym(h.ref,h.name,libId,x,y,path,'Studio:'+fpName,'sym/'+h.id,0));
    for(const pin of pins)instance.push(['pin',q(pin),['uuid',q(uuid(h.id+'/pin/'+pin))]]);
    const ref=property(instance,'Reference');set(ref,'at',['at',num(x),num(y-bodyH/2-3.81),'0']);
    const connections=locations.map(p=>{const net=h.pinNets?.[p.pin]?.trim();return net==='NC'?`(no_connect (at ${num(p.x)} ${num(p.y)}) (uuid ${q(uuid(h.id+'/nc/'+p.pin))}))`:net?globalLabel(net,p.x,p.y,p.angle,path):'';});
    return {name,fpName,library,body:[dump(instance),...connections],uuid:uid};
  }
  function mapping(model,assets){C.validateSchema(model);const g=C.generate(model);return {version:1,layoutName:model.name,source:assets.source,
    hardwareAddressChanged:true,note:'Block IDs are logical. Integrate channel/index lookup in firmware and author geographic mappings for new LEDs.',channels:g.channelCounts,
    leds:g.leds.map(l=>({...l,din:l.index===0?`LED_DATA_5V_CH${l.channel}`:`LS_CH${l.channel}_${l.index-1}`,dout:`LS_CH${l.channel}_${l.index}`,power:l.supply}))};}
  function makeExports(model,assets){
    C.validateSchema(model);const g=C.generate(model),files={},issues=C.checks(model,g);
    const reservedRefs=new Set([...g.leds,...g.caps].map(p=>p.ref));
    for(const h of model.hardware)if(h.kind!=='existing'&&reservedRefs.has(h.ref))throw Error('Component reference conflicts with a generated LED or capacitor: '+h.ref);
    const inherited=model.hardware.filter(h=>h.kind==='existing');
    const mapOnly=model.preset==='demo'&&inherited.length===0;
    if(!mapOnly&&(inherited.length!==assets.hardware.length||assets.hardware.some(h=>!inherited.some(x=>x.id===h.id))))
      throw Error('A controller project must retain every inherited controller/power/USB footprint. Restore missing components or use the LED-only spacing-study preset.');
    // The source PCB predates this label in its unchanged schematic (native KiCad parity check).
    const netAliases={'Net-(U1-GPIO43{slash}U0TXD)':'/MCU_TX'};
    const netMap=new Map();let nextNet=1;
    for(const s of assets.nets){const n=parse(s);netMap.set(netAliases[val(n[2])]||val(n[2]),Number(n[1]));nextNet=Math.max(nextNet,Number(n[1])+1);}
    const netId=name=>{name=netAliases[name]||name;if(!netMap.has(name))netMap.set(name,nextNet++);return netMap.get(name);};
    const rootPath='/'+assets.rootUuid,pcbItems=[],manifest=[];
    const leafSheets={};
    const ledSymbol=children(parse(assets.ledLib),'symbol').find(s=>val(s[1]).includes('1615'));
    const capSymbol=children(parse(assets.capLib),'symbol').find(s=>val(s[1]).includes('10uF'));
    const ledLib=`(lib_symbols ${dump(ledSymbol)})`,capLib=`(lib_symbols ${dump(capSymbol)})`;
    const ledLibId=val(ledSymbol[1]),capLibId=val(capSymbol[1]);
    const leafInfo=(ch,page)=>{
      const parent=assets.sheets.find(s=>s.name===`LEDs-${ch}`);
      const key=`${ch}-${page}`,file=`LEDs-${ch}-${page}.kicad_sch`,sheetId=uuid('sheet/'+key);
      if(!leafSheets[key])leafSheets[key]={body:[],file,uid:uuid('file/'+key),ch,page,sheetId,path:`${rootPath}/${parent.uuid}/${sheetId}`};
      return leafSheets[key];
    };
    for(let ch=1;ch<=8;ch++){
      const ls=g.leds.filter(l=>l.channel===ch);
      for(let i=0;i<ls.length;i++){
        const l=ls[i],before=i===0?`LED_DATA_5V_CH${ch}`:`LS_CH${ch}_${i-1}`,after=`LS_CH${ch}_${i}`;
        const page=Math.floor(i/40)+1,leaf=leafInfo(ch,page),seed='sym/'+l.key,symId=uuid(seed);
        const x=30.48+(i%8)*49.53,y=35.56+(Math.floor(i/8)%5)*48.26;
        const pcbPath=`${leaf.path}/${symId}`;
        const f=poseFootprint(assets.ledFootprint,{...l,angle:l.rotation},l.ref,pcbPath,{'1':after,'2':l.supply,'3':'GND','4':before},netId);
        f[1]=q('Studio:XL1615');
        pcbItems.push(dump(f));
        leaf.body.push(sym(l.ref,'XL-1615RGBC-WS2812B-S',ledLibId,x,y,leaf.path,'Studio:XL1615',seed),
          globalLabel(before,x-7.62,y,0,leaf.path),globalLabel(after,x+7.62,y,180,leaf.path),globalLabel(l.supply,x,y-7.62,90,leaf.path),globalLabel('GND',x,y+7.62,270,leaf.path));
        manifest.push({...l,din:before,dout:after,power:l.supply,schematicPath:pcbPath});
      }
    }
    // Keep the root/controller and USB sheets byte-for-byte: no silently lost circuitry.
    files['KiCad/Melbourne-Live-Train-Map.kicad_sch']=assets.rootSchematic;
    if(!mapOnly)files['KiCad/USB.kicad_sch']=assets.usbSchematic;
    else files['KiCad/Melbourne-Live-Train-Map.kicad_sch']=schWrap(assets.rootUuid,'(lib_symbols)',assets.sheets.filter(s=>s.name.startsWith('LEDs-')||s.file==='Capacitors.kicad_sch').map((s,i)=>sheet(s.name,s.file,s.uuid,25.4+(i%3)*88.9,35.56+Math.floor(i/3)*35.56,String(i+2),rootPath)).concat(['(sheet_instances (path "/" (page "1")))']),'LED spacing study — external controller and supply required');
    for(let ch=1;ch<=8;ch++){
      const parent=assets.sheets.find(s=>s.name===`LEDs-${ch}`),pages=Object.values(leafSheets).filter(p=>p.ch===ch);
      const body=pages.map((p,i)=>sheet(`Channel ${ch} / page ${p.page}`,p.file,p.sheetId,25+(i%4)*90,35+Math.floor(i/4)*35,`${ch+1}.${p.page}`,`${rootPath}/${parent.uuid}`));
      files['KiCad/'+parent.file]=schWrap(uuid('channel'+ch),'(lib_symbols)',body,`LED channel ${ch}: ${g.channelCounts[ch-1]} LEDs`);
    }
    for(const leaf of Object.values(leafSheets))files['KiCad/'+leaf.file]=schWrap(leaf.uid,ledLib,leaf.body,`LED channel ${leaf.ch} / ${leaf.page}`);
    const capParent=assets.sheets.find(s=>s.file==='Capacitors.kicad_sch'),capLeaves={};
    g.caps.forEach((cap,i)=>{
      const page=Math.floor(i/80)+1,key='caps-'+page,sheetId=uuid(key),path=`${rootPath}/${capParent.uuid}/${sheetId}`;
      const leaf=capLeaves[page]??={body:[],file:`Capacitors-${page}.kicad_sch`,uid:uuid(key+'file'),sheetId,path};
      const seed='sym/'+cap.ref,symId=uuid(seed),x=25.4+(i%10)*38.1,y=25.4+(Math.floor(i/10)%8)*30.48;
      const f=poseFootprint(assets.capFootprint,cap,cap.ref,`${path}/${symId}`,{'1':cap.supply,'2':'GND'},netId);f[1]=q('Studio:Cap0402');pcbItems.push(dump(f));
      leaf.body.push(sym(cap.ref,'10uF',capLibId,x,y,path,'Studio:Cap0402',seed,2),globalLabel(cap.supply,x,y-3.81,90,path),globalLabel('GND',x,y+3.81,270,path));
    });
    files['KiCad/Capacitors.kicad_sch']=schWrap(uuid('caps-root'),'(lib_symbols)',Object.entries(capLeaves).map(([p,s],i)=>sheet(`LED decoupling / ${p}`,s.file,s.sheetId,25+(i%4)*90,35+Math.floor(i/4)*35,`10.${p}`,`${rootPath}/${capParent.uuid}`)),'Grouped LED decoupling');
    for(const [p,s] of Object.entries(capLeaves))files['KiCad/'+s.file]=schWrap(s.uid,capLib,s.body,`Decoupling / ${p}`);
    const sourceValues=new Map();
    for(const raw of [assets.rootSchematic,assets.usbSchematic])for(const symbol of children(parse(raw),'symbol'))sourceValues.set(val(property(symbol,'Reference')?.[2]),val(property(symbol,'Value')?.[2]));
    const customSymbols=new Map(),extraSheets=[];
    for(const h of model.hardware){
      if(h.kind==='existing'){
        const source=assets.hardware.find(x=>x.id===h.id);if(!source)throw Error('Unknown inherited hardware: '+h.id);
        const f=poseFootprint(source.raw,h,null,null,null,netId),value=property(f,'Value');
        if(value&&sourceValues.has(h.ref))value[2]=q(sourceValues.get(h.ref));
        for(const pad of children(f,'pad')){const n=child(pad,'net'),alias=n&&netAliases[val(n[2])];if(alias)set(pad,'net',['net',String(netId(alias)),q(alias)]);}
        pcbItems.push(dump(f));
      }else if(h.raw){
        const sheetId=uuid('part-sheet/'+h.id),partPath=`${rootPath}/${sheetId}`,part=customPart(h,partPath),padNets={};
        const info=footprintInfo(h.raw);for(const pin of info.pins){const net=h.pinNets?.[pin]?.trim();padNets[pin]=net&&net!=='NC'?(netAliases[net]||net):`unconnected-(${h.ref}-Pad${pin})`;}
        const fp=poseFootprint(h.raw,h,h.ref,`${partPath}/${part.uuid}`,padNets,netId);
        for(const pad of children(fp,'pad'))if(!info.pins.includes(val(pad[1])))set(pad,'net',['net','0',q('')]);
        const value=property(fp,'Value');if(value)value[2]=q(h.name);else fp.push(['property',q('Value'),q(h.name),['at','0','3','0'],['layer',q('F.Fab')],['effects',['font',['size','1','1'],['thickness','.15']]]]);
        if(!child(fp,'uuid'))fp.push(['uuid',q(uuid('fp/'+h.id))]);fp[1]=q('Studio:'+part.fpName);
        pcbItems.push(dump(fp));
        files[`KiCad/${part.fpName}.kicad_sch`]=schWrap(uuid('part-file/'+h.id),`(lib_symbols ${part.library})`,part.body,`${h.ref}: ${h.name} — verify pin assignments`);
        files[`KiCad/Studio.pretty/${part.fpName}.kicad_mod`]=libraryFoot(h.raw,part.fpName);
        const symbol=parse(part.library);symbol[1]=q(part.name);customSymbols.set(part.name,dump(symbol));
        extraSheets.push(sheet(`${h.ref} — user component`,`${part.fpName}.kicad_sch`,sheetId,25.4+(extraSheets.length%3)*88.9,35.56+Math.floor(extraSheets.length/3)*35.56,String(20+extraSheets.length),rootPath));
      }else if(h.kind==='hole'){
        const name='Hole_'+h.id,raw=`(footprint ${q('Studio:'+name)} (layer "F.Cu") (at ${num(h.x)} ${num(h.y)}) (uuid ${q(uuid(h.id))}) (attr board_only exclude_from_pos_files exclude_from_bom)
          (property "Reference" ${q(h.ref)} (at 0 -3 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness .15))))
          (property "Value" "MountingHole" (at 0 3 0) (layer "F.Fab") (effects (font (size 1 1) (thickness .15))))
          (pad "" np_thru_hole circle (at 0 0) (size ${num(h.w)} ${num(h.w)}) (drill ${num(h.w)}) (layers "*.Cu" "*.Mask")))`;
        pcbItems.push(raw);files[`KiCad/Studio.pretty/${name}.kicad_mod`]=libraryFoot(raw,name);
      }else{
        const angle=C.rad(h.angle),rot=(x,y)=>({x:h.x+x*Math.cos(angle)-y*Math.sin(angle),y:h.y+x*Math.sin(angle)+y*Math.cos(angle)});
        const corners=[rot(-h.w/2,-h.h/2),rot(h.w/2,-h.h/2),rot(h.w/2,h.h/2),rot(-h.w/2,h.h/2)];
        corners.forEach((p,i)=>pcbItems.push(line(p,corners[(i+1)%4],'Dwgs.User',.2,h.id+i)));
        pcbItems.push(pcbText(`${h.ref}: ${h.kind} / PART NOT ASSIGNED`,h.x,h.y,1,-h.angle,'Dwgs.User',h.id));
      }
    }
    if(extraSheets.length){
      const parentId=uuid('user-components-sheet'),parentPath=`${rootPath}/${parentId}`;
      // A dedicated hierarchy keeps added parts clear of the preserved controller drawing.
      const root=parse(files['KiCad/Melbourne-Live-Train-Map.kicad_sch']);
      root.push(parse(sheet('User components','User-Components.kicad_sch',parentId,25.4,254,20,rootPath)));
      files['KiCad/Melbourne-Live-Train-Map.kicad_sch']=dump(root);
      const body=extraSheets.map(text=>text.replace(q(rootPath),q(parentPath)));
      files['KiCad/User-Components.kicad_sch']=schWrap(uuid('user-components-file'),'(lib_symbols)',body,'User-assigned components');
      // Insert this hierarchy level into symbol instance paths and PCB paths.
      for(let i=0;i<pcbItems.length;i++)for(const h of model.hardware.filter(h=>h.raw&&h.kind!=='existing')){
        const prefix=`${rootPath}/${uuid('part-sheet/'+h.id)}`;
        pcbItems[i]=pcbItems[i].replace(prefix,`${parentPath}/${uuid('part-sheet/'+h.id)}`);
      }
      for(const h of model.hardware.filter(h=>h.raw&&h.kind!=='existing')){
        const name='Part_'+h.id,file=`KiCad/${name}.kicad_sch`,prefix=`${rootPath}/${uuid('part-sheet/'+h.id)}`;
        files[file]=files[file].replaceAll(prefix,`${parentPath}/${uuid('part-sheet/'+h.id)}`);
      }
    }
    pcbItems.push(rect(0,0,model.board.width,model.board.height,'Edge.Cuts','board'));
    for(const {e,li,c} of g.paths){
      pcbItems.push(`(gr_curve (pts ${c.map(p=>`(xy ${num(p.x)} ${num(p.y)})`).join(' ')}) (stroke (width 0.18) (type ${e.dotted?'dot':'default'})) (layer "F.SilkS") (uuid ${q(uuid(e.id+'/'+li))}))`);
    }
    for(const n of model.nodes)if(n.name){
      const pa=C.point(n,0),pb=C.point(n,n.tracks-1),forward={x:Math.cos(C.rad(n.angle))*1.25,y:Math.sin(C.rad(n.angle))*1.25};
      const normal={x:Math.sin(C.rad(n.angle))*1.1,y:-Math.cos(C.rad(n.angle))*1.1};
      const corners=[{x:pa.x-forward.x-normal.x,y:pa.y-forward.y-normal.y},{x:pa.x+forward.x-normal.x,y:pa.y+forward.y-normal.y},
        {x:pb.x+forward.x+normal.x,y:pb.y+forward.y+normal.y},{x:pb.x-forward.x+normal.x,y:pb.y-forward.y+normal.y}];
      corners.forEach((p,i)=>pcbItems.push(line(p,corners[(i+1)%4],'F.SilkS',.22,n.id+i)));
      pcbItems.push(pcbText(n.labelText??n.name,n.x+n.labelDx,n.y+n.labelDy,n.labelSize,-n.labelAngle,'F.SilkS',n.id));
    }
    const nets=[...netMap.entries()].map(([n,i])=>`(net ${i} ${q(n)})`);
    const header=assets.pcbHeader.filter(s=>!/^\(generator(?:_version)?\s/.test(s));header.push('(generator "rail_layout_studio")');
    files['KiCad/Melbourne-Live-Train-Map.kicad_pcb']='(kicad_pcb\n'+header.join('\n')+'\n'+nets.join('\n')+'\n'+pcbItems.join('\n')+'\n)';
    // Carry source project settings, but do not carry per-board DRC waivers.
    const project=JSON.parse(assets.project);if(project.board)project.board.drc_exclusions=[];
    files['KiCad/Melbourne-Live-Train-Map.kicad_pro']=JSON.stringify(project,null,2);
    function libraryFoot(raw,name){let f=poseFootprint(raw,{x:0,y:0,angle:0},null,null,null,netId);f=remove(f,['at','path','uuid','sheetname','sheetfile','model']);f[1]=q(name);
      set(f,'version',['version','20241229']);set(f,'generator',['generator',q('rail_layout_studio')]);
      const ref=property(f,'Reference');if(ref)ref[2]=q('REF**');
      for(const p of children(f,'pad')){const i=p.findIndex(v=>Array.isArray(v)&&v[0]==='net');if(i>=0)p.splice(i,1);}return dump(f);}
    files['KiCad/Studio.pretty/XL1615.kicad_mod']=libraryFoot(assets.ledFootprint,'XL1615');
    files['KiCad/Studio.pretty/Cap0402.kicad_mod']=libraryFoot(assets.capFootprint,'Cap0402');
    // Bundle the source's embedded footprint and symbol definitions so exported
    // projects do not depend on the author's machine-specific library paths.
    const fpLibs=new Set(['Studio']);
    for(const h of assets.hardware){const f=parse(h.raw),full=val(f[1]),split=full.indexOf(':');if(split<1)continue;
      const lib=full.slice(0,split),name=full.slice(split+1);fpLibs.add(lib);files[`KiCad/${lib}.pretty/${name}.kicad_mod`]??=libraryFoot(h.raw,name);}
    files['KiCad/fp-lib-table']='(fp_lib_table (version 7) '+[...fpLibs].map(lib=>`(lib (name ${q(lib)}) (type "KiCad") (uri ${q('${KIPRJMOD}/'+lib+'.pretty')}) (options "") (descr "Bundled source snapshot"))`).join(' ')+')';
    const symbolLibs=new Map();
    for(const src of [assets.rootSchematic,assets.usbSchematic,`(holder ${assets.ledLib})`,`(holder ${assets.capLib})`]){
      for(const symbol of children(child(parse(src),'lib_symbols')||[],'symbol')){const full=val(symbol[1]),split=full.indexOf(':');if(split<1)continue;
        const lib=full.slice(0,split),name=full.slice(split+1);if(!symbolLibs.has(lib))symbolLibs.set(lib,new Map());symbol[1]=q(name);symbolLibs.get(lib).set(name,dump(symbol));}}
    if(customSymbols.size)symbolLibs.set('StudioParts',customSymbols);
    for(const [lib,symbols] of symbolLibs)files[`KiCad/${lib}.kicad_sym`]=`(kicad_symbol_lib (version 20241209) (generator "rail_layout_studio") ${[...symbols.values()].join('\n')})`;
    files['KiCad/sym-lib-table']='(sym_lib_table (version 7) '+[...symbolLibs.keys()].map(lib=>`(lib (name ${q(lib)}) (type "KiCad") (uri ${q('${KIPRJMOD}/'+lib+'.kicad_sym')}) (options "") (descr "Bundled source snapshot"))`).join(' ')+')';
    files['layout.rail.json']=JSON.stringify(model,null,2);
    files['mapping/led-manifest.json']=JSON.stringify({version:1,layoutName:model.name,source:assets.source,hardwareAddressChanged:true,
      note:'Block IDs are logical. Use channel/index lookup, not block minus chain start. New geographic mapping must be authored separately.',channels:g.channelCounts,leds:manifest},null,2);
    const csvCell=s=>q(String(s??''));
    const cols=['ref','block','channel','index','x','y','rotation','station','nodeId','edgeId','fraction','din','dout','power','geographicStatus'];
    files['mapping/led-manifest.csv']=cols.join(',')+'\n'+manifest.map(l=>cols.map(k=>csvCell(l[k])).join(',')).join('\n');
    files['mapping/stations.json']=JSON.stringify(model.nodes.filter(n=>n.name).map(n=>({id:n.id,name:n.name,gtfsStationId:n.stationId,platforms:n.platforms,
      blocks:manifest.filter(l=>l.nodeId===n.id).map(l=>l.block),trackCount:n.tracks,geographicStatus:n.original?'original-blocks':'needs-KML'})),null,2);
    files['mapping/layout-addresses.h']='#pragma once\n#include <stdint.h>\n// Generated layout lookup. Integration required in mapLeds.cpp; not a standalone firmware.\nstruct LayoutAddress { uint16_t block; uint8_t channel; uint16_t index; };\nstatic const LayoutAddress LAYOUT_ADDRESSES[] = {\n'+
      manifest.map(l=>`  {${l.block}, ${l.channel}, ${l.index}},`).join('\n')+'\n};\nstatic const uint16_t LAYOUT_CHAIN_LENGTHS[8] = {'+g.channelCounts.join(', ')+'};\n';
    files['EXPORT-REVIEW.md']=`# Layout export — NOT manufacturing ready\n\n${model.name}\n\n${manifest.length} map LEDs; ${g.caps.length} generated 10 uF grouped decoupling capacitors; ${model.hardware.filter(h=>h.kind==='existing').length} retained controller/power/USB footprints.\n\nOpen KiCad/Melbourne-Live-Train-Map.kicad_pro in KiCad 9+.\n\n${mapOnly?'This LED-only study omits the controller and USB circuits; supply the exported power rails and LED_DATA_5V_CHx signals externally.':'The existing main and USB circuits are preserved; a user-components hierarchy is added only when parts are assigned.'} LED and decoupling sheets are regenerated and linked to PCB footprints by matching UUID paths. Data chains, supply nets and ground are real nets, not silk drawings. All copper tracks, vias and fills from the original board are deliberately removed: arbitrary relocation makes them invalid. Route and validate in KiCad. The inherited MCU TX net name and mounting-hole values are reconciled to the source schematic. The source MCU/RF/power topology is unchanged, but its placement and RF geometry must be reviewed; original routing/antenna copper was NOT retained.\n\nOLED/encoder items without an exact part are drawings on Dwgs.User only. There is no guessed FPC pinout, OLED charge-pump circuit, encoder debounce or GPIO assignment. Assigned footprints have matching schematic symbols with numbered passive pins. Only the pin nets you enter are connected; blank pins are unconnected and NC pins are explicitly marked no-connect. A generic symbol does not verify a device’s electrical pin types, power requirements or interface circuit. Complete these circuits before ordering.\n\nThe source schematic instances retain the upstream project name to keep hierarchy identity. Source and assigned footprint/symbol libraries are bundled with this project. The source project's external 3D model paths are omitted.\n\nAutomatic capacitor placement is provisional. Grouping is inherited practice, not a validated decoupling/power design. Review current, voltage drop, connectors, protection, capacitor spacing and supply-domain assignment for the larger board.\n\nFirmware/backend: manifest and header are integration inputs, not automatic modifications of your other forks. Old block numbers are retained for surviving original LEDs, but chain indexes can change. New intermediate LEDs need real geographic block/transition definitions; canvas coordinates must never be treated as GPS. Saved timetable arrays must also be regenerated before using timetable mode with a changed layout.\n\nValidation\n${issues.map(i=>'- '+i.level.toUpperCase()+': '+i.message).join('\n')}\n\nNative KiCad loading/ERC/DRC has not been verified in the build environment. Run tools/validate-kicad.py from the program source on a machine with KiCad installed.\n`;
    files['LICENSE']=assets.license;
    return {files,g,issues,manifest};
  }
  global.RailCAD={parse,val,children,child,dump,set,property,uuid,poseFootprint,mapping,footprintInfo,makeExports};
})(globalThis);
