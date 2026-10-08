export function preventAppContextMenu(event: MouseEvent) {
  const target = event.target
  // Android uses the context menu for long-press selection and paste, including
  // empty password fields. Read-only text fields must still allow copying.
  if (target instanceof HTMLElement
    && (target.closest('input, textarea') || target.isContentEditable)) return

  event.preventDefault()
}
