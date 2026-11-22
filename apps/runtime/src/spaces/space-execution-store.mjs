import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { accountError } from "../accounts/account-policy.mjs";
import { integerLimit, requireSpaceExecution, spaceText } from "./space-policy.mjs";

const number = (n) => n == null ? null : Number(n);
const id = (type) => `${type}:${randomUUID()}`;
const hash = (input) => createHash("sha256").update(input).digest("hex");
const reservation = (r) => r && ({
  id: r.id, spaceId: r.space_id, documentId: r.document_id, bindingId: r.binding_id,
  requesterId: r.requester_id, sponsorId: r.sponsor_id, runId: r.run_id, stepId: r.step_id,
  periodKey: r.period_key, ceiling: number(r.ceiling), budgetKeys: r.budget_keys_json,
  inputHash: r.input_hash, state: r.state, actual: number(r.actual), receiptId: r.receipt_id
});
const queue = (r) => r && ({
  sequence: number(r.sequence), spaceId: r.space_id, documentId: r.document_id,
  runId: r.run_id, requesterId: r.requester_id, bindingId: r.binding_id, status: r.status,
  inputRevision: number(r.input_revision), aclRevision: number(r.acl_revision),
  ownerInstance: r.owner_instance, updatedAt: number(r.updated_at)
});

/** Durable FIFO and monthly call budgets. Never release an uncertain dispatch
 * on a timeout/cancellation request. Only the broker's receipt settles usage. */
export class SpaceExecutionStore {
  constructor({ spaces, instanceId = id("runtime") }) {
    this.spaces = spaces;
    this.pool = spaces.pool;
    this.now = spaces.now;
    this.instanceId = instanceId;
  }

  period() { return new Date(this.now()).toISOString().slice(0, 7); }

  async setBudget(userId, spaceId, { scopeKey = "space", hardLimit, expectedRevision = 0 }) {
    if (hardLimit !== null) integerLimit(hardLimit, { minimum: 0 });
    integerLimit(expectedRevision, { minimum: 0 });
    return this.spaces.transaction(spaceId, async (client) => {
      await this.spaces.member(userId, spaceId, client, true);
      if (scopeKey !== "space") {
        if (scopeKey.startsWith("member:")) await this.spaces.member(scopeKey.slice(7), spaceId, client);
        else if (scopeKey.startsWith("binding:") && (await client.query(
          "SELECT 1 FROM space_resource_bindings WHERE space_id=$1 AND id=$2",
          [spaceId, scopeKey.slice(8)])).rowCount) { /* validated scoped resource */ }
        else throw accountError(400, "invalid_budget_scope");
      }
      const periodKey = this.period();
      const r = (await client.query(`SELECT * FROM space_budget_periods
        WHERE space_id=$1 AND scope_key=$2 AND period_key=$3 AND unit='calls'`,
      [spaceId, scopeKey, periodKey])).rows[0];
      if ((number(r?.revision) || 0) !== expectedRevision) throw accountError(409, "budget_revision_conflict");
      if (hardLimit != null && number(r?.committed || 0) + number(r?.reserved || 0) > hardLimit) {
        throw accountError(409, "budget_below_existing_usage");
      }
      await client.query(`INSERT INTO space_budget_periods
        (space_id,scope_key,period_key,hard_limit,revision,updated_at) VALUES ($1,$2,$3,$4,1,$5)
        ON CONFLICT (space_id,scope_key,period_key,unit) DO UPDATE
        SET hard_limit=$4,revision=space_budget_periods.revision+1,updated_at=$5`,
      [spaceId, scopeKey, periodKey, hardLimit, this.now()]);
      await this.spaces.emit(client, spaceId, userId, "budget.changed", "budget", scopeKey, expectedRevision + 1);
      return { scopeKey, periodKey, hardLimit, revision: expectedRevision + 1 };
    });
  }

