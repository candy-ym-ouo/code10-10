<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { apiFetch, ApiError } from "../api/client.js";
import { useAuthStore, type User } from "../stores/auth.js";
import { exportStatusLabels, formatDateTime } from "../utils/format.js";

interface ExportTask {
  id: string;
  format: string;
  status: keyof typeof exportStatusLabels;
  processedCount: number;
  totalSessions: number;
  expiresAt: string | null;
  createdAt: string;
}

const auth = useAuthStore();
const form = reactive({ displayName: "", defaultInstrument: "", timezone: "Asia/Shanghai", locale: "zh-CN" });
const passwords = reactive({ currentPassword: "", newPassword: "", confirmPassword: "" });
const deletion = reactive({ currentPassword: "", confirmation: "" });
const message = ref("");
const error = ref("");
const loading = ref(true);
const exportFormat = ref<"json" | "csv">("json");
const creatingExport = ref(false);
const exportTasks = ref<ExportTask[]>([]);
const cancellingId = ref<string | null>(null);
let exportPollTimer: ReturnType<typeof setInterval> | null = null;

const activeExports = computed(() => exportTasks.value.some((task) => task.status === "PENDING" || task.status === "PROCESSING"));

async function load(): Promise<void> {
  try {
    const result = await apiFetch<{ user: User }>("/api/v1/users/me");
    Object.assign(form, {
      displayName: result.user.displayName,
      defaultInstrument: result.user.defaultInstrument ?? "",
      timezone: result.user.timezone,
      locale: result.user.locale,
    });
    auth.updateUser(result.user);
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "设置加载失败";
  } finally {
    loading.value = false;
  }
}
async function saveProfile(): Promise<void> {
  message.value = "";
  error.value = "";
  try {
    const result = await apiFetch<{ user: User }>("/api/v1/users/me", {
      method: "PATCH",
      body: JSON.stringify({ ...form, defaultInstrument: form.defaultInstrument || null }),
    });
    auth.updateUser(result.user);
    message.value = "个人设置已保存";
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "保存失败";
  }
}
async function changePassword(): Promise<void> {
  message.value = "";
  error.value = "";
  if (passwords.newPassword !== passwords.confirmPassword) {
    error.value = "两次输入的新密码不一致";
    return;
  }
  try {
    await apiFetch("/api/v1/users/me/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: passwords.currentPassword, newPassword: passwords.newPassword }),
    });
    message.value = "密码已修改，请重新登录";
    await auth.logout();
    window.location.href = "/login";
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "修改密码失败";
  }
}

async function loadExports(): Promise<void> {
  try {
    const result = await apiFetch<{ exports: ExportTask[] }>("/api/v1/exports");
    exportTasks.value = result.exports;
    if (!activeExports.value && exportPollTimer) {
      clearInterval(exportPollTimer);
      exportPollTimer = null;
    }
  } catch {
    // 后台轮询失败不打断页面
  }
}

async function openDownload(task: ExportTask): Promise<void> {
  error.value = "";
  try {
    const result = await apiFetch<{ downloadUrl?: string }>(`/api/v1/exports/${task.id}`);
    if (result.downloadUrl) window.open(result.downloadUrl, "_blank", "noopener,noreferrer");
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "下载地址获取失败";
  }
}

async function createExport(): Promise<void> {
  message.value = "";
  error.value = "";
  creatingExport.value = true;
  try {
    const result = await apiFetch<{ export: ExportTask; reused: boolean }>("/api/v1/exports", {
      method: "POST",
      body: JSON.stringify({ format: exportFormat.value }),
    });
    message.value = result.reused
      ? "相同条件的导出已存在，已复用现有任务，不会重复生成。"
      : "导出任务已提交，正在分批生成。";
    await loadExports();
    ensurePolling();
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "创建导出失败";
  } finally {
    creatingExport.value = false;
  }
}

async function cancelExport(task: ExportTask): Promise<void> {
  cancellingId.value = task.id;
  try {
    await apiFetch(`/api/v1/exports/${task.id}/cancel`, { method: "POST", body: "{}" });
    await loadExports();
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "取消失败";
  } finally {
    cancellingId.value = null;
  }
}

function ensurePolling(): void {
  if (!exportPollTimer) exportPollTimer = setInterval(() => void loadExports(), 3000);
}

function progressPercent(task: ExportTask): number {
  if (task.totalSessions <= 0) return task.status === "PROCESSING" ? 5 : 0;
  return Math.min(100, Math.round((task.processedCount / task.totalSessions) * 100));
}

async function deleteAccount(): Promise<void> {
  message.value = "";
  error.value = "";
  try {
    await apiFetch("/api/v1/users/me/deletion", {
      method: "POST",
      body: JSON.stringify(deletion),
    });
    await auth.logout();
    window.location.href = "/login";
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "注销失败";
  }
}

onMounted(() => {
  void load();
  void loadExports().then(ensurePolling);
});
onUnmounted(() => {
  if (exportPollTimer) clearInterval(exportPollTimer);
});
</script>

