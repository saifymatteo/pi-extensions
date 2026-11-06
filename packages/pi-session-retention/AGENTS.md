# Session retention

## Startup contract

Automatic maintenance is background work, not a prerequisite for startup. The session-start handler only schedules it; a busy agent defers the launch until `agent_settled`. After launch, work may overlap an agent run, so automatic discovery offers `/session-cleanup` in a notification rather than opening an approval dialog. The explicit command owns first approval; previously approved stores retain daily automatic cleanup.

The original operational READMEs describe the older startup approval dialog. Use the contract above for current startup behavior; preserve the existing daily schedule, pause state and explicit commands.

## Lifecycle safety

Queued timers are cancelled on shutdown or explicit maintenance. Running work holds the existing per-store lock, protects the current session family and checks other Pi processes. Switches and forks remain blocked while maintenance runs. Shutdown aborts and drains the complete background task and any file operation before the context can be replaced. Retain graph revalidation and filesystem safety checks even when optimizing scans.

## Verification

Run `node --test packages/pi-session-retention/test/*.test.mjs` from the repository root. Startup tests use controlled timers and a gated real-store scan to assert non-blocking dispatch, idle deferral, lock ownership during shutdown and explicit approval. Fixtures stay in temporary directories; live retention approval can authorize moves and permanent purges, so interactive checks require an isolated agent home.
