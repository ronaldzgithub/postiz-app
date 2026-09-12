#!/usr/bin/env node

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const COMMAND_SCHEMA = 'foundry.huaxiaobao.postiz.command.v1';
const PLAN_SCHEMA = 'foundry.huaxiaobao.postiz.http-plan.v1';
const WEBHOOK_SCHEMA = 'foundry.huaxiaobao.postiz.webhook-envelope.v1';
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|cookie|password|secret|token)/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(message) {
  throw new Error(message);
}

function assertObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
}

function assertExactKeys(value, allowedKeys, name) {
  const unexpectedKeys = Object.keys(value).filter(key => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    fail(`${name} contains unsupported fields: ${unexpectedKeys.sort().join(', ')}`);
  }
}

function assertNoSecrets(value, path = 'command') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) fail(`${path}.${key} must stay in Huaxiaobao credential storage`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} must be a non-empty string`);
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
}

function assertTimestamp(value, name) {
  if (
    typeof value !== 'string' ||
    !TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(new Date(value).getTime())
  ) {
    fail(`${name} must be a valid ISO-8601 timestamp with a timezone`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function payloadSha256(payload) {
  return sha256(JSON.stringify(stableValue(payload)));
}

function integrationIds(payload) {
  return [...new Set(payload.posts.map(post => post.integration.id))].sort();
}

export function targetSha256(payload) {
  return sha256(`postiz:integrations:${integrationIds(payload).join(',')}`);
}

function validateBase(command) {
  assertObject(command, 'command');
  assertNoSecrets(command);
  if (command.schema_version !== COMMAND_SCHEMA) fail(`schema_version must equal ${COMMAND_SCHEMA}`);
  assertNonEmptyString(command.command_id, 'command_id');
  assertPositiveInteger(command.task_revision, 'task_revision');
  assertNonEmptyString(command.organization_ref, 'organization_ref');
}

function validatePostPayload(payload, expectedType) {
  assertObject(payload, 'post_payload');
  if (payload.type !== expectedType) fail(`post_payload.type must equal ${expectedType}`);
  assertTimestamp(payload.date, 'post_payload.date');
  if (typeof payload.shortLink !== 'boolean') fail('post_payload.shortLink must be a boolean');
  if (!Array.isArray(payload.tags)) fail('post_payload.tags must be an array');
  if (!Array.isArray(payload.posts) || payload.posts.length === 0) {
    fail('post_payload.posts must be a non-empty array');
  }
  if (payload.republish === true) fail('republish is outside this v1 contract');

  payload.posts.forEach((post, postIndex) => {
    assertObject(post, `post_payload.posts[${postIndex}]`);
    assertObject(post.integration, `post_payload.posts[${postIndex}].integration`);
    assertNonEmptyString(post.integration.id, `post_payload.posts[${postIndex}].integration.id`);
    if (!Array.isArray(post.value) || post.value.length === 0) {
      fail(`post_payload.posts[${postIndex}].value must be a non-empty array`);
    }
    post.value.forEach((part, partIndex) => {
      assertObject(part, `post_payload.posts[${postIndex}].value[${partIndex}]`);
      if (typeof part.content !== 'string') {
        fail(`post_payload.posts[${postIndex}].value[${partIndex}].content must be a string`);
      }
      if (!Array.isArray(part.image)) {
        fail(`post_payload.posts[${postIndex}].value[${partIndex}].image must be an array`);
      }
    });
  });
}

function validateApproval(command, now) {
  assertObject(command.approval, 'approval');
  assertExactKeys(
    command.approval,
    new Set(['reference', 'expires_at', 'content_sha256', 'target_sha256', 'content_version']),
    'approval',
  );
  assertNonEmptyString(command.approval.reference, 'approval.reference');
  assertTimestamp(command.approval.expires_at, 'approval.expires_at');
  const expiresAt = new Date(command.approval.expires_at);
  if (expiresAt.getTime() <= now.getTime()) fail('approval is expired');
  if (expiresAt.getTime() <= new Date(command.post_payload.date).getTime()) {
    fail('approval must remain valid through the scheduled execution time');
  }
  if (command.approval.content_version !== command.content_version) {
    fail('approval.content_version does not match content_version');
  }
  if (command.approval.content_sha256 !== payloadSha256(command.post_payload)) {
    fail('approval.content_sha256 does not match post_payload');
  }
  if (command.approval.target_sha256 !== targetSha256(command.post_payload)) {
    fail('approval.target_sha256 does not match the target integrations');
  }
}

function postsQuery(command) {
  assertTimestamp(command.start_date, 'start_date');
  assertTimestamp(command.end_date, 'end_date');
  if (new Date(command.end_date).getTime() < new Date(command.start_date).getTime()) {
    fail('end_date must not precede start_date');
  }
  return {
    method: 'GET',
    path: '/public/v1/posts',
    query: { startDate: command.start_date, endDate: command.end_date },
  };
}

function planBase(command) {
  return {
    schema_version: PLAN_SCHEMA,
    command_id: command.command_id,
    task_revision: command.task_revision,
    operation: command.operation,
    organization_ref: command.organization_ref,
    network_performed: false,
    external_publish_performed: false,
  };
}

export function buildPlan(command, { now = new Date() } = {}) {
  validateBase(command);

  if (command.operation === 'draft_create' || command.operation === 'schedule_create') {
    const expectedType = command.operation === 'draft_create' ? 'draft' : 'schedule';
    const allowedKeys = new Set([
      'schema_version',
      'command_id',
      'task_revision',
      'organization_ref',
      'operation',
      'content_version',
      'post_payload',
    ]);
    if (expectedType === 'schedule') allowedKeys.add('approval');
    assertExactKeys(command, allowedKeys, 'command');
    assertPositiveInteger(command.content_version, 'content_version');
    validatePostPayload(command.post_payload, expectedType);

    if (expectedType === 'schedule') {
      if (new Date(command.post_payload.date).getTime() <= now.getTime()) {
        fail('scheduled execution time must be in the future');
      }
      validateApproval(command, now);
    }

    const contentHash = payloadSha256(command.post_payload);
    const requestPayload =
      expectedType === 'schedule' ? { ...command.post_payload, type: 'draft' } : command.post_payload;
    return {
      ...planBase(command),
      arms_future_external_publish: false,
      deferred_external_publish: expectedType === 'schedule',
      schedule_execution_mode:
        expectedType === 'schedule' ? 'huaxiaobao_just_in_time_draft_activation' : undefined,
      content_version: command.content_version,
      content_sha256: contentHash,
      target_sha256: targetSha256(command.post_payload),
      requests: [{ method: 'POST', path: '/public/v1/posts', body: requestPayload }],
      execution_preconditions:
        expectedType === 'schedule'
          ? {
              revalidate_immediately_before_publish: true,
              activate_not_before: command.post_payload.date,
              approval_reference: command.approval.reference,
              approval_expires_at: command.approval.expires_at,
              require_content_version: command.content_version,
              require_content_sha256: contentHash,
              require_target_sha256: command.approval.target_sha256,
              require_integration_enabled: true,
              on_mismatch: 'cancel_or_pause_without_publish',
            }
          : { external_publish_allowed: false },
      verification: {
        method: 'GET',
        path: '/public/v1/posts',
        query: { startDate: command.post_payload.date, endDate: command.post_payload.date },
        require: {
          integration_ids: integrationIds(command.post_payload),
          content_sha256: contentHash,
          state: 'DRAFT',
        },
      },
    };
  }

  if (command.operation === 'status_query' || command.operation === 'unknown_query_only') {
    assertExactKeys(
      command,
      new Set([
        'schema_version',
        'command_id',
        'task_revision',
        'organization_ref',
        'operation',
        'group',
        'integration_id',
        'content_version',
        'expected_content_sha256',
        'start_date',
        'end_date',
      ]),
      'command',
    );
    assertNonEmptyString(command.group, 'group');
    assertNonEmptyString(command.integration_id, 'integration_id');
    assertPositiveInteger(command.content_version, 'content_version');
    if (!SHA256_PATTERN.test(command.expected_content_sha256)) {
      fail('expected_content_sha256 must be a lowercase SHA-256 value');
    }

    return {
      ...planBase(command),
      query_only: true,
      mutation_allowed: false,
      requests: [postsQuery(command)],
      local_match: {
        group: command.group,
        integration_id: command.integration_id,
        content_version: command.content_version,
        content_sha256: command.expected_content_sha256,
      },
      unknown_policy:
        command.operation === 'unknown_query_only'
          ? 'never publish or republish; query Postiz/provider and create a manual check if still ambiguous'
          : undefined,
    };
  }

  if (command.operation === 'cancel_group') {
    assertExactKeys(
      command,
      new Set([
        'schema_version',
        'command_id',
        'task_revision',
        'organization_ref',
        'operation',
        'group',
        'integration_id',
        'content_version',
        'expected_content_sha256',
        'start_date',
        'end_date',
      ]),
      'command',
    );
    assertNonEmptyString(command.group, 'group');
    assertNonEmptyString(command.integration_id, 'integration_id');
    assertPositiveInteger(command.content_version, 'content_version');
    if (!SHA256_PATTERN.test(command.expected_content_sha256)) {
      fail('expected_content_sha256 must be a lowercase SHA-256 value');
    }
    const query = postsQuery(command);

    return {
      ...planBase(command),
      native_atomic_cancel: false,
      provider_content_retracted: false,
      required_huaxiaobao_transition_before_delete: 'cancel_deferred_activation_and_persist_tombstone',
      precondition_read: {
        ...query,
        require: {
          group: command.group,
          integration_id: command.integration_id,
          content_version: command.content_version,
          content_sha256: command.expected_content_sha256,
          state_in: ['DRAFT', 'QUEUE'],
        },
      },
      requests: [
        { method: 'DELETE', path: `/public/v1/posts/group/${encodeURIComponent(command.group)}` },
      ],
      verification: {
        ...query,
        require: { group_absent_or_deleted: command.group, workflow_not_running: true },
        on_ambiguous: 'query provider; do not claim cancellation or retry publication',
      },
    };
  }

  if (command.operation === 'analytics_query') {
    assertExactKeys(
      command,
      new Set([
        'schema_version',
        'command_id',
        'task_revision',
        'organization_ref',
        'operation',
        'post_id',
        'date_epoch_ms',
      ]),
      'command',
    );
    assertNonEmptyString(command.post_id, 'post_id');
    if (!Number.isSafeInteger(command.date_epoch_ms) || command.date_epoch_ms < 0) {
      fail('date_epoch_ms must be a non-negative integer');
    }
    return {
      ...planBase(command),
      query_only: true,
      requests: [
        {
          method: 'GET',
          path: `/public/v1/analytics/post/${encodeURIComponent(command.post_id)}`,
          query: { date: String(command.date_epoch_ms) },
        },
      ],
      evidence_limit: 'analytics are observed tool metrics, not revenue, acceptance, or customer outcome',
    };
  }

  fail(`unsupported operation: ${String(command.operation)}`);
}

export function buildScheduledActivationPlan(command, observedDraft, { now = new Date() } = {}) {
  validateBase(command);
  assertExactKeys(
    command,
    new Set([
      'schema_version',
      'command_id',
      'task_revision',
      'organization_ref',
      'operation',
      'content_version',
      'post_payload',
      'approval',
    ]),
    'command',
  );
  if (command.operation !== 'schedule_create') fail('only schedule_create can be activated');
  assertPositiveInteger(command.content_version, 'content_version');
  validatePostPayload(command.post_payload, 'schedule');
  validateApproval(command, now);
  if (now.getTime() < new Date(command.post_payload.date).getTime()) {
    fail('scheduled activation is not due yet');
  }

  assertObject(observedDraft, 'observed_draft');
  assertExactKeys(
    observedDraft,
    new Set([
      'post_id',
      'group',
      'state',
      'task_revision',
      'content_version',
      'content_sha256',
      'target_sha256',
      'approval_revoked',
    ]),
    'observed_draft',
  );
  assertNonEmptyString(observedDraft.post_id, 'observed_draft.post_id');
  assertNonEmptyString(observedDraft.group, 'observed_draft.group');
  if (observedDraft.state !== 'DRAFT') fail('observed draft must still be in DRAFT state');
  if (observedDraft.approval_revoked !== false) fail('approval is revoked or revocation state is unknown');
  if (observedDraft.task_revision !== command.task_revision) fail('task revision changed');
  if (observedDraft.content_version !== command.content_version) fail('content version changed');
  if (observedDraft.content_sha256 !== payloadSha256(command.post_payload)) fail('content hash changed');
  if (observedDraft.target_sha256 !== targetSha256(command.post_payload)) fail('target hash changed');

  return {
    ...planBase(command),
    schema_version: 'foundry.huaxiaobao.postiz.activation-plan.v1',
    approval_revalidated_at: now.toISOString(),
    exact_draft_verified: true,
    requests: [
      {
        method: 'PUT',
        path: `/public/v1/posts/${encodeURIComponent(observedDraft.post_id)}/status`,
        body: { status: 'schedule' },
      },
    ],
    verification: {
      method: 'GET',
      path: '/public/v1/posts',
      query: { startDate: command.post_payload.date, endDate: command.post_payload.date },
      require: {
        post_id: observedDraft.post_id,
        group: observedDraft.group,
        state_in: ['QUEUE', 'PUBLISHED'],
        content_sha256: observedDraft.content_sha256,
        target_sha256: observedDraft.target_sha256,
      },
      on_timeout_or_ambiguity: 'UNKNOWN_QUERY_ONLY',
    },
  };
}

function normalizedHeaders(headers) {
  assertObject(headers, 'headers');
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyWrappedWebhook(envelope, secret, { now = new Date(), maxSkewMs = 300_000 } = {}) {
  assertObject(envelope, 'webhook envelope');
  assertExactKeys(
    envelope,
    new Set(['schema_version', 'instance_ref', 'integration_ref', 'headers', 'raw_body']),
    'webhook envelope',
  );
  if (envelope.schema_version !== WEBHOOK_SCHEMA) fail(`schema_version must equal ${WEBHOOK_SCHEMA}`);
  assertNonEmptyString(envelope.instance_ref, 'instance_ref');
  assertNonEmptyString(envelope.integration_ref, 'integration_ref');
  assertNonEmptyString(envelope.raw_body, 'raw_body');
  assertNonEmptyString(secret, 'webhook secret');

  const headers = normalizedHeaders(envelope.headers);
  const eventId = headers['x-huaxiaobao-event-id'];
  const timestamp = headers['x-huaxiaobao-timestamp'];
  const signature = headers['x-huaxiaobao-signature'];
  assertNonEmptyString(eventId, 'x-huaxiaobao-event-id');
  assertTimestamp(timestamp, 'x-huaxiaobao-timestamp');
  if (Math.abs(now.getTime() - new Date(timestamp).getTime()) > maxSkewMs) fail('webhook timestamp is stale');

  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${eventId}.${envelope.raw_body}`).digest('hex')}`;
  if (typeof signature !== 'string' || !secureEqual(signature, expected)) fail('webhook signature is invalid');

  const payload = JSON.parse(envelope.raw_body);
  if (!Array.isArray(payload) || payload.length !== 1) fail('Postiz webhook body must contain exactly one root post');
  const post = payload[0];
  assertObject(post, 'Postiz webhook post');
  assertObject(post.integration, 'Postiz webhook post.integration');
  assertNonEmptyString(post.id, 'Postiz webhook post.id');
  if (post.integration.id !== envelope.integration_ref) fail('webhook integration does not match integration_ref');
  assertTimestamp(post.publishDate, 'Postiz webhook post.publishDate');

  const bodyHash = sha256(envelope.raw_body);
  return {
    schema_version: 'foundry.huaxiaobao.postiz.webhook-verification.v1',
    authenticated: true,
    event_id: eventId,
    body_sha256: bodyHash,
    deduplication_key: sha256(
      [envelope.instance_ref, post.integration.id, post.id, post.state, post.publishDate, bodyHash].join('\u0000'),
    ),
    transport_ack_only: true,
    native_postiz_webhook_signed: false,
    readback: {
      method: 'GET',
      path: '/public/v1/posts',
      query: { startDate: post.publishDate, endDate: post.publishDate },
      require: { id: post.id, integration_id: post.integration.id, state: post.state },
    },
  };
}

async function main() {
  const [option, filePath, ...extra] = process.argv.slice(2);
  if (!option || !filePath || extra.length > 0) {
    fail(
      'usage: node scripts/foundry-huaxiaobao-contract.mjs --plan COMMAND.json | --activate-schedule ACTIVATION.json | --verify-webhook EVENT.json',
    );
  }
  const input = JSON.parse(await readFile(filePath, 'utf8'));

  if (option === '--plan') {
    process.stdout.write(`${JSON.stringify(buildPlan(input), null, 2)}\n`);
    return;
  }
  if (option === '--verify-webhook') {
    const secret = process.env.POSTIZ_WEBHOOK_INGRESS_SECRET;
    if (!secret) fail('POSTIZ_WEBHOOK_INGRESS_SECRET is required for webhook verification');
    process.stdout.write(`${JSON.stringify(verifyWrappedWebhook(input, secret), null, 2)}\n`);
    return;
  }
  if (option === '--activate-schedule') {
    assertObject(input, 'activation input');
    process.stdout.write(
      `${JSON.stringify(buildScheduledActivationPlan(input.command, input.observed_draft), null, 2)}\n`,
    );
    return;
  }
  fail(`unsupported option: ${option}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`contract validation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
