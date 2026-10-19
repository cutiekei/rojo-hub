const crypto = require("crypto")
const fs = require("fs/promises")
const net = require("net")
const path = require("path")
const vscode = require("vscode")

const TASK_TYPE = "rojoHub"
const TASK_PREFIX = "Syncing to "
const PROJECT_EXTENSION = ".project.json"
const STARTUP_SUFFIX = "-startup"
const DEFAULT_PORT = 34872
const PORT_POLL_INTERVAL = 100
const PORT_WAIT_TIMEOUT = 5000
const PINNED_KEY = "pinnedPlaces"

function formatName(baseName) {
	return baseName
		.split(/[-_ ]+/)
		.filter(Boolean)
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join(" ")
}

// regex instead of JSON.parse since rojo allows comments in project files
async function getServePort(projectFile) {
	const contents = await fs.readFile(projectFile, "utf8")
	const match = contents.match(/"servePort"\s*:\s*(\d+)/)
	return match ? Number(match[1]) : DEFAULT_PORT
}

function createSyncTask(place, projectPath, port, isStartup) {
	const label = `${TASK_PREFIX}${place.name}${isStartup ? " [STARTUP]" : ""}`
	const definition = { type: TASK_TYPE, project: projectPath, port }
	const execution = new vscode.ShellExecution("rojo", ["serve", projectPath], { cwd: place.folder.uri.fsPath })
	const task = new vscode.Task(definition, place.folder, label, "Rojo", execution, [])

	task.isBackground = true
	task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, focus: false }
	return task
}

// a "<name>-startup.project.json" next to "<name>.project.json" becomes that place's [STARTUP] option
async function loadPlaces() {
	const userExcludes = vscode.workspace.getConfiguration("rojoHub").get("exclude", [])
	const excludes = ["**/node_modules/**", ...userExcludes]
	const files = await vscode.workspace.findFiles(`**/*${PROJECT_EXTENSION}`, `{${excludes.join(",")}}`)
	const placesByKey = new Map()
	const startupFiles = []

	for (const uri of files) {
		const folder = vscode.workspace.getWorkspaceFolder(uri)
		if (!folder) continue

		const projectPath = vscode.workspace.asRelativePath(uri, false)
		const directory = path.posix.dirname(projectPath)
		const baseName = path.posix.basename(projectPath, PROJECT_EXTENSION)
		const port = await getServePort(uri.fsPath)

		// nested places like src/events/christmas are grouped under their parent folder, src/shinrin isn't
		const parent = path.posix.dirname(directory)
		const group = parent.includes("/") ? formatName(path.posix.basename(parent)) : undefined

		// "Event Christmas" under "Events" shows as "Christmas"
		const name = formatName(baseName)
		const [firstWord, ...otherWords] = name.split(" ")
		const repeatsGroup = group && otherWords.length > 0 && group.startsWith(firstWord)
		const place = { name, label: repeatsGroup ? otherWords.join(" ") : name, group, folder, directory }

		if (baseName.endsWith(STARTUP_SUFFIX)) {
			startupFiles.push({ place, projectPath, baseName, port })
			continue
		}
		place.syncTask = createSyncTask(place, projectPath, port, false)
		placesByKey.set(`${folder.uri}|${directory}|${baseName}`, place)
	}

	const places = [...placesByKey.values()]
	for (const { place, projectPath, baseName, port } of startupFiles) {
		const siblingBaseName = baseName.slice(0, -STARTUP_SUFFIX.length)
		const sibling = placesByKey.get(`${place.folder.uri}|${place.directory}|${siblingBaseName}`)

		if (sibling) {
			sibling.startupTask = createSyncTask(sibling, projectPath, port, true)
			continue
		}
		place.syncTask = createSyncTask(place, projectPath, port, false)
		places.push(place)
	}

	// ungrouped places first, then each group
	return places.sort(
		(a, b) =>
			(a.group ?? "").localeCompare(b.group ?? "") ||
			a.syncTask.definition.project.localeCompare(b.syncTask.definition.project)
	)
}

function getPlaceId(place) {
	return `${place.folder.uri}|${place.syncTask.definition.project}`
}

function getTaskKey(task) {
	return `${task.scope?.uri}|${task.definition.project}`
}

