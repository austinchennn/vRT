# Releasing

Every `@vrealtime/*` package shares one version and is released together. A release is a git tag: pushing `v0.1.0` runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. re-runs the checks (spec, types, unit and end-to-end tests, budgets);
2. packs the tarballs and installs them into an empty project;
3. publishes those exact tarballs to npm, dependencies first, with [provenance](https://docs.npmjs.com/generating-provenance-statements).

Publishing is re-runnable: versions already on npm are skipped, so a release that failed halfway is finished by running the workflow again. `node scripts/publish.mjs --dry-run` runs on every pull request, so the release path is exercised continuously.

## One-time setup (repository owner)

These steps need the owner's own npm and GitHub accounts; nobody else can do them.

1. **Create the npm organization** `vrealtime` at <https://www.npmjs.com/org/create>. The free plan is enough for public packages.
2. **Create a publish token** at npmjs.com: profile picture → Access Tokens → Generate New Token.
   - **Token name:** something that says where it is used, for example `vrt-github-actions-release`.
   - **Bypass two-factor authentication:** checked, because CI cannot type a one-time password.
   - **Allowed IP ranges:** empty, because GitHub-hosted runners have no fixed addresses.
   - **Packages and scopes:** permission **Read and write (publish and stage)**, then **Only select packages and scopes** and the `@vrealtime` scope. The scope appears once the organization exists. "Stage only" would make `npm publish` fail with `E_STAGE_REQUIRED`.
   - **Organizations:** **No access**. Organization access manages members and teams, and does not grant publishing.
   - **Expiration:** short, for example 7 days. The token is only needed until trusted publishing is set up after the first release.
   - Copy the token when it is shown; it is displayed only once.
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

## After the first release: publishing without a token

npm is retiring direct publishing with access tokens: it stops working in January 2027 ([About access tokens](https://docs.npmjs.com/about-access-tokens)). The replacement is [trusted publishing](https://docs.npmjs.com/trusted-publishers), where npm trusts this repository's workflow through OIDC and no long-lived token exists. It is configured per package, so it can only be set up once the first release has created the packages:

1. On each package's settings page on npmjs.com, add a trusted publisher:
   - GitHub Actions;
   - organization or user `austinchennn`, repository `vRT`;
   - workflow `release.yml`, environment `npm`;
   - allow `npm publish` for direct releases, or keep the default staged publishing to approve every version with 2FA.

   A new configuration must complete a publish within 2 days, or it expires.
2. In `release.yml`, install npm 11.5.1 or later (trusted publishing needs it, and Node 22's bundled npm is older), and drop `NODE_AUTH_TOKEN`.
3. In each package's Settings → Publishing access, choose "Require two-factor authentication and disallow tokens". Then delete the `NPM_TOKEN` secret and revoke the token.
