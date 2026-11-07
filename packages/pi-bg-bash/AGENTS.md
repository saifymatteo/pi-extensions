# Background job controls

## Ownership and delivery

`/bg` manages only jobs registered in the current runtime/session. It does not discover servers by executable name or port, recover jobs after restart, or stop jobs automatically on shutdown. Shutdown drains stop requests already in flight; unrelated detached jobs retain their existing lifetime.

Keep human inspection separate from delivery: opening the list or output leaves wait leases and completion consumption unchanged. Both human and model stop requests use the same stop transition. A claimed running job resolves its existing completion promise so `pi-wait` receives one terminal result. Stopping an unclaimed running job records a custom result with `triggerTurn: false`, avoiding a new idle model request.

Command completion is not child-exit evidence. Keep explicit cleanup available for captured descendants after their command finishes; that cleanup preserves the original result/lease and emits no second completion. History eviction waits for identity discovery and retains jobs with unverified descendant cleanup.

## Process safety

Use the recorded real OS PID and its captured creation identity. Windows launches return native `Start-Process` PIDs, not MSYS `$!` values. A missing identity disables stopping rather than guessing. Capture known descendants at launch and again before stopping; revalidate identities before signaling and verify tracked descendants afterward. Permission failures are not proof of termination. Retain discovered descendant identities across failed attempts, even after reparenting; processes that escape between snapshots remain outside this cleanup guarantee.

Graceful stopping requests SIGINT on Unix or a real console Ctrl+C on Windows, waits briefly, and leaves survivors available for explicit Force kill. It never escalates automatically. Force kill skips the interrupt and grace period but retains discovery, identity checks, and final verification. Model `job: "<id>:stop"` requests graceful shutdown; existing `:kill` explicitly forces termination.

Windows jobs launch in a separate hidden console. Clear the inherited ignore-Ctrl+C attribute before children start. Bash also needs inheritable `CONIN$` from its own solo console and a .NET process launch: PowerShell's native-command pipeline substitutes a stdin pipe, making MSYS suppress native children's Ctrl+C handlers. Authenticate the solo console before opening input and close owned handles in `finally`; this input must never come from Pi's console.

The disposable interrupt helper detaches its own console and authenticates the target console's membership and process birth identities before broadcasting Ctrl+C. Shared consoles (especially Pi's), unknown members, missing consoles, or console API failures fail closed, leaving Force kill available. Never substitute Node's Windows `process.kill(pid, "SIGINT")`: it is forced termination, not genuine Ctrl+C. Older jobs without safe console isolation may support force only. On Unix, background launch enables Bash job control so asynchronous commands do not inherit Bash's usual ignored SIGINT disposition.

## UI and output

The TUI list refreshes while preserving selection; Enter opens bounded output, `s` asks before graceful stopping, and `x` separately confirms Force kill with a cleanup-hook warning. RPC exposes both actions; print/JSON remain list-only. Session invalidation and component disposal release refresh timers. Human log reads are independent of completion delivery. Keep reads byte-bounded even for a single enormous line, and strip terminal controls before rendering shell output or command labels.

## Verification

The package tests use isolated fixtures, fake process inventories, and host stubs. Exercise a disposable parent/child process tree on Windows and Unix before claiming native termination coverage; unit tests do not prove CIM, `ps`, signal, terminal, or live-host behavior. Require application and child SIGINT-cleanup markers; successful `GenerateConsoleCtrlEvent` alone proves only API acceptance. Preserve the shared `async-work:providers:v1` contract with `pi-wait`; consolidation is a separate change.

The interaction was informed by `gvanderclay/pi-bg-bash` at commit `c31b6a6004062129d40f3c58f90022bfd6ad7af9`. This implementation uses its own UI/process integration; retain upstream MIT notices if copying upstream code in future changes.
