/**
 * Keep the browser from offering what was typed into a box before.
 *
 * Every box in this console is a topic, a filter, a payload, a number or a name, and the list the
 * browser drops under it is whatever was typed into any box of the same name on this origin — a
 * topic from last week's broker under today's filter, a payload under a rule's name. It covers the
 * very field being filled in, and it is not this console's memory: the recent brokers, the topic
 * tree and the pickers are the suggestions that know what they are suggesting.
 *
 * Set at focus rather than written on each of eighty-odd boxes, so a box added next month is
 * covered without anybody remembering to. A box that already says what it wants keeps it.
 */
export function stopAutofill(root: Document): () => void {
  const quiet = (event: FocusEvent) => {
    const target = event.target;

    if (
      (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
      !target.hasAttribute('autocomplete')
    ) {
      target.setAttribute('autocomplete', 'off');
    }
  };

  // Capture, so the attribute is in place before anything the focus itself sets off.
  root.addEventListener('focusin', quiet, true);

  return () => root.removeEventListener('focusin', quiet, true);
}
