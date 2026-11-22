import { z } from 'zod';
import { get, patch, post } from '../api.js';
import { defineTool, defined } from '../util.js';

// STATUSES_ALL in rl_agent/madscientist/constants.py.
const STATUSES = ['pending_judge', 'pending_user', 'approved', 'rejected', 'deferred', 'implementing', 'pr_open',
  'training', 'done', 'failed', 'cancelled'];
// GROUPS in dashboard/src/api/lab.ts.
const GROUPS = ['pending', 'in_flight', 'outcomes', 'closed', 'judging'];
const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'a 24-character proposal id');

export function register(server) {
  defineTool(server, 'list_proposals', {
    title: 'List MadScientist proposals',
    description: 'Lab page: research proposals, most recently updated first (awaiting-decision ones oldest first), each with '
      + 'its verdict and the status of its training runs.',
    readOnly: true,
    input: {
      group: z.enum(GROUPS).optional().describe('pending = awaiting your decision (pending_user, deferred); in_flight = approved '
        + 'through training; outcomes = done or failed; closed = rejected or cancelled; judging = pending_judge.'),
      status: z.array(z.enum(STATUSES)).optional().describe('Exact statuses, e.g. ["pending_user"].'),
      q: z.string().optional().describe('Search title, hypothesis and arXiv ids.'),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
      offset: z.number().int().min(0).optional(),
    },
  }, async ({ group, status, q, limit, offset }) => get('/api/v1/lab/proposals', defined({ group, status: status && status.join(','), q, limit, offset })));

  defineTool(server, 'get_proposal', {
    title: 'Get proposal',
    description: 'Full proposal: hypothesis, experiment arms, judge review, audit timeline, its training runs (arm, seed, '
      + 'status, scored model) and the per-arm outcome statistics.',
    readOnly: true,
    input: { id: objectId },
  }, async ({ id }) => get(`/api/v1/lab/proposals/${id}`));

  defineTool(server, 'get_madscientist_activity', {
    title: 'MadScientist activity feed',
    description: 'Recent audit events across all proposals (or one), newest first.',
    readOnly: true,
    input: {
      proposal: objectId.optional().describe('Only this proposal\'s events.'),
      agent: z.array(z.string()).optional().describe('Only these agents, e.g. ["scout","judge","user"].'),
      limit: z.number().int().min(1).max(200).optional().describe('Default 30.'),
      offset: z.number().int().min(0).optional(),
    },
  }, async ({ proposal, agent, limit, offset }) => get('/api/v1/lab/activity', defined({ proposal, agent: agent && agent.join(','), limit, offset })));

  defineTool(server, 'decide_proposal', {
    title: 'Decide proposal',
    description: 'Approve, approve with revisions, reject or defer a proposal awaiting a decision (pending_user or deferred). '
      + 'Approval lets the orchestrator queue its training jobs.',
    input: {
      id: objectId,
      action: z.enum(['approve', 'approve_with_revisions', 'reject', 'defer']),
      note: z.string().max(4000).optional(),
    },
  }, async ({ id, action, note }) => post(`/api/v1/lab/proposals/${id}/decision`, defined({ action, note, source: 'mcp' })));

  defineTool(server, 'edit_proposal', {
    title: 'Edit proposal',
    description: 'Adjust a proposal still awaiting a decision (pending_user or deferred). Editable keys: title, hypothesis, '
      + 'motivation, code_changes_summary, n_seeds_per_arm, num_iterations_per_seed, expected_wall_time_hours, '
      + 'success_criteria.primary, and success_criteria.primary_parsed.{metric, arm_a, arm_b, comparator, threshold, '
      + 'threshold_kind}. Other keys are ignored. Every edit is recorded in the audit trail.',
    input: { id: objectId, patch: z.record(z.string(), z.any()) },
  }, async ({ id, patch: changes }) => patch(`/api/v1/lab/proposals/${id}`, { patch: changes, source: 'mcp' }));
}
