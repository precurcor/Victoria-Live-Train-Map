"""Extract source PCB assets and replay only Kea's pure layout geometry.

Never imports/executes the upstream KiCad client or writes the source board.
The selected AST functions are recorded into a portable editor model.
"""
from pathlib import Path
import ast
import csv
import json
import math
import re
from enum import Enum

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'layout-studio' / 'assets.json'

def parse(text):
    tokens = re.findall(r'"(?:\\.|[^"\\])*"|[()]|[^\s()]+', text)
    stack, result = [], None
    for t in tokens:
        if t == '(':
            node = []
            if stack: stack[-1].append(node)
            else: result = node
            stack.append(node)
        elif t == ')': stack.pop()
        else: stack[-1].append(t)
    return result

def val(token):
    return json.loads(token) if token.startswith('"') else token

def children(node, key): return [x for x in node if isinstance(x, list) and x[0] == key]
def child(node, key): return next((x for x in node if isinstance(x, list) and x[0] == key), None)
def prop(node, key): return next((val(x[2]) for x in children(node, 'property') if val(x[1]) == key), '')
def dump(node): return '(' + ' '.join(dump(x) if isinstance(x, list) else x for x in node) + ')'

source = (ROOT / 'PCB/generate-layout.py').read_text()
tree = ast.parse(source)
group_names = ['city_loop_group','burnley_group','pakenham_cranbourne_group','frankston_sandringham_group',
               'werribee_sunbury_group','upfield_craigieburn_group','mernda_hurstbridge_group','metro_tunnel_group']
keep = {'vector','relative','bearing_to_kicad_angle','calculate_track_connections','flip_dir','permanent_offset','add_block',*group_names}
namespace = {k:getattr(math,k) for k in ['cos','sin','radians','degrees','acos','tan','atan2']}
class Dir(Enum): L=1; R=2; L_R=3
class LED: x=1.7; y=1.6
namespace.update(Dir=Dir,led=LED(),LED_OFFSET=.85,STATION_OFFSET=1.15,STATION_LINE_WIDTH=.25,
                 total_stations=0,total_leds=0,ref_letter='D',DEBUG=False)
nodes, edges, edge_map = [], [], {}
counter = 0
channel = 7
def next_id():
    global counter
    counter += 1
    return f'n{counter}'
namespace['next_id'] = next_id
def noop(*a,**kw): pass
for name in ['draw_station_rectangle','add_station_name','add_via','move_footprint','add_data_trace',
             'add_stitching_via','add_tunnel','add_bridge','draw_line','draw_text','draw_bezier','draw_circle']:
    namespace[name] = noop
def cap(cursor):
    cursor['cap_ref_num'] += 1
    cursor['cap_counter'] -= cursor['leds_per_cap']
namespace['add_capacitor'] = cap
def connection(a,ai,b,bi,dotted=False):
    if '_node_id' not in a or '_node_id' not in b: return
    key = (a['_node_id'], b['_node_id'])
    if key not in edge_map:
        edge_map[key] = dict(id=f'e{len(edges)+1}',a=key[0],b=key[1],lanes=[],count=0,mode='count',pitch=3,
                             channel=channel,dotted=dotted,bend=0,waypoint=None)
        edges.append(edge_map[key])
    if [ai,bi] not in edge_map[key]['lanes']: edge_map[key]['lanes'].append([ai,bi])
namespace['draw_track_connnection'] = connection
selected=[]
for n in tree.body:
    if isinstance(n, ast.FunctionDef) and n.name in keep:
        if n.name == 'add_block':
            n.body.insert(1, ast.parse('cursor["_node_id"] = next_id()').body[0])
        selected.append(n)
