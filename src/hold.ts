import { request } from './api';
import type { View } from './model';

export function holdButton(
  button: HTMLButtonElement,
  error: HTMLElement,
  duration: number,
  tabId: number | undefined,
  unlocked: (view: View) => void,
) {
  let active = false;
  let disposed = false;
  let token: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let generation = 0;
  let pointer: number | undefined;
  let key: string | undefined;
  const abort = new AbortController();
  const options = { signal: abort.signal };
  const idle = () => {
    button.textContent = `Hold to unlock · ${duration}s`;
    button.style.setProperty('--progress', '0');
    button.setAttribute('aria-label', `Hold to unlock for ${duration} seconds`);
  };
  idle();
  async function cancel() {
    if (!active) return;
    active = false;
    generation++;
    clearTimeout(timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
    token = undefined;
    idle();
    try {
      await request({ kind: 'cancel', tabId });
    } catch {
      /* A closed tab cannot reconnect. */
    }
  }
  async function start(event: Event) {
    if (!event.isTrusted || active || disposed) return;
    active = true;
    const current = ++generation;
    error.textContent = '';
    button.textContent = 'Starting…';
    try {
      const result = await request<{ token: string; duration: number }>({ kind: 'begin', tabId });
      if (!active || generation !== current || disposed) return;
      token = result.token;
      const started = performance.now();
      button.textContent = 'Keep holding';
      // Rendering stays smooth even while a background heartbeat is pending.
      const animate = () => {
        if (!active || generation !== current || disposed) return;
        const progress = Math.min(1, (performance.now() - started) / (result.duration * 1000));
        button.style.setProperty('--progress', String(progress));
        if (progress < 1) frame = requestAnimationFrame(animate);
      };
      frame = requestAnimationFrame(animate);
      const tick = async () => {
        if (!active || generation !== current || disposed) return;
        try {
          const elapsed = performance.now() - started;
          if (elapsed >= result.duration * 1000) {
            const view = await request<View>({ kind: 'complete', token, tabId });
            if (!active || generation !== current || disposed) return;
            active = false;
            if (frame !== undefined) cancelAnimationFrame(frame);
            token = undefined;
            idle();
            unlocked(view);
          } else {
            await request({ kind: 'pulse', token, tabId });
            if (active && generation === current)
              timer = setTimeout(() => {
                void tick();
              }, 100);
          }
        } catch (cause) {
          await cancel();
          if (!disposed) error.textContent = (cause as Error).message;
        }
      };
      void tick();
    } catch (cause) {
      await cancel();
      if (!disposed) error.textContent = (cause as Error).message;
    }
  }
  button.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || pointer !== undefined || key !== undefined) return;
      pointer = event.pointerId;
      button.setPointerCapture(pointer);
      button.focus();
      void start(event);
    },
    options,
  );
  const endPointer = () => {
    pointer = undefined;
    void cancel();
  };
  button.addEventListener('pointerup', endPointer, options);
  button.addEventListener('pointercancel', endPointer, options);
  button.addEventListener('lostpointercapture', endPointer, options);
  button.addEventListener('contextmenu', (event) => event.preventDefault(), options);
  button.addEventListener(
    'keydown',
    (event) => {
      if (event.code !== 'Space' && event.code !== 'Enter') return;
      event.preventDefault();
      if (event.repeat || pointer !== undefined || key !== undefined) return;
      key = event.code;
      void start(event);
    },
    options,
  );
  button.addEventListener(
    'keyup',
    (event) => {
      if (event.code === key) {
        event.preventDefault();
        key = undefined;
        void cancel();
      }
    },
    options,
  );
  button.addEventListener(
    'blur',
    () => {
      key = undefined;
      void cancel();
    },
    options,
  );
  window.addEventListener(
    'blur',
    () => {
      key = undefined;
      pointer = undefined;
      void cancel();
    },
    options,
  );
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) {
        key = undefined;
        pointer = undefined;
        void cancel();
      }
    },
    options,
  );
  window.addEventListener(
    'pagehide',
    () => {
      void cancel();
    },
    options,
  );
  return () => {
    disposed = true;
    void cancel();
    clearTimeout(timer);
    abort.abort();
  };
}
