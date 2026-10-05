import { useEffect } from 'react';
import { WINDOW_TITLE } from '../shell/shell';
import type { LinkState } from './linkState';

const NAME = 'MQTTForge';

/**
 * The title for a link: the app's name, and what the link is doing.
 *
 * Just the address when there is a link, because an address in a title bar reads as 'this is where
 * I am' already, and a word in front of it is a word a narrow taskbar cuts the address off for.
 * Every other state says itself in words, the address after them when there is one to name.
 *
 * Only the name before the API has answered: the Disconnected the console stands in with until
 * then is a guess, and a title built on it would say 'not connected' over a live link for the
 * first beat of every reload — the broker panel's chip holds back for the same reason.
 */
export function titleFor(state: LinkState, pointedAt: string | undefined, answered: boolean): string {
  if (!answered) return NAME;

  const to = pointedAt ? ` to ${pointedAt}` : '';
  switch (state) {
    case 'Connected':
      return `${NAME} — ${pointedAt ?? 'connected'}`;
    case 'Waiting':
      return `${NAME} — connecting${to}`;
    case 'Retrying':
      return `${NAME} — reconnecting${to}`;
    case 'Faulted':
      return `${NAME} — connection faulted${pointedAt ? ` · ${pointedAt}` : ''}`;
    case 'Reconnecting':
      // The console's own server gone: nothing it says about the broker is current, so it names
      // no broker.
      return `${NAME} — console offline`;
    case 'Disconnected':
      return `${NAME} — not connected`;
  }
}

type Host = { sendMessage?: (message: string) => void };

/**
 * Keeps the title saying the link: the document's, which is the tab in a browser, and the desktop
 * window's, which does not follow the document by itself — WebView2 reports a title change and
 * Photino passes none of it on, so the page hands the title over as a message instead (see
 * src/MqttForge.Desktop/WindowTitle.cs). A title bar, a taskbar button and Alt+Tab are where a
 * reader looks for a window they are not looking at.
 */
export function useWindowTitle(state: LinkState, pointedAt: string | undefined, answered: boolean) {
  const title = titleFor(state, pointedAt, answered);

  useEffect(() => {
    document.title = title;

    // Photino's bridge, on Windows and macOS alike. A browser has a window.external too — a
    // leftover with no sendMessage on it — so the method is what is checked for, not the object.
    const host = window.external as unknown as Host | undefined;
    if (typeof host?.sendMessage === 'function') host.sendMessage(`${WINDOW_TITLE}${title}`);
  }, [title]);
}
