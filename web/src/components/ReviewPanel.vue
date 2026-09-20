<template>
  <n-spin :show="loading">
    <template v-if="overview">
      <!-- 羯磨门槛 -->
      <n-alert
        :type="overview.gate.gate_passed ? 'success' : 'warning'"
        :bordered="false"
        style="margin-bottom: 12px"
      >
        <template #icon>
          <n-icon :component="overview.gate.gate_passed ? CheckmarkCircleOutline : AlertCircleOutline" />
        </template>
        {{ overview.gate.gate_passed ? '已具足羯磨条件，可发起羯磨转常住' : '尚未具足羯磨条件' }}
        <template v-if="!overview.gate.gate_passed">
          <div v-for="r in overview.gate.reasons" :key="r" style="margin-top: 4px">· {{ r }}</div>
        </template>
      </n-alert>

      <n-grid :cols="3" :x-gap="12" style="margin-bottom: 16px">
        <n-grid-item>
          <n-card size="small" embedded>
            <n-statistic label="评议次数（已汇总 / 规定）">
              <template #default>
                <n-text :type="overview.gate.rounds_ok ? 'success' : 'warning'">
                  {{ overview.gate.completed_rounds }} / {{ overview.gate.required_rounds }}
                </n-text>
              </template>
            </n-statistic>
          </n-card>
        </n-grid-item>
        <n-grid-item>
          <n-card size="small" embedded>
            <n-statistic label="总平均分（达标线）">
              <template #default>
                <n-text :type="overview.gate.score_ok ? 'success' : 'warning'">
                  {{ overview.gate.overall_avg ?? '—' }}
                </n-text>
                <n-text depth="3" style="font-size: 13px"> / {{ overview.gate.pass_score }}</n-text>
              </template>
            </n-statistic>
          </n-card>
        </n-grid-item>
        <n-grid-item>
          <n-card size="small" embedded>
            <n-statistic label="未处理缺勤提醒">
              <template #default>
                <n-text :type="overview.gate.alerts_ok ? 'success' : 'error'">
                  {{ overview.gate.open_alerts }}
                </n-text>
                <n-text depth="3" style="font-size: 13px"> 条</n-text>
              </template>
            </n-statistic>
          </n-card>
        </n-grid-item>
      </n-grid>

      <!-- 评议轮次 -->
      <n-space align="center" justify="space-between" style="margin-bottom: 8px">
        <n-text strong>按月评议（{{ overview.rounds.length }} 轮）</n-text>
        <n-button
          v-if="isPending && !hasOpenRound"
          size="small"
          type="primary"
          secondary
          :loading="acting"
          @click="openNextRound"
        >
          <template #icon><n-icon :component="AddOutline" /></template>
          发起第 {{ overview.rounds.length + 1 }} 轮评议
        </n-button>
      </n-space>

      <n-empty v-if="!overview.rounds.length" description="尚未发起评议" style="padding: 24px 0" />

      <n-collapse v-else :expanded-names="expandedNames" @update:expanded-names="(v: string[]) => expandedNames = v">
        <n-collapse-item v-for="round in overview.rounds" :key="round.id" :name="round.id">
          <template #header>
            <n-space align="center" :size="8">
              <n-text strong>第 {{ round.round_no }} 轮</n-text>
              <n-text depth="3" style="font-size: 12px">{{ round.period_start }} ~ {{ round.period_end }}</n-text>
              <n-tag size="small" :type="round.status === 'open' ? 'warning' : 'success'" :bordered="false">
                {{ round.status === 'open' ? '评议中' : '已汇总' }}
              </n-tag>
            </n-space>
          </template>
          <template #header-extra>
            <n-text v-if="round.status === 'summarized'" depth="3" style="font-size: 12px">
              {{ round.reviewer_count }} 位执事 · 平均 {{ round.avg_score }} 分 · 缺勤 {{ round.absent_count }} 次
            </n-text>
            <n-text v-else depth="3" style="font-size: 12px">已评 {{ round.scores?.length ?? 0 }} 位执事</n-text>
          </template>

          <!-- 阶段汇总 -->
          <n-alert v-if="round.status === 'summarized'" type="default" :bordered="false" style="margin-bottom: 10px">
            <template #header>阶段汇总</template>
            <div v-if="round.summary_note">{{ round.summary_note }}</div>
            <n-text depth="3" style="font-size: 12px">
              {{ round.summarized_by ?? '客堂' }} 汇总于 {{ fmtTime(round.summarized_at) }}
            </n-text>
          </n-alert>

          <!-- 执事评分表 -->
          <n-table size="small" :bordered="false" :single-line="false">
            <thead>
              <tr>
                <th>执事</th>
                <th style="width: 72px">评分</th>
                <th>评语</th>
                <th v-if="isPending" style="width: 130px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in round.scores" :key="s.id">
                <td>
                  <n-space align="center" :size="6">
                    {{ s.reviewer_name }}
                    <n-tag v-if="s.reviewer_post" size="tiny" :bordered="false">{{ s.reviewer_post }}</n-tag>
                    <n-tag v-if="s.is_makeup" size="tiny" type="warning" :bordered="false">补评</n-tag>
                  </n-space>
                </td>
                <td>
                  <n-text :type="s.score >= (overview?.gate.pass_score ?? 60) ? 'success' : 'error'" strong>
                    {{ s.score }}
                  </n-text>
                </td>
                <td>
                  <n-text depth="2" style="font-size: 13px">{{ s.comment ?? '—' }}</n-text>
                  <n-button
                    v-if="s.revision_count"
                    text
                    size="tiny"
                    type="primary"
                    style="margin-left: 6px"
                    @click="showRevisions(s)"
                  >
                    修订 {{ s.revision_count }} 次
                  </n-button>
                </td>
                <td v-if="isPending">
                  <n-space :size="4">
                    <n-button size="tiny" quaternary type="primary" @click="openRevise(round, s)">修订</n-button>
                    <n-button size="tiny" quaternary @click="showRevisions(s)">历史</n-button>
                  </n-space>
                </td>
              </tr>
              <tr v-if="!round.scores?.length">
                <td :colspan="isPending ? 4 : 3" style="text-align: center; color: #9b8f80">尚无执事评分</td>
              </tr>
            </tbody>
          </n-table>

          <n-space v-if="isPending" style="margin-top: 10px">
            <n-button size="small" secondary @click="openScore(round)">
              <template #icon><n-icon :component="CreateOutline" /></template>
              {{ round.status === 'open' ? '执事评分' : '缺席补评' }}
            </n-button>
            <n-popconfirm v-if="round.status === 'open'" @positive-click="summarize(round)">
              <template #trigger>
                <n-button size="small" type="primary" secondary :loading="acting">阶段汇总</n-button>
              </template>
              汇总后本轮评分冻结，未评执事只能补评。确认汇总第 {{ round.round_no }} 轮？
            </n-popconfirm>
          </n-space>
        </n-collapse-item>
      </n-collapse>
    </template>
  </n-spin>

  <!-- 执事评分 / 缺席补评 -->
  <n-modal v-model:show="scoreModal.show" preset="card" style="width: 440px"
           :title="scoreModal.isMakeup ? '缺席补评' : '执事评分'">
    <n-alert v-if="scoreModal.isMakeup" type="warning" :bordered="false" style="margin-bottom: 12px">
      第 {{ scoreModal.roundNo }} 轮已汇总，本次提交将记为缺席补评并计入汇总。
    </n-alert>
    <n-form label-placement="left" label-width="80px">
      <n-form-item label="评分执事" required>
        <n-select
          v-model:value="scoreModal.reviewer_name"
          :options="reviewerOptions"
          filterable
          tag
          placeholder="选择或输入执事法名"
          @update:value="onReviewerPick"
        />
      </n-form-item>
      <n-form-item label="职务">
        <n-input v-model:value="scoreModal.reviewer_post" placeholder="知客 / 维那 / 典座等" />
      </n-form-item>
      <n-form-item label="评分" required>
        <n-input-number v-model:value="scoreModal.score" :min="0" :max="100" style="width: 100%">
          <template #suffix>分</template>
        </n-input-number>
      </n-form-item>
      <n-form-item label="评语">
        <n-input v-model:value="scoreModal.comment" type="textarea" :autosize="{ minRows: 2 }" />
      </n-form-item>
    </n-form>
    <template #footer>
      <n-space justify="end">
        <n-button @click="scoreModal.show = false">取消</n-button>
        <n-button type="primary" :loading="acting" @click="submitScore">提交</n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 修订评分 / 评语 -->
  <n-modal v-model:show="reviseModal.show" preset="card" title="修订评分与评语" style="width: 440px">
    <n-form label-placement="left" label-width="80px">
      <n-form-item label="评分执事">
        <n-text strong>{{ reviseModal.reviewer_name }}</n-text>
      </n-form-item>
      <n-form-item label="评分" required>
        <n-input-number v-model:value="reviseModal.score" :min="0" :max="100" style="width: 100%">
          <template #suffix>分</template>
        </n-input-number>
      </n-form-item>
      <n-form-item label="评语">
        <n-input v-model:value="reviseModal.comment" type="textarea" :autosize="{ minRows: 2 }" />
      </n-form-item>
      <n-form-item label="修订人">
        <n-input v-model:value="reviseModal.revised_by" placeholder="留痕用，默认同评分执事" />
      </n-form-item>
    </n-form>
    <n-alert type="info" :bordered="false">修订将保留原评分与评语记录，可在「历史」中查看。</n-alert>
    <template #footer>
      <n-space justify="end">
        <n-button @click="reviseModal.show = false">取消</n-button>
        <n-button type="primary" :loading="acting" @click="submitRevise">确认修订</n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 修订历史 -->
  <n-modal v-model:show="revisionModal.show" preset="card" title="评语修订历史" style="width: 520px">
    <n-empty v-if="!revisionModal.items.length" description="暂无修订记录" />
    <n-timeline v-else>
      <n-timeline-item
        v-for="rev in revisionModal.items"
        :key="rev.id"
        :title="`${rev.revised_by ?? revisionModal.reviewer} 修订于 ${fmtTime(rev.revised_at)}`"
      >
        <div v-if="rev.old_score !== rev.new_score" style="margin-bottom: 4px">
          评分：<n-text delete depth="3">{{ rev.old_score }}</n-text>
          → <n-text strong type="primary">{{ rev.new_score }}</n-text>
        </div>
        <div v-if="rev.old_comment !== rev.new_comment">
          <div><n-text depth="3" delete>{{ rev.old_comment ?? '（无评语）' }}</n-text></div>
          <div><n-text>{{ rev.new_comment ?? '（无评语）' }}</n-text></div>
        </div>
      </n-timeline-item>
    </n-timeline>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NSpin, NAlert, NIcon, NGrid, NGridItem, NCard, NStatistic, NText, NSpace, NButton,
  NTag, NEmpty, NCollapse, NCollapseItem, NTable, NPopconfirm, NModal, NForm, NFormItem,
  NSelect, NInput, NInputNumber, NTimeline, NTimelineItem, useMessage,
} from 'naive-ui';
import type { SelectOption } from 'naive-ui';
import { AddOutline, CreateOutline, CheckmarkCircleOutline, AlertCircleOutline } from '@vicons/ionicons5';
import { http } from '../api.js';
import type {
  Inspection, Monk, ReviewOverview, ReviewRevision, ReviewRound, ReviewScore,
} from '../types.js';

