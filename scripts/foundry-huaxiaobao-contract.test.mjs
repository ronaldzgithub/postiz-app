import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  buildPlan,
  buildScheduledActivationPlan,
  payloadSha256,
  targetSha256,
  verifyWrappedWebhook,
} from './foundry-huaxiaobao-contract.mjs';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const postPayload = type => ({
  type,
  shortLink: false,
  date: '2030-01-02T00:00:00.000Z',
  tags: [],
  posts: [
    {
      integration: { id: 'integration-opaque-1' },
      value: [{ content: 'Prepared content', image: [] }],
      settings: {},
    },
  ],
});
const baseCommand = {
  schema_version: 'foundry.huaxiaobao.postiz.command.v1',
  command_id: 'command-opaque-1',
  task_revision: 2,
  organization_ref: 'organization-opaque-1',
};

test('draft plan can only create a DRAFT and never claims a publish', () => {
  const payload = postPayload('draft');
  const plan = buildPlan(
    { ...baseCommand, operation: 'draft_create', content_version: 1, post_payload: payload },
    { now: NOW },
  );

  assert.equal(plan.requests[0].method, 'POST');
  assert.equal(plan.requests[0].body.type, 'draft');
  assert.equal(plan.arms_future_external_publish, false);
  assert.equal(plan.external_publish_performed, false);
  assert.equal(plan.verification.require.state, 'DRAFT');
});

test('schedule fails closed without fresh approval through execution time', () => {
  const payload = postPayload('schedule');
  assert.throws(
    () =>
      buildPlan(
        { ...baseCommand, operation: 'schedule_create', content_version: 3, post_payload: payload },
        { now: NOW },
      ),
    /approval must be an object/,
  );

  const approval = {
    reference: 'approval-opaque-1',
    expires_at: '2030-01-01T12:00:00.000Z',
    content_version: 3,
    content_sha256: payloadSha256(payload),
    target_sha256: targetSha256(payload),
  };
  assert.throws(
    () =>
      buildPlan(
        { ...baseCommand, operation: 'schedule_create', content_version: 3, post_payload: payload, approval },
        { now: NOW },
      ),
    /valid through the scheduled execution time/,
  );
});

test('approved schedule binds content version, content hash, targets and execution recheck', () => {
  const payload = postPayload('schedule');
  const plan = buildPlan(
    {
      ...baseCommand,
      operation: 'schedule_create',
      content_version: 3,
      post_payload: payload,
      approval: {
        reference: 'approval-opaque-1',
        expires_at: '2030-01-03T00:00:00.000Z',
        content_version: 3,
        content_sha256: payloadSha256(payload),
        target_sha256: targetSha256(payload),
      },
    },
    { now: NOW },
  );

  assert.equal(plan.arms_future_external_publish, false);
  assert.equal(plan.deferred_external_publish, true);
  assert.equal(plan.requests[0].body.type, 'draft');
  assert.equal(plan.execution_preconditions.revalidate_immediately_before_publish, true);
  assert.equal(plan.execution_preconditions.on_mismatch, 'cancel_or_pause_without_publish');
});

test('scheduled draft activates only at execution time with fresh unrevoked approval', () => {
  const payload = postPayload('schedule');
  const command = {
    ...baseCommand,
    operation: 'schedule_create',
    content_version: 3,
    post_payload: payload,
    approval: {
      reference: 'approval-opaque-1',
      expires_at: '2030-01-03T00:00:00.000Z',
      content_version: 3,
      content_sha256: payloadSha256(payload),
      target_sha256: targetSha256(payload),
    },
  };
  const observedDraft = {
    post_id: 'post-opaque-1',
    group: 'group-opaque-1',
    state: 'DRAFT',
    task_revision: 2,
    content_version: 3,
    content_sha256: payloadSha256(payload),
    target_sha256: targetSha256(payload),
    approval_revoked: false,
  };

  const activation = buildScheduledActivationPlan(command, observedDraft, {
    now: new Date('2030-01-02T00:00:01.000Z'),
  });
  assert.equal(activation.requests[0].method, 'PUT');
  assert.deepEqual(activation.requests[0].body, { status: 'schedule' });
  assert.equal(activation.verification.on_timeout_or_ambiguity, 'UNKNOWN_QUERY_ONLY');

  assert.throws(
    () =>
      buildScheduledActivationPlan(command, { ...observedDraft, approval_revoked: true }, {
        now: new Date('2030-01-02T00:00:01.000Z'),
      }),
    /revoked/,
  );
  assert.throws(
    () =>
      buildScheduledActivationPlan(command, observedDraft, {
        now: new Date('2030-01-03T00:00:01.000Z'),
      }),
    /expired/,
  );
});

