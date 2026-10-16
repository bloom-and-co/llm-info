import { checkPriceWatchFreshness, fetchPriceWatch } from '../builder/price-watch.mjs';

try {
  const { data, url } = await fetchPriceWatch(process.env.LLM_PRICE_WATCH_URL || undefined);
  const ageMs = checkPriceWatchFreshness(data);
  console.log(
    `price-watch: ${url}; verified_at=${data.verified_at}; age_hours=${(ageMs / 3_600_000).toFixed(2)}`,
  );
} catch (error) {
  console.error(`price-watch monitor failed: ${error.message}`);
  process.exitCode = 1;
}
