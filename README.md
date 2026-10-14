# ompg-herdr-bridge

A community [herdr](https://herdr.dev) ↔ [omp / ompg](https://github.com/mariozechner/pi) agent-state bridge.
It replaces herdr's bundled `herdr-omp-agent-state.ts` integration for omp with a more reliable and more informative one.

[中文说明](#中文说明)

## Why

herdr's bundled omp integration reports only `working / blocked / idle`, and has some rough edges:

| Bundled integration | ompg-herdr-bridge |
|---|---|
| Pipe send fails twice → message silently dropped; pane stuck on stale state until the next real transition | Failed delivery enters a backoff resync loop (1s → 2s → 5s → 10s) and re-delivers the **full report set** (session + state + metadata) once herdr is reachable again — survives herdr restarts |
| Detects "retrying" by regex-matching English error text in `agent_end` | Subscribes to OMP's native `auto_retry_start` / `auto_retry_end` events — language-independent, no guessing |
| No model / context info | Reports `pane.report_metadata` tokens: current model, thinking level, context usage (`48k/1M (5%)`) |
| No `resume_argv` | Sends `resume_argv` (`ompg --resume=<session>`) so herdr can restore the agent session after a restart |
| Silent failures, no introspection | Failures logged via `pi.logger`; `/herdr status` shows health, seq, last state, last error |
| Nothing on shutdown | Best-effort terminal `idle` report on `session_shutdown` |

Both integrations speak the documented [herdr socket API](https://herdr.dev/docs/socket-api/) (JSON Lines over the injected pipe/socket, `seq` ordering). This plugin is written from scratch against that API — it contains no herdr code.

## Requirements

- herdr 0.9+ (any build that injects `HERDR_ENV` / `HERDR_SOCKET_PATH` / `HERDR_PANE_ID` into pane processes)
- omp / ompg with extension support (`~/.ompg/agent/extensions/` or `~/.omp/agent/extensions/`)

## Install

**1. Remove the bundled integration first** — two reporters fight over the pane state:

```bash
herdr integration uninstall omp
```

Note: herdr only manages the copy in `~/.omp`. If your ompg uses a different config dir (e.g. `~/.ompg`), delete the copy there manually too:

```bash
rm ~/.ompg/agent/extensions/herdr-omp-agent-state.ts   # if present
```

**2. Install the bridge:**

```powershell
# Windows — auto-detects ~/.ompg → PI_CONFIG_DIR → ~/.omp
powershell -File install.ps1 -RemoveOfficial
```

```bash
# Unix
./install.sh --remove-official
```

Or manually: copy `herdr-ompg-bridge.ts` into `<config-dir>/agent/extensions/`.

**3. Restart omp/ompg inside a herdr pane** and verify with `/herdr status`.

## The `/herdr` command

| Subcommand | Effect |
|---|---|
| `status` | Activation, pane/endpoint, connection health, seq, desired vs delivered state, last error |
| `test` | Sends a synthetic `blocked` state for 3 s, then restores — end-to-end link check |
| `off` / `on` | Disable / re-enable reporting for this session |

## Configuration (env vars, all optional)

| Variable | Default | Meaning |
|---|---|---|
| `HERDR_OMP_BRIDGE_FORCE` | `0` | Activate even in headless/print mode (testing) |
| `HERDR_OMP_IDLE_DEBOUNCE_MS` | `250` | Idle debounce window (same name as the bundled integration) |
| `HERDR_OMP_BRIDGE_HEARTBEAT_MS` | `30000` | Periodic full re-report (session + state + metadata). herdr's agent state decays without re-assertion, and a herdr restart mid-task is otherwise only noticed at the next state transition. `0` disables |
| `HERDR_OMP_BRIDGE_METADATA` | `1` | Set `0` to disable `pane.report_metadata` |
| `HERDR_OMP_BRIDGE_DISPLAY_NAME` | `ompg` | `display_agent` shown in the herdr UI. The authoritative agent label stays `omp` (herdr's built-in semantics); set `0` to show `omp` instead |
| `HERDR_OMP_BRIDGE_LOG` | `0` | Verbose logging |

## Offline test (no herdr needed)

```bash
# terminal 1: fake server that swallows the first 3 responses,
# so you can watch the resync backoff and recovery
FAKE_FAIL_FIRST=3 node test/fake-herdr-server.mjs

# terminal 2: run omp against the fake pipe
HERDR_ENV=1 \
HERDR_SOCKET_PATH=herdr-bridge-test \
HERDR_PANE_ID=test-pane \
HERDR_OMP_BRIDGE_FORCE=1 \
ompg --extension ./herdr-ompg-bridge.ts -p "just say ok"
```

Expected server output: `pane.report_agent_session` → `pane.report_agent` (working) → `pane.report_metadata` → `pane.report_agent` (idle), with the first three requests timing out client-side and re-delivered after the backoff.

## Uninstall

```bash
rm <config-dir>/agent/extensions/herdr-ompg-bridge.ts
herdr integration install omp   # optional: restore the bundled integration
```

## License

[MIT](LICENSE). herdr itself is a separate project (Apache-2.0); this plugin just speaks its documented socket API.

---

# 中文说明

社区版 herdr ↔ omp/ompg 桥接插件，替代 herdr 官方给 omp 装的 `herdr-omp-agent-state.ts` 集成。

**相对官方集成的改进：**

- **断线自愈**：官方版管道发送失败两次即静默丢弃，herdr 重启后面板会卡在旧状态；本插件失败后按 1s→2s→5s→10s 退避重连，恢复后全量重报（会话身份 + 状态 + 元数据）
- **重试判定走原生事件**：官方版靠英文正则匹配报错文案猜"是否在自动重试"；本插件直接订阅 omp 的 `auto_retry_start/end` 事件，与语言无关
- **元数据上报**：通过 `pane.report_metadata` 上报当前模型、思考等级、上下文用量（如 `48k/1M (5%)`），herdr 面板可直接显示
- **会话恢复**：上报 `resume_argv`（`ompg --resume=<会话>`），herdr 重启后能恢复 agent 会话
- **可观测**：失败写日志；`/herdr status` 查看健康度、seq、最近错误；`/herdr test` 发合成状态验证链路；退出时发终态

**安装：**

```powershell
# Windows
herdr integration uninstall omp                       # 先卸官方（只管 ~/.omp）
Remove-Item ~/.ompg/agent/extensions/herdr-omp-agent-state.ts -ErrorAction SilentlyContinue
powershell -File install.ps1
```

装完在 herdr 面板里重启 ompg，`/herdr status` 验证。无 herdr 也能离线测试（见上方 Offline test）。

许可证：MIT。与 herdr 本体（Apache-2.0）相互独立，仅按其公开 socket API 文档通信，不含 herdr 代码。