test('UNKNOWN operation is query-only and cannot republish', () => {
  const plan = buildPlan({
    ...baseCommand,
    operation: 'unknown_query_only',
    group: 'group-opaque-1',
    integration_id: 'integration-opaque-1',
    content_version: 3,
    expected_content_sha256: 'a'.repeat(64),
    start_date: '2030-01-01T00:00:00.000Z',
    end_date: '2030-01-03T00:00:00.000Z',
  });

  assert.equal(plan.query_only, true);
  assert.equal(plan.mutation_allowed, false);
  assert.deepEqual(plan.requests.map(request => request.method), ['GET']);
  assert.match(plan.unknown_policy, /never publish or republish/);
});

test('cancel exposes soft-delete/workflow ambiguity and requires verification', () => {
  const plan = buildPlan({
    ...baseCommand,
    operation: 'cancel_group',
    group: 'group-opaque-1',
    integration_id: 'integration-opaque-1',
    content_version: 3,
    expected_content_sha256: 'a'.repeat(64),
    start_date: '2030-01-01T00:00:00.000Z',
    end_date: '2030-01-03T00:00:00.000Z',
  });

  assert.equal(plan.native_atomic_cancel, false);
  assert.equal(plan.provider_content_retracted, false);
  assert.match(plan.required_huaxiaobao_transition_before_delete, /persist_tombstone/);
  assert.equal(plan.requests[0].method, 'DELETE');
  assert.equal(plan.verification.require.workflow_not_running, true);
});

test('analytics stays query-only and carries an evidence limitation', () => {
  const plan = buildPlan({
    ...baseCommand,
    operation: 'analytics_query',
    post_id: 'post-opaque-1',
    date_epoch_ms: 1_893_456_000_000,
  });

  assert.equal(plan.query_only, true);
  assert.equal(plan.requests[0].method, 'GET');
  assert.match(plan.evidence_limit, /not revenue/);
});

test('wrapped webhook requires HMAC and deduplicates independent of delivery id', () => {
  const secret = 'test-only-secret';
  const timestamp = '2030-01-01T00:00:00.000Z';
  const rawBody = JSON.stringify([
    {
      id: 'post-opaque-1',
      state: 'PUBLISHED',
      publishDate: '2030-01-01T00:00:00.000Z',
      releaseURL: 'https://social.example/post/1',
      integration: { id: 'integration-opaque-1' },
    },
  ]);
  const envelopeFor = eventId => ({
    schema_version: 'foundry.huaxiaobao.postiz.webhook-envelope.v1',
    instance_ref: 'postiz-instance-opaque-1',
    integration_ref: 'integration-opaque-1',
    raw_body: rawBody,
    headers: {
      'x-huaxiaobao-event-id': eventId,
      'x-huaxiaobao-timestamp': timestamp,
      'x-huaxiaobao-signature': `sha256=${createHmac('sha256', secret)
        .update(`${timestamp}.${eventId}.${rawBody}`)
        .digest('hex')}`,
    },
  });

  const first = verifyWrappedWebhook(envelopeFor('delivery-1'), secret, { now: NOW });
  const duplicate = verifyWrappedWebhook(envelopeFor('delivery-2'), secret, { now: NOW });
  assert.equal(first.authenticated, true);
  assert.equal(first.deduplication_key, duplicate.deduplication_key);
  assert.equal(first.native_postiz_webhook_signed, false);

  const tampered = envelopeFor('delivery-1');
  tampered.raw_body = `${rawBody} `;
  assert.throws(() => verifyWrappedWebhook(tampered, secret, { now: NOW }), /signature is invalid/);
});

test('credentials and republish are rejected from plans', () => {
  const payload = postPayload('draft');
  payload.republish = true;
  assert.throws(
    () =>
      buildPlan(
        { ...baseCommand, operation: 'draft_create', content_version: 1, post_payload: payload },
        { now: NOW },
      ),
    /republish is outside/,
  );
  assert.throws(
    () =>
      buildPlan(
        {
          ...baseCommand,
          operation: 'analytics_query',
          post_id: 'post-opaque-1',
          date_epoch_ms: 0,
          api_key: 'must-not-be-here',
        },
        { now: NOW },
      ),
    /credential storage/,
  );
});
