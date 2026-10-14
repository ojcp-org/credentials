# OJCP sandbox

A test world for OJCP's credential RFCs, told as one story through five persona tabs. Jordan Lee works at Vandelay Industries and is looking for a new job. He puts a signed record of his job in his wallet, asks his AI assistant to apply for him within limits he sets, and confirms his work history to an employer straight from the wallet. The assistant never sees the record.

> **Test keys and made-up data only.** Nothing here is a real issuer, attester, trust list, employer or candidate. Every page says so, and nothing from the sandbox should be trusted outside it.

It covers hiring credentials and their issuer profile ([RFC 0014](https://github.com/ojcp-org/ojcp/pull/45)), wallet presentation to employers ([RFC 0013](https://github.com/ojcp-org/ojcp/pull/44)), standing mandates ([RFC 0008](https://github.com/ojcp-org/ojcp/pull/40)), occupation codes and binding actions ([RFC 0009](https://github.com/ojcp-org/ojcp/pull/46)), action mandates (spec *User Mandates*) and decentralized provider trust ([RFC 0010](https://github.com/ojcp-org/ojcp/pull/41)).

## The five tabs

Every page carries the same thin sandbox bar, in OJCP's colours: the five tabs, where the story is ("Step 6 of 10", with a **Next** button that takes you to the right site), all ten steps, and Jordan's inbox for codes. Clicking a tab goes to that party's own origin, so cookies, signatures and wallet requests work exactly as between separate companies. Below the bar, each site has its own look, so it's always clear whose screen you're on.

| Tab | Persona | Origin | What happens |
|---|---|---|---|
| 1 · HR | Jordan, at work | `hr.` | ExamplePeople, a Workday-like HR platform Vandelay uses. Signed in as an employee, he adds a record of his job to his wallet, at any time (RFC 0014 §4.1). The platform signs as a `customer_records` issuer. |
| 2 · Wallet | Jordan's phone | `wallet.` | Redeems the offer over OpenID4VCI and checks the issuer's signature, keeping three copies bound to separate keys. The wallet provider also runs the permission service, so approving JobGPT's permission is a wallet screen (`wallet.…/permissions/{id}`): the wallet verified Jordan's email when he set it up, so he approves with Face ID and no code. **Permissions** lists and cancels it. Later checks Acme's signed request and shows exactly what Acme will see, with values, and what it won't. |
| 3 · Assistant | Jordan, chatting | `agent.` | JobGPT, a ChatGPT-style assistant with a **Job search** app built on OJCP. It proposes a permission and sends Jordan to approve it in his wallet. It then shows jobs with trust badges and applies, and stops for what's Jordan's to do: Acme's work-history check, Initech's terms. It checks its own credentials' status, so it stops when Jordan cancels in the wallet. |
| 4 · Employer | Acme | `acme.` | Its careers site. Its verification page (RFC 0013): confirm the email first, then share from the wallet, or continue without one. Its recruiters' ATS view: how each application arrived, what the permission disclosed, the verified work history, and what Acme never received. |
| 5 · Under the hood | Anyone evaluating OJCP | `sandbox.` | The ten steps, who's who with each site's trust tier, every message between the parties, and a lab: a domain takeover, a suspended attester, a distrusted attester, Jordan cancelling, the clock, hostile-agent probes and a conformance run against any of the sandbox's providers. The attesters' and trust list's own pages show what each vouched for and what it's doing. |

On every page, short plain-English lines slide in at the corner as things happen anywhere in the sandbox: JobGPT asking for permission, an employer checking it, the wallet checking who's asking, an attester suspending a site. Only moments an event marks with `say` appear; the speaker button turns them off. Under the hood keeps the full technical record.

With `ANTHROPIC_API_KEY` set, free text in the assistant goes to a model, which calls the same functions as the buttons. It never sees a credential, a key or a wallet record. Without it, the assistant runs scripted, with suggested replies.

## What each party proves

- **The wallet trusts only signed requests from verifiers it can check.** Acme signs with the `x509_hash` client ID prefix under a certificate for its host, issued by a sandbox verifier CA the wallet pins (RFC 0013 §4.2). The response goes encrypted (`direct_post.jwt`) to a key made for that request.
- **A wallet answer can't be attached to someone else's application.** Acme's page confirms the application's email with a code before any wallet request exists. That browser becomes the bound session. A presentation completes the step only when it returns there, or when the candidate types the email on the wallet's device (RFC 0013 §3).
- **Acme keeps only what it asked for.** `verifyHiringPresentation` checks the pinned issuer key and its signing window, the type, profile and basis, the key binding to the request's nonce and client ID, and status. Then it drops anything not requested, unread.
- **The assistant only links.** Before relaying a wallet step it checks the site's trust tier, that the page is on the site's own origin, and that the claims are within RFC 0013 §5's list. It learns only that the step is done.
- **The HR platform isn't told where the record is used.** Acme refreshes the platform's status lists on a schedule, not when Jordan presents.

## Origins

| Host (under `sandbox.ojcp.dev`, or `sandbox.lvh.me:8443` locally) | Role |
|---|---|
| `sandbox.` | Under the hood |
| `hr.` | ExamplePeople, the HR platform: an RFC 0014 issuer (`services/issuer`) |
| `wallet.` | Jordan's wallet |
| `agent.` | JobGPT, Jordan's assistant: an agent platform built on `@ojcp/agent-wallet` |
| `issuer.` | Protocol endpoints of the permission service Jordan's wallet provider runs (`services/issuer`): it issues standing mandates and publishes their status. It has no pages of its own: consent and the permissions list are wallet screens, and its account pages redirect there (`accountUi`) |
| `acme.` | Acme Corporation's careers site: an employer running its own provider, with wallet steps |
| `acme-careers.` | A lookalike of Acme's site, using Acme's name with no attestations of its own |
| `ats.` | ExampleATS, hosting Globex and Initech jobs on one origin |
| `globex.ats.` | Globex's careers site, a tenant sharing ExampleATS's identity key |
| `attest-a.`, `attest-b.` | Two attesters run by different operators: Sandbox KYB Co. and Sandbox Business Registry. Each page says what it checks, what it vouched for and whether that still stands, and shows what it's doing live (issuing, suspending, answering status-list fetches without learning who asked) |
| `lists.` | The trust-list publisher the assistant pins. Its page lists the attesters it trusts and for what, any distrust, its pinned key, and its live activity |

All pages are one React app (`ui/`, React and Mantine with ojcp.dev's theme), served on each origin with a bootstrap naming the persona. Each party's own Hono app answers everything else, and every origin serves `/_sandbox/` for the bar, the timeline and the lab.

## Run locally

Node 22.13 or later. `*.sandbox.lvh.me` is public DNS that resolves to 127.0.0.1.

```bash
pnpm install
pnpm --filter "@ojcp/sandbox..." build
pnpm --filter @ojcp/sandbox local
```

The first run creates a local CA and certificates in `.local/`, and regenerates them when the host list changes. Open `https://hr.sandbox.lvh.me:8443/` to start the story. To avoid certificate warnings, trust `.local/ca.pem`, on macOS with `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db .local/ca.pem`.

## Deploy

One process serves every origin and keeps the whole world in memory, so it runs as **exactly one replica**. Restarting it, or pressing *Reset* in the lab, builds a fresh world with new keys. It serves plain HTTP on `PORT` (8080). A load balancer terminates TLS for `sandbox.<domain>`, `*.sandbox.<domain>` and `*.ats.sandbox.<domain>`. `GET /healthz` answers on any Host, for health checks that address the pod by IP.

| Variable | Meaning |
|---|---|
| `SANDBOX_DOMAIN` | Base domain, e.g. `sandbox.ojcp.dev` |
| `PORT` | Listen port (default 8080) |
| `SANDBOX_PUBLIC_PORT` | Public port when it isn't 443 |
| `SANDBOX_TLS_KEY`, `SANDBOX_TLS_CERT` | PEM files, to serve TLS directly (local use) |
| `ANTHROPIC_API_KEY` | Turns on chat mode |
| `SANDBOX_LLM_MODEL` | Model for chat mode (default: the newest available) |

CI (`.github/workflows/ci.yml`) builds the image for amd64 and arm64 on every push to `main` and publishes it publicly as `ghcr.io/ojcp-org/sandbox:<commit>` (and `:main`). To build it yourself, from the repository root:

```bash
docker build -f services/sandbox/Dockerfile -t ojcp-sandbox .
```

[`deploy/rx-workloads-dev`](../../deploy/rx-workloads-dev) mirrors the layout of the `rx-workloads-dev` repository, next to the `ojcp-website` app:

- `charts/apps-vcluster/ojcp-sandbox.yaml`: the Argo CD application;
- `charts/apps-vcluster/charts/ojcp-sandbox/`: Deployment, Service and ALB Ingress;
- `vclusters/apps/ojcp-sandbox-cert.yaml`: the ACM certificate, already in `vclusters/apps/vcluster.yaml`. The `ojcp.dev` certificate's `*.ojcp.dev` covers one label only.

The Deployment's image tag is the commit to deploy; bump it in `rx-workloads-dev` when CI publishes a new one. The GHCR package `ojcp-org/sandbox` is public, so no pull secret is needed. The Service is headless: the apps vCluster allocates IPv4 cluster IPs while the host cluster is IPv6, and the ALB targets pod IPs.

DNS records come from external-dns, which reads the Ingress hosts, as for `ojcp.dev`. The ALB controller finds the certificate from the Ingress `tls` hosts. For chat mode, create the secret in the `ojcp-sandbox` namespace:

```bash
kubectl -n ojcp-sandbox create secret generic ojcp-sandbox --from-literal=anthropic-api-key=…
```
