import subprocess
p='src/engine.ts'; src=open(p).read()
muts={
 'one-hour write allocation dropped': ("  if (cacheWrite1h) allocate(cacheWrite1h, 'cache_write_1h', [0, 0, 0]);", ""),
 'one-hour fallback uses five-minute rate': ("return rate('input', [], false) * 2;", "return rate('cache_write', [], false);"),
 'one-hour mode tier ratio dropped': ("prices.cache_write_1h *= prices.input / tiered(model.prices).input;", "void 0;"),
 'tier >=': ("if (inputCount > tier.above_input_tokens)","if (inputCount >= tier.above_input_tokens)"),
 'tier disabled': ("if (inputCount > tier.above_input_tokens) Object.assign(active, tier.prices);",""),
 'missing mode -> standard': ("multiplier = options.providerModeMultiplier || own || 2;","multiplier = 1;"),
 'mode tiers ignored': ("Object.assign(prices, tiered(modePrices));","Object.assign(prices, modePrices);"),
 'fallback min': ("return candidates.length ? Math.max(...candidates) : highest;","return candidates.length ? Math.min(...candidates) : highest;"),
 'missing -> 0': ("return candidates.length ? Math.max(...candidates) : highest;","return candidates.length ? Math.max(...candidates) : 0;"),
 'cache alloc min cost': ("choices.sort((a, b) => b.r - baseRates[b.i] - (a.r - baseRates[a.i]) || a.i - b.i);","choices.sort((a, b) => a.r - baseRates[a.i] - (b.r - baseRates[b.i]) || a.i - b.i);"),
 'modality overflow cut expensive first': ("sort((a, b) => modalRates[a] - modalRates[b])","sort((a, b) => modalRates[b] - modalRates[a])"),
 'region ignored': ("const uplift = normalizedRegion === 'global' ? 1 : (model.region_uplift?.[normalizedRegion] ?? 1);","const uplift = 1;"),
 'multiplier ignored': ("multiplier = selected.multiplier ?? 1;",""),
 'reasoning not added': ("if (reasoning) outputCost += reasoning * rate('reasoning', ['output']);",""),
 'output modal cheap first': (".sort((a, b) => b.rate - a.rate);",".sort((a, b) => a.rate - b.rate);"),
 'per_image always added': ("images &&\n    !count('output_image_tokens') &&","images &&"),
 'web search missing ->0 silent': ("else warnings.push('missing_price:web_search');",""),
 'money floor': ("Math.round(value * 1e10) / 1e10","Math.floor(value * 1e8) / 1e8"),
 'dated suffix off': ("(dated.test(id)","(false"),
 'prefix strip off': (".replace(/^(?:openai|anthropic|gemini|models|google|xai|x-ai)\\//i, '')",""),
 'alias case sensitive': ("m.aliases?.some((a) => a.toLowerCase() === id) ||","m.aliases?.some((a) => a === id) ||"),
 'explicit cache modality ignored': ("const fixed = Math.min(left, remaining[i], explicit[i - 1] ?? 0);","const fixed = 0;"),
 'input clamp removed': ("const input = Math.max(rawInput, cacheRead + cacheWrite + cacheWrite1h, ...inputMod);","const input = rawInput;"),
}
for name,(a,b) in muts.items():
    if a not in src: print('NOTFOUND',name); continue
    open(p,'w').write(src.replace(a,b,1))
    r=subprocess.run(['npx','vitest','run','--exclude','tests/worker-bundle.test.ts','--exclude','.work/**'],capture_output=True,text=True)
    print(('KILLED ' if r.returncode else 'SURVIVED'),name)
open(p,'w').write(src)
