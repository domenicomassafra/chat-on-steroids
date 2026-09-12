/** One browser startup owner for explicit work and durable recovery. */
import { bridgeStatus, browserWakeConnected } from './bridge.js';
import { isPreferredBrowserRunning, openInPreferredBrowser } from './browser.js';
import { getConfig } from './config.js';
import { browserProfileDir } from './profile.js';

let waking: { lastSeenAt: number | null; selected: string; work: Promise<void>; failed: boolean; finished: boolean } | null = null;
/** One browser startup per absence episode, shared by authored sends, discovery and owed recovery. */
export async function wakeBrowserUrl(url: string, retry = false, backgroundStartup = false,
  authority?: { current(): boolean }): Promise<void> {
  if (authority && !authority.current()) return;
  const browser = await bridgeStatus();
  if (browserWakeConnected()) { waking = null; return; }
  const selected = getConfig().ui.chatBrowser ?? 'chrome';
  // The companion can be missing because its protocol is incompatible or MV3 is
  // suspended. Only process absence permits an OS launch; forwarding a URL to
  // an existing Chrome process can activate it even with minimized startup flags.
  const prior = waking;
  // An owner-isolated Chromium data root is an exact browser identity. Starting the same family
  // with that --user-data-dir either creates that identity or hands the URL to that exact running
  // profile. A family-wide process probe cannot distinguish it from another account, so it must
  // not suppress this launch merely because some unrelated Chrome/Edge/Brave process exists.
  const absent = browserProfileDir() !== null || await isPreferredBrowserRunning() === false;
  // A settings change while the probe yielded revokes that browser's absence evidence.
  if (selected !== (getConfig().ui.chatBrowser ?? 'chrome')) return;
  // The process query yields. Off, a collected reply or a new navigation can revoke
  // the exact recovery meanwhile; a missing socket alone never proves Chrome exited.
  if (authority && !authority.current()) return;
  if (browserWakeConnected()) { waking = null; return; }
  if (!absent) return;
  if (retry && waking === prior && (waking?.failed || waking?.finished)) waking = null;
  // Until the extension registers, another explicit send belongs to the same startup.
  // A changed browser choice starts a distinct attempt without adopting the old family.
  if (waking?.lastSeenAt === browser.lastSeenAt && waking.selected === selected) return waking.work;
  const work = (async () => {
    await (backgroundStartup ? openInPreferredBrowser(url, { backgroundStartup: true }) : openInPreferredBrowser(url));
  })();
  const attempt = { lastSeenAt: browser.lastSeenAt, selected, work, failed: false, finished: false };
  waking = attempt;
  try { await work; } catch (error) { attempt.failed = true; throw error; } finally { attempt.finished = true; }
}
export function resetBrowserStartupForTests(): void { waking = null; }
