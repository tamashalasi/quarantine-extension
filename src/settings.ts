import browser, { request } from './api';
import { autosave } from './autosave';
import { mountGate } from './gate';
import { selectorTypes, validateConfig, type Config, type SelectorType, type View } from './model';

const app = document.querySelector<HTMLElement>('#app')!;
let tabId: number;
let gate: ReturnType<typeof mountGate> | undefined;
let gateKey = '';
let loaded = false;
let refreshId = 0;
let editing = false;
let savedConfig = '';
let disposeEditor: (() => void) | undefined;
const help: Record<SelectorType, string> = {
  'Base domain': 'example.co.uk — includes subdomains; private suffixes are respected.',
  Host: 'www.example.com — exactly this hostname, on any port.',
  Exact: 'https://example.com/path — includes query string and fragment.',
  'Starts with': 'https://example.com/path — case-sensitive URL prefix.',
  'Regular expression': 'Pattern against the full URL; no / delimiters or flags.',
  Never: 'Inactive rule. Selector text is kept for later.',
};
function editor(config: Config) {
  disposeEditor?.();
  editing = false;
  savedConfig = JSON.stringify(config);
  const draft = structuredClone(config);
  app.innerHTML = `<header><div><div class="eyebrow">Quarantine</div><h1>Make room for intention.</h1></div></header><form><section class="card"><div class="card-head"><div><h2>A pause for the whole browser</h2><p class="description">Unlock once, until you close the browser or lock it again.</p></div><input id="global" type="checkbox" aria-label="Enable global quarantine"></div><label class="duration">Hold duration (seconds)<input id="duration" type="number" min="1" max="300" step="1" required></label><p class="hint">The same duration applies to settings, global quarantine, and every page rule.</p></section><section class="card"><div class="card-head"><div><h2>Pages to pause for</h2><p class="description">A rule stays unlocked while any matching tab remains open.</p></div><button id="add" class="secondary" type="button">Add rule</button></div><div id="rules"></div></section><p class="hint"><span id="save-status" role="status" aria-live="polite">All changes are saved</span></p><p id="error" class="error" role="status" aria-live="polite"></p></form><p class="footer">To lock everything, click the extension icon in the toolbar. Private by design. Settings stay in this browser. Quarantine covers ordinary HTTP/HTTPS pages; browser settings and other protected pages remain available.</p>`;
  const global = app.querySelector<HTMLInputElement>('#global')!;
  global.checked = draft.globalEnabled;
  const duration = app.querySelector<HTMLInputElement>('#duration')!;
  duration.value = String(draft.duration);
  const rules = app.querySelector<HTMLElement>('#rules')!;
  const status = app.querySelector<HTMLElement>('#save-status')!;
  const error = app.querySelector<HTMLElement>('#error')!;
  const saver = autosave({
    read: () =>
      validateConfig({ ...draft, duration: Number(duration.value), globalEnabled: global.checked }),
    write: async (config) => {
      await request({ kind: 'save', tabId, config });
      savedConfig = JSON.stringify(config);
    },
    status: (saving, cause) => {
      editing = saving;
      if (!saving) void refresh();
      status.textContent = saving ? 'Saving...' : 'All changes are saved';
      error.textContent = cause ? `Changes have not been saved: ${(cause as Error).message}` : '';
    },
  });
  disposeEditor = saver.dispose;
  global.onchange = saver.change;
  duration.oninput = saver.change;
  function rows() {
    rules.replaceChildren();
    if (!draft.rules.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No page rules yet. Add a place you’d like to visit more deliberately.';
      rules.append(empty);
    }
    draft.rules.forEach((rule, index) => {
      const row = document.createElement('div');
      row.className = 'row';
      const typeLabel = document.createElement('label');
      typeLabel.textContent = 'Selector type';
      const select = document.createElement('select');
      select.setAttribute('aria-label', `Rule ${index + 1} selector type`);
      for (const type of selectorTypes) {
        const option = document.createElement('option');
        option.value = type;
        option.textContent = type;
        select.append(option);
      }
      select.value = rule.type;
      typeLabel.append(select);
      const textLabel = document.createElement('label');
      textLabel.textContent = 'Selector text';
      const input = document.createElement('input');
      input.value = rule.text;
      input.maxLength = 2048;
      input.setAttribute('aria-label', `Rule ${index + 1} selector text`);
      input.spellcheck = false;
      const description = document.createElement('div');
      description.className = 'rule-help';
      description.textContent = help[rule.type];
      input.disabled = rule.type === 'Never';
      input.required = rule.type !== 'Never';
      select.onchange = () => {
        rule.type = select.value as SelectorType;
        description.textContent = help[rule.type];
        input.disabled = rule.type === 'Never';
        input.required = rule.type !== 'Never';
        saver.change();
      };
      input.oninput = () => {
        rule.text = input.value;
        saver.change();
      };
      textLabel.append(input, description);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary remove';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove rule ${index + 1}`);
      remove.onclick = () => {
        draft.rules.splice(index, 1);
        rows();
        saver.change();
      };
      row.append(typeLabel, textLabel, remove);
      rules.append(row);
    });
  }
  rows();
  app.querySelector<HTMLButtonElement>('#add')!.onclick = () => {
    draft.rules.push({ id: crypto.randomUUID(), type: 'Host', text: '' });
    rows();
    saver.change();
    rules.querySelector<HTMLInputElement>('.row:last-child input')?.focus();
  };
  app.querySelector('form')!.onsubmit = (event) => event.preventDefault();
}
async function refresh() {
  const id = ++refreshId;
  try {
    const view = await request<View>({ kind: 'view', tabId });
    if (id !== refreshId) return;
    if (view.gate) {
      app.hidden = true;
      loaded = false;
      disposeEditor?.();
      disposeEditor = undefined;
      app.replaceChildren();
      const key = `${view.gate.id}:${view.duration}`;
      if (key !== gateKey) {
        gate?.destroy();
        const host = document.createElement('div');
        document.body.append(host);
        gate = mountGate(host, view, tabId, () => {
          void refresh();
        });
        gateKey = key;
      }
    } else if (view.config) {
      gate?.destroy();
      gate = undefined;
      gateKey = '';
      if (!loaded || (!editing && savedConfig !== JSON.stringify(view.config))) {
        editor(view.config);
        loaded = true;
      }
      app.hidden = false;
    }
  } catch (error) {
    app.hidden = false;
    disposeEditor?.();
    loaded = false;
    app.textContent = `Unable to load Quarantine settings: ${(error as Error).message}`;
  }
}
window.addEventListener('pagehide', () => disposeEditor?.());
browser.runtime.onMessage.addListener((message: unknown) => {
  if ((message as { kind?: string })?.kind === 'refresh' && tabId !== undefined) void refresh();
});
void browser.tabs.getCurrent().then((tab) => {
  if (tab?.id === undefined) throw new Error('Open settings in a browser tab.');
  tabId = tab.id;
  return refresh();
});
