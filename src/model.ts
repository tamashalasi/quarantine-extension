import { getDomain } from 'tldts';

export const selectorTypes = [
  'Base domain',
  'Host',
  'Exact',
  'Starts with',
  'Regular expression',
  'Never',
] as const;
export type SelectorType = (typeof selectorTypes)[number];
export interface Rule {
  id: string;
  type: SelectorType;
  text: string;
}
export interface Config {
  version: 1;
  duration: number;
  globalEnabled: boolean;
  rules: Rule[];
}
export interface Session {
  globalUnlocked: boolean;
  settingsUnlocked: boolean;
  ruleIds: string[];
}
export interface Tab {
  id: number;
  url: string;
}
export interface Gate {
  id: string;
  title: string;
  description: string;
}
export interface View {
  gate: Gate | null;
  duration: number;
  anyUnlocked: boolean;
  config?: Config;
}
export const defaultConfig = (): Config => ({
  version: 1,
  duration: 10,
  globalEnabled: false,
  rules: [],
});
export const lockedSession = (): Session => ({
  globalUnlocked: false,
  settingsUnlocked: false,
  ruleIds: [],
});
export const isWeb = (url: string) => /^https?:\/\//.test(url);

function host(text: string): string {
  if (!text || /[\s/?#@]/.test(text))
    throw new Error('Enter a hostname without a scheme, path, or port.');
  const url = new URL(`https://${text}`);
  if (url.port || url.username || url.password) throw new Error('Enter a hostname without a port.');
  return url.hostname.toLowerCase().replace(/\.$/, '');
}
const base = (hostname: string) => getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;

export function validateConfig(input: unknown): Config {
  if (!input || typeof input !== 'object') throw new Error('Invalid settings.');
  const c = input as Config;
  if (c.version !== 1 || !Number.isInteger(c.duration) || c.duration < 1 || c.duration > 300)
    throw new Error('Hold duration must be a whole number from 1 to 300 seconds.');
  if (typeof c.globalEnabled !== 'boolean' || !Array.isArray(c.rules))
    throw new Error('Invalid settings.');
  if (c.rules.length > 200) throw new Error('Use at most 200 rules.');
  const ids = new Set<string>();
  const rules = c.rules.map((r): Rule => {
    if (!r || typeof r.id !== 'string' || !/^[\w-]{1,100}$/.test(r.id) || ids.has(r.id))
      throw new Error('Invalid or duplicate rule ID.');
    ids.add(r.id);
    if (!selectorTypes.includes(r.type) || typeof r.text !== 'string' || r.text.length > 2048)
      throw new Error('Invalid selector.');
    let text = r.text;
    if (r.type !== 'Never' && !text.trim())
      throw new Error('Each active rule needs selector text.');
    if (r.type === 'Host') text = host(text.trim());
    if (r.type === 'Base domain') text = base(host(text.trim()));
    if (r.type === 'Exact') {
      if (!isWeb(text)) throw new Error('Exact selectors must begin with http:// or https://.');
      text = new URL(text).href;
    }
    if (r.type === 'Starts with' && !isWeb(text))
      throw new Error('URL prefixes must begin with http:// or https://.');
    if (r.type === 'Regular expression') {
      try {
        new RegExp(text);
      } catch {
        throw new Error('Invalid regular expression. Use a pattern without / delimiters or flags.');
      }
    }
    return { id: r.id, type: r.type, text };
  });
  return { version: 1, duration: c.duration, globalEnabled: c.globalEnabled, rules };
}

export function matches(rule: Rule, value: string): boolean {
  if (!isWeb(value) || rule.type === 'Never') return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    switch (rule.type) {
      case 'Base domain':
        return base(hostname) === base(host(rule.text));
      case 'Host':
        return hostname === host(rule.text);
      case 'Exact':
        return url.href === new URL(rule.text).href;
      case 'Starts with':
        return url.href.startsWith(rule.text);
      case 'Regular expression':
        return new RegExp(rule.text).test(url.href);
    }
  } catch {
    return false;
  }
}

interface Hold {
  token: string;
  gate: string;
  tabId: number;
  url: string;
  started: number;
  pulse: number;
}
export class Coordinator {
  tabs: Tab[] = [];
  holds = new Map<string, Hold>();
  constructor(
    public config: Config,
    public session: Session,
    public settingsUrl: string,
  ) {}
  isSettings(url: string) {
    return url.split(/[?#]/)[0] === this.settingsUrl;
  }
  reconcile(tabs: Tab[], hasWindows = true) {
    this.tabs = tabs;
    if (!hasWindows) {
      this.lock();
      return;
    }
    this.session.ruleIds = this.session.ruleIds.filter((id) => {
      const rule = this.config.rules.find((r) => r.id === id);
      return rule && tabs.some((t) => matches(rule, t.url));
    });
    if (!tabs.some((t) => this.isSettings(t.url))) this.session.settingsUnlocked = false;
    if (!this.config.globalEnabled) this.session.globalUnlocked = false;
    for (const [token, hold] of this.holds) {
      if (
        !tabs.some((t) => t.id === hold.tabId && t.url === hold.url) ||
        this.view(hold.tabId).gate?.id !== hold.gate
      )
        this.holds.delete(token);
    }
  }
  view(tabId: number): View {
    const url = this.tabs.find((t) => t.id === tabId)?.url ?? '';
    let gate: Gate | null = null;
    if (this.isSettings(url)) {
      if (!this.session.settingsUnlocked)
        gate = {
          id: 'settings',
          title: 'A pause before changing things.',
          description: 'Hold to unlock Quarantine settings.',
        };
    } else if (isWeb(url)) {
      if (this.config.globalEnabled && !this.session.globalUnlocked)
        gate = {
          id: 'global',
          title: 'A moment before the internet.',
          description: 'Unlock this browser session when you’re ready.',
        };
      else {
        const rule = this.config.rules.find(
          (r) => matches(r, url) && !this.session.ruleIds.includes(r.id),
        );
        if (rule)
          gate = {
            id: `rule:${rule.id}`,
            title: 'Is this where you want to be?',
            description: `${rule.type}: ${rule.text}`,
          };
      }
    }
    return {
      gate,
      duration: this.config.duration,
      anyUnlocked: this.anyUnlocked(),
      ...(this.isSettings(url) && !gate ? { config: structuredClone(this.config) } : {}),
    };
  }
  anyUnlocked() {
    return (
      this.session.globalUnlocked ||
      this.session.settingsUnlocked ||
      this.session.ruleIds.length > 0
    );
  }
  lock() {
    this.session = lockedSession();
    this.holds.clear();
  }
  save(config: unknown, tabId: number) {
    if (
      !this.isSettings(this.tabs.find((t) => t.id === tabId)?.url ?? '') ||
      !this.session.settingsUnlocked
    )
      throw new Error('Unlock settings before saving.');
    this.config = validateConfig(config);
    this.lock();
  }
  begin(tabId: number, now: number, token: string) {
    const tab = this.tabs.find((t) => t.id === tabId);
    const gate = this.view(tabId).gate;
    if (!tab || !gate) throw new Error('This quarantine is already unlocked.');
    this.cancelTab(tabId);
    this.holds.set(token, { token, gate: gate.id, tabId, url: tab.url, started: now, pulse: now });
    return { token, duration: this.config.duration };
  }
  pulse(token: string, tabId: number, now: number) {
    const hold = this.holds.get(token);
    if (!hold || hold.tabId !== tabId || now - hold.pulse > 1500 || now < hold.pulse) {
      this.holds.delete(token);
      throw new Error('Hold interrupted. Please try again.');
    }
    hold.pulse = now;
    return hold;
  }
  complete(token: string, tabId: number, now: number) {
    const hold = this.pulse(token, tabId, now);
    if (now - hold.started < this.config.duration * 1000 || this.view(tabId).gate?.id !== hold.gate)
      throw new Error('Keep holding until the countdown finishes.');
    this.holds.delete(token);
    if (hold.gate === 'global') this.session.globalUnlocked = true;
    else if (hold.gate === 'settings') this.session.settingsUnlocked = true;
    else this.session.ruleIds.push(hold.gate.slice(5));
  }
  cancelTab(tabId: number) {
    for (const [token, hold] of this.holds) if (hold.tabId === tabId) this.holds.delete(token);
  }
}
