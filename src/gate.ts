import styles from './ui.css';
import { holdButton } from './hold';
import type { View } from './model';

export function mountGate(
  parent: HTMLElement,
  view: View,
  tabId: number | undefined,
  onUnlock: (view: View) => void,
  openSettings?: () => void,
) {
  const shadow = parent.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = styles;
  const dialog = document.createElement('dialog');
  dialog.className = 'quarantine';
  dialog.setAttribute('aria-labelledby', 'gate-title');
  dialog.innerHTML = `<section class="gate"><div class="eyebrow">Quarantine</div><div class="mark" aria-hidden="true">Ⅱ</div><h1 id="gate-title"></h1><p class="description"></p><button class="hold" type="button"></button><p class="hint">A little room to choose. Release early to start over.</p><p class="error" role="status" aria-live="polite"></p></section>`;
  dialog.querySelector('h1')!.textContent = view.gate?.title ?? 'Taking a moment…';
  dialog.querySelector('.description')!.textContent =
    view.gate?.description ?? 'Checking your quarantine settings.';
  const button = dialog.querySelector<HTMLButtonElement>('.hold')!;
  const error = dialog.querySelector<HTMLElement>('.error')!;
  let cleanup = () => {};
  if (view.gate) cleanup = holdButton(button, error, view.duration, tabId, onUnlock);
  else button.hidden = true;
  if (openSettings) {
    const link = document.createElement('button');
    link.className = 'link';
    link.textContent = 'Quarantine settings';
    link.onclick = openSettings;
    dialog.querySelector('section')!.append(link);
  }
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  shadow.append(style, dialog);
  const show = () => {
    if (parent.isConnected && !dialog.open) dialog.showModal();
  };
  show();
  return {
    destroy() {
      cleanup();
      dialog.close();
      parent.remove();
    },
    show,
  };
}