const props = defineProps<{ inspection: Inspection }>();
const emit = defineEmits<{ (e: 'changed'): void }>();

const message = useMessage();
const loading = ref(false);
const acting = ref(false);
const overview = ref<ReviewOverview | null>(null);
const reviewers = ref<Monk[]>([]);

const isPending = computed(() => props.inspection.result === 'pending');
const hasOpenRound = computed(() => overview.value?.rounds.some((r) => r.status === 'open') ?? false);
const expandedNames = ref<string[]>([]);

function expandCurrentRound() {
  // 首次加载时展开评议中的轮次（否则展开最近一轮）
  if (expandedNames.value.length > 0) return;
  const rounds = overview.value?.rounds ?? [];
  const open = rounds.find((r) => r.status === 'open');
  const target = open?.id ?? rounds[rounds.length - 1]?.id;
  if (target) expandedNames.value = [target];
}

const reviewerOptions = computed<SelectOption[]>(() =>
  reviewers.value.map((m) => ({
    label: m.current_post ? `${m.dharma_name}（${m.current_post}）` : m.dharma_name,
    value: m.dharma_name,
  })),
);

function fmtTime(t: string | null) {
  return t ? t.replace('T', ' ').slice(0, 16) : '';
}

async function load() {
  loading.value = true;
  try {
    const { data } = await http.get<ReviewOverview>(`/reviews/inspections/${props.inspection.id}`);
    overview.value = data;
    expandCurrentRound();
  } finally {
    loading.value = false;
  }
}