  async usage(userId, spaceId) {
    const member = await this.spaces.member(userId, spaceId);
    const manager = ["owner", "admin"].includes(member.role);
    const budgets = (await this.pool.query(`SELECT scope_key AS "scopeKey",period_key AS "periodKey",
      hard_limit AS "hardLimit",committed,reserved,revision FROM space_budget_periods
      WHERE space_id=$1 AND period_key=$2 AND ($3 OR scope_key=$4) ORDER BY scope_key`,
    [spaceId, this.period(), manager, `member:${userId}`])).rows.map((r) => ({ ...r,
      hardLimit: number(r.hardLimit), committed: number(r.committed), reserved: number(r.reserved), revision: number(r.revision) }));
    const rows = (await this.pool.query(`SELECT * FROM space_usage_reservations WHERE space_id=$1
      AND ($2 OR requester_id=$3) ORDER BY created_at DESC LIMIT 200`, [spaceId, manager, userId])).rows;
    return { periodKey: this.period(), unit: "calls", budgets, reservations: rows.map(reservation) };
  }

  async authorize(userId, spaceId, documentId, bindingId, client) {
    const space = await this.spaces.accounts.space(spaceId, client);
    if (this.spaces.sharing && space.kind === "personal") {
      const personal = await this.spaces.accounts.personalSpace(userId, client);
      requireSpaceExecution(await this.spaces.member(userId, personal.id, client));
      if (bindingId) throw accountError(403, "content_resource_denied");
    } else requireSpaceExecution(await this.spaces.member(userId, spaceId, client));
    const document = await this.spaces.requireDocument(userId, spaceId, documentId, "edit", client);
    const binding = bindingId ? await this.spaces.requireBinding(userId, spaceId, bindingId, client) : null;
    return { document, binding };
  }

