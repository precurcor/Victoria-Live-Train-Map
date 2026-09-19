/* Representative engineering exports for KiCad's native parsers. */
const fs=require('node:fs'),path=require('node:path');
const A=require('../assets.json');require('../core.js');require('../cad.js');
const C=globalThis.RailCore,K=globalThis.RailCAD;
const destination=path.resolve(process.argv[2]||'native-samples');
for(const preset of ['kea','victoria','study-assigned']){
  const m=preset==='kea'?C.baseProject(A):preset==='victoria'?C.addRegional(C.baseProject(A),A):C.example(C.baseProject(A));
  if(preset==='study-assigned'){
    const h=m.hardware.find(h=>h.kind==='encoder');h.name='Validation fixture (not a real encoder)';
    h.raw='(footprint "Validation_Only" (version 20241229) (generator "rail_layout_studio") (layer "F.Cu") '+
      [1,2,3,4].map(n=>`(pad "${n}" thru_hole circle (at ${(n-1)*2.54} 0) (size 1.5 1.5) (drill .8) (layers "*.Cu" "*.Mask"))`).join(' ')+')';
    h.pinNets={'1':'GND','2':'LED_DATA_5V_CH1','3':'NC','4':''};
    m.hardware.push({id:'hole-fixture',kind:'hole',ref:'MH1',name:'Mounting hole',x:5,y:5,w:3.2,h:3.2,angle:0});
  }
  const out=K.makeExports(m,A),dir=path.join(destination,preset);
  for(const [name,body] of Object.entries(out.files)){const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);}
  console.log(`${preset}: ${out.manifest.length} LEDs; ${Object.keys(out.files).length} files`);
}
