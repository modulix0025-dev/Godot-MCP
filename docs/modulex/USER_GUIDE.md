# ModuleX Game Studio: owner's guide

This guide describes what the Studio does **today** on Windows. Anything that is not finished is marked **(not yet)**,
with its current behaviour. The design decisions behind each part are in [`DECISIONS.md`](DECISIONS.md), and the
evidence is in [`PROGRESS.md`](PROGRESS.md).

## 1. Install

There are two installers. Both are per-user installs: no admin rights are needed, and each installs into
`%LOCALAPPDATA%\ModuleX Game Studio`.

| Installer | Size | What it contains |
|---|---|---|
| `ModuleXGameStudioSetup.exe` | about 26 MB | The app, its Node runtime, Studio Core, both Godot addons (as source), the workflows, the Claude Desktop extension and the licence texts. Everything else is installed by the Setup Assistant. |
| `ModuleXGameStudioFullSetup.exe` | about 135 MB | All of the above, plus **Godot 4.5.1 (.NET)** and **gamedev-mcp-server 9.2.9**, each verified against its official checksum when the installer was built. |

**SmartScreen.** Unless the build was signed with your certificate, Windows SmartScreen says *"Windows protected
your PC"*. Choose *More info*, then *Run anyway*. To sign the installers, add your certificate to the repository
secrets ([security.md §4](security.md)).

**Removing.** Uninstalling removes the app. Your games in `%USERPROFILE%\ModuleX Games` are never deleted.

## 2. First run: the Setup Assistant

The first time you open the app, the Setup Assistant shows what is installed and what your target platforms still
need. Anything the full installer bundled is shown as **bundled**.

- **Install everything needed** installs, per component and per user:
  - the export templates (4.5.1 .NET);
  - a private .NET 8 SDK;
  - Git, if none is found on your PATH.
- **Checksums.** Every download is checked against its official checksum before anything is unpacked. A
  mismatched file is discarded and the component shows **failed**, with the reason.
- **Interruptions.** Downloads resume after an interruption, or after you close the app.
- **Android.** Android needs JDK 17 and the Android SDK. The SDK installs only after you tick *I accept the
  Android SDK licence*.

The **Pipeline** card says whether games can be built yet ("Builds games") and whether scripted playtests run
("Scripted playtests"). Both turn on without restarting the app as soon as their components are installed.

## 3. Connect Claude Desktop

Open **Settings**, then the **Claude Desktop** card.

1. **Show the extension file.** Explorer opens with `modulex-game-studio.mcpb` selected. Double-click it, and Claude
   Desktop shows its install dialog.
2. **Copy pairing token.** The token goes to your clipboard; it is never shown on screen. Paste it into the
   extension's settings in Claude Desktop, which keeps it in its own secure storage.

Claude Desktop now sees the Studio's **Agent-safe `studio_*` tools only**. It cannot:

- use raw Godot tools;
- approve anything;
- change any policy.

## 4. Make a game

Ask Claude Desktop, in Arabic or English. For example: *"اعمل لعبة 3D لطفل بيسافر في الفضاء، 5 مراحل، فيها
نقاط ومتجر"*.

1. **Claude writes a Game Specification.** The Studio stores it with its scene and asset manifests and a task plan.
2. **The pipeline starts.** The game appears under **Projects**. The **Studio** screen shows its 19 stages:

   ```
   project creation → assets → scenes → gameplay → QA → playtest → visual inspection
   → bug fixes → regression → optimisation → build → export
   ```

3. **Every stage ends with a status:**

   | Status | Meaning |
   |---|---|
   | SUCCESS | done |
   | PARTIAL SUCCESS | done, but something is missing; the stage says what |
   | BLOCKED | the stage needs something, and says what to install or approve |
   | FAILED | the stage did not work; the evidence is attached |
   | NEEDS HUMAN | the stage needs your decision |

4. **"Completion" is computed from the evidence.** No one, not Claude and not the Studio, can mark a game as
   complete by hand. Anything not yet proven is listed under *No evidence*.

**Testing.** The game is played automatically through ten default scenarios, among them:

