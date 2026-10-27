#!/usr/bin/env python3
"""
keepers_temporal.py — ShadowVault HyperEVM keepers, on Temporal Cloud.

Replaces the pm2 cron_restart scheduling of the two HyperEVM (chain 999) keepers with
durable Temporal workflows + Schedules. The keeper *logic is unchanged*: the activity
runs the existing Node script as a subprocess (`node keeper/<script>.js`), streams its
JSON log lines into Temporal heartbeats, parses out the steps + tx hashes for the run
history, and raises on a non-zero exit so Temporal retries with backoff.

Two schedules replace two crons:
  - hlp-hc-keeper-v2.js   every 3h    (was cron "0 */3 * * *")
  - nav-from-hc.js        every 10m   (was cron "*/10 * * * *")
Overlap policy SKIP: a still-running cycle is never double-started.

Env: ~/.temporal-cloud.env (TEMPORAL_ADDRESS / _NAMESPACE / _API_KEY). The Node keepers
self-load their own env (.env.pool-e + .env in the repo root) via dotenv, so this layer
passes nothing secret — it only orchestrates.

  <venv>/python keepers_temporal.py worker        # run the worker (pm2, autorestart)
  <venv>/python keepers_temporal.py schedule       # create/update both Schedules
  <venv>/python keepers_temporal.py trigger hlp     # run one hlp cycle now
  <venv>/python keepers_temporal.py trigger nav     # run one nav cycle now
"""
import asyncio
import json
import os
import shutil
import sys
from dataclasses import dataclass
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.client import (
    Client, Schedule, ScheduleActionStartWorkflow, ScheduleIntervalSpec,
    ScheduleSpec, SchedulePolicy, ScheduleOverlapPolicy,
)
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError
from temporalio.worker import Worker

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)  # ~/ShadowVaultV15


