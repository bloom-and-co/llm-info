import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { CacheDoc, PriceStore } from './index.js';
export function fileStore(
  path = process.env.LLM_INFO_CACHE ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'llm-info', 'llm-info.json'),
): PriceStore {
  return {
    async read() {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as CacheDoc;
      } catch (e: any) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async write(doc) {
      await mkdir(dirname(path), { recursive: true });
      let previous: CacheDoc | null = null;
      try {
        previous = JSON.parse(await readFile(path, 'utf8'));
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (previous && Date.parse(previous.data.generated_at) > Date.parse(doc.data.generated_at))
        return;
      const tmp = path + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
      try {
        await writeFile(tmp, JSON.stringify(doc));
        await rename(tmp, path);
      } finally {
        await rm(tmp, { force: true });
      }
    },
  };
}