async function loadReviewers() {
  const { data } = await http.get<Monk[]>('/monks', { params: { status: 'permanent' } });
  reviewers.value = data;
}

onMounted(() => {
  load();
  loadReviewers();
});

// ---- 发起新一轮 ----
async function openNextRound() {
  acting.value = true;
  try {
    await http.post(`/reviews/inspections/${props.inspection.id}/rounds`, {});
    message.success('已发起新一轮评议');
    await load();
    emit('changed');
  } finally {
    acting.value = false;
  }
}

// ---- 评分 / 补评 ----
const scoreModal = ref({
  show: false,
  roundId: '',
  roundNo: 0,
  isMakeup: false,
  reviewer_name: null as string | null,
  reviewer_post: '',
  score: 80,
  comment: '',
});

function openScore(round: ReviewRound) {
  scoreModal.value = {
    show: true,
    roundId: round.id,
    roundNo: round.round_no,
    isMakeup: round.status === 'summarized',
    reviewer_name: null,
    reviewer_post: '',
    score: 80,
    comment: '',
  };
}

function onReviewerPick(name: string) {
  const monk = reviewers.value.find((m) => m.dharma_name === name);
  if (monk?.current_post) scoreModal.value.reviewer_post = monk.current_post;
}

async function submitScore() {
  const m = scoreModal.value;
  if (!m.reviewer_name) {
    message.warning('请填写评分执事');
    return;
  }
  acting.value = true;
  try {
    await http.post(`/reviews/rounds/${m.roundId}/scores`, {
      reviewer_name: m.reviewer_name,
      reviewer_post: m.reviewer_post || null,
      score: m.score,
      comment: m.comment || null,
    });
    message.success(m.isMakeup ? '缺席补评已记录' : '评分已提交');
    m.show = false;
    await load();
    emit('changed');
  } finally {
    acting.value = false;
  }
}

