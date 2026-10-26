import fs from 'node:fs';
import { checkPriceWatchFreshness, feedFromMetadata } from '../builder/price-watch.mjs';

const [file = 'data/llm-info.json', eventsFile] = process.argv.slice(2);
try {
  const data = feedFromMetadata(JSON.parse(fs.readFileSync(file, 'utf8')).sources?.price_watch);
  if (!data) throw Error(`${file} has no price_watch source`);
  const ageMs = checkPriceWatchFreshness(data);
  console.log(
    `price-watch: verified_at=${data.verified_at}; age_hours=${(ageMs / 3_600_000).toFixed(2)}`,
  );
  if (eventsFile) {
    const problems = JSON.parse(fs.readFileSync(eventsFile, 'utf8')).filter(
      (event) => event.type !== 'published_change',
    );
    if (problems.length) throw Error('verification events: ' + JSON.stringify(problems));
  }
} catch (error) {
  console.error(`price-watch monitor failed: ${error.message}`);
  process.exitCode = 1;
}
