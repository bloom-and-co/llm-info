"""Cached, source-attributed LLM price estimates."""
from __future__ import annotations
import json, os, tempfile, threading, time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Protocol
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from ._sdk import snapshot_from_data, Usage

DEFAULT_URL='https://raw.githubusercontent.com/bloom-and-co/llm-prices/main/data/prices.json'
FALLBACK_URL='https://cdn.jsdelivr.net/gh/bloom-and-co/llm-prices@main/data/prices.json'
class PricesNotLoadedError(RuntimeError): pass
class PriceStore(Protocol):
    def read(self)->dict|None: ...
    def write(self,doc:dict)->None: ...

def _date(s): return datetime.fromisoformat(s.replace('Z','+00:00'))
def _now(): return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
def _valid(d):
    try:
        return bool(isinstance(d,dict) and d.get('schema')==1 and isinstance(d.get('version'),str) and len(d.get('providers',[]))==4 and all(isinstance(p.get('models'),list) for p in d['providers']) and _date(d['generated_at']))
    except (TypeError, ValueError, KeyError):
        return False
class MemoryStore:
    def __init__(self,initial=None): self.doc=initial
    def read(self): return self.doc
    def write(self,doc):
        if not self.doc or _date(doc['data']['generated_at'])>=_date(self.doc['data']['generated_at']): self.doc=doc
class FileStore:
    def __init__(self,path=None): self.path=Path(path or os.environ.get('LLM_PRICES_CACHE') or Path(os.environ.get('XDG_CACHE_HOME',Path.home()/'.cache'))/'llm-prices'/'prices.json')
    def read(self):
        try: return json.loads(self.path.read_text())
        except FileNotFoundError: return None
    def write(self,doc):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        previous=self.read()
        if previous and _date(previous['data']['generated_at'])>_date(doc['data']['generated_at']): return
        fd,tmp=tempfile.mkstemp(dir=self.path.parent,prefix='.prices-')
        try:
            with os.fdopen(fd,'w') as f: json.dump(doc,f)
            os.replace(tmp,self.path)
        finally:
            if os.path.exists(tmp): os.unlink(tmp)

def _fetch(url,etag):
    req=Request(url,headers={'If-None-Match':etag} if etag else {})
    try:
        with urlopen(req,timeout=15) as r: return r.status, r.headers.get('ETag'),json.load(r)
    except HTTPError as e:
        if e.code==304:return 304,etag,None
        raise

def _base(value): return value if isinstance(value,(int,float)) else value.get('base') if isinstance(value,dict) else None

def _match(provider,model):
    from re import fullmatch,escape
    for m in provider['models']:
        if m['id'].lower()==model.lower():return m
    for m in sorted(provider['models'],key=lambda m:-len(m['id'])):
        if fullmatch(escape(m['id'])+r'-(?:20\d{6}|20\d{2}-\d{2}-\d{2})',model,flags=2):return m
    return None

