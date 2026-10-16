# Releasing

Every `@vrealtime/*` package shares one version and is released together. A release is a git tag: pushing `v0.1.0` runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. re-runs the checks (spec, types, unit and end-to-end tests, budgets);
2. packs the tarballs and installs them into an empty project;
3. publishes those exact tarballs to npm, dependencies first, with [provenance](https://docs.npmjs.com/generating-provenance-statements).

Publishing is re-runnable: versions already on npm are skipped, so a release that failed halfway is finished by running the workflow again. `node scripts/publish.mjs --dry-run` runs on every pull request, so the release path is exercised continuously.

## One-time setup (repository owner)

These steps need the owner's own npm and GitHub accounts; nobody else can do them.

1. **Create the npm organization** `vrealtime` at <https://www.npmjs.com/org/create>. The free plan is enough for public packages.
2. **Create a publish token** at npmjs.com, under Access Tokens, as a granular access token:
   - write access limited to the `@vrealtime` organization's packages;
   - the shortest expiry that covers the next release;
   - if the account requires two-factor authentication for publishing, allow this token to publish without a one-time password, because CI cannot type one.
3. **Store the token in GitHub** as an Actions secret named `NPM_TOKEN`, under Settings → Secrets and variables → Actions. Then optionally open Settings → Environments → `npm` and add required reviewers, so every release waits for an approval. The environment is created by the first workflow run.

## Releasing a version

1. Set the version, if it changed since the last release:

   ```bash
   npm run version:set -- 0.2.0
   ```

   This updates every package, pins internal dependencies (packages and examples) to the new version and refreshes the lockfile. Commit it through a pull request.
2. Optionally do a dry run: Actions → Release → Run workflow, with "dry-run" checked, on `main`.
3. Tag the merged commit on `main` and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

   The workflow refuses to publish if the tag and the package versions differ.
4. Check the result:

   ```bash
   npm view @vrealtime/core version
   ```

   Each package page on npmjs.com shows a provenance badge linking to the workflow run.

A version with a prerelease suffix (`1.0.0-rc.1`) is published under the dist-tag `next`, so `npm install` keeps installing the latest stable version.

## When something goes wrong

- **A publish failed halfway** (network, registry error): re-run the failed workflow run. Packages already published are skipped.
- **A broken version was published:** publish a fixed patch version and deprecate the broken one with `npm deprecate @vrealtime/<package>@<version> "<reason>"`. Unpublishing is limited to 72 hours and breaks anyone who installed the version, so avoid it.

## Later: publishing without a token

After the first release, every package exists on npm and can switch to [trusted publishing](https://docs.npmjs.com/trusted-publishers). npm then trusts this repository's workflow directly and no long-lived token is needed:

1. On each package's settings page, add a trusted publisher: GitHub Actions, repository `austinchennn/vRT`, workflow `release.yml`, environment `npm`.
2. In `release.yml`, make sure the npm version supports trusted publishing (add a step that installs a recent npm, since the one bundled with Node 22 may be too old).
3. Delete the `NPM_TOKEN` secret and revoke the token.
