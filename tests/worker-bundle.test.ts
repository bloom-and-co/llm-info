import { it, expect } from 'vitest';
import { build } from 'esbuild';

it('bundles and imports a memory-store Worker without Node modules', async () => {
  const result = await build({
    stdin: {
      contents:
        "import { createLlmInfo, memoryStore } from './src/index.ts'; export default { fetch() { return new Response(String(createLlmInfo({store:memoryStore()}).info().stale)) } };",
      resolveDir: process.cwd(),
      sourcefile: 'worker.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
  });
  const code = result.outputFiles[0].text;
  expect(code).not.toMatch(/(?:from|import\()\s*["']node:/);
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  const worker = (await import(url)).default;
  expect(await (await worker.fetch()).text()).toBe('true');
});
