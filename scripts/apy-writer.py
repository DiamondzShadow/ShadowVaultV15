#!/usr/bin/env python3
"""
Per-venue APY read-model writer for the BRX Yield portal.

Mirrors the keeper heartbeat pattern (temporal/keepers_temporal.py): fetch each Arbitrum
strategy pool's LIVE rate from that venue's own canonical source, then write a same-origin
JSON the portal fetches at /engine/apy.json. No keys ship to the browser; the honesty logic
(and provenance) lives here where it can be verified against each venue's UI.

Deliberately NEVER fabricates a rate: any venue whose source fails this cycle is written as
apy: null (portal renders "market-set"), and if EVERY venue fails we keep the last-good file
rather than overwrite it with nulls.

Venues (source of truth: config/deployed.json -> pools):
  A Morpho steakUSDC  bbqUSDC vault 0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA  -> Morpho GraphQL netApy (net of fee)
  B GMX GM ETH/USDC   market      0x70d95587d40a2caf56bd97485ab3eec10bee6336  -> GMX arbitrum-api /apy
  C Aave v3 USDC      pool        0x794a61358D6845594F94dc1DB02A252b5b4814aD  -> on-chain currentLiquidityRate
  D Fluid fUSDC       fToken      0x1A996cb54bb95462040408C06122D45D6Cdb6096  -> Fluid API totalRate

Scheduling: run every 15 min by the Temporal worker `shadowvault-hc-keepers-temporal`
(temporal/keepers_temporal.py -> ApyRefreshWorkflow -> refresh_apy_readmodel activity runs this
as a subprocess, same pattern as the keepers; schedule id `shadowvault-apy-periodic`). Also runs
standalone for a manual refresh: `python3 scripts/apy-writer.py`.
"""
import json
import os
from datetime import datetime, timezone

import requests

OUT = os.environ.get("BRX_APY_PATH", "/var/www/yield.billionairesrow.io/engine/apy.json")
ARB_RPC = os.environ.get("APY_ARB_RPC", "https://arb1.arbitrum.io/rpc")
TIMEOUT = 15

MORPHO_VAULT = "0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA"
GMX_MARKET = "0x70d95587d40a2caf56bd97485ab3eec10bee6336"
AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
AAVE_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
FLUID_FUSDC = "0x1A996cb54bb95462040408C06122D45D6Cdb6096"

RAY = 10 ** 27
SECONDS_PER_YEAR = 31_536_000


def _now():
    return datetime.now(timezone.utc).isoformat()


def morpho_net_apy():
    """Steakhouse USDC MetaMorpho vault net APY (after the vault fee), Morpho's own number."""
    q = ('{ vaultByAddress(address:"%s", chainId:42161){ state{ netApy } } }' % MORPHO_VAULT)
    r = requests.post("https://blue-api.morpho.org/graphql", json={"query": q}, timeout=TIMEOUT)
    r.raise_for_status()
    apy = r.json()["data"]["vaultByAddress"]["state"]["netApy"]
    return {"apy": float(apy), "basis": "net", "source": "Morpho API"}


def gmx_apy():
    """GM ETH/USDC pool APY (fees + funding) from GMX's canonical arbitrum API."""
    r = requests.get("https://arbitrum-api.gmxinfra.io/apy", timeout=TIMEOUT)
    r.raise_for_status()
    markets = {k.lower(): v for k, v in r.json()["markets"].items()}
    m = markets[GMX_MARKET.lower()]
    return {"apy": float(m["apy"]), "basis": "gross", "source": "GMX API"}


def aave_supply_apy():
    """Aave v3 USDC supply APY, read on-chain from currentLiquidityRate (ray APR -> compounded APY)."""
    data = "0x35ea6a75" + AAVE_USDC[2:].rjust(64, "0")  # getReserveData(address)
    r = requests.post(ARB_RPC, timeout=TIMEOUT, json={
        "jsonrpc": "2.0", "id": 1, "method": "eth_call",
        "params": [{"to": AAVE_POOL, "data": data}, "latest"]})
    r.raise_for_status()
    words = r.json()["result"][2:]
    # ReserveData: [0]configuration [1]liquidityIndex [2]currentLiquidityRate ...
    liq_rate = int(words[2 * 64:3 * 64], 16)
    apr = liq_rate / RAY
    apy = (1 + apr / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1
    return {"apy": apy, "basis": "supply", "source": "on-chain"}


def fluid_supply_apy():
    """Fluid fUSDC total supply rate (supply + rewards) from Fluid's lending API. Rate is in 1e2 %."""
    r = requests.get("https://api.fluid.instadapp.io/v2/lending/42161/tokens", timeout=TIMEOUT)
    r.raise_for_status()
    for t in r.json()["data"]:
        if t["address"].lower() == FLUID_FUSDC.lower():
            return {"apy": float(t["totalRate"]) / 10000.0, "basis": "supply", "source": "Fluid API"}
    raise KeyError("fUSDC not in Fluid response")


FETCHERS = {"A": morpho_net_apy, "B": gmx_apy, "C": aave_supply_apy, "D": fluid_supply_apy}


def main():
    venues, ok_count = {}, 0
    for key, fn in FETCHERS.items():
        try:
            v = fn()
            v["asOf"] = _now()
            venues[key] = v
            ok_count += 1
        except Exception as e:  # fail-soft per venue -> null (portal shows "market-set")
            venues[key] = {"apy": None, "source": "unavailable", "error": str(e)[:120]}

    if ok_count == 0:
        # Total wipeout — keep last-good rather than blank every venue.
        print(f"{_now()} all venues failed; keeping last-good {OUT}")
        return

    doc = {"updatedAt": _now(), "chain": "arbitrum", "venues": venues}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(doc, fh)
    os.replace(tmp, OUT)  # atomic
    rates = " ".join(f"{k}={(v['apy'] * 100):.2f}%" if v.get("apy") is not None else f"{k}=n/a"
                     for k, v in venues.items())
    print(f"{_now()} wrote {OUT}  {rates}")


if __name__ == "__main__":
    main()