def _load_env(path):
    path = os.path.expanduser(path)
    if not os.path.exists(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_env("~/.temporal-cloud.env")

TASK_QUEUE = os.environ.get("SHADOWVAULT_KEEPER_TASK_QUEUE", "shadowvault-hc-keepers")


def _node_bin():
    # Resolved lazily (never at module import — the workflow sandbox forbids shutil.which there).
    return os.environ.get("NODE_BIN") or shutil.which("node") or "/usr/bin/node"

# The two keepers, their scripts and cadence. Kept here so schedules + triggers agree.
KEEPERS = {
    "hlp": {"script": "keeper/hlp-hc-keeper-v2.js", "label": "hlp-hc", "interval_min": 180},
    "nav": {"script": "keeper/nav-from-hc.js",      "label": "nav-from-hc", "interval_min": 10},
}


@dataclass
class KeeperParams:
    script: str          # repo-relative path, e.g. "keeper/hlp-hc-keeper-v2.js"
    label: str           # short name for logs / history
    timeout_s: int = 300


@activity.defn(name="run_keeper_cycle")
async def run_keeper_cycle(params: KeeperParams) -> dict:
    """Run one keeper pass as a subprocess. Streams stdout→heartbeat, parses JSON logs."""
    script_abs = os.path.join(REPO, params.script)
    if not os.path.exists(script_abs):
        raise ApplicationError(f"keeper script not found: {script_abs}", type="MissingScript")

    activity.heartbeat(f"starting {params.label}")
    proc = await asyncio.create_subprocess_exec(
        _node_bin(), script_abs,
        cwd=REPO,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=os.environ.copy(),  # keeper self-loads its own .env.pool-e/.env
    )

    lines, steps, txs = [], [], []
    try:
        while True:
            raw = await asyncio.wait_for(proc.stdout.readline(), timeout=params.timeout_s)
            if not raw:
                break
            line = raw.decode(errors="replace").rstrip()
            if not line:
                continue
            lines.append(line)
            activity.heartbeat(line[:180])  # keeper progress → Temporal heartbeat
            try:
                j = json.loads(line)
                if j.get("step"):
                    steps.append(j["step"])
                if j.get("txHash"):
                    txs.append(j["txHash"])
            except Exception:
                pass  # dotenv banners / non-JSON lines
    except asyncio.TimeoutError:
        proc.kill()
        raise ApplicationError(
            f"{params.label} produced no output for {params.timeout_s}s — killed",
            type="KeeperStalled")

    rc = await proc.wait()
    summary = {
        "label": params.label, "script": params.script, "rc": rc, "ok": rc == 0,
        "steps": steps, "txHashes": txs, "logLines": len(lines), "tail": lines[-6:],
    }
    if rc != 0:
        raise ApplicationError(
            f"{params.label} exited {rc}: {' | '.join(lines[-4:])}",
            type="KeeperFailed", non_retryable=False, details=[summary])
    return summary


@workflow.defn(name="ShadowVaultKeeperWorkflow")
class ShadowVaultKeeperWorkflow:
    @workflow.run
    async def run(self, params: KeeperParams) -> dict:
        return await workflow.execute_activity(
            run_keeper_cycle, params,
            start_to_close_timeout=timedelta(seconds=params.timeout_s + 60),
            heartbeat_timeout=timedelta(seconds=90),
            retry_policy=RetryPolicy(
                initial_interval=timedelta(seconds=20),
                maximum_interval=timedelta(minutes=5),
                maximum_attempts=4),
        )


async def _client() -> Client:
    addr = os.environ.get("TEMPORAL_ADDRESS")
    ns = os.environ.get("TEMPORAL_NAMESPACE")
    api_key = os.environ.get("TEMPORAL_API_KEY")
    if not (addr and ns and api_key):
        sys.exit("FATAL: TEMPORAL_ADDRESS / _NAMESPACE / _API_KEY unset (source ~/.temporal-cloud.env)")
    return await Client.connect(addr, namespace=ns, api_key=api_key, tls=True)


async def run_worker():
    client = await _client()
    worker = Worker(
        client, task_queue=TASK_QUEUE,
        workflows=[ShadowVaultKeeperWorkflow], activities=[run_keeper_cycle])
    print(f"shadowvault HC keeper worker on task-queue '{TASK_QUEUE}' (node={_node_bin()}). Ctrl-C to stop.")
    await worker.run()


async def trigger_once(which: str):
    k = KEEPERS[which]
    client = await _client()
    handle = await client.start_workflow(
        ShadowVaultKeeperWorkflow.run,
        KeeperParams(script=k["script"], label=k["label"]),
        id=f"shadowvault-{k['label']}-manual", task_queue=TASK_QUEUE)
    print(f"started {handle.id}; awaiting result...")
    print(json.dumps(await handle.result(), indent=2))


async def ensure_schedules():
    client = await _client()
    for which, k in KEEPERS.items():
        sid = f"shadowvault-{k['label']}-periodic"
        wid = f"shadowvault-{k['label']}"
        sched = Schedule(
            action=ScheduleActionStartWorkflow(
                ShadowVaultKeeperWorkflow.run,
                KeeperParams(script=k["script"], label=k["label"]),
                id=wid, task_queue=TASK_QUEUE),
            spec=ScheduleSpec(
                intervals=[ScheduleIntervalSpec(every=timedelta(minutes=k["interval_min"]))]),
            policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
        )
        try:
            await client.create_schedule(sid, sched)
            print(f"created schedule '{sid}' (every {k['interval_min']}m, overlap=SKIP).")
        except Exception as e:
            print(f"schedule '{sid}' not created ({str(e)[:100]}); likely already exists "
                  f"(delete it in the Temporal UI to recreate with new params).")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "worker":
        asyncio.run(run_worker())
    elif cmd == "schedule":
        asyncio.run(ensure_schedules())
    elif cmd == "trigger":
        which = sys.argv[2] if len(sys.argv) > 2 else ""
        if which not in KEEPERS:
            sys.exit(f"usage: keepers_temporal.py trigger {{{'|'.join(KEEPERS)}}}")
        asyncio.run(trigger_once(which))
    else:
        sys.exit("usage: keepers_temporal.py {worker|schedule|trigger <hlp|nav>}")


if __name__ == "__main__":
    main()
