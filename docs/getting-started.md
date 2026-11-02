# Start your first team

Use an ordinary Windows terminal for this procedure. The Team Window is an operator control
surface; opening it inside a named teammate's session is refused. Windows is the tested target.

## Install and sign in

Choose the Windows installer or a source checkout. Both use your separately installed provider
CLI and its account; Summon does not sign in for you.

### Windows installer

Use the installer and matching SHA-256 from the
[official releases page](https://github.com/NomadicDaddy/summon/releases). Check its release notes
and the [installation requirements](reference/installation.md#windows-installer) first. Builds
are unsigned until a publisher signing process is configured.

Setup installs Summon for your Windows account. Its **Dependencies** page offers to download
missing Bun and PowerShell; these runtimes are not bundled. A selected PowerShell winget install
can show the announced administrator prompt. Provider CLIs remain separate: install and sign in
to at least one of `claude`, `codex`, `grok` or `kilo` using that provider's own tools.

After setup, open **Summon** from Start. If a dependency could not be installed, follow the Finish
page's official installation links before trying again. Then continue at **Add and start one
teammate** below.

### Source checkout

1. Install stable [Bun 1.4.3 or later](https://bun.com/docs/installation) and
   [PowerShell 7.6 or later](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows).
   Keep `bun.exe` and `pwsh.exe` on `PATH`. Windows PowerShell 5.1 and preview runtimes do not
   satisfy these checks.
2. Install at least one supported provider CLI: `claude`, `codex`, `grok` or `kilo`. Complete
   its own sign-in and account setup in that CLI's terminal. A successful executable check does
   not establish account or model access.
3. Obtain the source from the [official repository](https://github.com/NomadicDaddy/summon),
   then open its root folder in your terminal. With Git installed:

    ```sh
    git clone https://github.com/NomadicDaddy/summon.git
    cd summon
    ```

    In that folder, where `package.json` and `bun.lock` are located, run:

    ```sh
    bun install --frozen-lockfile
    bun link
    ```

    Ensure Bun's global binary directory is on `PATH`; `bun pm bin -g` prints it. Installation
    downloads the pinned Electron runtime.

4. Open a new, non-administrator terminal after changing `PATH`, then run:

    ```sh
    summon --team
    ```

The default team uses `~/.summon/team-default`. To create an independent empty team, use
`summon --team testing` from your own terminal. That name selects a team, not a teammate.
Existing flat-store data requires a [separate offline cutover](reference/storage-layout.md#default-team-subfolder);
startup does not move it for you.

## Add and start one teammate

1. Choose **Add your first teammate**, or **Add teammate** when a roster already exists.
2. Pick a gallery starter or **Start blank**. Choose a unique name, an installed CLI and an
   existing working folder. Optional expertise describes what the teammate knows; domain states
   what it owns. These fields reach provider prompts, so keep credentials out of them.
3. Save the teammate. Saving selects the profile and launches nothing.
4. Choose **Start &lt;name&gt;** in the welcome pane, or **Summon** in the toolbar. Handle any
   provider sign-in, trust or permission prompt yourself. Summon
   does not answer those prompts or grant the provider additional authority.

The header moves through Connecting, Logging in and Summon startup. Logging in only means the
CLI showed itself. The teammate reads its complete startup instructions, confirms this launch's
mailbox readiness and sets its first status. The header then shows its task or Ready. Ready is
self-reported availability, not proof that a task succeeded.

## Get one useful result

In the selected terminal, ask for a bounded first task, for example: “Read this project's README
and tell me its purpose and normal validation command. Do not change files.” Use a folder you
intend that provider to read. Check the answer against the files it names and ask about any
uncertainty before assigning changes.

You can then [give work through the Room and follow progress](guides/work-with-your-team.md).
The provider's reply, a completed task, and a permission request are separate events.

## If first use stops

- For a missing runtime or provider, open **Team settings → CLI setup**, install or authenticate
  through the provider's own tools, reopen Summon after `PATH` changes, then refresh the check.
- For Connecting or startup failures, retain the exact error and use the
  [startup troubleshooting guide](guides/troubleshoot-startup-and-delivery.md).
- If startup instructions cannot be read completely, leave the teammate stopped. Do not tell it
  to continue with stale instructions, reset its cursors or remove a lock to force a launch.
- If Electron's installed version differs from the package, close Team Windows yourself before
  using the [documented repair](reference/team-window.md).

Return to the [documentation index](README.md) for controls, profiles and maintenance.
