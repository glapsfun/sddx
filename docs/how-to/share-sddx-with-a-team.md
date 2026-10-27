# Share sddx with a team

The plugin is installed per person, but a repository can ask for it, so
everyone who opens the project is prompted to use the same workflow. The team's
policy and history live in `.sddx/`, under version control like any other
code.

## Ask for the plugin in the repository

Add this to the repository's `.claude/settings.json`, merging it into what is
already there:

```json
{
  "extraKnownMarketplaces": {
    "sddx": {
      "source": {
        "source": "github",
        "repo": "glapsfun/sddx"
      }
    }
  },
  "enabledPlugins": {
    "sddx@sddx": true
  }
}
```

Commit it yourself. sddx never writes into `.claude/`, so this file stays
yours to review like any other change.

When teammates open the repository and trust the folder, Claude Code registers
the marketplace. Enabling a plugin in project settings does not download it,
so each teammate installs it once:

```
claude plugin install sddx@sddx --scope project
```

Headless runs (`claude -p`) do not use marketplaces declared by the repository.
Install the plugin explicitly on machines that only run headless sessions.

## Share the policy

Commit `.sddx/`. It holds the team's decisions and history:

- `.sddx/config.json`: the interaction mode, and the profile. Set
  `"profile": "strict"` to turn on the per-edit test-first gates for everyone;
  each task records the profile it started under.
- `.sddx/specs/`: every goal's design and plan, as approved.
- `.sddx/receipts/`: one hash-chained receipt per finished task.

## Check the history in CI

Every guarantee is enforced by the CLI, so CI can re-check the receipt chain
without Claude Code:

```sh
npx @glapsfun/sddx audit --ci
```

## Opting out on one machine

To turn the plugin off for yourself in one repository without changing it for
the team, set it in `.claude/settings.local.json`, which is not committed:

```
{ "enabledPlugins": { "sddx@sddx": false } }
```
