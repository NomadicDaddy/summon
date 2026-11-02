# Support

Thanks for using summon. Here is where to go for help.

## Questions and discussion

For "how do I…", registration problems, CLI setup, and general questions, use **GitHub
Discussions** on the summon repository. Search existing threads first; your question may already be
answered.

Before asking, it is worth checking:

- **[Documentation](docs/README.md)** - first use, task guides and detailed command reference.
- **[docs/guides/team-board.md](docs/guides/team-board.md)** - every board lane and card action, and
  what each one actually does.
- **[CHANGELOG.md](docs/CHANGELOG.md)** - what changed, release by release.

## Bugs

Open a GitHub issue. The useful ones say what you ran, what happened, and what you expected, and
include the Summon version and build fingerprint from the window footer, or the commit and
`package.json` version for a source checkout. Include your Bun version from `bun --version`.

summon drives the provider CLIs rather than replacing them. If the problem is inside a session -
the model's answer, the CLI's own behaviour, authentication to a provider - it belongs with that
CLI's own support, not here. If the problem is that a session did not open, a name did not resume,
mail did not arrive, or the window misbehaved, that is summon.

## What is not supported

summon does not install the provider CLIs, manage their credentials, or pay their bills. It is
tested on Windows with PowerShell 7.6 or later; other platforms are not currently covered by its
smoke tests.