class LlmPrices:
    def __init__(self,url=DEFAULT_URL,fallback_urls=None,store=None,ttl=21600,auto_refresh=True,fetch=None,accept=None,on_event=None):
        self.url=url;self.urls=[url]+(fallback_urls if fallback_urls is not None else [FALLBACK_URL]);self.store=store or FileStore();self.ttl=ttl;self.auto_refresh=auto_refresh;self.fetch=fetch or _fetch;self.accept=accept;self.on_event=on_event;self.doc=None;self.snapshot=None;self._lock=threading.RLock()
    def _emit(self,event,detail=None):
        if self.on_event:self.on_event(event,detail)
    def _activate(self,doc):
        snapshot=snapshot_from_data(doc['data'])
        for p in doc['data']['providers']:
            if not p['models']:raise ValueError('empty provider')
            for m in p['models']:snapshot.calc(Usage(input_tokens=1,output_tokens=1),m['id'],p['id'],None,None)
        self.snapshot=snapshot;self.doc=doc
    def _persist(self,doc):
        old=self.store.read()
        if old and _date(old['data']['generated_at'])>_date(doc['data']['generated_at']):doc=old
        else:self.store.write(doc)
        self._activate(doc)
    def info(self):
        d=self.doc
        return {'version':d['data']['version'] if d else None,'generated_at':d['data']['generated_at'] if d else None,'fetched_at':d['fetched_at'] if d else None,'stale':not d or time.time()-_date(d['fetched_at']).timestamp()>self.ttl,'last_error':d['last_error'] if d else None}
    def load(self):
        with self._lock:
            if self.doc is None:
                old=self.store.read()
                if old and _valid(old.get('data')):self._activate(old)
            if self.doc is None:self.refresh(force=True)
            elif self.info()['stale'] and self.auto_refresh:threading.Thread(target=self.refresh,daemon=True).start()
            return self.info()
    def refresh(self,force=False):
        with self._lock:
            if self.doc and not force and not self.info()['stale']:return {'status':'fresh','info':self.info()}
            attempted=_now();error=''
            for url in self.urls:
                try:
                    status,etag,data=self.fetch(url,self.doc['etag'] if self.doc else None)
                    if status==304 and self.doc:
                        self._persist({**self.doc,'fetched_at':_now(),'last_attempt_at':attempted,'last_error':None});self._emit('not_modified');return {'status':'not_modified','info':self.info()}
                    if status<200 or status>=300:raise RuntimeError(f'HTTP {status}')
                    if not _valid(data):self._emit('rejected','invalid_shape');return {'status':'rejected','reason':'invalid_shape','info':self.info()}
                    if self.doc and _date(data['generated_at'])<_date(self.doc['data']['generated_at']):self._emit('rejected','older_data');return {'status':'rejected','reason':'older_data','info':self.info()}
                    nextdoc={'cache_schema':1,'source_url':url,'fetched_at':_now(),'etag':etag,'last_attempt_at':attempted,'last_error':None,'data':data}
                    try:
                        check=snapshot_from_data(data)
                        for provider in data['providers']:
                            if not provider['models']:raise ValueError('empty provider')
                            for model in provider['models']:check.calc(Usage(input_tokens=1),model['id'],provider['id'],None,None)
                    except Exception:self._emit('rejected','invalid_sdk_data');return {'status':'rejected','reason':'invalid_sdk_data','info':self.info()}
                    if self.accept and not self.accept(data,self.doc['data'] if self.doc else None):self._emit('rejected','accept_false');return {'status':'rejected','reason':'accept_false','info':self.info()}
                    self._persist(nextdoc);self._emit('updated');return {'status':'updated','info':self.info()}
                except Exception as e:error=str(e)
            if self.doc:
                self._persist({**self.doc,'last_attempt_at':attempted,'last_error':error});self._emit('error',error);return {'status':'error','info':self.info()}
            raise RuntimeError('Unable to load prices: '+error)
    def calc(self,provider,model,usage,at=None,options=None):
        if not self.doc:raise PricesNotLoadedError('Prices are not loaded; call load() first')
        p=next((p for p in self.doc['data']['providers'] if p['id']==provider),None)
        m=_match(p,model) if p else None
        if not m:return None
        clean={k:v for k,v in usage.items() if k not in ('cache_write_1h_tokens','output_images','output_video_seconds')}
        try:result=self.snapshot.calc(Usage(**clean),m['id'],provider,None,at)
        except LookupError:return None
        d=Decimal;extra=d(0);warnings=[];options=options or {};x=m.get('x_extra_prices',{})
        if self.info()['stale']:warnings.append('stale_data')
        if usage.get('cache_write_1h_tokens'):
            rate=x.get('cache_write_1h_mtok');base=_base(m['prices'].get('cache_write_mtok'))
            if rate is None or base is None:warnings.append('missing_price:cache_write_1h')
            else:extra+=(d(str(rate))-d(str(base)))*d(str(usage['cache_write_1h_tokens']))/d(1000000)
        for field,tag in [('output_images','per_image'),('output_video_seconds','per_video_second')]:
            if not usage.get(field) or (field=='output_images' and usage.get('output_image_tokens')):continue
            rate=x.get(tag)
            if isinstance(rate,dict):
                if tag=='per_image' and not options.get('size'):warnings.append('missing_param:size');continue
                if tag=='per_image' and not options.get('quality'):warnings.append('missing_param:quality');continue
                key=(str(options['size'])+'/'+str(options['quality'])) if tag=='per_image' else options.get('resolution')
                if not key and 'default' not in rate:warnings.append('missing_param:resolution');continue
                rate=rate.get(key or 'default')
            if rate is None:warnings.append('missing_price:'+tag);continue
            extra+=d(str(rate))*d(str(usage[field]))
        if options.get('service_tier') not in (None,'default'):warnings.append('service_tier_ignored')
        return {'total_usd':result.total_price+extra,'input_usd':result.input_price,'output_usd':result.output_price,'extra_usd':extra,'provider':provider,'model':m['id'],'requested_model':model,'usage':usage,'data_version':self.doc['data']['version'],'source':m.get('x_source','unknown'),'warnings':warnings}
    def extract_usage(self,provider,response,request=None,api_flavor=None):
        if not self.doc:raise PricesNotLoadedError('Prices are not loaded; call load() first')
        request=request or {};u=response.get('usage') or response.get('usageMetadata') or {};model=response.get('model') or response.get('modelVersion') or request.get('model');out={}
        def set_(key,val):
            if isinstance(val,(int,float)):out[key]=val
        if provider=='anthropic':
            set_('input_tokens',u.get('input_tokens',0)+u.get('cache_creation_input_tokens',0)+u.get('cache_read_input_tokens',0));set_('output_tokens',u.get('output_tokens'));set_('cache_read_tokens',u.get('cache_read_input_tokens'));set_('cache_write_tokens',u.get('cache_creation_input_tokens'));set_('cache_write_1h_tokens',u.get('cache_creation',{}).get('ephemeral_1h_input_tokens'))
        elif provider=='google':
            set_('input_tokens',u.get('promptTokenCount'));set_('output_tokens',u.get('candidatesTokenCount',0)+u.get('thoughtsTokenCount',0));set_('cache_read_tokens',u.get('cachedContentTokenCount'))
            p=next((p for p in self.doc['data']['providers'] if p['id']==provider),None)
            m=_match(p,model) if p and model else None
            if m and m['prices'].get('output_reasoning_mtok'):set_('output_reasoning_tokens',u.get('thoughtsTokenCount'))
            for source,dest in [('promptTokensDetails','input_image_tokens'),('candidatesTokensDetails','output_image_tokens')]:
                if source in u:set_(dest,sum(x.get('tokenCount',0) for x in u[source] if x.get('modality')=='IMAGE'))
            if 'generatedImages' in response:set_('output_images',len(response['generatedImages']))
            set_('output_video_seconds',response.get('duration',request.get('duration',request.get('durationSeconds'))))
        else:
            set_('input_tokens',u.get('prompt_tokens',u.get('input_tokens')));set_('output_tokens',u.get('completion_tokens',u.get('output_tokens')))
            set_('cache_read_tokens',u.get('prompt_tokens_details',u.get('input_tokens_details',{})).get('cached_tokens'))
            set_('input_image_tokens',u.get('input_tokens_details',{}).get('image_tokens'));set_('output_image_tokens',u.get('output_tokens_details',{}).get('image_tokens'))
            p=next((p for p in self.doc['data']['providers'] if p['id']==provider),None)
            m=_match(p,model) if p and model else None
            if m and m['prices'].get('output_reasoning_mtok'):set_('output_reasoning_tokens',u.get('completion_tokens_details',u.get('output_tokens_details',{})).get('reasoning_tokens'))
            set_('input_audio_tokens',u.get('prompt_tokens_details',u.get('input_tokens_details',{})).get('audio_tokens'))
            set_('output_audio_tokens',u.get('completion_tokens_details',u.get('output_tokens_details',{})).get('audio_tokens'))
            if api_flavor=='images' or 'data' in response:set_('output_images',len(response['data']) if 'data' in response else request.get('n',1))
            set_('output_video_seconds',response.get('duration',request.get('duration',request.get('durationSeconds'))))
        return {'model':model,'usage':out}
    def from_response(self,provider,response,request=None,api_flavor=None,at=None):
        extracted=self.extract_usage(provider,response,request,api_flavor)
        if not extracted['model']:return None
        return self.calc(provider,extracted['model'],extracted['usage'],at,{**(request or {}),**response,'service_tier':response.get('service_tier')})
