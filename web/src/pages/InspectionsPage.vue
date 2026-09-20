<template>
  <n-card size="small">
    <n-space align="center" justify="space-between">
      <n-space align="center">
        <n-radio-group v-model:value="resultFilter" size="medium" @update:value="load">
          <n-radio-button value="pending">考察中</n-radio-button>
          <n-radio-button value="passed">已转常住</n-radio-button>
          <n-radio-button value="failed">未通过</n-radio-button>
          <n-radio-button value="">全部</n-radio-button>
        </n-radio-group>
      </n-space>
      <n-button type="primary" @click="openStart">
        <template #icon><n-icon :component="HourglassOutline" /></template>
        发心常住 · 转入考察
      </n-button>
    </n-space>
  </n-card>

  <n-card size="small" style="margin-top:16px">
    <n-data-table
      :columns="columns"
      :data="rows"
      :loading="loading"
      :row-key="(r: Inspection) => r.id"
      :pagination="{ pageSize: 10 }"
      striped
    />
  </n-card>

  <!-- 发起考察期 -->
  <n-modal v-model:show="showStart" preset="card" title="发心常住 · 转入考察期" style="width: 480px">
    <n-form ref="startFormRef" :model="startForm" :rules="startRules" label-placement="left" label-width="92px">
      <n-form-item label="挂单僧人" path="guadan_id">
        <n-select
          v-model:value="startForm.guadan_id"
          :options="guadanOptions"
          filterable
          placeholder="选择在寺挂单僧人"
        />
      </n-form-item>
      <n-grid :cols="2">
        <n-grid-item>
          <n-form-item label="考察开始" path="start_date">
            <n-date-picker
              v-model:formatted-value="startForm.start_date"
              value-format="yyyy-MM-dd"
              style="width: 100%"
            />
          </n-form-item>
        </n-grid-item>
        <n-grid-item>
          <n-form-item label="考察时长" path="duration_months">
            <n-input-number
              v-model:value="startForm.duration_months"
              :min="3"
              :max="6"
              style="width: 100%"
            >
              <template #suffix>个月</template>
            </n-input-number>
          </n-form-item>
        </n-grid-item>
      </n-grid>
      <n-form-item label="达标线">
        <n-input-number v-model:value="startForm.pass_score" :min="0" :max="100" style="width: 100%">
          <template #suffix>分</template>
        </n-input-number>
        <template #feedback>每月一轮评议，总平均分达到此线方可羯磨</template>
      </n-form-item>
      <n-form-item label="备注">
        <n-input v-model:value="startForm.note" type="textarea" :autosize="{ minRows: 2 }" placeholder="发心因缘、初步印象" />
      </n-form-item>
    </n-form>
    <template #footer>
      <n-space justify="end">
        <n-button @click="showStart = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="submitStart">转入考察</n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 羯磨通过（先校验门槛） -->
  <n-modal v-model:show="showPass" preset="card" title="考察通过 · 羯磨转常住" style="width: 480px">
    <n-spin :show="gateLoading">
      <n-alert v-if="gate" :type="gate.gate_passed ? 'success' : 'error'" :bordered="false" style="margin-bottom: 12px">
        <template #icon>
          <n-icon :component="gate.gate_passed ? CheckmarkCircleOutline : CloseCircleOutline" />
        </template>
        {{ gate.gate_passed ? '评议具足，可以羯磨' : '未达羯磨条件' }}
        <template v-if="!gate.gate_passed">
          <div v-for="r in gate.reasons" :key="r" style="margin-top: 4px">· {{ r }}</div>
        </template>
      </n-alert>
      <n-descriptions v-if="gate" :column="3" size="small" bordered style="margin-bottom: 12px">
        <n-descriptions-item label="评议轮次">
          {{ gate.completed_rounds }} / {{ gate.required_rounds }}
        </n-descriptions-item>
        <n-descriptions-item label="总平均分">
          {{ gate.overall_avg ?? '—' }} / {{ gate.pass_score }}
        </n-descriptions-item>
        <n-descriptions-item label="未处理提醒">
          {{ gate.open_alerts }} 条
        </n-descriptions-item>
      </n-descriptions>
      <n-form label-placement="left" label-width="92px">
        <n-form-item label="僧人">
          <n-text strong>{{ passTarget?.dharma_name }}</n-text>
        </n-form-item>
        <n-form-item label="羯磨日期">
          <n-date-picker
            v-model:formatted-value="passForm.karma_date"
            value-format="yyyy-MM-dd"
            style="width: 100%"
          />
        </n-form-item>
        <n-form-item label="担任职务">
          <n-select
            v-model:value="passForm.current_post"
            :options="postOptions"
            filterable
            tag
            placeholder="知客 / 维那 / 典座等（可留空）"
            clearable
          />
        </n-form-item>
        <n-form-item label="备注">
          <n-input v-model:value="passForm.note" type="textarea" :autosize="{ minRows: 2 }" />
        </n-form-item>
      </n-form>
    </n-spin>
    <template #footer>
      <n-space justify="end">
        <n-button @click="showPass = false">取消</n-button>
        <n-button
          type="primary"
          :loading="saving"
          :disabled="!gate?.gate_passed"
          @click="submitPass"
        >
          羯磨成就
        </n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 月度评议抽屉 -->
  <n-drawer v-model:show="showReview" :width="720" @update:show="(v: boolean) => { if (!v) reviewTarget = null; }">
    <n-drawer-content :title="`按月评议 · ${reviewTarget?.dharma_name ?? ''}`" closable>
      <ReviewPanel
        v-if="reviewTarget"
        :key="reviewTarget.id"
        :inspection="reviewTarget"
        @changed="load"
      />
    </n-drawer-content>
  </n-drawer>

  <!-- 决策快照 -->
  <n-modal v-model:show="showSnapshot" preset="card" title="羯磨决策快照" style="width: 680px">
    <n-spin :show="snapshotLoading">
      <template v-if="decision">
        <n-descriptions :column="3" size="small" bordered style="margin-bottom: 12px">
          <n-descriptions-item label="结论">
            <n-tag size="small" :type="decision.decision === 'passed' ? 'success' : 'error'" :bordered="false">
              {{ decision.decision === 'passed' ? '羯磨通过' : '考察不通过' }}
            </n-tag>
          </n-descriptions-item>
          <n-descriptions-item label="评议轮次">
            {{ decision.completed_rounds }} / {{ decision.required_rounds }}
          </n-descriptions-item>
          <n-descriptions-item label="总平均分">
            {{ decision.overall_avg ?? '—' }} / {{ decision.pass_score }}
          </n-descriptions-item>
          <n-descriptions-item label="未处理提醒">{{ decision.open_alerts }} 条</n-descriptions-item>
          <n-descriptions-item label="经办人">{{ decision.decided_by ?? '—' }}</n-descriptions-item>
          <n-descriptions-item label="决策时间">{{ fmtTime(decision.created_at) }}</n-descriptions-item>
        </n-descriptions>

        <n-collapse>
          <n-collapse-item v-for="round in decision.snapshot.rounds" :key="round.id" :name="round.id">
            <template #header>
              <n-space align="center" :size="8">
                <n-text strong>第 {{ round.round_no }} 轮</n-text>
                <n-text depth="3" style="font-size: 12px">{{ round.period_start }} ~ {{ round.period_end }}</n-text>
                <n-tag size="small" :type="round.status === 'summarized' ? 'success' : 'warning'" :bordered="false">
                  {{ round.status === 'summarized' ? '已汇总' : '评议中' }}
                </n-tag>
              </n-space>
            </template>
            <template #header-extra>
              <n-text v-if="round.status === 'summarized'" depth="3" style="font-size: 12px">
                {{ round.reviewer_count }} 位执事 · 平均 {{ round.avg_score }} 分 · 缺勤 {{ round.absent_count }} 次
              </n-text>
            </template>
            <n-table size="small" :bordered="false" :single-line="false">
              <thead>
                <tr><th>执事</th><th style="width:72px">评分</th><th>评语</th></tr>
              </thead>
              <tbody>
                <tr v-for="s in round.scores" :key="s.id">
                  <td>
                    {{ s.reviewer_name }}
                    <n-tag v-if="s.reviewer_post" size="tiny" :bordered="false">{{ s.reviewer_post }}</n-tag>
                    <n-tag v-if="s.is_makeup" size="tiny" type="warning" :bordered="false">补评</n-tag>
                  </td>
                  <td><n-text strong>{{ s.score }}</n-text></td>
                  <td>
                    <n-text depth="2" style="font-size: 13px">{{ s.comment ?? '—' }}</n-text>
                    <n-text v-if="s.revisions.length" depth="3" style="font-size: 12px">
                      （修订 {{ s.revisions.length }} 次）
                    </n-text>
                  </td>
                </tr>
              </tbody>
            </n-table>
            <n-text v-if="round.summary_note" depth="2" style="font-size: 13px">
              汇总结语：{{ round.summary_note }}
            </n-text>
          </n-collapse-item>
        </n-collapse>

        <n-text depth="3" style="display:block; margin-top: 12px; font-size: 12px">
          考察期内考勤：随众 {{ decision.snapshot.attendance.present }} ·
          缺勤 {{ decision.snapshot.attendance.absent }} · 请假 {{ decision.snapshot.attendance.leave }}
        </n-text>
      </template>
      <n-empty v-else description="未找到决策快照" />
    </n-spin>
  </n-modal>
