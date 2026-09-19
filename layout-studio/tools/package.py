"""Build the downloadable program/source/example archive. Requires Node and Python."""
from pathlib import Path
import json
import subprocess
import tempfile
import zipfile

STUDIO=Path(__file__).resolve().parents[1]
subprocess.run(['python3',str(STUDIO/'tools'/'build.py')],check=True)
release=STUDIO/'releases'/'Victoria-Rail-Layout-Studio.zip'
release.parent.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='rail-studio-') as temporary:
    subprocess.run(['node','-e',r'''
const fs=require('fs'),path=require('path'),root=process.argv[1],dest=process.argv[2];
const a=require(path.join(root,'assets.json'));require(path.join(root,'core.js'));require(path.join(root,'cad.js'));
const model=RailCore.addRegional(RailCore.baseProject(a),a),out=RailCAD.makeExports(model,a);
for(const [name,data] of Object.entries(out.files)){const file=path.join(dest,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);}
console.log(JSON.stringify({stations:model.nodes.filter(n=>n.name).length,leds:out.g.leds.length,exportFiles:Object.keys(out.files).length}));
''',str(STUDIO),temporary],check=True)
    prefix='Victoria-Rail-Layout-Studio/'
    with zipfile.ZipFile(release,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=7) as archive:
        for name in ['Victoria-Rail-Layout-Studio.html','README.md','START-HERE.txt','INTEGRATION.md','LICENSE']:
            archive.write(STUDIO/name,prefix+name)
        for file in sorted(STUDIO.rglob('*')):
            relative=file.relative_to(STUDIO)
            if not file.is_file() or any(p in ('releases','__pycache__') for p in relative.parts) or file.suffix=='.pyc':continue
            if file.name=='Victoria-Rail-Layout-Studio.html':continue
            archive.write(file,prefix+'source/layout-studio/'+relative.as_posix())
        for file in sorted(Path(temporary).rglob('*')):
            if file.is_file():archive.write(file,prefix+'example-victoria-export/'+file.relative_to(temporary).as_posix())
        archive.write(STUDIO/'tools'/'validate-kicad.py',prefix+'example-victoria-export/validate-kicad.py')
    with zipfile.ZipFile(release) as archive:
        bad=archive.testzip()
        if bad:raise RuntimeError('Corrupt archive member: '+bad)
        assert prefix+'Victoria-Rail-Layout-Studio.html' in archive.namelist()
        assert prefix+'example-victoria-export/KiCad/Melbourne-Live-Train-Map.kicad_pcb' in archive.namelist()
print(json.dumps({'archive':str(release),'bytes':release.stat().st_size}))
