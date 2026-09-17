"""Native verification on a machine with KiCad 9+: python validate-kicad.py EXPORT_DIR.

Runs KiCad's own parsers, checks netlist LED pins against the exported manifest,
and emits ERC/DRC reports. Never plots manufacturing files or changes the design.
"""
from pathlib import Path
import argparse
import json
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('export_dir',type=Path,help='Extracted export folder containing KiCad/ and mapping/')
    ap.add_argument('--cli',default='kicad-cli',help='Path to kicad-cli (KiCad 9 or later)')
    args=ap.parse_args()
    cli=shutil.which(args.cli)
    if not cli: ap.error('kicad-cli was not found. Install KiCad 9+, or give its full path using --cli.')
    root=args.export_dir.resolve();base=root/'KiCad'/'Melbourne-Live-Train-Map';report=root/'native-validation';report.mkdir(exist_ok=True)
    manifest=json.loads((root/'mapping'/'led-manifest.json').read_text())
    outcomes={}
    commands={
        'netlist':['sch','export','netlist','--format','kicadxml','--output',str(report/'netlist.xml'),str(base.with_suffix('.kicad_sch'))],
        'erc':['sch','erc','--format','json','--exit-code-violations','--output',str(report/'erc.json'),str(base.with_suffix('.kicad_sch'))],
        'drc':['pcb','drc','--schematic-parity','--format','json','--exit-code-violations','--output',str(report/'drc.json'),str(base.with_suffix('.kicad_pcb'))],
    }
    for label,command in commands.items():
        result=subprocess.run([cli,*command],capture_output=True,text=True,cwd=base.parent)
        (report/(label+'.log')).write_text(result.stdout+'\n'+result.stderr)
        outcomes[label]={'exit_code':result.returncode,'parsed':result.returncode in (0,5),'clean':result.returncode==0}
        print(f'{label}: exit {result.returncode} (0 = clean, 5 = reported rule violations)')
    mismatches=[]
    if outcomes['netlist']['clean']:
        tree=ET.parse(report/'netlist.xml');pins={}
        for net in tree.findall('./nets/net'):
            for node in net.findall('node'):pins[(node.get('ref'),node.get('pin'))]=net.get('name')
        for led in manifest['leds']:
            expected={'1':led['dout'],'2':led['power'],'3':'GND','4':led['din']}
            for number,net in expected.items():
                actual=pins.get((led['ref'],number))
                if actual!=net:mismatches.append({'ref':led['ref'],'pin':number,'expected':net,'actual':actual})
    else:
        mismatches.append({'error':'Native netlist export failed; LED pins could not be checked.'})
    outcomes['led_pin_mismatches']=mismatches
    outcomes['manufacturing_ready']=False
    (report/'summary.json').write_text(json.dumps(outcomes,indent=2))
    print(f'LED pin mismatches: {len(mismatches)}. Reports: {report}')
    print('An unrouted layout is expected to fail DRC. Resolve all findings and complete OLED/encoder/RF/power design before fabrication.')
    return 0 if all(outcomes[k]['clean'] for k in commands) and not mismatches else 1

if __name__=='__main__':sys.exit(main())
