# summon

Open named Claude Code, Codex, Grok Build, or Kilo sessions with saved conversations,
individual working folders and a shared Team Room. The optional Windows Team Window brings
their terminals, work board, decisions and diary together.

Windows is the tested platform. Install [Bun 1.4.3 or later](https://bun.com/docs/installation),
[PowerShell 7.6 or later](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows)
and at least one supported provider CLI separately. Sign in through that CLI. Summon does not
install providers or manage their credentials.

From a source checkout:

```sh
bun install --frozen-lockfile
bun link
summon --team
```

For the Windows 11 x64 installer, see [installation and prerequisites](docs/reference/installation.md#windows-installer).
Setup can download missing Bun and PowerShell with your consent; provider CLIs are installed
and authenticated separately. Open **Summon** from Start after setup.

Run the Team Window from your own ordinary, non-administrator terminal. It starts with no
teammates in a new team; use **Add your first teammate**, save the profile, then choose
**Start &lt;name&gt;** in the welcome pane or **Summon** in the toolbar.
See [getting started](docs/getting-started.md) for the complete first-use procedure and recovery.

- [Documentation](docs/README.md): guides organized by what you want to do.
- [Public release history](docs/CHANGELOG.md).
- [Contributing and development](docs/reference/development.md).
- [Support](SUPPORT.md), [security boundaries](SECURITY.md), [privacy](PRIVACY.md) and
  [license](LICENSE).

Provider permissions, account access and model availability remain with each provider. A running
session or mailbox readiness indicator does not mean its work is complete or approved.
