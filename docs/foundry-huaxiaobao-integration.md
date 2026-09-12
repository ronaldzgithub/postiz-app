# Foundry–Huaxiaobao integration boundary

## Status and source record

This document defines a proposed integration boundary. It is not evidence that
Postiz has been deployed, connected to a real social account, scheduled a post,
or received approval to publish. This documentation change did not perform any
runtime or external-account validation.

| Item | Pinned value |
| --- | --- |
| Upstream project | `gitroomhq/postiz-app` |
| Upstream remote | `https://github.com/gitroomhq/postiz-app.git` |
| Fork owner / remote | `ronaldzgithub` / `https://github.com/ronaldzgithub/postiz-app.git` |
| Integration branch | `codex/foundry-huaxiaobao-integration` |
| Baseline commit | `3cbe20b86bf3b2243843d51bb63dcec8773babf7` |

Keep the original project as `upstream` and the fork as `origin`. Each upstream
merge must deliberately update this baseline and its compatibility evidence;
never push integration work to the upstream project.

## Ownership boundary

- Foundry owns content plans, service/offer semantics, target audience,
  commercial opportunity, approval reference, acceptance and accounting. A
  Postiz `PUBLISHED` record or analytics value is not proof of customer outcome,
  revenue, membership growth or net value.
- Huaxiaobao owns Postiz/API connectivity, platform accounts, OAuth/token state,
  login and administrator worksite, capability registration, execution policy
  and typed receipts. Foundry must not copy credentials or build a second social
  platform SDK.
- Postiz remains the content drafting, scheduling, publishing-status and
  analytics workspace. Its UI and scheduler do not grant external-action
  authority.
- VolvenceDeploy owns approved runtime deployment, persistence, health, upgrade
  and recovery.

Platform support and account health are independent. A successful post on one
provider cannot mark any other provider ready. Xiaohongshu support is not
assumed from generic social publishing; if another dedicated adapter is the
primary executor, Postiz must be explicitly registered as a non-conflicting
planner or fallback, never as a second simultaneous sender for the same account.

## Capability decomposition

Register separate versioned Huaxiaobao capabilities per provider and account.

| Capability | Native surface | Side effect and gate | Verification |
| --- | --- | --- | --- |
| Read integrations/account state | Public integrations API and integration model | Read-only; contains sensitive account metadata | Bind organization/provider/opaque integration ID; re-read token-health flags without exporting tokens |
| Create/update content draft | Posts API/UI with `DRAFT` state | Internal Postiz mutation only | Re-read immutable content/media hash and provider targets |
| Create/change schedule | Posts service/workflow | Arms future external publishing; requires approval valid for the actual execution window | Re-read schedule, timezone, provider targets, approval expiry and workflow identity |
| Stop/cancel scheduled content | Delete/change-date/service workflow control | Must prevent future publication; does not retract already-published platform content | Verify workflow termination/cancellation and current Postiz state, then verify platform when execution may have started |
| Publish now / workflow publish | Temporal post workflow and provider SDK | Irreversible external action; exact unexpired named approval required | Query Postiz and provider-side post identity/state; never trust 2xx alone |
| Republish | Explicit `republish` path | A new external action, not a harmless retry | New action ID and approval; verify new provider post identity |
| Read publication/analytics | Posts/analytics APIs | Read-only but may process personal/audience data | Record provider, post ID, observed time and metric provenance |
| Receive Postiz activity webhook | `post.activity.ts` | Notification only | Authenticate at the Huaxiaobao boundary and re-query; webhook delivery is not business ACK |
| Create/refresh/delete platform connection | Integration APIs/UI | Account-owner or tool-admin action; may rotate/disable credentials | Adapter re-checks provider identity, permissions and a non-sending account operation |

Relevant source anchors are
`apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.1.2.ts`,
`libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts`,
`libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts`,
`libraries/nestjs-libraries/src/database/prisma/schema.prisma`, and
`apps/backend/src/public-api/routes/v1/public.integrations.controller.ts`.

## Scheduling, retry, cancellation, and unknown results

The V1.1.2 post workflow disables automatic provider SDK retries for
irreversible publication and classifies refreshable tokens, stop conditions,
bad responses, timeouts and unknown failures. It records an ambiguous outcome as
an error and asks the operator to check the platform. Preserve that safety
property: timeout or lost acknowledgement must trigger a provider/Postiz lookup,
not another send.

