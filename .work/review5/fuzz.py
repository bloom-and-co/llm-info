import json, sys
sys.path.insert(0,'python')
from llm_info._engine import calculate
from decimal import Decimal
d=json.load(open('data/llm-info.json')); idx={(m['provider'],m['id']):m for m in d['models']}
cases=json.load(open('.work/review5/cases.json'))
bad=0; wd=0
for c in cases:
    r=calculate(idx[(c['p'],c['id'])],c['u'],c['opt'],c['mode'],c['region'])
    if abs(float(r['total_usd'])-c['t'])>1e-9*max(1,c['t']):
        bad+=1
        if bad<8: print('DIFF',c['id'],c['u'],c['mode'],c['region'],c['opt'],'js',c['t'],'py',r['total_usd'])
    if sorted(r['warnings'])!=sorted(c['w']):
        wd+=1
        if wd<6: print('WDIFF',c['id'],c['u'],c['mode'],c['w'],r['warnings'])
print('total diffs',bad,'warning diffs',wd,'of',len(cases))