<template>
  <section class="page">
    <header class="page-header"><div><h1>设置</h1><p>管理默认练习偏好、时区和账户安全。</p></div></header>
    <div v-if="message" class="alert success" style="margin-bottom: 16px">{{ message }}</div>
    <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
    <div v-if="loading" class="loading">正在加载设置…</div>
    <div v-else class="grid grid-2">
      <form class="card stack" @submit.prevent="saveProfile">
        <h2>练习偏好</h2>
        <label class="field"><span>展示名</span><input v-model="form.displayName" required maxlength="80" /></label>
        <label class="field"><span>默认乐器</span><input v-model="form.defaultInstrument" maxlength="60" /></label>
        <label class="field"><span>IANA 时区</span><input v-model="form.timezone" required placeholder="Asia/Shanghai" /></label>
        <label class="field"><span>界面语言</span><select v-model="form.locale"><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></label>
        <div class="row end"><button class="button" type="submit">保存设置</button></div>
      </form>

      <form class="card stack" @submit.prevent="changePassword">
        <h2>账户安全</h2>
        <p class="muted">修改密码会撤销其他设备上的刷新会话。密码至少 10 位，包含字母和数字。</p>
        <label class="field"><span>当前密码</span><input v-model="passwords.currentPassword" required type="password" autocomplete="current-password" /></label>
        <label class="field"><span>新密码</span><input v-model="passwords.newPassword" required type="password" autocomplete="new-password" /></label>
        <label class="field"><span>确认新密码</span><input v-model="passwords.confirmPassword" required type="password" autocomplete="new-password" /></label>
        <div class="row end"><button class="button secondary" type="submit">修改密码</button></div>
      </form>

      <article class="card stack">
        <h2>数据导出</h2>
        <p class="muted">导出会包含练习、音频元数据、标记、目标和进度，不包含音频二进制。任务分批生成，可随时取消并从断点续跑。</p>
        <div class="row">
          <label class="field" style="flex: 1">
            <span>格式</span>
            <select v-model="exportFormat">
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
            </select>
          </label>
          <button class="button secondary" type="button" :disabled="creatingExport" @click="createExport">
            {{ creatingExport ? "提交中…" : "创建导出" }}
          </button>
        </div>
        <p class="muted">相同条件的导出会复用已有任务与文件，不会生成副本；文件仅保留 24 小时，下载地址短时有效。</p>
        <ul v-if="exportTasks.length" class="stack" style="gap: 8px; list-style: none; padding: 0">
          <li v-for="task in exportTasks" :key="task.id" class="card" style="padding: 12px">
            <div class="row" style="justify-content: space-between">
              <strong>{{ task.format.toUpperCase() }} 导出</strong>
              <span class="badge" :class="task.status">{{ exportStatusLabels[task.status] }}</span>
            </div>
            <div v-if="task.status === 'PROCESSING' || task.status === 'PENDING'" class="stack" style="gap: 4px; margin-top: 8px">
              <progress :value="progressPercent(task)" max="100" style="width: 100%">{{ progressPercent(task) }}%</progress>
              <span class="muted">已处理 {{ task.processedCount }} / {{ task.totalSessions }} 个练习</span>
            </div>
            <p v-if="task.status === 'READY'" class="muted" style="margin-top: 8px">
              可下载至 {{ formatDateTime(task.expiresAt) }}，之后链接失效。
            </p>
            <p v-if="task.status === 'EXPIRED'" class="muted" style="margin-top: 8px">文件已过期并删除，可重新创建导出。</p>
            <div class="row end" style="margin-top: 8px; gap: 8px">
              <button v-if="task.status === 'READY'" class="button" type="button" @click="openDownload(task)">下载</button>
              <button
                v-if="task.status === 'PENDING' || task.status === 'PROCESSING'"
                class="button secondary"
                type="button"
                :disabled="cancellingId === task.id"
                @click="cancelExport(task)"
              >
                {{ cancellingId === task.id ? "取消中…" : "取消任务" }}
              </button>
            </div>
          </li>
        </ul>
      </article>
      <article class="card stack">
        <h2>数据与隐私</h2>
        <p class="muted">音频和导出文件存放在私有对象存储中，播放与下载地址短期有效且只能由本人签发。</p>
        <p class="muted">删除练习会进入后台清理队列，对象和业务数据清理失败时会保留可重试状态。</p>
        <form class="stack" @submit.prevent="deleteAccount">
          <h3>注销账号</h3>
          <p class="muted">注销会删除全部练习、音频对象和导出文件，已签发的下载链接立即失效，操作不可恢复。</p>
          <label class="field">
            <span>当前密码</span>
            <input v-model="deletion.currentPassword" required type="password" autocomplete="current-password" />
          </label>
          <label class="field">
            <span>输入 DELETE-MY-ACCOUNT 确认</span>
            <input v-model="deletion.confirmation" required autocomplete="off" />
          </label>
          <div class="row end">
            <button class="button danger" type="submit">永久注销账号</button>
          </div>
        </form>
      </article>
    </div>
  </section>
</template>
