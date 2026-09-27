"""Isolate the genai-prices 0.1.9 private raw provider conversion here."""

from genai_prices.data_snapshot import DataSnapshot
from genai_prices.types import Usage, _providers_from_raw


def snapshot_from_data(data):
    return DataSnapshot(_providers_from_raw(data["providers"]), False)
