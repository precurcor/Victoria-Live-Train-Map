"""CI format/parity gate. Electrical rule violations remain in the published reports.

A passing format gate is not electrical sign-off or fabrication approval.
"""
from pathlib import Path
import json
import subprocess
import sys

root = Path(sys.argv[1])
failed = []
for project in sorted(root.iterdir()):
    if not (project / 'KiCad').is_dir():
        continue
    subprocess.run([sys.executable, str(Path(__file__).with_name('validate-kicad.py')), str(project)], check=False)
    report = project / 'native-validation'
    summary_file = report / 'summary.json'
    if not summary_file.exists():
        failed.append(f'{project.name}: no validation summary')
        continue
    summary = json.loads(summary_file.read_text())
    for stage in ['netlist', 'erc', 'drc']:
        if not summary[stage]['parsed']:
            failed.append(f'{project.name}: {stage} failed to parse')
            print((report / (stage + '.log')).read_text())
    if summary['led_pin_mismatches']:
        failed.append(f"{project.name}: {len(summary['led_pin_mismatches'])} LED pin net mismatches")
        print(json.dumps(summary['led_pin_mismatches'][:8], indent=2))
    drc_file = report / 'drc.json'
    if drc_file.exists():
        drc = json.loads(drc_file.read_text())
        parity = drc.get('schematic_parity', [])
        if parity:
            failed.append(f'{project.name}: {len(parity)} schematic parity findings')
            print(json.dumps(parity[:5], indent=2))
    print(f'{project.name}: native parsing checked; ERC/DRC reports retained, not waived.')
if failed:
    print('\n'.join(failed))
    sys.exit(1)
print('All representative exports passed native format, LED pin-net and schematic parity checks.')
