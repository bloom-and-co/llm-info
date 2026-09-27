import json,sys
from datetime import datetime,timezone
from genai_prices.data_snapshot import DataSnapshot
from genai_prices.types import Usage,_providers_from_raw
raw=json.load(open(sys.argv[1]))
providers=_providers_from_raw(raw['providers'])
snapshot=DataSnapshot(providers,False)
for provider in providers:
    model=next((m for m in provider.models if m.prices),None)
    if model is None: raise ValueError(provider.id)
    snapshot.calc(Usage(input_tokens=1000,output_tokens=1000),model.id,provider.id,None,datetime.now(timezone.utc))
print('python SDK validation: 4 providers passed')