</template>

<script setup lang="ts">
import { h, onMounted, ref } from 'vue';
import {
  NCard, NSpace, NRadioGroup, NRadioButton, NButton, NIcon, NDataTable, NModal,
  NForm, NFormItem, NSelect, NDatePicker, NInputNumber, NInput, NGrid, NGridItem,
  NTag, NPopconfirm, NText, NDrawer, NDrawerContent, NAlert, NDescriptions,
  NDescriptionsItem, NSpin, NCollapse, NCollapseItem, NTable, NEmpty, useMessage,
} from 'naive-ui';
import type { DataTableColumns, FormInst, FormRules, SelectOption } from 'naive-ui';
import { HourglassOutline, CheckmarkCircleOutline, CloseCircleOutline } from '@vicons/ionicons5';
import { http, POSTS } from '../api.js';
import ReviewPanel from '../components/ReviewPanel.vue';
import type { GateCheck, Guadan, Inspection, InspectionDecision } from '../types.js';

const message = useMessage();
const rows = ref<Inspection[]>([]);
const loading = ref(false);
const resultFilter = ref('pending');
const saving = ref(false);

const showStart = ref(false);
const showPass = ref(false);
const showReview = ref(false);
const showSnapshot = ref(false);
const startFormRef = ref<FormInst | null>(null);
const guadanOptions = ref<SelectOption[]>([]);
const passTarget = ref<Inspection | null>(null);
const reviewTarget = ref<Inspection | null>(null);
const gate = ref<GateCheck | null>(null);
const gateLoading = ref(false);
const decision = ref<InspectionDecision | null>(null);
const snapshotLoading = ref(false);

