import { useCallback, type KeyboardEvent } from 'react';
import { studioStore } from './studioStore';

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * The studio's keys, handled on its own root element rather than the window. DesignBox listened on
 * the window, which in the console would delete a part while someone typed in the publish box.
 */
export function useStudioShortcuts({ focus }: { focus: () => void }) {
  return useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (TYPING.has(target.tagName) || target.isContentEditable) return;

      const s = studioStore.getState();
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      let handled = true;

      // A reader who selected the placeholder note, or any other page text, is reaching for the
      // browser's own copy — stealing Ctrl+C into the object clipboard would silently drop it.
      const textSelected = !!window.getSelection()?.toString();

      if (mod && key === 'z' && !event.shiftKey) s.undo();
      else if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) s.redo();
      else if (mod && key === 'd') s.duplicate(s.selection);
      else if (mod && key === 'c' && textSelected) handled = false;
      else if (mod && key === 'c') s.copy(s.selection);
      else if (mod && key === 'v') s.paste();
      else if (mod) handled = false;
      else if (key === 'q') s.setTool('select');
      else if (key === 'w') s.setTool('move');
      else if (key === 'e') s.setTool('rotate');
      else if (key === 'r') s.setTool('scale');
      else if (key === 'f') focus();
      else if (key === 'escape') s.select([]);
      else if (key === 'delete' || key === 'backspace') s.removeObjects(s.selection);
      else handled = false;

      if (handled) event.preventDefault();
    },
    [focus],
  );
}
