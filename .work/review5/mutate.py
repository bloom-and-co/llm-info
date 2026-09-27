import subprocess, shutil, os
src=open('builder/core.mjs').read()
os.makedirs('.work/review5/mut', exist_ok=True)
shutil.copyfile('builder/core.test.ts', '.work/review5/mut/core.test.ts')
muts={
 'one-hour cache price mapping dropped': ("  cache_creation_input_token_cost_above_1hr: 'cache_write_1h_mtok',", ""),
 'one-hour models.dev price mapping dropped': ("  cache_write_1h: 'cache_write_1h_mtok',", ""),
 'source metadata enters content hash': ("    skipped: doc.skipped,", "    skipped: doc.skipped, sources: doc.sources,"),
 'extra dup: min instead of max': ("target[name] = Math.max(prior, value);","target[name] = Math.min(prior, value);"),
 'lite dup tier conflict removed': ("field: `${field}@${next.start + 1}`,","field: `${field}@${next.start + 1}`, _x: (()=>{throw 0})(),"),
 'lite dup no conflict push': ("          conflicts.push({\n            provider: p,\n            model: id,\n            field,\n            source_a","          [].push({\n            provider: p,\n            model: id,\n            field,\n            source_a"),
 'mergePrice tiers min': ("tierMap.set(t.start, Math.max(t.price, prior ?? 0));","tierMap.set(t.start, prior ?? t.price);"),
 'mode merge drop conflicts': ("{ provider: p, model: id, field: `x_modes.${mode}.${field}` },\n          conflicts,","{ provider: p, model: id, field: `x_modes.${mode}.${field}` },\n          [],"),
 'region min': ("old.x_region_uplift[region] = Math.max(prior ?? 0, factor);","old.x_region_uplift[region] = Math.min(prior ?? 99, factor);"),
 'capability bool and': ("values[field] = prior || candidate;","values[field] = prior && candidate;"),
 'capability limits max': ("values[field] = Math.min(prior, candidate);","values[field] = Math.max(prior, candidate);"),
 'efforts prefer litellm': ("values[field] = source === 'models_dev' ? candidate : prior;","values[field] = prior;"),
 'validate flagship removed': ("throw Error('missing flagship ' + id);","void 0;"),
 'validate NaN allowed': ("(!Number.isFinite(x) || x < 0)","(x < 0)"),
 'finalize always new version': ("if (previous && content === stableContent(previous)) return previous;",""),
 'fast mode not scaled': ("scalePrice(value, fastMultiplier)","value"),
 'mode tier dropped': ("if (tierValues.length && modePrices[key] !== undefined)","if (false)"),
 'conflict sort removed': ("conflicts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));",""),
 'models.dev tier off-by-one': ("t.tiers.push({ start: tier.tier.size - 1, price: tier[k] });","t.tiers.push({ start: tier.tier.size, price: tier[k] });"),
 'x-ai per_image from input_cost_per_image dropped': ("put(extras, 'per_image', num(v.input_cost_per_image));","void 0;"),
 'model-without-price guard off': ("throw Error('model without price ' + m.id);","void 0;"),
 'video default dropped': ("...(video === undefined ? {} : { default: video }),",""),
}
for name,(a,b) in muts.items():
    if a not in src: print('NOTFOUND',name); continue
    open('.work/review5/mut/core.mjs','w').write(src.replace(a,b,1))
    r=subprocess.run(['npx','vitest','run','.work/review5/mut/core.test.ts'],capture_output=True,text=True)
    print(('KILLED ' if r.returncode else 'SURVIVED'),name)
open('.work/review5/mut/core.mjs','w').write(src)