  async reserve({ userId, spaceId, documentId, bindingId = null, runId, stepId, input, ceiling = 1 }) {
    spaceText(runId, "Run", 256);
    spaceText(stepId, "Step", 256);
    integerLimit(ceiling, { maximum: 1000 });
    if (typeof input !== "string" || Buffer.byteLength(input) > 16 * 1024 * 1024) throw accountError(400, "invalid_step_input");
    return this.spaces.transaction(spaceId, async (client) => {
      const { binding } = await this.authorize(userId, spaceId, documentId, bindingId, client);
      const inputHash = hash(input);
      const previous = reservation((await client.query(`SELECT * FROM space_usage_reservations
        WHERE space_id=$1 AND run_id=$2 AND step_id=$3`, [spaceId, runId, stepId])).rows[0]);
      if (previous) {
        if (previous.inputHash !== inputHash || previous.bindingId !== bindingId || previous.ceiling !== ceiling
          || previous.requesterId !== userId || previous.documentId !== documentId) throw accountError(409, "step_idempotency_conflict");
        if (previous.state !== "released") return previous;
        // A durable release proves that dispatch never happened. Retain the
        // old ledger and reserve anew; a released ID cannot dispatch for free.
        await client.query("UPDATE space_usage_reservations SET step_id=$2 WHERE id=$1",
          [previous.id, `released:${previous.stepId}:${previous.id}`]);
      }
      if (stepId.startsWith("tool:")) {
        const uncertain = (await client.query(`SELECT 1 FROM space_usage_reservations
          WHERE space_id=$1 AND run_id=$2 AND input_hash=$3 AND binding_id IS NOT DISTINCT FROM $4
            AND state IN ('dispatched','pending') LIMIT 1`, [spaceId, runId, inputHash, bindingId])).rowCount;
        if (uncertain) throw accountError(409, "shared_tool_outcome_requires_reconciliation");
      }
      const periodKey = this.period(), keys = ["space", `member:${userId}`, ...(binding ? [`binding:${binding.id}`] : [])].sort();
      for (const key of keys) {
        await client.query(`INSERT INTO space_budget_periods (space_id,scope_key,period_key,updated_at)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [spaceId, key, periodKey, this.now()]);
        const budget = (await client.query(`SELECT * FROM space_budget_periods
          WHERE space_id=$1 AND scope_key=$2 AND period_key=$3 AND unit='calls' FOR UPDATE`,
        [spaceId, key, periodKey])).rows[0];
        const sourceLimit = key === `binding:${binding?.id}` ? binding.limits.monthlyCalls : null;
        const limits = [number(budget.hard_limit), sourceLimit].filter((n) => n != null);
        if (limits.some((limit) => number(budget.committed) + number(budget.reserved) + ceiling > limit)) {
          throw accountError(429, "space_call_budget_exhausted", "本月调用额度已用完，请联系空间管理员");
        }
      }
      for (const key of keys) await client.query(`UPDATE space_budget_periods SET reserved=reserved+$4,updated_at=$5
        WHERE space_id=$1 AND scope_key=$2 AND period_key=$3 AND unit='calls'`,
      [spaceId, key, periodKey, ceiling, this.now()]);
      const reservationId = id("usage");
      await client.query(`INSERT INTO space_usage_reservations
        (id,space_id,document_id,binding_id,requester_id,sponsor_id,run_id,step_id,period_key,ceiling,
        budget_keys_json,input_hash,state,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,'reserved',$13,$13)`,
      [reservationId, spaceId, documentId, bindingId, userId, binding?.providerId || userId, runId, stepId,
        periodKey, ceiling, JSON.stringify(keys), inputHash, this.now()]);
      await this.ledger(client, reservationId, spaceId, "reserved", ceiling);
      return reservation((await client.query("SELECT * FROM space_usage_reservations WHERE id=$1", [reservationId])).rows[0]);
    });
  }

  async ledger(client, reservationId, spaceId, type, amount, receiptId = null) {
    await client.query(`INSERT INTO space_usage_ledger
      (reservation_id,space_id,event_type,amount,receipt_id,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [reservationId, spaceId, type, amount, receiptId, this.now()]);
  }

  async dispatch(spaceId, reservationId) {
    return this.spaces.transaction(spaceId, async (client) => {
      const r = reservation((await client.query("SELECT * FROM space_usage_reservations WHERE space_id=$1 AND id=$2 FOR UPDATE",
        [spaceId, reservationId])).rows[0]);
      if (!r) throw accountError(404, "reservation_not_found");
      if (r.state !== "reserved") throw accountError(409, "step_already_dispatched");
      await this.authorize(r.requesterId, spaceId, r.documentId, r.bindingId, client);
      const q = (await client.query("SELECT status FROM space_run_queue WHERE space_id=$1 AND run_id=$2",
        [spaceId, r.runId])).rows[0];
      if (!q || q.status !== "running") throw accountError(409, "run_not_dispatchable");
      await client.query("UPDATE space_usage_reservations SET state='dispatched',updated_at=$2 WHERE id=$1", [reservationId, this.now()]);
      await this.ledger(client, reservationId, spaceId, "dispatched", r.ceiling);
      return { ...r, state: "dispatched" };
    });
  }

  async pending(spaceId, reservationId) {
    return this.spaces.transaction(spaceId, async (client) => {
      const r = reservation((await client.query("SELECT * FROM space_usage_reservations WHERE space_id=$1 AND id=$2 FOR UPDATE",
        [spaceId, reservationId])).rows[0]);
      if (!r) throw accountError(404, "reservation_not_found");
      if (r.state !== "dispatched") return r;
      await client.query("UPDATE space_usage_reservations SET state='pending',updated_at=$2 WHERE id=$1", [reservationId, this.now()]);
      await this.ledger(client, reservationId, spaceId, "pending", r.ceiling);
      return { ...r, state: "pending" };
    });
  }

  async releaseUndispatched(spaceId, reservationId) {
    return this.finalize(spaceId, reservationId, { actual: 0, receiptId: null, undispatched: true });
  }

  /** Server-only broker call: a user-supplied JSON receipt is never authority. */
  async settle(spaceId, reservationId, receipt) {
    if (!receipt || receipt.verified !== true || !receipt.id) throw accountError(400, "verified_receipt_required");
    return this.finalize(spaceId, reservationId, {
      actual: integerLimit(receipt.calls, { minimum: 0 }), receiptId: spaceText(receipt.id, "Receipt", 256),
      inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, undispatched: false
    });
  }

  async finalize(spaceId, reservationId, outcome) {
    return this.spaces.transaction(spaceId, async (client) => {
      const r = reservation((await client.query("SELECT * FROM space_usage_reservations WHERE space_id=$1 AND id=$2 FOR UPDATE",
        [spaceId, reservationId])).rows[0]);
      if (!r) throw accountError(404, "reservation_not_found");
      if (["settled", "released"].includes(r.state)) {
        if (r.actual !== outcome.actual || r.receiptId !== outcome.receiptId) throw accountError(409, "receipt_conflict");
        return r;
      }
      if (outcome.actual > r.ceiling) throw accountError(409, "receipt_exceeds_reservation");
      if (outcome.undispatched ? r.state !== "reserved" : !["dispatched", "pending"].includes(r.state)) {
        throw accountError(409, "reservation_state_conflict");
      }
      for (const tokens of [outcome.inputTokens, outcome.outputTokens]) if (tokens != null) integerLimit(tokens, { minimum: 0 });
      for (const key of [...r.budgetKeys].sort()) {
        const updated = await client.query(`UPDATE space_budget_periods SET reserved=reserved-$4,
          committed=committed+$5,updated_at=$6 WHERE space_id=$1 AND scope_key=$2 AND period_key=$3
          AND unit='calls' AND reserved>=$4 RETURNING scope_key`,
        [spaceId, key, r.periodKey, r.ceiling, outcome.actual, this.now()]);
        if (!updated.rowCount) throw accountError(409, "budget_reservation_inconsistent");
      }
      const state = outcome.undispatched ? "released" : "settled";
      await client.query(`UPDATE space_usage_reservations SET state=$2,actual=$3,receipt_id=$4,input_tokens=$5,
        output_tokens=$6,updated_at=$7 WHERE id=$1`, [reservationId, state, outcome.actual, outcome.receiptId,
        outcome.inputTokens ?? null, outcome.outputTokens ?? null, this.now()]);
      await this.ledger(client, reservationId, spaceId, state, outcome.actual, outcome.receiptId);
      return { ...r, state, actual: outcome.actual, receiptId: outcome.receiptId };
    });
  }

  async enqueue({ userId, spaceId, documentId, bindingId = null, runId, inputRevision, resume = false, frozenInput = false }) {
    integerLimit(inputRevision);
    return this.spaces.transaction(spaceId, async (client) => {
      const { document } = await this.authorize(userId, spaceId, documentId, bindingId, client);
      let inputHash = null;
      if (frozenInput) {
        const input = (await client.query(`SELECT i.messages_json,r.payload_json FROM runtime_run_inputs i
          JOIN runtime_runs r ON r.space_id=i.space_id AND r.id=i.run_id
          WHERE i.space_id=$1 AND i.run_id=$2`, [spaceId, runId])).rows[0];
        if (!input || input.payload_json.sessionId !== documentId || input.payload_json.principal?.userId !== userId) {
          throw accountError(409, "frozen_input_unavailable");
        }
        inputHash = hash(JSON.stringify(input.messages_json));
      }
      const existing = queue((await client.query("SELECT * FROM space_run_queue WHERE space_id=$1 AND run_id=$2", [spaceId, runId])).rows[0]);
      if (existing) {
        if (resume && existing.requesterId === userId && existing.documentId === documentId
          && existing.bindingId === bindingId && ["completed", "failed", "cancelled"].includes(existing.status)) {
          const unsettled = (await client.query(`SELECT 1 FROM space_usage_reservations WHERE space_id=$1 AND run_id=$2
            AND state IN ('dispatched','pending')`, [spaceId, runId])).rowCount;
          if (unsettled) throw accountError(409, "run_outcome_requires_reconciliation");
          await client.query(`UPDATE space_run_queue SET sequence=nextval(pg_get_serial_sequence('space_run_queue','sequence')),
            status='queued',owner_instance=NULL,input_revision=$3,acl_revision=$4,updated_at=$5,frozen_input_hash=$6
            WHERE space_id=$1 AND run_id=$2`, [spaceId, runId, inputRevision, document.aclRevision, this.now(), inputHash]);
          return queue((await client.query("SELECT * FROM space_run_queue WHERE space_id=$1 AND run_id=$2", [spaceId, runId])).rows[0]);
        }
        if (existing.requesterId !== userId || existing.documentId !== documentId || existing.bindingId !== bindingId
          || existing.inputRevision !== inputRevision) throw accountError(409, "run_queue_idempotency_conflict");
        return existing;
      }
      await client.query(`INSERT INTO space_run_queue
        (space_id,document_id,run_id,requester_id,binding_id,status,input_revision,acl_revision,created_at,updated_at,frozen_input_hash)
        VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$8,$9)`,
      [spaceId, documentId, runId, userId, bindingId, inputRevision, document.aclRevision, this.now(), inputHash]);
      return queue((await client.query("SELECT * FROM space_run_queue WHERE space_id=$1 AND run_id=$2", [spaceId, runId])).rows[0]);
    });
  }

  async claim(spaceId, runId) {
    return this.spaces.transaction(spaceId, async (client) => {
      const row = (await client.query("SELECT * FROM space_run_queue WHERE space_id=$1 AND run_id=$2", [spaceId, runId])).rows[0];
      const current = queue(row);
      if (!current || current.status !== "queued") throw accountError(409, "run_not_queued");
      const earlier = (await client.query(`SELECT 1 FROM space_run_queue WHERE space_id=$1 AND document_id=$2
        AND ((status='queued' AND sequence<$3) OR status IN ('running','cancelling','outcome_unknown')) LIMIT 1`,
      [spaceId, current.documentId, current.sequence])).rowCount;
      if (earlier) return null;
      const { document } = await this.authorize(current.requesterId, spaceId, current.documentId, current.bindingId, client);
      const content = await this.spaces.content(spaceId, current.documentId, client);
      const frozen = row.frozen_input_hash && (await client.query(
        "SELECT messages_json FROM runtime_run_inputs WHERE space_id=$1 AND run_id=$2", [spaceId, runId])).rows[0];
      if ((frozen ? hash(JSON.stringify(frozen.messages_json)) !== row.frozen_input_hash
        : content.revision !== current.inputRevision) || document.aclRevision !== current.aclRevision) {
        await client.query("UPDATE space_run_queue SET status='failed',updated_at=$3 WHERE space_id=$1 AND run_id=$2", [spaceId, runId, this.now()]);
        return { ...current, status: "failed", reason: "document_changed_while_queued" };
      }
      await client.query(`UPDATE space_run_queue SET status='running',owner_instance=$3,updated_at=$4
        WHERE space_id=$1 AND run_id=$2`, [spaceId, runId, this.instanceId, this.now()]);
      return { ...current, status: "running", ownerInstance: this.instanceId };
    });
  }

  async waitForTurn(spaceId, runId, signal) {
    try {
      while (true) {
        signal?.throwIfAborted();
        const result = await this.claim(spaceId, runId);
        if (result?.status === "failed") throw accountError(409, result.reason, "排队期间文档已变化，请检查最新内容后重试");
        if (result) return result;
        await delay(100, undefined, { signal });
      }
    } catch (error) {
      await this.finish(spaceId, runId, signal?.aborted ? "cancelled" : "failed", { onlyQueued: true });
      throw error;
    }
  }

  async finish(spaceId, runId, status, { onlyQueued = false } = {}) {
    if (!["completed", "cancelled", "failed", "outcome_unknown"].includes(status)) throw accountError(400, "invalid_queue_status");
    return this.spaces.transaction(spaceId, async (client) => {
      const r = queue((await client.query("SELECT * FROM space_run_queue WHERE space_id=$1 AND run_id=$2", [spaceId, runId])).rows[0]);
      if (!r || onlyQueued && r.status !== "queued") return r;
      if (!["queued", "running", "cancelling", "outcome_unknown"].includes(r.status)) return r;
      if (r.ownerInstance && r.ownerInstance !== this.instanceId) throw accountError(409, "queue_owned_by_another_runtime");
      const pending = (await client.query(`SELECT 1 FROM space_usage_reservations
        WHERE space_id=$1 AND run_id=$2 AND state IN ('dispatched','pending')`, [spaceId, runId])).rowCount;
      const next = pending ? "outcome_unknown" : status;
      await client.query("UPDATE space_run_queue SET status=$3,updated_at=$4 WHERE space_id=$1 AND run_id=$2",
        [spaceId, runId, next, this.now()]);
      return { ...r, status: next };
    });
  }

  async cancel(userId, spaceId, runId) {
    return this.spaces.transaction(spaceId, async (client) => {
      const q = queue((await client.query("SELECT * FROM space_run_queue WHERE space_id=$1 AND run_id=$2", [spaceId, runId])).rows[0]);
      if (!q) throw accountError(404, "run_not_found");
      await this.spaces.requireDocument(userId, spaceId, q.documentId, q.requesterId === userId ? "edit" : "manage", client);
      const status = q.status === "queued" ? "cancelled" : q.status === "running" ? "cancelling" : q.status;
      await client.query("UPDATE space_run_queue SET status=$3,updated_at=$4 WHERE space_id=$1 AND run_id=$2", [spaceId, runId, status, this.now()]);
      return { ...q, status };
    });
  }

  async listQueue(userId, spaceId, documentId) {
    await this.spaces.requireDocument(userId, spaceId, documentId);
    return (await this.pool.query(`SELECT * FROM space_run_queue WHERE space_id=$1 AND document_id=$2
      ORDER BY sequence DESC LIMIT 100`, [spaceId, documentId])).rows.map(queue);
  }

  /** Called after the existing RunStore marks lost owners interrupted. A
   * restart never repeats an external call. Only undispatched reservations or
   * durable Runtime tool receipts can release/settle the old writer. */
  async recover(spaceId, { onlyUnknown = false } = {}) {
    const rows = await this.spaces.transaction(spaceId, async (client) => {
      const result = await client.query(`SELECT q.*,r.status AS run_status FROM space_run_queue q
        JOIN runtime_runs r ON r.space_id=q.space_id AND r.id=q.run_id
        WHERE q.space_id=$1 AND q.status IN ('queued','running','cancelling','outcome_unknown')
          AND ($2=FALSE OR q.status='outcome_unknown')
          AND r.status IN ('interrupted','completed','aborted','failed','waiting')`, [spaceId, onlyUnknown]);
      for (const r of result.rows) await client.query(
        "UPDATE space_run_queue SET owner_instance=$3,updated_at=$4 WHERE space_id=$1 AND run_id=$2",
        [spaceId, r.run_id, this.instanceId, this.now()]);
      return result.rows;
    });
    const recovered = [];
    for (const row of rows) {
      const reservations = (await this.pool.query(`SELECT * FROM space_usage_reservations
        WHERE space_id=$1 AND run_id=$2 AND state IN ('reserved','dispatched','pending')`,
      [spaceId, row.run_id])).rows.map(reservation);
      for (const r of reservations) {
        if (r.state === "reserved") await this.releaseUndispatched(spaceId, r.id);
        else if (r.stepId.startsWith("tool:")) {
          const invocationId = r.stepId.slice(5);
          const receipt = (await this.pool.query(`SELECT result_json FROM runtime_tool_invocation_receipts
            WHERE space_id=$1 AND run_id=$2 AND invocation_id=$3`, [spaceId, r.runId, invocationId])).rows[0];
          if (receipt && receipt.result_json?.failureCode !== "execution_outcome_unknown") {
            await this.settle(spaceId, r.id, { id: `tool:${invocationId}`, calls: 1, verified: true });
          } else await this.pending(spaceId, r.id);
        } else await this.pending(spaceId, r.id);
      }
      const status = row.run_status === "completed" || row.run_status === "waiting" ? "completed"
        : row.run_status === "aborted" ? "cancelled" : "failed";
      const pendingProjection = (await this.pool.query(`SELECT 1 FROM runtime_run_completion_tasks
        WHERE space_id=$1 AND run_id=$2 AND status<>'completed'
          AND NOT completed_steps ? 'runtime.document'`, [spaceId, row.run_id])).rowCount;
      const current = await this.finish(spaceId, row.run_id, pendingProjection ? "outcome_unknown" : status);
      recovered.push(current);
    }
    return recovered;
  }

  async reconcile(userId, spaceId) {
    await this.spaces.member(userId, spaceId, this.pool, true);
    return { queue: await this.recover(spaceId, { onlyUnknown: true }), ...(await this.usage(userId, spaceId)) };
  }
}
