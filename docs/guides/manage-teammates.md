# Maintain teammates and conversations

Open **Maintenance**, then **Person**, from the operator's Team Window. Ordinary profile edits
can be saved while the teammate runs and apply at its next launch. Stop it before changing a
saved session ID, Claude account directory or an allowed PM CLI, or before removing it. Saving
launches nothing. Registration, cloning and removal are operator operations; an ordinary
teammate or PM role grants no exception.

## Edit a profile

The **Person** tab holds the working folder, expertise, domain, notes, provider settings, usage
and removal controls. Expertise describes standing knowledge; domain assigns ownership; notes
retain current decisions and handoff pointers. Keep credentials out of these fields because
they reach provider prompts.

Use **Save Teammate** for the form. A stale notes edit refuses without discarding your draft;
copy your edits and reload the form before trying again. Team-wide choices on the **Team** tab
save as you change them. **Team settings** opens it directly, including before any teammate exists.

Ordinary teammates keep their registered CLI. The operator may switch a stopped PM's CLI; that
clears its prior session binding and observed model cache. This does not transfer a conversation
between providers.

## Resume the intended conversation

Use **Summon** or **Resume** to reopen the registration's saved provider conversation. Just after
adding a teammate, the welcome pane offers **Start &lt;name&gt;**. For a registration with no saved
provider conversation, its first launch creates one. Summon notes and mailbox history remain
available; this does not promise to clear provider memory or project instructions. This guide
describes saved-conversation resume, not a general fresh-conversation selector. A session running
elsewhere is labelled and is not adopted or duplicated.

Maintenance can set an optional known provider session ID while the teammate is stopped. Use an
ID you actually know belongs to that provider conversation. Codex fresh launches instead bind
the identity supplied by Codex's hook or the named session's `summon --mail bind`; do not guess
from a folder, timestamp or another rollout.

For Claude, **Claude account directory (optional)** selects an existing directory for
`CLAUDE_CONFIG_DIR`. Sign in there using Claude first. Switching clears the previous account's
session ID from the form; each account retains its saved conversation. The displayed directory
does not verify an email address, subscription or entitlement.

Kilo can use its configured model or an LM Studio model selected in its profile. Configure and
start the model server separately. Its URL can be remote HTTP(S), so choose a trusted destination
for prompts; Summon does not restrict it to loopback or encrypt plain HTTP.

## Interpret provider information

The header and provider hover show observed model, reasoning, context capacity, account directory
when applicable and working folder. Capacity describes a model window, not remaining tokens.
Missing or stale observations are not a promise of the current native configuration.

**Read Provider Usage** reads Codex account windows and session estimates when its installed CLI
supplies them. Estimates are labelled; unavailable is not zero or unlimited. Claude and Grok
telemetry is not connected, and Kilo usage is unavailable. Use each provider's own displays.
CLI setup checks versions separately from sign-in and model access.

## Archive or remove a teammate

Maintenance requires the stopped state and typing the name. Archive is the default: it retains
the registration, notes, icon and own mailbox under that team's `archives/`, leaving scratch
folders in place. Restoration is manual. Permanent removal also removes its scratch folders.
Provider conversations, project files and messages already sent to other teammates remain.

If removal partly fails, retain the reported paths and error; do not assume nothing changed.
The CLI `summon --remove <name>` is immediate and does not ask for confirmation. Use it only
when you intend that removal. Read the [registration and session reference](../reference/sessions-and-communication.md)
before command-level maintenance, or [troubleshoot a startup refusal](troubleshoot-startup-and-delivery.md).
