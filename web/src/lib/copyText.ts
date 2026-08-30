/**
 * Copy to the clipboard, both ways, because one of them is missing where it is most wanted.
 *
 * navigator.clipboard exists only in a secure context, and the QR panel by definition shows
 * itself on a LAN address — which over plain http is not one. So the API this reaches for first
 * is undefined precisely when that panel is on screen, and its button was silently doing nothing
 * every time it shipped. The deprecated execCommand path is what still works there.
 *
 * In lib rather than beside that panel because it is no longer only that panel's problem: a
 * window opened onto one message offers the same thing, and the desktop shell is served over
 * plain http too.
 *
 * Returns whether it worked, so the caller can say 'Copied' only when something was.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused or the document was not focused. Fall through and try the old way.
    }
  }

  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  // Off screen rather than hidden: execCommand copies from a selection, and a field with
  // display:none or visibility:hidden cannot hold one.
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.top = '-9999px';
  document.body.appendChild(field);

  try {
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
