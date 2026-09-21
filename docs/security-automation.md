# Security automation

The repository uses GitHub-maintained actions and npm's built-in audit command.
Action versions are pinned to commit SHAs; Dependabot keeps those pins updated.

| Automation | When it runs | What it checks |
| --- | --- | --- |
| CI | Pushes to `main`, pull requests targeting `main`, manual dispatch | TypeScript build and Jest tests on Node.js 22 and 24 |
| CodeQL | Pushes to `main`, pull requests targeting `main`, Tuesdays at 07:23 UTC, manual dispatch | JavaScript/TypeScript code and GitHub Actions workflows; findings appear in GitHub's code scanning alerts |
| Dependency Review | Pull requests targeting `main` | Newly introduced dependencies with high or critical known vulnerabilities fail the check |
| npm Audit | Pushes to `main`, pull requests targeting `main`, Tuesdays at 07:41 UTC, manual dispatch | All locked production and development dependencies; high or critical vulnerabilities fail the check |
| Dependabot | Mondays at 07:00 UTC | npm dependencies and GitHub Actions versions, including pinned action commits |

Dependabot groups minor and patch npm updates separately for production and
development dependencies, and groups minor and patch action updates. Major
updates remain separate pull requests. Updates require review and are not
automatically merged.

The npm audit job does not install dependencies or execute their lifecycle
scripts. Run the same check locally with:

```bash
npm audit --package-lock-only --include=dev --audit-level=high
```

This checks the entire dependency tree, including vulnerabilities already in the
lockfile. The September 21, 2026 audit is clean after replacing the obsolete
`window` wrapper with jsdom and updating vulnerable transitive dependencies.
jsdom stays on the 26.x line for compatibility with the CommonJS Jest setup;
newer majors introduce ESM dependencies. Review dependency changes and run the
tests before applying them. The workflows do not run `npm audit fix` or suppress
existing findings.

## GitHub settings

These workflows target the repository's default branch, `main`. Scheduled runs
and Dependabot version updates begin after the files reach the default branch.
No custom secrets or external service accounts are needed. Workflow tokens have
read access to repository contents; only CodeQL receives permission to upload
security findings. Pull requests use `pull_request` events, including fork and
Dependabot pull requests.

Dependency Review requires the repository's dependency graph to be enabled;
the dependency graph and Dependabot alerts are enabled for this repository.
Dependabot **security updates** are a separate repository setting from the weekly
version updates configured here; they were disabled when this configuration was
added. Enable security updates under **Settings → Advanced
Security** to request fixes when new advisories are published. CodeQL uses an
advanced workflow setup; keep the separate CodeQL default setup disabled to avoid
conflicting analyses.

To enforce checks before merging, select them in the ruleset or branch protection
for `main`. CodeQL findings appear in the Security tab and do not necessarily fail
the analysis job; use a code scanning merge protection rule if findings should
block merges.

References: [CodeQL workflow configuration](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options),
[Dependency Review](https://github.com/actions/dependency-review-action),
[Dependabot configuration](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference),
and [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/).
