<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Dialog, InputText, Select, ToggleSwitch } from 'primevue'
import { deleteBookmark, listBookmarks, openBookmark, saveBookmark, selectBookmark, validateBookmark,
  type BookmarkEdit, type BookmarkSnapshot } from '../composables/bookmarks'

const { locale } = useI18n()
const zh = {
  title: '收藏地址', choose: '选择收藏地址', add: '新建', edit: '编辑', launch: '启动', resume: '继续',
  name: '名称', url: '网址', selector: 'DOM query（可选）', key: '2FA secret key（可选）',
  keyHint: '粘贴 Base32 密钥或 otpauth://totp/ 导入链接。留空保留已有密钥。',
  savedKey: '已保存密钥', clear: '删除已有密钥', enter: '填入后自动回车',
  hint: '打开页面后最多检测 8 秒；找到输入框时计算并填入当前 6 位验证码。仅在配置网址的同一来源填入。',
  stored: '密钥在本机加密保存；卸载后无法恢复。', save: '保存', cancel: '取消', remove: '删除',
  closeFirst: '此页面已开启，请先在页面返回菜单中退出，再编辑或删除。',
  deleteAsk: '确定删除这个收藏及其 2FA 密钥？', empty: '保存常用的局域网 HTTP 服务或其他网址。',
  nameError: '请输入名称（最多 120 个字符）', urlError: '请输入完整的 http:// 或 https:// 地址，不含用户名和密码',
  selectorError: 'DOM query 不是有效的 CSS 选择器', secretRequired: '设置 DOM query 时请导入 2FA 密钥',
  failed: '操作失败，请检查地址、密钥或重试。', loadError: '无法读取收藏，请重试；原保存内容不会覆盖。', retry: '重试',
}
const en: typeof zh = {
  title: 'Favorite addresses', choose: 'Select an address', add: 'New', edit: 'Edit', launch: 'Start', resume: 'Continue',
  name: 'Name', url: 'URL', selector: 'DOM query (optional)', key: '2FA secret key (optional)',
  keyHint: 'Paste a Base32 key or otpauth://totp/ URI. Leave blank to keep the saved key.',
  savedKey: 'Key saved', clear: 'Remove saved key', enter: 'Press Enter after filling',
  hint: 'Look for the input for up to 8 seconds after opening, then calculate and fill the current six-digit code. Same-origin pages only.',
  stored: 'Keys are encrypted on this device and cannot be recovered after uninstalling.',
  save: 'Save', cancel: 'Cancel', remove: 'Delete', closeFirst: 'Close this page from its Back menu before editing or deleting it.',
  deleteAsk: 'Delete this favorite and its 2FA key?', empty: 'Save LAN HTTP services or other websites.',
  nameError: 'Enter a name (up to 120 characters)', urlError: 'Enter a complete http:// or https:// URL without credentials',
  selectorError: 'DOM query is not a valid CSS selector', secretRequired: 'Import a 2FA key to use a DOM query',
  failed: 'Operation failed. Check the address and key, or retry.', loadError: 'Could not read favorites. Retry; saved data will not be overwritten.', retry: 'Retry',
}
const text = computed(() => locale.value.startsWith('zh') ? zh : en)
const state = ref<BookmarkSnapshot>({ items: [], selectedId: '' })
const selected = computed(() => state.value.items.find(item => item.id === state.value.selectedId))
const busy = ref(false)
const loaded = ref(false)
const error = ref('')
const visible = ref(false)
const deleting = ref(false)
const editError = ref('')
const editHasSecret = ref(false)
const draft = ref<BookmarkEdit>({ id: '', name: '', url: '', selector: '', secret: '', autoEnter: false, clearSecret: false })

