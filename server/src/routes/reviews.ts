import type { FastifyPluginAsync } from 'fastify';
import { pool, many, one, ApiError } from '../db.js';

// 可在事务（client）或直连（pool）上执行的最小查询接口
interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface GateResult {
  required_rounds: number;
  completed_rounds: number;
  rounds_ok: boolean;
  open_alerts: number;
  alerts_ok: boolean;
  overall_avg: number | null;
  pass_score: number;
  score_ok: boolean;
  gate_passed: boolean;
  reasons: string[];
}

// ---------------------------------------------------------------------
// 羯磨门槛：规定评议次数全部汇总、无未处理缺勤提醒、总平均分达标
// ---------------------------------------------------------------------
export async function computeGate(db: Queryable, inspectionId: string): Promise<GateResult> {
  const { rows: insp } = await db.query(
    `SELECT i.required_rounds, i.pass_score, i.monk_id
     FROM inspections i WHERE i.id = $1`,
    [inspectionId],
  );
  if (insp.length === 0) throw new ApiError(404, '考察记录不存在');
  const { required_rounds, pass_score, monk_id } = insp[0] as {
    required_rounds: number; pass_score: string; monk_id: string;
  };

  const { rows: rc } = await db.query(
    `SELECT count(*)::int AS n FROM review_rounds
     WHERE inspection_id = $1 AND status = 'summarized'`,
    [inspectionId],
  );
  const completedRounds = rc[0].n as number;

  const { rows: av } = await db.query(
    `SELECT round(avg(s.score), 2)::float AS avg
     FROM review_scores s
     JOIN review_rounds r ON r.id = s.round_id
     WHERE r.inspection_id = $1 AND r.status = 'summarized'`,
    [inspectionId],
  );
  const overallAvg = (av[0].avg ?? null) as number | null;

  const { rows: al } = await db.query(
    `SELECT count(*)::int AS n FROM absence_alerts
     WHERE monk_id = $1 AND status = 'open'`,
    [monk_id],
  );
  const openAlerts = al[0].n as number;

  const roundsOk = completedRounds >= required_rounds;
  const alertsOk = openAlerts === 0;
  const scoreOk = overallAvg !== null && overallAvg >= Number(pass_score);

  const reasons: string[] = [];
  if (!roundsOk) reasons.push(`评议次数不足：已汇总 ${completedRounds}/${required_rounds} 轮`);
  if (!alertsOk) reasons.push(`尚有 ${openAlerts} 条未处理缺勤提醒`);
  if (!scoreOk) {
    reasons.push(overallAvg === null
      ? '尚无已汇总的评议成绩'
      : `总平均分 ${overallAvg} 未达 ${Number(pass_score)} 分达标线`);
  }

  return {
    required_rounds,
    completed_rounds: completedRounds,
    rounds_ok: roundsOk,
    open_alerts: openAlerts,
    alerts_ok: alertsOk,
    overall_avg: overallAvg,
    pass_score: Number(pass_score),
    score_ok: scoreOk,
    gate_passed: roundsOk && alertsOk && scoreOk,
    reasons,
  };
}