exec(compile(ast.fix_missing_locations(ast.Module(body=selected,type_ignores=[])),'pure-layout-geometry','exec'),namespace)
raw = namespace['add_block']
def record(cursor,*args,**kw):
    raw(cursor,*args,**kw)
    name = cursor.get('name')
    label = name[0].replace('\n',' ') if name else ''
    if label == 'An  ac': label = 'Anzac'
    points = cursor['track_list']
    nodes.append(dict(id=cursor['_node_id'],name=label,x=cursor['x'],y=cursor['y'],angle=(cursor['angle']-90)%360,
        pitch=cursor['side_spacing'],offset=cursor.get('offset',0),tracks=len(points),channel=channel,
        ledIds=[None if p.get('skip') else int(p['ref_num']) for p in points],
        labelDx=0,labelDy=(-4 if not name or name[1]!=Dir.L else 4),labelAngle=0,labelSize=1.6,
        locked=False,region='Kea original',stationId='',platforms=[],original=True))
namespace['add_block']=record
cursor=dict(ref_num=100,ref_num_step=1,cap_ref_num=100,leds_per_cap=12,cap_counter=0,x=0,y=0,angle=0,
            angle_step=45,radius=3,spacing=2.3,side_spacing=2.062,tracks=1,name=None,offset=0)
for group,channel in zip(group_names,[7,1,2,3,4,5,6,8]): cursor=namespace[group](cursor)

pcb=parse((ROOT/'PCB/Melbourne-Live-Train-Map.kicad_pcb').read_text())
footprints=children(pcb,'footprint')
def label_key(text):
    return ' '.join(text.casefold().split()).replace('an ac','anzac')
station_texts={label_key(val(t[1])):t for t in children(pcb,'gr_text')}
for n in nodes:
    text=station_texts.get(label_key(n['name']))
    if not text: continue
    at=child(text,'at');font=child(child(text,'effects'),'font');size=child(font,'size')
    cache=child(text,'render_cache');coords=[]
    if cache:
        for poly in children(cache,'polygon'):
            pts=child(poly,'pts')
            coords.extend((float(p[1]),float(p[2])) for p in children(pts or [],'xy'))
    # Centre the source's rendered text bounds to preserve its visual location
    # without distributing the source's external typeface or cached glyph paths.
    x=(min(p[0] for p in coords)+max(p[0] for p in coords))/2 if coords else float(at[1])
    y=(min(p[1] for p in coords)+max(p[1] for p in coords))/2 if coords else float(at[2])
    n.update(labelDx=x-n['x'],labelDy=y-n['y'],labelSize=float(size[1]),labelAngle=-float(at[3]) if len(at)>3 else 0,
             labelText='Anzac' if n['name']=='Anzac' else val(text[1]))
led=next(f for f in footprints if prop(f,'Reference')=='D100')
capacitor=next(f for f in footprints if prop(f,'Reference')=='C100')
hardware=[]
for f in footprints:
    ref=prop(f,'Reference')
    if re.fullmatch(r'[DC]\d+',ref) and int(ref[1:])>=100: continue
    at=child(f,'at')
    if not at: continue
    # Decorative footprints reuse G***. References are not unique object IDs.
    fid = 'hw-'+re.sub(r'[^A-Za-z0-9_-]', '_',ref)
    if any(h['id']==fid for h in hardware): fid+='-'+val(child(f,'uuid')[1])
    coords=[]
    for p in children(f,'pad'):
        pa,ps=child(p,'at'),child(p,'size')
        if pa and ps:
            px,py,pw,ph=map(float,[pa[1],pa[2],ps[1],ps[2]])
            coords.extend([(px-pw/2,py-ph/2),(px+pw/2,py+ph/2)])
    for p in children(f,'fp_rect')+children(f,'fp_line'):
        for k in ['start','end']:
            pt=child(p,k)
            if pt: coords.append((float(pt[1]),float(pt[2])))
    # Symmetric conservative bounds, including offset-origin connectors.
    w=max([abs(x)*2 for x,y in coords]+[1]);h=max([abs(y)*2 for x,y in coords]+[1])
    hardware.append(dict(id=fid,ref=ref,name=prop(f,'Value'),kind='existing',x=float(at[1]),y=float(at[2]),
                         angle=float(at[3]) if len(at)>3 else 0,w=w,h=h,locked=False,raw=dump(f)))