async function refresh() {
  if (busy.value) return
  try { state.value = await listBookmarks(); loaded.value = true; error.value = '' }
  catch { error.value = text.value.loadError }
}
async function choose(id: string) {
  busy.value = true
  try { state.value = await selectBookmark(id); error.value = '' }
  catch { error.value = text.value.failed }
  finally { busy.value = false }
}
function edit(create = false) {
  if (!create && selected.value?.opened) { error.value = text.value.closeFirst; return }
  const item = create ? undefined : selected.value
  draft.value = { id: item?.id ?? '', name: item?.name ?? '', url: item?.url ?? '', selector: item?.selector ?? '',
    autoEnter: item?.autoEnter ?? false, secret: '', clearSecret: false }
  editHasSecret.value = item?.hasSecret ?? false
  editError.value = ''; deleting.value = false; visible.value = true
}
async function save() {
  const reason = validateBookmark(draft.value, editHasSecret.value, document)
  if (reason) { editError.value = text.value[reason]; return }
  busy.value = true
  try { state.value = await saveBookmark(draft.value); visible.value = false; draft.value.secret = ''; error.value = '' }
  catch { editError.value = text.value.failed }
  finally { busy.value = false }
}
async function remove() {
  busy.value = true
  try { state.value = await deleteBookmark(draft.value.id); visible.value = false; draft.value.secret = '' }
  catch { editError.value = text.value.failed }
  finally { busy.value = false }
}
async function launch() {
  if (!selected.value) return
  busy.value = true; error.value = ''
  try { await openBookmark(selected.value.id) }
  catch (cause) {
    const detail = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : ''
    error.value = detail ? `${text.value.failed} ${detail}` : text.value.failed
  }
  finally { busy.value = false }
  // Activities can finish creating after the command returns. Refresh again on focus.
  if (!error.value) await refresh()
}
const onFocus = () => { void refresh() }
const onVisibility = () => { if (document.visibilityState === 'visible') void refresh() }
onMounted(() => { void refresh(); window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onVisibility) })
onUnmounted(() => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisibility); draft.value.secret = '' })
</script>

<template>
  <section class="p-3 border-b flex flex-col gap-2 shrink-0 min-w-0" aria-label="Favorite addresses">
    <div class="flex items-center justify-between gap-2"><strong>{{ text.title }}</strong>
      <div class="flex gap-1"><Button size="small" :label="text.add" icon="pi pi-plus" :disabled="busy || !loaded" @click="edit(true)" />
        <Button size="small" :label="text.edit" severity="secondary" :disabled="busy || !selected" @click="edit()" /></div>
    </div>
    <div class="flex gap-2 min-w-0">
      <Select :model-value="state.selectedId" :options="state.items" option-label="name" option-value="id"
        :placeholder="text.choose" :aria-label="text.choose" class="flex-1 min-w-0" :disabled="busy || !loaded"
        :filter="state.items.length > 6" @update:model-value="choose" />
      <Button :label="selected?.opened ? text.resume : text.launch" icon="pi pi-play" :loading="busy"
        :disabled="!selected || !loaded" @click="launch" />
    </div>
    <p v-if="!state.items.length" class="text-sm opacity-70">{{ text.empty }}</p>
    <div v-if="error" role="alert" class="text-sm break-words text-red-500">{{ error }}
      <Button :label="text.retry" text size="small" @click="refresh" /></div>
    <Dialog v-model:visible="visible" modal :header="text.title" :closable="!busy" :close-on-escape="!busy"
      :style="{ width: '34rem', maxWidth: 'calc(100vw - 1rem)' }" @hide="draft.secret = ''">
      <form class="flex flex-col gap-3" @submit.prevent="save">
        <label class="flex flex-col gap-1">{{ text.name }}<InputText v-model="draft.name" maxlength="120" :aria-label="text.name" /></label>
        <label class="flex flex-col gap-1">{{ text.url }}<InputText v-model="draft.url" type="url" maxlength="2048" :aria-label="text.url" /></label>
        <label class="flex flex-col gap-1">{{ text.selector }}<InputText v-model="draft.selector" maxlength="1024" placeholder="input[name=otp]" :aria-label="text.selector" /></label>
        <label class="flex flex-col gap-1">{{ text.key }}<InputText v-model="draft.secret" type="password" autocomplete="new-password" maxlength="2048" :aria-label="text.key" /></label>
        <p class="text-sm opacity-70">{{ text.keyHint }} {{ text.stored }}</p>
        <label v-if="editHasSecret" class="flex items-center gap-2"><ToggleSwitch v-model="draft.clearSecret" :aria-label="text.clear" />{{ text.clear }} ({{ text.savedKey }})</label>
        <label class="flex items-center gap-2"><ToggleSwitch v-model="draft.autoEnter" :aria-label="text.enter" />{{ text.enter }}</label>
        <p class="text-sm opacity-70">{{ text.hint }}</p>
        <p v-if="editError" role="alert" class="text-red-500 break-words">{{ editError }}</p>
        <p v-if="deleting" class="text-sm">{{ text.deleteAsk }}</p>
        <div class="flex flex-wrap justify-end gap-2">
          <Button v-if="draft.id" type="button" :label="text.remove" severity="danger" outlined :disabled="busy" @click="deleting ? remove() : deleting = true" />
          <Button type="button" :label="text.cancel" severity="secondary" :disabled="busy" @click="visible = false" />
          <Button type="submit" :label="text.save" :loading="busy" />
        </div>
      </form>
    </Dialog>
  </section>
</template>

<style scoped>
:deep(.p-select-label) { overflow: hidden; text-overflow: ellipsis; }
</style>
