"""Bundle into one offline HTML file. No runtime installation required."""
from pathlib import Path
import json
ROOT=Path(__file__).resolve().parents[1]
html=(ROOT/'index.template.html').read_text()
assets=json.loads((ROOT/'assets.json').read_text())
scripts={'VENDOR':(ROOT/'vendor/jszip.min.js').read_text(),
         'ASSETS':'const STUDIO_ASSETS='+json.dumps(assets,separators=(',',':')).replace('<','\\u003c')+';',
         'CORE':(ROOT/'core.js').read_text(),'CAD':(ROOT/'cad.js').read_text(),'APP':(ROOT/'app.js').read_text()}
for marker,script in scripts.items():
    html=html.replace('<!-- '+marker+' -->','<script>\n'+script.replace('</script','<\\/script')+'\n</script>')
(ROOT/'Victoria-Rail-Layout-Studio.html').write_text(html)
print('Built',ROOT/'Victoria-Rail-Layout-Studio.html',len(html.encode()),'bytes')