- it boots;
- the player moves;
- no falling through the floor;
- the HUD is visible;
- pause/resume works;
- winning, losing, level 2, and save/load all work.

When a test finds a bug in generated code, the fix loop restores the known-good file and runs everything again. A
bug it cannot fix stops the run with **BLOCKED**, the file and a suggested action. It never claims success.

If the Studio stops (for example, the PC restarts), it resumes interrupted runs by itself on the next start, from
the step where they stopped.

## 5. Approvals

Destructive, costly or critical actions wait in **Approvals**. Each request shows:

- what will happen, and why;
- the scope;
- the exact files;
- the risk;
- how to roll it back.

Deleted files are moved to `.modulex/trash/<approval id>/`, not erased. "Always allow for this project" is offered
only for the ModuleX Agent, never for Claude Desktop.

**Budgets.** An action whose estimated cost would exceed your monthly or per-project budget always asks first, even
when it would normally run automatically. The budget meter is in the top bar; the limits are in Settings.

## 6. Builds and platforms

| Platform | What you get |
|---|---|
| **Windows** | An exported game (`.exe` + data), with its sha256 shown under **Builds**. Release builds contain none of the Studio's testing code. |
| **Android** | Built once the Android tools are installed. Reported "built, not device-tested" unless a device or emulator is connected. |
| **iOS** | **PREPARED** on Windows: a project snapshot ready for a Mac. A signed build needs a paired macOS build worker (below). |

## 7. Workers

**ComfyUI (3D assets).** Until a TRUSTED ComfyUI worker is registered, games use simple built-in shapes, and the
Studio says so; it never pretends. Remote workers must be reached through the authenticating proxy
(`studio/worker/comfy-proxy`).

**Build workers (signed iOS).** To pair a Mac:

1. On the Mac, run `modulex-build-worker pair --state <dir>`. It prints a one-time code, valid for 10 minutes.
2. In **Workers**, enter the worker's `https://` address and the code, then press **Pair**.

The worker's token is stored in Windows Credential Manager. Signing certificates never leave the Mac.

## 8. Developer Mode

Off by default. When it is on, the ModuleX Agent may also use raw Godot tools for this session. Turning it on asks
twice. Claude Desktop never gets raw tools.

## 9. Updates

Updates are never installed automatically, and the default channel is **Stable**. An update is installed only if
it is signed with the Studio's update key.

**(not yet)** In-app update installation is disabled until the release feed and its signing key are published.
Until then, update by running a newer installer: your data is kept.

## 10. Where things are

| What | Where |
|---|---|
| Your games | `%USERPROFILE%\ModuleX Games\<game>` (each is a normal Godot 4.5.1 .NET project, with its own git history of checkpoints) |
| Studio data | `%LOCALAPPDATA%\com.modulex.gamestudio` (Tauri app data, named after the app identifier): `studio.db`, the audit log, settings, the Setup Assistant downloads |
| Secrets | Windows Credential Manager, entries named "ModuleX Game Studio" |
| Licences | `licenses\` in the install folder ([THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)) |

## 11. Troubleshooting

| You see | Do this |
|---|---|
| Top bar **Godot** amber | Install Godot in the Setup Assistant, or use the full installer. |
| Build **BLOCKED: export templates are not installed** | Setup Assistant → *Export templates 4.5.1 (.NET)*, then ask Claude to resume the pipeline. |
| A component **failed: checksum mismatch** | The download was corrupted or tampered with. Press *Retry*. |
| **Playtest** stage FAILED, or BLOCKED with a script | Open **Test & Debug** for the evidence; *Copy diagnostics* puts it on the clipboard. |
| iOS shows **PREPARED** | Expected on Windows. Pair a macOS build worker for a signed build. |
| The app stays on **Starting Studio Core…** | The first launch can take up to a minute while Windows scans the app. If Core cannot start, the screen shows the error, the log path (`%LOCALAPPDATA%\com.modulex.gamestudio\logs\core.log`), *Retry* and *Copy diagnostics*. |
| Claude Desktop says the Studio is down | Keep the ModuleX app open: Claude Desktop talks to the Studio while it runs. |