const startForm = ref({
  guadan_id: null as string | null,
  start_date: new Date().toISOString().slice(0, 10),
  duration_months: 4,
  pass_score: 60,
  note: '',
});
const startRules: FormRules = {
  guadan_id: { required: true, message: '请选择挂单僧人', trigger: 'change' },
  start_date: { required: true, message: '请选择开始日期', trigger: 'change' },
  duration_months: { required: true, type: 'number', min: 3, max: 6, message: '考察期为 3-6 个月', trigger: 'blur' },
};

const passForm = ref({ karma_date: new Date().toISOString().slice(0, 10), current_post: null as string | null, note: '' });
const postOptions: SelectOption[] = POSTS.map((p) => ({ label: p, value: p }));

function fmtTime(t: string | null) {
  return t ? t.replace('T', ' ').slice(0, 16) : '';
}

async function load() {
  loading.value = true;
  try {
    const params = resultFilter.value ? { result: resultFilter.value } : {};
    const { data } = await http.get<Inspection[]>('/inspections', { params });
    rows.value = data;
  } finally {
    loading.value = false;
  }
}

async function openStart() {
  startForm.value = {
    guadan_id: null,
    start_date: new Date().toISOString().slice(0, 10),
    duration_months: 4,
    pass_score: 60,
    note: '',
  };
  const { data } = await http.get<Guadan[]>('/guadan', { params: { status: 'active' } });
  guadanOptions.value = data
    .filter((g) => g.monk_status === 'guadan')
    .map((g) => ({
      label: `${g.dharma_name}（${g.home_monastery ?? '出家寺庙未录'} · 到寺 ${g.arrive_date}）`,
      value: g.id,
    }));
  showStart.value = true;
}

async function submitStart() {
  await startFormRef.value?.validate();
  saving.value = true;
  try {
    await http.post('/inspections', startForm.value);
    message.success('已转入考察期');
    showStart.value = false;
    resultFilter.value = 'pending';
    load();
  } finally {
    saving.value = false;
  }
}

function openReview(row: Inspection) {
  reviewTarget.value = row;
  showReview.value = true;
}

