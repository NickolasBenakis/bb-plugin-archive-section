---
name: archive-section
description: Explain or check the Archive Section plugin, which moves archived BB threads into an Archived sidebar section and restores their old section on unarchive. Use when the user asks why an archived thread moved, wants archived threads sorted into a section, or asks to change which section receives them.
---

# Archive Section

The plugin moves a thread into the archive section as soon as it is archived,
including children archived with their parent. When the thread is unarchived,
it goes back to the section it was in before, or out of every section if it had
none. A thread the user moved out of the archive section while archived is left
alone on unarchive.

On load, the plugin sweeps every archived thread into the section, which
catches threads archived while the plugin was disabled.

## Commands

| Command | Effect |
| --- | --- |
| `bb archive-section status` | Show the matched section, the restore setting, and how many archived threads are outside the section. |
| `bb archive-section sweep` | Move every archived thread outside the section into it. |

Both accept `--json`.

## Settings

Change settings with `bb plugin config archive-section set <key> <value>`,
then `bb plugin reload archive-section`; settings are read once per load.

- `sectionName` (default `Archived`): the section that receives archived
  threads. Matching ignores emoji, spacing, and case, so `Archived` matches
  `🗑️ Archived`. If no section matches, the plugin creates one with this name
  the next time a thread is archived.
- `restoreOnUnarchive` (default `true`): move unarchived threads back to their
  previous section.
