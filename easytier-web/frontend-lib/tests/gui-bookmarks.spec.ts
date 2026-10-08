import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import PrimeVue from 'primevue/config'
import source from '../../../tauri-plugin-vpnservice/android/src/main/assets/bookmark_dom.js?raw'
import Bookmarks from '../../../easytier-gui/src/components/Bookmarks.vue'
import { preventAppContextMenu } from '../../../easytier-gui/src/modules/context_menu'
import { validateBookmark, type BookmarkEdit, type BookmarkSnapshot } from '../../../easytier-gui/src/composables/bookmarks'
const native = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<BookmarkSnapshot>>())
vi.mock('../../../easytier-gui/src/composables/bookmarks', async importOriginal => ({
  ...await importOriginal<typeof import('../../../easytier-gui/src/composables/bookmarks')>(),
  listBookmarks: () => native('plugin:vpnservice|list_bookmarks'),
  saveBookmark: (item: Record<string, unknown>) => native('plugin:vpnservice|save_bookmark', item),
  selectBookmark: (id: string) => native('plugin:vpnservice|select_bookmark', { id }),
  deleteBookmark: (id: string) => native('plugin:vpnservice|delete_bookmark', { id }),
  openBookmark: (id: string) => native('open_bookmark', { id }),
}))
let saved: BookmarkSnapshot
beforeEach(() => {
  document.body.innerHTML = ''
  saved = { items: [], selectedId: '' }
  native.mockReset().mockImplementation(async (command, args) => {
    const payload = args as Record<string, unknown> | undefined
    if (command.endsWith('save_bookmark')) {
      const input = args as unknown as BookmarkEdit
      const item = { id: input.id || String(saved.items.length + 1), name: input.name, url: input.url,
        selector: input.selector, autoEnter: input.autoEnter, hasSecret: true, opened: false }
      saved = { items: [...saved.items.filter(old => old.id !== item.id), item], selectedId: item.id }
    }
    if (command === 'open_bookmark') saved.items[0].opened = true
    if (command.endsWith('delete_bookmark')) saved = { items: [], selectedId: '' }
    if (command.endsWith('select_bookmark')) saved.selectedId = String(payload?.id)
    return structuredClone(saved)
  })
})