function isSameTask(a, b) {
	return getTaskKey(a) === getTaskKey(b)
}

function isPlaceTask(place, task) {
	return isSameTask(task, place.syncTask) || (place.startupTask && isSameTask(task, place.startupTask))
}

function getRunningSyncs() {
	return vscode.tasks.taskExecutions.filter((execution) => execution.task.definition.type === TASK_TYPE)
}

function stopAllSyncs() {
	for (const execution of getRunningSyncs()) execution.terminate()
}

function stopAndWait(execution) {
	return new Promise((resolve) => {
		const listener = vscode.tasks.onDidEndTask((event) => {
			if (!isSameTask(event.execution.task, execution.task)) return
			listener.dispose()
			resolve()
		})
		execution.terminate()
	})
}

function isPortFree(port) {
	return new Promise((resolve) => {
		const server = net.createServer()
		server.once("error", () => resolve(false))
		server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
	})
}

// connects instead of listening so the check can't grab the port while rojo starts
function isPortListening(port) {
	return new Promise((resolve) => {
		const socket = net.connect(port, "127.0.0.1")
		socket.once("connect", () => {
			socket.destroy()
			resolve(true)
		})
		socket.once("error", () => resolve(false))
	})
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// the task ends when its terminal closes, but rojo can hold the port a moment longer
async function waitForPortFree(port) {
	const deadline = Date.now() + PORT_WAIT_TIMEOUT
	while (Date.now() < deadline) {
		if (await isPortFree(port)) return
		await sleep(PORT_POLL_INTERVAL)
	}
}

// places on different ports sync side by side, a place on a taken port replaces whatever holds it
async function startSync(task) {
	const running = getRunningSyncs()
	if (running.some((execution) => isSameTask(execution.task, task))) return

	const samePort = running.find((execution) => execution.task.definition.port === task.definition.port)
	if (samePort) {
		await stopAndWait(samePort)
		await waitForPortFree(task.definition.port)
	}
	await vscode.tasks.executeTask(task)
}

class PlacesPanel {
	constructor(context) {
		this.extensionUri = context.extensionUri
		this.workspaceState = context.workspaceState
		// failed syncs stay on the panel until they're retried or dismissed
		this.failures = new Map()
		this.startingKeys = new Set()
		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
		this.statusBar.command = "rojoHub.places.focus"
		this.statusBar.tooltip = "Open Rojo Hub"
		context.subscriptions.push(this.statusBar)
	}

	async resolveWebviewView(view) {
		const templatePath = vscode.Uri.joinPath(this.extensionUri, "media", "panel.html").fsPath
		const template = await fs.readFile(templatePath, "utf8")

		this.view = view
		view.onDidDispose(() => (this.view = undefined))
		view.webview.options = { enableScripts: true }
		view.webview.onDidReceiveMessage((message) => this.handleMessage(message))
		view.webview.html = template.replaceAll("{{nonce}}", crypto.randomBytes(16).toString("base64"))
	}

	async reload() {
		this.places = await loadPlaces()
		this.redraw()
	}

	getStatus(place) {
		const execution = getRunningSyncs().find((candidate) => isPlaceTask(place, candidate.task))
		const failure = this.failures.get(getPlaceId(place))
		const task = execution?.task ?? failure?.task ?? place.syncTask

		if (execution) return { status: this.startingKeys.has(getTaskKey(task)) ? "starting" : "syncing", task }
		if (failure) return { status: "failed", task, exitCode: failure.exitCode }
		return { status: "idle", task }
	}

	// rojo builds the project before it listens, which can take a few seconds on big places
	async watchStartup(task) {
		if (task.definition.type !== TASK_TYPE) return

		const key = getTaskKey(task)
		const isRunning = () => getRunningSyncs().some((execution) => getTaskKey(execution.task) === key)
		this.startingKeys.add(key)
		this.redraw()
		while (isRunning() && !(await isPortListening(task.definition.port))) await sleep(PORT_POLL_INTERVAL)
		this.startingKeys.delete(key)
		this.redraw()
	}

	updateStatusBar(places) {
		const active = places.filter((place) => place.status === "syncing" || place.status === "starting")
		if (active.length === 0) return this.statusBar.hide()

		this.statusBar.text = active
			.map((place) => {
				const icon = place.status === "starting" ? "$(loading~spin)" : "$(circle-filled)"
				return `${icon} ${place.label}${place.isStartup ? " $(rocket)" : ""} :${place.port}`
			})
			.join("  ")
		this.statusBar.show()
	}

	showTerminal(place) {
		const execution = getRunningSyncs().find((candidate) => isPlaceTask(place, candidate.task))
		const task = execution?.task ?? this.failures.get(getPlaceId(place))?.task
		if (!task) return

		// task terminals are named after their task, and a failed one stays open so its error can be read
		const terminal = vscode.window.terminals.find((candidate) => candidate.name === task.name)
		terminal?.show()
	}

	// waits for the first load so the panel doesn't flash its empty message
	redraw() {
		if (!this.places) return

		const pinnedIds = this.workspaceState.get(PINNED_KEY, [])
		const places = this.places.map((place) => {
			const id = getPlaceId(place)
			const { status, task, exitCode } = this.getStatus(place)
			return {
				id,
				label: place.label,
				group: place.group,
				project: task.definition.project,
				port: task.definition.port,
				hasCustomPort: place.syncTask.definition.port !== DEFAULT_PORT,
				hasStartup: Boolean(place.startupTask),
				isStartup: !isSameTask(task, place.syncTask),
				isPinned: pinnedIds.includes(id),
				status,
				exitCode,
			}
		})
		this.updateStatusBar(places)
		this.view?.webview.postMessage({ places })
	}

	recordExit({ execution, exitCode }) {
		// stopping a task closes its terminal, which reports no exit code
		if (exitCode === undefined || exitCode === 0) return
		if (execution.task.definition.type !== TASK_TYPE) return

		const place = this.places?.find((candidate) => isPlaceTask(candidate, execution.task))
		if (!place) return
		this.failures.set(getPlaceId(place), { task: execution.task, exitCode })
		this.redraw()
	}

	serve(place, isStartup) {
		this.failures.delete(getPlaceId(place))
		this.redraw()
		return startSync(isStartup ? place.startupTask : place.syncTask)
	}

	async handleMessage(message) {
		if (message.type === "ready") return this.redraw()
		if (message.type === "stopAll") return stopAllSyncs()

		// the id can be stale if the places reloaded since the panel last drew
		const place = this.places?.find((candidate) => getPlaceId(candidate) === message.id)
		if (!place) return

		switch (message.type) {
			case "sync":
				return this.serve(place, false)
			case "syncStartup":
				return this.serve(place, true)
			case "stop":
				for (const execution of getRunningSyncs()) {
					if (isPlaceTask(place, execution.task)) execution.terminate()
				}
				return
			case "showTerminal":
				return this.showTerminal(place)
			case "dismiss":
				this.failures.delete(message.id)
				return this.redraw()
			case "togglePin": {
				const pinnedIds = this.workspaceState.get(PINNED_KEY, [])
				const updatedIds = pinnedIds.includes(message.id)
					? pinnedIds.filter((pinnedId) => pinnedId !== message.id)
					: [...pinnedIds, message.id]
				await this.workspaceState.update(PINNED_KEY, updatedIds)
				return this.redraw()
			}
		}
	}
}

function activate(context) {
	const panel = new PlacesPanel(context)
	const projectWatcher = vscode.workspace.createFileSystemWatcher(`**/*${PROJECT_EXTENSION}`)
	const reloadPlaces = () => panel.reload()

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("rojoHub.places", panel),
		projectWatcher,
		projectWatcher.onDidCreate(reloadPlaces),
		projectWatcher.onDidChange(reloadPlaces),
		projectWatcher.onDidDelete(reloadPlaces),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("rojoHub.exclude")) reloadPlaces()
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(reloadPlaces),
		vscode.tasks.onDidStartTask((event) => panel.watchStartup(event.execution.task)),
		vscode.tasks.onDidEndTask(() => panel.redraw()),
		vscode.tasks.onDidEndTaskProcess((event) => panel.recordExit(event)),
		vscode.commands.registerCommand("rojoHub.stop", stopAllSyncs),
		vscode.commands.registerCommand("rojoHub.refresh", reloadPlaces)
	)

	reloadPlaces()
}

module.exports = { activate }
