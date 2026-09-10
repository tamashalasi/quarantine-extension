// Serialize writes so an older response can never mark newer edits as saved.
export function autosave<T>(options: {
  read: () => T;
  write: (value: T) => Promise<unknown>;
  status: (saving: boolean, error?: unknown) => void;
  delay?: number;
}) {
  let revision = 0;
  let saving = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay = options.delay ?? 250) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void save();
    }, delay);
  };
  async function save() {
    if (disposed || saving) return;
    const current = revision;
    let value: T;
    try {
      value = options.read();
    } catch (error) {
      options.status(true, error);
      return;
    }
    saving = true;
    try {
      await options.write(value);
      if (!disposed && current === revision) options.status(false);
    } catch (error) {
      if (!disposed && current === revision) {
        options.status(true, error);
        schedule(1500);
      }
    } finally {
      saving = false;
      if (!disposed && current !== revision) schedule();
    }
  }
  return {
    change() {
      if (disposed) return;
      revision++;
      options.status(true);
      schedule();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
