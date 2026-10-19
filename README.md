# Rojo Hub

A sidebar for [Rojo](https://rojo.space) projects in VS Code and Cursor. It lists every `*.project.json` in your workspace, so you can start and stop `rojo serve` with one click and always see which project is syncing.

## Features

- **One-click serve.** Hover a project and press ▶ to run `rojo serve` for it in a terminal named "Syncing to &lt;Project&gt;".
- **Live status.** A card's dot blinks amber while rojo builds the project and turns green once it's listening. The status bar shows every running sync, even with the sidebar closed, and clicking it opens Rojo Hub.
- **Jump to the terminal.** Click a syncing card (or its terminal button) to show that sync's terminal.
- **Several projects at once.** Projects with different `servePort`s sync side by side in the Syncing section. Starting a project on a port that's already in use stops whatever holds it first. Projects with a custom port show it in the list.
- **Startup variants.** A `<name>-startup.project.json` next to `<name>.project.json` doesn't get its own row. It appears as a 🚀 button on that project's row and syncs as "Syncing to &lt;Project&gt; [STARTUP]".
- **Groups and filter.** Nested projects like `src/events/christmas` are grouped under their parent folder, and the filter box narrows the list as you type.
- **Pinned projects.** Pin a project from its hover buttons to keep it at the top of the list. Pins are saved per workspace.
- **Failed syncs.** If `rojo serve` exits with an error, its card turns red and stays in the Syncing section with retry and dismiss buttons. Hover it for the exit code.
- **Live list.** Adding, changing or deleting project files updates the panel automatically.

## Requirements

`rojo` must be on your `PATH`. Toolchain managers like [Rokit](https://github.com/rojo-rbx/rokit) handle this already.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `rojoHub.exclude` | `[]` | Glob patterns for project files to hide, relative to the workspace folder. |

For example, to hide tooling-only projects:

```json
"rojoHub.exclude": ["default.project.json", "sourcemap.project.json"]
```

## Install

Grab the `.vsix` from [Releases](https://github.com/cutiekei/rojo-hub/releases), then either:

- run `code --install-extension rojo-hub-0.1.0.vsix` (use `cursor` instead of `code` for Cursor), or
- open the Extensions panel, open its `...` menu, and choose **Install from VSIX...**

## Build from source

```sh
npx @vscode/vsce package
```

This writes `rojo-hub-<version>.vsix` to the repo folder.

## License

MIT
