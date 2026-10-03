<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from "vue";
import { apiFetch, ApiError } from "../api/client.js";
import { useAuthStore, type User } from "../stores/auth.js";

interface ExportTask {
  id: string;
  format: string;
  status: "PENDING" | "PROCESSING" | "READY" | "FAILED" | "EXPIRED" | "CANCELLED";
  totalSessions: number;
  processedSessions: number;
  failure: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const statusLabels: Record<ExportTask["status"], string> = {
  PENDING: "排队中",
  PROCESSING: "处理中",
  READY: "可下载",
  FAILED: "失败",
  EXPIRED: "已过期",
  CANCELLED: "已取消",
};

const auth = useAuthStore();
const form = reactive({ displayName: "", defaultInstrument: "", timezone: "Asia/Shanghai", locale: "zh-CN" });
const passwords = reactive({ currentPassword: "", newPassword: "", confirmPassword: "" });
const deletion = reactive({ password: "", confirming: false });
const message = ref("");
const error = ref("");
const loading = ref(true);
const exports = ref<ExportTask[]>([]);
const exportBusy = ref(false);
let pollTimer: ReturnType<typeof setInterval> | undefined;

function progressPercent(task: ExportTask): number | null {
  if (task.status !== "PROCESSING" || task.totalSessions === 0) return null;
  return Math.min(100, Math.round((task.processedSessions / task.totalSessions) * 100));
}

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

async function loadExports(): Promise<void> {
  try {
    const result = await apiFetch<{ exports: ExportTask[] }>("/api/v1/exports?limit=10");
    exports.value = result.exports;
    const active = result.exports.some((task) => task.status === "PENDING" || task.status === "PROCESSING");
    if (!active && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  } catch {
    // 列表刷新失败不打断页面操作
  }
}

function ensurePolling(): void {
  if (!pollTimer) pollTimer = setInterval(() => void loadExports(), 3000);
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

async function createExport(): Promise<void> {
  message.value = "";
  error.value = "";
  exportBusy.value = true;
  try {
    await apiFetch("/api/v1/exports", { method: "POST", body: JSON.stringify({ format: "json" }) });
    await loadExports();
    ensurePolling();
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "创建导出失败";
  } finally {
    exportBusy.value = false;
  }
}

async function refreshDownload(task: ExportTask): Promise<void> {
  try {
    const result = await apiFetch<{ downloadUrl?: string }>(`/api/v1/exports/${task.id}`);
    if (result.downloadUrl) window.location.href = result.downloadUrl;
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "获取下载链接失败";
  }
}

async function cancelExport(task: ExportTask): Promise<void> {
  try {
    await apiFetch(`/api/v1/exports/${task.id}/cancel`, { method: "POST" });
    await loadExports();
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "取消失败";
  }
}

async function deleteAccount(): Promise<void> {
  message.value = "";
  error.value = "";
  if (!deletion.confirming) {
    deletion.confirming = true;
    return;
  }
  try {
    await apiFetch("/api/v1/users/me", { method: "DELETE", body: JSON.stringify({ password: deletion.password }) });
    await auth.logout();
    window.location.href = "/login";
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "账号删除失败";
    deletion.confirming = false;
  }
}

onMounted(() => {
  void load();
  void loadExports();
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
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
        <p class="muted">导出在后台分批处理，可随时取消；处理中断会从断点继续。重复请求同一份导出不会生成副本。</p>
        <p class="muted">文件仅保留 24 小时，下载链接短期有效；账号删除后所有链接立即失效。导出包含练习、音频元数据、标记、目标和进度，不包含音频二进制。</p>
        <div class="row">
          <button class="button secondary" type="button" :disabled="exportBusy" @click="createExport">创建 JSON 导出</button>
        </div>
        <ul v-if="exports.length" class="stack" style="gap: 8px; margin-top: 4px">
          <li v-for="task in exports" :key="task.id" class="card" style="padding: 12px">
            <div class="row between">
              <strong>{{ task.format.toUpperCase() }} · {{ statusLabels[task.status] }}</strong>
              <span class="muted">{{ new Date(task.createdAt).toLocaleString() }}</span>
            </div>
            <div v-if="progressPercent(task) !== null" class="muted" style="margin: 4px 0">
              进度 {{ task.processedSessions }}/{{ task.totalSessions }}（{{ progressPercent(task) }}%）
            </div>
            <div v-if="task.status === 'PROCESSING'" class="muted">已处理 {{ task.processedSessions }} 条练习…</div>
            <div v-if="task.failure" class="alert" style="margin-top: 6px">{{ task.failure }}</div>
            <div class="row" style="margin-top: 8px">
              <button v-if="task.status === 'READY'" class="button" type="button" @click="refreshDownload(task)">下载</button>
              <button
                v-if="task.status === 'PENDING' || task.status === 'PROCESSING'"
                class="button secondary"
                type="button"
                @click="cancelExport(task)"
              >
                取消任务
              </button>
            </div>
          </li>
        </ul>
      </article>

      <article class="card stack">
        <h2>删除账号</h2>
        <p class="muted">账号删除会在后台清除全部音频、导出文件和业务数据，删除后所有下载链接立即失效，且无法恢复。</p>
        <template v-if="deletion.confirming">
          <label class="field"><span>输入当前密码确认删除</span><input v-model="deletion.password" required type="password" autocomplete="current-password" /></label>
          <div class="row end">
            <button class="button secondary" type="button" @click="deletion.confirming = false">再想想</button>
            <button class="button danger" type="button" @click="deleteAccount">永久删除账号</button>
          </div>
        </template>
        <div v-else class="row end">
          <button class="button danger" type="button" @click="deleteAccount">删除我的账号</button>
        </div>
      </article>

      <article class="card stack">
        <h2>数据与隐私</h2>
        <p class="muted">音频存放在私有对象存储中，播放地址短期有效且只能由本人签发。</p>
        <p class="muted">删除练习会进入后台清理队列，对象和业务数据清理失败时会保留可重试状态。</p>
      </article>
    </div>
  </section>
</template>