// ---- 修订 ----
const reviseModal = ref({
  show: false,
  scoreId: '',
  reviewer_name: '',
  score: 0,
  comment: '',
  revised_by: '',
});

function openRevise(_round: ReviewRound, s: ReviewScore) {
  reviseModal.value = {
    show: true,
    scoreId: s.id,
    reviewer_name: s.reviewer_name,
    score: s.score,
    comment: s.comment ?? '',
    revised_by: s.reviewer_name,
  };
}

async function submitRevise() {
  const m = reviseModal.value;
  acting.value = true;
  try {
    await http.put(`/reviews/scores/${m.scoreId}`, {
      score: m.score,
      comment: m.comment || null,
      revised_by: m.revised_by || null,
    });
    message.success('已修订并留痕');
    m.show = false;
    await load();
    emit('changed');
  } finally {
    acting.value = false;
  }
}

// ---- 修订历史 ----
const revisionModal = ref({
  show: false,
  reviewer: '',
  items: [] as ReviewRevision[],
});

async function showRevisions(s: ReviewScore) {
  const { data } = await http.get<ReviewRevision[]>(`/reviews/scores/${s.id}/revisions`);
  revisionModal.value = { show: true, reviewer: s.reviewer_name, items: data };
}

// ---- 阶段汇总 ----
async function summarize(round: ReviewRound) {
  acting.value = true;
  try {
    await http.post(`/reviews/rounds/${round.id}/summarize`, { summarized_by: '知客' });
    message.success(`第 ${round.round_no} 轮已汇总`);
    await load();
    emit('changed');
  } finally {
    acting.value = false;
  }
}
</script>
