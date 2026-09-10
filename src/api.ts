import browser from 'webextension-polyfill';
export default browser;
export async function request<T>(message: Record<string, unknown>): Promise<T> {
  const response = (await browser.runtime.sendMessage(message)) as { value?: T; error?: string };
  if (!response || response.error)
    throw new Error(response?.error ?? 'Quarantine is unavailable. Reload this page to reconnect.');
  return response.value as T;
}
