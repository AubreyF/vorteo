# Vorteo roadmap

Unfinished work lives in [GitHub issues](https://github.com/terran-labs/vorteo/issues), one issue per outcome. Each issue holds its own plan, decisions and risks; the docs describe only what is built. The [customizations inventory](vorteo-customizations.md) covers what is already implemented.

## Priorities

Every open issue carries one priority label. Priority orders selection; it never grants authority to integrate, publish or install.

| Label               | Meaning                                              |
| ------------------- | ---------------------------------------------------- |
| `priority:critical` | Breaks installations or loses data. Drop other work. |
| `priority:high`     | The current release or the work right after it.      |
| `priority:normal`   | Planned, after the high items.                       |
| `priority:low`      | Worth doing when convenient.                         |

`debt` marks independently closable technical or process debt.

## Factory states

Agent work uses the same labels as Freed: `factory:ready` (an agent may take it), `factory:running`, `factory:blocked` (waiting on a decision or dependency) and `factory:human-review` (needs the owner).

## Views

- [High priority](https://github.com/terran-labs/vorteo/issues?q=is%3Aopen+label%3Apriority%3Ahigh)
- [Ready for the factory](https://github.com/terran-labs/vorteo/issues?q=is%3Aopen+label%3Afactory%3Aready)

## Keep pace with Paseo

Every upstream merge compares incoming behavior with the [customizations inventory](vorteo-customizations.md#upstream-comparison), credits inherited features and opens or closes issues for any resulting retirement work.