The posts service starts the workflow with `TERMINATE_EXISTING`, and exposes
explicit schedule/change-date and `republish` paths. Deletion is a soft delete of
the Postiz record and then attempts to terminate workflows; termination errors
can be returned after being caught. Therefore:

- soft deletion is not proof that a scheduled execution was stopped;
- deleting a Postiz record is not deletion of already-published provider content;
- cancellation racing with a worker requires platform-side verification;
- republish always needs a new action identity and approval;
- scheduler dispatch must revalidate approval expiry, target/content hash,
  account/tenant and revocation immediately before provider execution.

The persisted states `QUEUE`, `PUBLISHED`, `ERROR` and `DRAFT` are tool states,
not Foundry acceptance states. The adapter must retain a separate frozen
checkpoint and typed outcome, including an explicit unknown-result path.

## Account and HITL entry

Foundry tasks store opaque organization, integration and provider references.
Huaxiaobao resolves an identity-bound, short-lived route at authorization time,
for example the native launches page or
`/integrations/social/[provider]?refresh=<opaque-internal-id>`. Do not store the
resolved URL, OAuth callback, access/refresh token, cookie, API key or reusable
session in a task, ledger entry, receipt or normal log.

| Identity | Allowed intervention | Completion condition |
| --- | --- | --- |
| Account owner | Supply/authorize the owned social account, complete OAuth/login/reauthorization | Adapter verifies provider identity, requested scopes and account health |
| Huaxiaobao/tool administrator | Configure Postiz organization/integration/webhook, review provider capability and activate it | Configuration read-back and a non-sending account check |
| Ordinary worker | Prepare media/copy, repair metadata, inspect an ambiguous post, or operate a bounded content task | Adapter re-reads the Postiz/provider result; worker receives no owner/admin/approval authority |
| Named approver | Approve the exact provider account, content/media hash, schedule/window, purpose and expiry | Approval is revalidated at execution and consumed according to Foundry policy |

Every persistent dependency identifies why a person is required, the blocked
goal/checkpoint, identity, allowed scope, opaque entry, completion test, deadline,
budget if relevant, and completion/cancel/failure/expiry route. Multiple posts
blocked by the same expired connection share one dependency. While paused they
must not repeatedly poll, spend budget, or enqueue outbound attempts.

## Typed verification, ACK, and resume

Use the existing versioned Foundry/Huaxiaobao contract. Every command and result
must include schema version, stable action ID, attempt, provider and opaque
organization/account/integration references, content/media and target hashes,
schedule revision, approval reference/expiry, observed time, evidence class and
provenance.

The required chain is:

1. Foundry freezes the approved command and original checkpoint.
2. Huaxiaobao validates tenant, provider, account, permission, current schedule
   revision and approval immediately before execution.
3. Postiz dispatches at most one provider action for that immutable identity.
4. The adapter re-queries Postiz and the platform-side post where possible and
   emits a typed success, blocked, cancelled, failed, expired, conflict or
   unknown outcome using the current canonical contract.
5. The originating Foundry component durably ACKs that exact outcome before the
   checkpoint resumes. Redelivery returns the stored receipt; identity/content
   mismatch fails closed.

`post.activity.ts` currently performs a best-effort outbound POST and swallows
errors. It does not provide a durable event identity, authenticated business
acknowledgement or reliable retry contract. Treat it only as a wake-up hint and
poll the authenticated API/current provider state. Late callbacks cannot update
a newer schedule/task version. A restart must reconstruct pending verification
from durable command and receipt state, not from an in-memory callback.

## External-action inventory

External actions include publish-now, scheduled publish, republish, comments or
other provider interactions exposed by a connector, and any webhook/workflow
HTTP request carrying customer data. Draft creation and analytics reads do not
authorize these actions. Native scheduling/retry behavior cannot bypass a
revoked or expired approval. Removing a future post, retracting provider content,
and editing already-published content are distinct capabilities with separate
verification and approval rules.

## Deployment, upgrade, and rollback

- VolvenceDeploy must pin source commits and image digests. The repository
  `docker-compose.yaml` currently references floating `latest` images, so it is
  a development starting point rather than an acceptable production identity.
- Isolate Postiz, PostgreSQL, Redis and Temporal persistence plus provider token
  state inside the Huaxiaobao-managed execution boundary. Keep Foundry outside
  this credential store.