// ---------------------------------------------------------------------
// 决策快照：冻结考察记录、门槛结果、各轮评分（含修订留痕）与考勤统计
// ---------------------------------------------------------------------
export async function buildSnapshot(db: Queryable, inspectionId: string) {
  const { rows: insp } = await db.query(
    `SELECT i.*, m.dharma_name, m.ordination_no, m.home_monastery
     FROM inspections i JOIN monks m ON m.id = i.monk_id WHERE i.id = $1`,
    [inspectionId],
  );
  if (insp.length === 0) throw new ApiError(404, '考察记录不存在');
  const inspection = insp[0];

  const gate = await computeGate(db, inspectionId);

  const { rows: rounds } = await db.query(
    `SELECT * FROM review_rounds WHERE inspection_id = $1 ORDER BY round_no`,
    [inspectionId],
  );
  const roundsWithScores = [];
  for (const round of rounds) {
    const { rows: scores } = await db.query(
      `SELECT * FROM review_scores WHERE round_id = $1 ORDER BY created_at`,
      [round.id as string],
    );
    const scoresWithRevisions = [];
    for (const score of scores) {
      const { rows: revisions } = await db.query(
        `SELECT * FROM review_comment_revisions WHERE score_id = $1 ORDER BY revised_at`,
        [score.id as string],
      );
      scoresWithRevisions.push({ ...score, revisions });
    }
    roundsWithScores.push({ ...round, scores: scoresWithRevisions });
  }

  const { rows: att } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'present')::int AS present,
            count(*) FILTER (WHERE status = 'absent')::int  AS absent,
            count(*) FILTER (WHERE status = 'leave')::int   AS leave
     FROM attendance
     WHERE monk_id = $1 AND attend_date BETWEEN $2 AND $3`,
    [inspection.monk_id as string, inspection.start_date as string, inspection.expected_end as string],
  );

  return { inspection, gate, rounds: roundsWithScores, attendance: att[0] };
}

// 补评 / 修订后重算已汇总轮次的汇总值
async function refreshRoundSummary(db: Queryable, roundId: string): Promise<void> {
  await db.query(
    `UPDATE review_rounds r
        SET reviewer_count = s.n, avg_score = s.avg
     FROM (
       SELECT round_id, count(*)::int AS n, round(avg(score), 2) AS avg
       FROM review_scores WHERE round_id = $1 GROUP BY round_id
     ) s
     WHERE r.id = $1 AND r.status = 'summarized'`,
    [roundId],
  );
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 默认评议月止：起日 + 1 个月 - 1 天
function defaultPeriodEnd(start: string): string {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const routes: FastifyPluginAsync = async (app) => {
  // 评议总览：轮次 + 各执事评分（含修订数）+ 羯磨门槛
  app.get<{ Params: { id: string } }>('/inspections/:id', async (req) => {
    const inspection = await one(`
      SELECT i.*, m.dharma_name, m.ordination_no
      FROM inspections i JOIN monks m ON m.id = i.monk_id
      WHERE i.id = $1
    `, [req.params.id]);
    if (!inspection) throw new ApiError(404, '考察记录不存在');

    const rounds = await many(`
      SELECT r.*,
             (SELECT count(*)::int FROM review_scores s WHERE s.round_id = r.id) AS score_count
      FROM review_rounds r
      WHERE r.inspection_id = $1
      ORDER BY r.round_no
    `, [req.params.id]);

    const roundsWithScores = [];
    for (const round of rounds) {
      const scores = await many(`
        SELECT s.*,
               (SELECT count(*)::int FROM review_comment_revisions v WHERE v.score_id = s.id) AS revision_count
        FROM review_scores s
        WHERE s.round_id = $1
        ORDER BY s.is_makeup, s.created_at
      `, [round.id as string]);
      roundsWithScores.push({ ...round, scores });
    }

    const gate = await computeGate(pool, req.params.id);
    return { inspection, rounds: roundsWithScores, gate };
  });

  // 发起新一轮月度评议（同时只允许一轮评议中）
  app.post<{ Params: { id: string } }>('/inspections/:id/rounds', async (req, reply) => {
    const { period_start, period_end } = req.body as {
      period_start?: string; period_end?: string;
    };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: insp } = await client.query(
        "SELECT * FROM inspections WHERE id=$1 AND result='pending'",
        [req.params.id],
      );
      if (insp.length === 0) throw new ApiError(404, '进行中的考察不存在');

      const { rows: openRounds } = await client.query(
        "SELECT 1 FROM review_rounds WHERE inspection_id=$1 AND status='open'",
        [req.params.id],
      );
      if (openRounds.length) throw new ApiError(409, '已有评议中的轮次，请先完成阶段汇总');

      const { rows: last } = await client.query(
        'SELECT * FROM review_rounds WHERE inspection_id=$1 ORDER BY round_no DESC LIMIT 1',
        [req.params.id],
      );
      const roundNo = last.length ? (last[0].round_no as number) + 1 : 1;
      // 默认评议月：首轮自考察开始日起，其后接续上一轮
      const start = period_start
        ?? (last.length ? addDays(last[0].period_end as string, 1) : (insp[0].start_date as string));
      const end = period_end ?? defaultPeriodEnd(start);
      if (end < start) throw new ApiError(400, '评议月止日不能早于起日');

      const { rows } = await client.query(
        `INSERT INTO review_rounds (inspection_id, round_no, period_start, period_end)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.params.id, roundNo, start, end],
      );
      await client.query('COMMIT');
      return reply.code(201).send(rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 执事评分；轮次已汇总后提交自动记为缺席补评并重算汇总
  app.post<{ Params: { id: string } }>('/rounds/:id/scores', async (req, reply) => {
    const { reviewer_name, reviewer_post, score, comment } = req.body as {
      reviewer_name?: string; reviewer_post?: string | null;
      score?: number; comment?: string | null;
    };
    if (!reviewer_name?.trim()) throw new ApiError(400, '请填写评分执事');
    if (score === undefined || score === null || !Number.isInteger(score) || score < 0 || score > 100) {
      throw new ApiError(400, '评分须为 0-100 的整数');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: rounds } = await client.query(
        `SELECT r.*, i.result AS inspection_result
         FROM review_rounds r JOIN inspections i ON i.id = r.inspection_id
         WHERE r.id = $1`,
        [req.params.id],
      );
      if (rounds.length === 0) throw new ApiError(404, '评议轮次不存在');
      if (rounds[0].inspection_result !== 'pending') throw new ApiError(409, '考察已结束，无法再评分');
      const isMakeup = rounds[0].status === 'summarized';

      const { rows: dup } = await client.query(
        'SELECT 1 FROM review_scores WHERE round_id=$1 AND reviewer_name=$2',
        [req.params.id, reviewer_name.trim()],
      );
      if (dup.length) throw new ApiError(409, '该执事本轮已评分，如需调整请使用修订');

      const { rows } = await client.query(
        `INSERT INTO review_scores (round_id, reviewer_name, reviewer_post, score, comment, is_makeup)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.params.id, reviewer_name.trim(), reviewer_post ?? null, score, comment ?? null, isMakeup],
      );
      if (isMakeup) await refreshRoundSummary(client, req.params.id);
      await client.query('COMMIT');
      return reply.code(201).send(rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 修订评分 / 评语（留痕）；已汇总轮次修订后重算汇总
  app.put<{ Params: { id: string } }>('/scores/:id', async (req) => {
    const { score, comment, revised_by } = req.body as {
      score?: number; comment?: string | null; revised_by?: string | null;
    };
    if (score === undefined && comment === undefined) {
      throw new ApiError(400, '没有需要修订的内容');
    }
    if (score !== undefined && (!Number.isInteger(score) || score < 0 || score > 100)) {
      throw new ApiError(400, '评分须为 0-100 的整数');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: cur } = await client.query(
        `SELECT s.*, r.status AS round_status, i.result AS inspection_result
         FROM review_scores s
         JOIN review_rounds r ON r.id = s.round_id
         JOIN inspections i ON i.id = r.inspection_id
         WHERE s.id = $1`,
        [req.params.id],
      );
      if (cur.length === 0) throw new ApiError(404, '评分记录不存在');
      if (cur[0].inspection_result !== 'pending') throw new ApiError(409, '考察已结束，无法再修订');
      const old = cur[0];

      const newScore = score ?? (old.score as number);
      const newComment = comment === undefined ? (old.comment as string | null) : comment;
      if (newScore === old.score && newComment === old.comment) {
        throw new ApiError(400, '评分与评语均未变化');
      }

      await client.query(
        `INSERT INTO review_comment_revisions (score_id, old_score, new_score, old_comment, new_comment, revised_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.params.id, old.score, newScore, old.comment, newComment, revised_by ?? null],
      );
      const { rows } = await client.query(
        'UPDATE review_scores SET score=$2, comment=$3 WHERE id=$1 RETURNING *',
        [req.params.id, newScore, newComment],
      );
      if (old.round_status === 'summarized') await refreshRoundSummary(client, old.round_id as string);
      await client.query('COMMIT');
      return rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 某条评分的修订历史
  app.get<{ Params: { id: string } }>('/scores/:id/revisions', async (req) => {
    const { rows } = await pool.query(
      'SELECT 1 FROM review_scores WHERE id=$1',
      [req.params.id],
    );
    if (rows.length === 0) throw new ApiError(404, '评分记录不存在');
    return many(
      'SELECT * FROM review_comment_revisions WHERE score_id=$1 ORDER BY revised_at DESC',
      [req.params.id],
    );
  });

  // 阶段汇总：冻结本轮评分人数、平均分与评议月内缺勤次数
  app.post<{ Params: { id: string } }>('/rounds/:id/summarize', async (req) => {
    const { summary_note, summarized_by } = req.body as {
      summary_note?: string | null; summarized_by?: string | null;
    };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: rounds } = await client.query(
        `SELECT r.*, i.monk_id, i.result AS inspection_result
         FROM review_rounds r JOIN inspections i ON i.id = r.inspection_id
         WHERE r.id = $1`,
        [req.params.id],
      );
      if (rounds.length === 0) throw new ApiError(404, '评议轮次不存在');
      if (rounds[0].inspection_result !== 'pending') throw new ApiError(409, '考察已结束');
      if (rounds[0].status !== 'open') throw new ApiError(409, '该轮已汇总');
      const round = rounds[0];

      const { rows: stats } = await client.query(
        'SELECT count(*)::int AS n, round(avg(score), 2) AS avg FROM review_scores WHERE round_id=$1',
        [req.params.id],
      );
      if ((stats[0].n as number) === 0) throw new ApiError(400, '尚无执事评分，不能汇总');

      const { rows: abs } = await client.query(
        `SELECT count(*)::int AS n FROM attendance
         WHERE monk_id=$1 AND status='absent' AND attend_date BETWEEN $2 AND $3`,
        [round.monk_id, round.period_start, round.period_end],
      );

      const { rows } = await client.query(
        `UPDATE review_rounds
            SET status='summarized', reviewer_count=$2, avg_score=$3, absent_count=$4,
                summary_note=$5, summarized_by=$6, summarized_at=now()
          WHERE id=$1 RETURNING *`,
        [req.params.id, stats[0].n, stats[0].avg, abs[0].n,
         summary_note ?? null, summarized_by ?? null],
      );
      await client.query('COMMIT');
      return rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 羯磨门槛检查
  app.get<{ Params: { id: string } }>('/inspections/:id/gate', async (req) =>
    computeGate(pool, req.params.id),
  );

  // 决策快照列表（羯磨通过 / 不通过时留存）
  app.get<{ Params: { id: string } }>('/inspections/:id/decisions', async (req) => {
    const { rows } = await pool.query('SELECT 1 FROM inspections WHERE id=$1', [req.params.id]);
    if (rows.length === 0) throw new ApiError(404, '考察记录不存在');
    return many(
      'SELECT * FROM inspection_decisions WHERE inspection_id=$1 ORDER BY created_at DESC',
      [req.params.id],
    );
  });
};

export default routes;
