import { invoke } from '@tauri-apps/api/core'

export interface Bookmark {
  id: string
  name: string
  url: string
  selector: string
  autoEnter: boolean
  hasSecret: boolean
  opened: boolean
}
export interface BookmarkSnapshot { items: Bookmark[], selectedId: string }
export interface BookmarkEdit {
  id: string, name: string, url: string, selector: string,
  autoEnter: boolean, secret: string, clearSecret: boolean,
}

export const listBookmarks = () => invoke<BookmarkSnapshot>('plugin:vpnservice|list_bookmarks')
export const saveBookmark = (item: BookmarkEdit) => invoke<BookmarkSnapshot>('plugin:vpnservice|save_bookmark', { ...item })
export const selectBookmark = (id: string) => invoke<BookmarkSnapshot>('plugin:vpnservice|select_bookmark', { id })
export const deleteBookmark = (id: string) => invoke<BookmarkSnapshot>('plugin:vpnservice|delete_bookmark', { id })
export const openBookmark = (id: string) => invoke<void>('open_bookmark', { id })
export const readBookmarkClipboard = () => invoke<string>('plugin:clipboard-manager|read_text')

export function validateBookmark(item: BookmarkEdit, hasSecret: boolean, document: Document) {
  if (!item.name.trim() || item.name.length > 120) return 'nameError'
  try {
    const url = new URL(item.url.trim())
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || item.url.length > 2048) return 'urlError'
  }
  catch { return 'urlError' }
  if (item.selector.trim()) {
    try { document.querySelector(item.selector) }
    catch { return 'selectorError' }
    if (!(item.secret.trim() || (hasSecret && !item.clearSecret))) return 'secretRequired'
  }
}
