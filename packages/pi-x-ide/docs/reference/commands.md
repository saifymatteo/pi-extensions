# `/ide` command reference

Pi × IDE registers the `/ide` command family in the Pi TUI for managing IDE
connections.

| Command         | Behavior                                                           |
| --------------- | ------------------------------------------------------------------ |
| `/ide`          | Open the TUI selector to list available IDE connections.           |
| `/ide status`   | Show the current connection, workspace, and most recent selection. |
| `/ide list`     | List candidate connections from the lock directory.                |
| `/ide auto`     | Re-attempt automatic matching by `cwd` and connect when matched.   |
| `/ide off`      | Disconnect and disable automatic context attachment.               |
| `/ide attach`   | Manually insert the latest selection range into the input box.     |
| `/ide skip`     | Pause or resume attaching IDE context to prompts.                  |
| `/ide install`  | Install or update `balaenis.pi-x-ide` through a supported IDE CLI. |
| `/ide settings` | Edit global or project settings.                                   |

### `/ide settings`

Opens a picker for **Global** (`<agent-dir>/extensions/pi-x-ide.json`, from
`$PI_CODING_AGENT_DIR` or `~/.pi/agent`) or **Project**
(`<cwd>/.pi/extensions/pi-x-ide.json`, which overrides Global). Then it lists
every setting for that file:

| Setting       | Values                  | Config key                  | Default  |
| ------------- | ----------------------- | --------------------------- | -------- |
| `Display`     | `widget` / `statusline` | `status_display`            | `widget` |
| `Zed nested`  | `manual` / `auto`       | `zedNested`                 | `manual` |
| `AutoInstall` | on / off                | `env.PI_X_IDE_AUTO_INSTALL` | on       |
| `Fix prompt`  | text (`\n` = newline)   | `fixPrompt`                 | built-in |
| `Send context` | on / off               | `sendContext`               | on       |

A value not set in the open file shows dimmed as `default`, or as `inherited`
from Global in the project file.

| Key             | Action                                              |
| --------------- | --------------------------------------------------- |
| `↑`/`↓`         | Move between settings                               |
| `Space`/`Enter` | Toggle or cycle a value; edit text                  |
| `x`             | Remove the key from this file (default / inherited) |
| `Ctrl+S`        | Save this file                                      |
| `Esc`           | Back to the picker (twice to discard changes)       |

`Display` applies immediately. `Zed nested` and `AutoInstall` apply after
`/reload`. Other `env` overrides stay JSON-only. See
[Configuration](configuration.md).

## Pause IDE context

`/ide skip` pauses IDE context: no selection is attached to your prompts and the
widget shows `⊘`. The pause lasts until you run `/ide skip` again, even across
prompts and new IDE selections. On resume, the latest selection is attached to the
next prompt.

To start every session paused, turn off `Send context` in `/ide settings`
(`"sendContext": false`). `/ide skip` then resumes for the current session only.

In fullscreen mode (`"tuiMode": "fullscreen"`) you can also click anywhere on the
IDE widget to toggle the pause. The `statusline` display is not clickable.

## The attach shortcut

Pi registers `Ctrl+Alt+K` in the TUI as a shortcut for `/ide attach` by default.
Repeated presses append the latest selected range to the current input, so you can
select multiple ranges in the editor and attach them one by one.

- **macOS:** this is a terminal shortcut (`Ctrl+Option+K`). `Cmd` shortcuts are
  handled by the terminal/OS and are not available to Pi's TUI.
- **Customize:** set `PI_X_IDE_ATTACH_SHORTCUT` to another pi key id.
- **Disable:** set `PI_X_IDE_ATTACH_SHORTCUT` to `off`, `none`, `false`, or `0`.

See [Configuration](configuration.md) for the full environment variable reference.
