import { useEffect } from 'react';

// Double-clicking a line of explanation should hand back that line. Left to itself the browser
// widens from the word outward and, with grid and flex panes either side of the text, finds no
// boundary to stop at — so the rest of the page comes along. Every <p> here is prose meant to be
// read and copied whole, so we claim the second press before that widening starts and take the
// paragraph exactly. Anything else double-clicked keeps the browser's own behaviour.
export function useProseSelection() {
  useEffect(() => {
    const takeParagraph = (event: MouseEvent) => {
      if (event.detail < 2) return;

      const target = event.target;
      const paragraph = target instanceof Element ? target.closest('p') : null;
      if (!paragraph) return;

      const selection = window.getSelection();
      if (!selection) return;

      // The press is what the browser expands from; refusing it keeps the widening from running.
      event.preventDefault();

      const range = document.createRange();
      range.selectNodeContents(paragraph);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    document.addEventListener('mousedown', takeParagraph);
    return () => document.removeEventListener('mousedown', takeParagraph);
  }, []);
}