describe('favorite addresses UI', () => {
  it('allows native edit menus on every bookmark field under the production context-menu policy', async () => {
    document.addEventListener('contextmenu', preventAppContextMenu)
    const wrapper = mount(Bookmarks, { attachTo: document.body,
      global: { plugins: [PrimeVue, createI18n({ legacy: false, locale: 'en', messages: { en: {} } })] } })
    try {
      await flushPromises()
      await wrapper.findAll('button').find(button => button.text() === 'New')!.trigger('click')
      await flushPromises()
      const fields = document.querySelectorAll<HTMLInputElement>('[role=dialog] input')
      expect(fields.length).toBeGreaterThanOrEqual(4)
      for (const field of fields) {
        for (const value of ['', 'selected text']) {
          field.value = value
          const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
          field.dispatchEvent(event)
          expect(event.defaultPrevented, field.getAttribute('aria-label') || field.type).toBe(false)
        }
      }
      const textarea = document.createElement('textarea')
      textarea.readOnly = true; textarea.value = 'copyable text'; document.body.append(textarea)
      const copy = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      textarea.dispatchEvent(copy); expect(copy.defaultPrevented).toBe(false)
      textarea.remove()
      const background = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      document.body.dispatchEvent(background); expect(background.defaultPrevented).toBe(true)
    } finally {
      wrapper.unmount()
      document.removeEventListener('contextmenu', preventAppContextMenu)
    }
  })

  it('switches between saved pages and keeps each page open state separate', async () => {
    saved = { selectedId: 'A', items: [
      { id: 'A', name: 'LAN A', url: 'http://10.0.0.1', selector: '', hasSecret: false, autoEnter: false, opened: true },
      { id: 'B', name: 'Long service name '.repeat(7), url: 'http://10.0.0.2', selector: '', hasSecret: false, autoEnter: false, opened: false },
    ] }
    const wrapper = mount(Bookmarks, { attachTo: document.body,
      global: { plugins: [PrimeVue, createI18n({ legacy: false, locale: 'en', messages: { en: {} } })] } })
    try {
      await flushPromises(); expect(wrapper.text()).toContain('Continue')
      await wrapper.get('[role=combobox]').trigger('click'); await flushPromises()
      const option = Array.from(document.querySelectorAll<HTMLElement>('[role=option]')).find(item => item.textContent?.includes('Long service'))!
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      option.click(); await flushPromises()
      expect(native.mock.calls).toContainEqual(['plugin:vpnservice|select_bookmark', { id: 'B' }])
      expect(saved.selectedId).toBe('B')
      expect(wrapper.text()).toContain('Start'); expect(wrapper.text()).not.toContain('Continue')
      saved.selectedId = 'A'; window.dispatchEvent(new Event('focus')); await flushPromises()
      expect(wrapper.text()).toContain('Continue')
    } finally { wrapper.unmount() }
  })

  it('keeps creation disabled after a load failure and permits retry without wiping data', async () => {
    native.mockRejectedValueOnce(new Error('keystore unavailable'))
    const wrapper = mount(Bookmarks, { attachTo: document.body,
      global: { plugins: [PrimeVue, createI18n({ legacy: false, locale: 'en', messages: { en: {} } })] } })
    try {
      await flushPromises(); expect(wrapper.get('[role=alert]').text()).toContain('Could not read')
      expect(wrapper.findAll('button').find(button => button.text() === 'New')!.attributes('disabled')).toBeDefined()
      await wrapper.findAll('button').find(button => button.text() === 'Retry')!.trigger('click'); await flushPromises()
      expect(wrapper.find('[role=alert]').exists()).toBe(false)
      expect(saved.items).toHaveLength(0)
    } finally { wrapper.unmount() }
  })

  it('creates, reloads, resumes a single page, prevents editing open pages, and deletes', async () => {
    const create = () => mount(Bookmarks, { attachTo: document.body,
      global: { plugins: [PrimeVue, createI18n({ legacy: false, locale: 'en', messages: { en: {} } })] } })
    let wrapper = create()
    const click = async (name: string) => {
      const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent?.trim() === name)
      expect(button, name).toBeTruthy(); button!.click(); await flushPromises()
    }
    const input = async (label: string, value: string) => {
      const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
      element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
    }
    try {
      await flushPromises(); await click('New')
      await input('Name', 'LAN HTTP')
      await input('URL', 'http://192.0.2.1:8080/')
      await input('DOM query (optional)', 'input[name=otp]')
      await input('2FA secret key (optional)', 'JBSWY3DPEHPK3PXP')
      await click('Save')
      expect(native).toHaveBeenCalledWith('plugin:vpnservice|save_bookmark', expect.objectContaining({ autoEnter: false, selector: 'input[name=otp]' }))
      wrapper.unmount(); wrapper = create(); await flushPromises()
      expect(wrapper.text()).toContain('LAN HTTP')
      await click('Start'); expect(wrapper.text()).toContain('Continue')
      await click('Continue'); expect(saved.items).toHaveLength(1)
      await click('Edit'); expect(wrapper.text()).toContain('Close this page')
      saved.items[0].opened = false
      window.dispatchEvent(new Event('focus')); await flushPromises()
      await click('Edit')
      expect(document.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe('')
      await click('Delete'); await click('Delete')
      expect(saved.items).toHaveLength(0)
    } finally { wrapper.unmount() }
  })

  it('validates URLs, selectors, and missing keys without overwriting existing secrets', () => {
    const valid = { id: '', name: 'Service', url: 'http://10.0.0.1:8080', selector: '#otp', secret: '', clearSecret: false, autoEnter: false }
    expect(validateBookmark(valid, true, document)).toBeUndefined()
    expect(validateBookmark({ ...valid, clearSecret: true }, true, document)).toBe('secretRequired')
    expect(validateBookmark({ ...valid, selector: '[' }, true, document)).toBe('selectorError')
    expect(validateBookmark({ ...valid, url: 'javascript:alert(1)' }, true, document)).toBe('urlError')
    expect(validateBookmark({ ...valid, url: 'https://user:password@example.com' }, true, document)).toBe('urlError')
  })
})

describe('actual WebView autofill script', () => {
  const run = (config: Record<string, unknown>) => window.eval(source.replace('__BOOKMARK_CONFIG__', JSON.stringify({ origin: location.origin, selector: '#otp', ...config })))
  it('waits for dynamic input, fires input/change events, and fills leading zeroes', () => {
    expect(run({})).toBe('waiting')
    document.body.innerHTML = '<input id="otp">'
    const input = document.querySelector<HTMLInputElement>('#otp')!
    const changed = vi.fn(); input.addEventListener('input', changed); input.addEventListener('change', changed)
    expect(run({})).toBe('ready')
    expect(input.value).toBe('')
    expect(run({ code: '005924', autoEnter: false })).toBe('filled')
    expect(input.value).toBe('005924'); expect(changed).toHaveBeenCalledTimes(2)
  })
  it('does not fill another origin, invalid selector or non-editable element', () => {
    document.body.innerHTML = '<input id="otp">'
    expect(run({ code: '123456', expiresAt: Date.now() - 1 })).toBe('timeout')
    expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('')
    expect(run({ code: '123456', origin: 'https://another.example' })).toBe('wrong_origin')
    expect(run({ selector: '[' })).toBe('invalid_selector')
    document.body.innerHTML = '<input id="otp" disabled>'
    expect(run({})).toBe('invalid_input')
  })
  it('optionally submits a form, respecting an Enter handler that prevents default', () => {
    document.body.innerHTML = '<form><input id="otp"></form>'
    const form = document.querySelector('form')!
    const submit = vi.spyOn(form, 'requestSubmit').mockImplementation(() => {})
    run({ code: '123456', autoEnter: false }); expect(submit).not.toHaveBeenCalled()
    run({ code: '123456', autoEnter: true }); expect(submit).toHaveBeenCalledOnce()
    document.querySelector('input')!.addEventListener('keydown', event => event.preventDefault())
    run({ code: '654321', autoEnter: true }); expect(submit).toHaveBeenCalledOnce()
  })
})
