# EC2 hotfix deployment

From the repository root, deploy the latest commit already present on
`samirextra369/esim2.2` branch `with-fonepay` with:

```bash
./scripts/deploy-now.sh
```

For a slower deployment that also runs all typechecks and tests on EC2:

```bash
./scripts/deploy-now.sh --with-tests
```

The local trigger streams `scripts/ec2-deploy.sh` to the server over SSH, so
there is no one-time script installation on EC2. It never pushes local changes;
the deploy target is always fetched from the canonical deployment repository,
`git@github.com:samirextra369/esim2.2.git`. The parent repository
`aaaaa012/esim` is an upstream development source, but production instances do
not fetch or deploy from it.

## Deployment gates

The remote deploy refuses to run when another deployment holds the lock, the
EC2 checkout is on another branch, tracked files were edited directly on EC2,
or the fetched commit is not a fast-forward.

It installs the frozen lockfile, generates Prisma, and builds every application
before interrupting a running service. It then applies committed Prisma
migrations, restarts the API, waits for database and Redis readiness, restarts
the OCR worker and both Next.js applications, and verifies all four systemd
units and local HTTP endpoints.

If a post-update step fails, it restores the previous Git commit, rebuilds it,
and restarts the previous application version. Prisma migrations are
forward-only and are not reversed. Production migrations must therefore remain
backward-compatible with the immediately preceding release (expand/contract
migrations).

## Configuration overrides

The trigger defaults to the current EC2 host and the repository-root PEM file.
These can be overridden without editing the script:

```bash
VISA_EC2_HOST=example.internal \
VISA_EC2_USER=ec2-user \
VISA_EC2_KEY=/secure/path/VisacompassEC2.pem \
./scripts/deploy-now.sh
```

The production `.env` remains only on EC2 and is never copied, replaced, or
printed by the deployment scripts.

## GitHub automatic deployment

The `deploy-production` job in `.github/workflows/ci.yml` runs in
`samirextra369/esim2.2` after the CI verification job succeeds for a push to
`with-fonepay`. Pull requests and pushes to other branches never deploy.
Deployments are serialized, and GitHub passes the exact tested commit SHA to
EC2. A delayed workflow cannot roll production back over a newer deployed
commit.

The deploy job also checks `github.repository == 'samirextra369/esim2.2'`.
Mirroring this workflow to the upstream parent repository runs CI there but can
never deploy the parent repository to production.

Create a protected GitHub Environment named `production`, then configure:

- Environment secret `EC2_HOST`: the EC2 Elastic IP or stable hostname.
- Environment secret `EC2_SSH_PRIVATE_KEY`: the complete private key, including
  its BEGIN/END lines.
- Environment secret `EC2_KNOWN_HOSTS`: the trusted EC2 SSH host-key line.
- Optional environment variable `EC2_USER`: defaults to `ec2-user`.

The CI build also requires these repository-level Actions variables (they are
not production environment secrets):

- `CLERK_PUBLISHABLE_KEY`: the public `pk_live_...` Clerk frontend key.
- `NEXT_PUBLIC_API_URL`: the public API origin.
- `NEXT_PUBLIC_CUSTOMER_WEB_URL`: the public customer-web origin.
- `NEXT_PUBLIC_PAYMENT_MODE`: the frontend payment mode.

Do not create `EC2_KNOWN_HOSTS` blindly in the workflow with `ssh-keyscan`.
Obtain the host key through the already-trusted SSH connection and compare its
fingerprint before saving it as a GitHub secret.