- Add service/application health checks beyond the compose database/Redis checks:
  authenticated Postiz read, Temporal worker visibility, scheduled workflow
  visibility and a non-sending provider account probe.
- Before upgrade, back up databases and durable workflow state, record schema and
  dependency versions, exercise migrations in isolation, then test schedule,
  cancellation, unknown-result and restart recovery. Promotion requires the
  Foundry/Huaxiaobao contract suite and secret scan.
- Roll back to the prior pinned artifact only with compatible schemas/workflows;
  otherwise restore the approved snapshot or use a reviewed forward fix. Never
  terminate or migrate a running production instance without an approved
  VolvenceDeploy change.

## License and provider boundary

The root `LICENSE` is AGPL-3.0. Individual packages declare other licenses,
including ISC, and every bundled dependency/asset retains its own terms. Review
the exact deployed packages, transitive components and any paid/hosted features;
do not infer that all functionality is free for commercial use merely because a
root license exists. Separately validate each social provider's API terms,
automation policy, account rights and content rules. Preserve license, copyright
and attribution notices.

## Executable offline contract boundary

`scripts/foundry-huaxiaobao-contract.mjs` is a no-network planning and receipt-
verification boundary for contract version
`foundry.huaxiaobao.postiz.command.v1`. It deliberately does not contain an
HTTP client or credentials. `scripts/foundry-huaxiaobao-contract.test.mjs` and
`docs/foundry-huaxiaobao-postiz-command.example.json` exercise the boundary
without contacting Postiz or a provider:

```sh
node --test scripts/foundry-huaxiaobao-contract.test.mjs
node scripts/foundry-huaxiaobao-contract.mjs \
  --plan docs/foundry-huaxiaobao-postiz-command.example.json
```

The planner exposes only `draft_create`, `schedule_create`, `status_query`,
`cancel_group`, `analytics_query`, and `unknown_query_only`. A scheduled plan
binds the exact content and integration-target hashes and requires a current
approval whose expiry is later than both the planning time and intended
execution time. Because native `postWorkflowV112` does not know the external
approval, the safe plan initially persists a Postiz `DRAFT`; it does not arm the
native workflow. At the due time `buildScheduledActivationPlan` requires a fresh
read-back of that same draft, matching task/content/target versions and a known
unrevoked approval, then emits the native draft-to-schedule status change. A
plan is not an authorization token. Revocation, expiry, changed content, wrong
tenant or restart without durable state stops activation. `UNKNOWN` produces
GET-only status/read-back steps and can never turn into publish or republish.

Native group deletion is a soft-delete plus best-effort Temporal termination,
so the cancellation plan first requires Huaxiaobao to durably tombstone the
deferred activation, then requires a read-back and reports that provider content
was not retracted. A missing or ambiguous result remains
unknown and query-only. This boundary does not modify the existing Temporal
workflow.

Postiz's current outbound callback is unsigned. Direct callbacks therefore do
not meet this contract. Huaxiaobao must terminate a private ingress and wrap the
unaltered raw body in `foundry.huaxiaobao.postiz.webhook-envelope.v1`, signed by
an ingress-only HMAC secret. The verifier checks signature and freshness,
derives a stable resource/body deduplication key independent of delivery ID,
and returns a GET read-back plan. Callback acceptance is transport evidence,
not business ACK; Foundry resumes only after typed verification is consumed.

## Current truth and blockers

| Milestone | State at this baseline |
| --- | --- |
| Source/fork/branch record | Recorded above; source present locally |
| Integration design | Documented; no live integration claimed |
| Offline planner/verifier | Implemented and covered by local contract tests; it performs no HTTP requests |
| Huaxiaobao live adapter/capability activation | Not present or proven by this change |
| Isolated deployment and health | Not run or proven |
| Schedule/cancel/restart/duplicate/revocation tests | Not run or proven |
| Real provider account validation | Blocked pending an authorized account per provider |
| Approved publish validation | Blocked pending an exact named approval |
| Production deployment | Not approved and not claimed |

The minimum first implementation is integration/account status, draft creation,
schedule read and signed/polled status verification with publishing disabled.
Enable one provider's scheduled publish only after approval-at-execution,
cancel-race, unknown-result, typed ACK and restart-resume tests pass.
