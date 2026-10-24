# Archive Section for BB

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/nikosbenakis)

Moves a BB thread into an **Archived** sidebar section the moment you archive
it, and puts it back in its old section when you unarchive it.

## Install

```sh
bb plugin install git:https://github.com/NickolasBenakis/bb-plugin-archive-section.git
```

Or from a checkout:

```sh
npm install --include=dev
bb plugin install .
```

## Behavior

- **Archive**: the thread moves into the archive section. Cascade archives move
  every child too. The thread's previous section is remembered.
- **Unarchive**: the thread returns to its previous section (or to no section).
  If you moved it out of the archive section yourself while it was archived,
  the plugin leaves it where it is.
- **Startup**: every archived thread outside the section is swept in, which
  catches anything archived while the plugin was not loaded.

The section is matched by name, ignoring emoji, spacing, and case, so the
default `Archived` matches `🗑️ Archived`. If none matches, one is created on
the next archive.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `sectionName` | `Archived` | Section that receives archived threads |
| `restoreOnUnarchive` | `true` | Return unarchived threads to their previous section |

```sh
bb plugin config archive-section set sectionName "Old work"
bb plugin reload archive-section
```

## CLI

```sh
bb archive-section status [--json]   # matched section and stragglers
bb archive-section sweep [--json]    # move every archived thread into the section
```

## Development

```sh
npm run check   # typecheck + bb plugin build
```

## Support

If this plugin saves you time, you can [buy me a coffee](https://buymeacoffee.com/nikosbenakis).

## License

MIT