# Station IDs are sourced from the fork's GTFS stops, not invented from display names.
catalog={}
stops=ROOT.parent/'LED-Rails-Backend/railNetworks/MEL/stops.txt'
for row in csv.reader(stops.open(encoding='utf-8-sig')):
    # This checked-in file concatenates Metro and V/Line CSV variants. V/Line
    # includes stop_url, shifting parent_station by one. Identify by value.
    if len(row)<4 or row[0]=='stop_id': continue
    station_pattern=r'(vic|nsw):rail:[A-Z0-9-]+'
    parent=next((v for v in row[4:] if re.fullmatch(station_pattern,v)),None)
    is_parent=bool(re.fullmatch(station_pattern,row[0]))
    if is_parent: parent=row[0]
    # Do not mistake entrances / replacement bus stops for rail platforms.
    if not parent or ('Station' not in row[1]) or 'Replacement' in row[1]: continue
    name=row[1].replace(' Railway Station','').replace(' Station','').strip()
    if name=='Jolimont-MCG': name='Jolimont'
    entry=catalog.setdefault(parent,dict(stationId=parent,name=name,platforms=[]))
    if not is_parent:
        platform=row[8] if len(row)==9 and not row[8].startswith('Level') else ''
        entry['platforms'].append(dict(stopId=row[0],platform=platform,lat=float(row[2]),lon=float(row[3])))
for n in nodes:
    for s in catalog.values():
        if n['name'].casefold()==s['name'].casefold():
            n.update(stationId=s['stationId'],platforms=s['platforms'])
            break

sch=parse((ROOT/'PCB/Melbourne-Live-Train-Map.kicad_sch').read_text())
ledsch=parse((ROOT/'PCB/LEDs-1.kicad_sch').read_text())
capsch=parse((ROOT/'PCB/Capacitors.kicad_sch').read_text())
assets=dict(source={'hardware':'precurcor/Victoria-Live-Train-Map','commit':'f628db0917e4a076e77e99ff934c330375196ae1'},
 nodes=nodes,edges=edges,hardware=hardware,catalog=sorted(catalog.values(),key=lambda s:s['name']),
 pcbHeader=[dump(n) for n in pcb[1:] if isinstance(n,list) and n[0] in ['version','generator','generator_version','general','paper','layers','setup']],
 nets=[dump(n) for n in children(pcb,'net')],ledFootprint=dump(led),capFootprint=dump(capacitor),
 rootSchematic=(ROOT/'PCB/Melbourne-Live-Train-Map.kicad_sch').read_text(),usbSchematic=(ROOT/'PCB/USB.kicad_sch').read_text(),
 ledLib=dump(child(ledsch,'lib_symbols')),capLib=dump(child(capsch,'lib_symbols')),
 rootUuid=val(child(sch,'uuid')[1]),sheets=[dict(name=prop(s,'Sheetname'),file=prop(s,'Sheetfile'),uuid=val(child(s,'uuid')[1])) for s in children(sch,'sheet')],
 project=(ROOT/'PCB/Melbourne-Live-Train-Map.kicad_pro').read_text(),license=(ROOT/'LICENSE').read_text(),
 originalLeds=[dict(ref=prop(f,'Reference'),at=[float(x) for x in child(f,'at')[1:]],
                    supply=next(val(child(p,'net')[2]) for p in children(f,'pad') if val(p[1])=='2'))
               for f in footprints if re.fullmatch(r'D\d+',prop(f,'Reference')) and int(prop(f,'Reference')[1:])>=100])
OUT.write_text(json.dumps(assets,separators=(',',':')))
print(json.dumps(dict(nodes=len(nodes),stations=sum(bool(n['name']) for n in nodes),edges=len(edges),
                     leds=sum(sum(x is not None for x in n['ledIds']) for n in nodes),hardware=len(hardware),catalog=len(catalog),bytes=OUT.stat().st_size)))