async function openPass(row: Inspection) {
  passTarget.value = row;
  passForm.value = { karma_date: new Date().toISOString().slice(0, 10), current_post: null, note: '' };
  showPass.value = true;
  gateLoading.value = true;
  try {
    const { data } = await http.get<GateCheck>(`/reviews/inspections/${row.id}/gate`);
    gate.value = data;
  } finally {
    gateLoading.value = false;
  }
}

async function submitPass() {
  saving.value = true;
  try {
    await http.post(`/inspections/${passTarget.value?.id}/pass`, passForm.value);
    message.success('羯磨成就，已转为常住');
    showPass.value = false;
    load();
  } finally {
    saving.value = false;
  }
}

async function fail(row: Inspection) {
  await http.post(`/inspections/${row.id}/fail`, { note: null });
  message.warning('考察未通过，已退回挂单身份');
  load();
}

async function openSnapshot(row: Inspection) {
  showSnapshot.value = true;
  snapshotLoading.value = true;
  decision.value = null;
  try {
    const { data } = await http.get<InspectionDecision[]>(`/reviews/inspections/${row.id}/decisions`);
    decision.value = data[0] ?? null;
  } finally {
    snapshotLoading.value = false;
  }
}

const RESULT_LABEL: Record<string, string> = { pending: '考察中', passed: '已转常住', failed: '未通过' };
const RESULT_TYPE: Record<string, 'warning' | 'success' | 'error'> = {
  pending: 'warning', passed: 'success', failed: 'error',
};

const columns: DataTableColumns<Inspection> = [
  { title: '法名', key: 'dharma_name', width: 90, fixed: 'left', render: (r) => h(NText, { strong: true }, { default: () => r.dharma_name }) },
  {
    title: '状态',
    key: 'result',
    width: 100,
    render: (r) => h(NTag, { size: 'small', type: RESULT_TYPE[r.result], bordered: false }, { default: () => RESULT_LABEL[r.result] }),
  },
  { title: '开始日期', key: 'start_date', width: 110 },
  { title: '考察期满', key: 'expected_end', width: 110 },
  {
    title: '评议进度',
    key: 'completed_rounds',
    width: 110,
    render: (r) => h(NText, { depth: r.result === 'pending' ? 1 : 3 }, {
      default: () => `${r.completed_rounds ?? 0} / ${r.required_rounds} 轮`,
    }),
  },
  {
    title: '总平均分',
    key: 'overall_avg',
    width: 100,
    render: (r) => {
      if (r.overall_avg === null || r.overall_avg === undefined) return '—';
      const ok = r.overall_avg >= r.pass_score;
      return h(NText, { type: ok ? 'success' : 'error', strong: true }, { default: () => String(r.overall_avg) });
    },
  },
  {
    title: '进度',
    key: 'days_elapsed',
    render: (r) => {
      if (r.result !== 'pending') return '—';
      const total = (new Date(r.expected_end).getTime() - new Date(r.start_date).getTime()) / 86400000;
      const pct = Math.min(100, Math.round((r.days_elapsed / Math.max(total, 1)) * 100));
      return h(NText, { depth: 3 }, { default: () => `第 ${r.days_elapsed} 天（${pct}%）` });
    },
  },
  { title: '羯磨日期', key: 'karma_date', width: 110, render: (r) => r.karma_date ?? '—' },
  { title: '备注', key: 'note', ellipsis: { tooltip: true } },
  {
    title: '操作',
    key: 'actions',
    width: 240,
    fixed: 'right',
    render: (r) => {
      if (r.result !== 'pending') {
        return h(NButton, { size: 'small', quaternary: true, onClick: () => openSnapshot(r) }, { default: () => '决策快照' });
      }
      return h(NSpace, { size: 4 }, {
        default: () => [
          h(NButton, { size: 'small', quaternary: true, onClick: () => openReview(r) }, { default: () => '评议' }),
          h(NButton, { size: 'small', type: 'primary', quaternary: true, onClick: () => openPass(r) }, { default: () => '羯磨通过' }),
          h(NPopconfirm, { onPositiveClick: () => fail(r) }, {
            trigger: () => h(NButton, { size: 'small', type: 'error', quaternary: true }, { default: () => '不通过' }),
            default: () => `确认 ${r.dharma_name} 考察不通过？将退回挂单身份并留存决策快照。`,
          }),
        ],
      });
    },
  },
];

onMounted(load);
</script>
