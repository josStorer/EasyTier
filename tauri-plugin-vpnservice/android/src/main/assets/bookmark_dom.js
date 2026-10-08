// Executed only in the main frame. The native controller owns the 8-second
// deadline and computes a fresh OTP only after this probe reports ready.
(function (config) {
  if (config.expiresAt && Date.now() >= config.expiresAt) return 'timeout';
  if (location.origin !== config.origin) return 'wrong_origin';
  let input;
  try { input = document.querySelector(config.selector); }
  catch { return 'invalid_selector'; }
  if (!input) return 'waiting';
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return 'invalid_input';
  // Always wait for the first match; never skip it to fill a later input.
  if (input instanceof HTMLInputElement
      && !['text', 'password', 'tel', 'number', 'search', 'url', 'email'].includes(input.type)) return 'input_unavailable';
  if (input.matches(':disabled') || input.readOnly || input.closest('[hidden], [inert]')) return 'input_unavailable';
  const style = getComputedStyle(input);
  if (!input.getClientRects().length || style.visibility === 'hidden' || style.visibility === 'collapse') return 'input_unavailable';
  if (!config.code) return 'ready';
  const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
  setter.call(input, config.code);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  if (config.autoEnter) {
    input.focus();
    const allowed = input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    if (allowed && input.form?.isConnected) input.form.requestSubmit();
  }
  return 'filled';
})(__BOOKMARK_CONFIG__)
