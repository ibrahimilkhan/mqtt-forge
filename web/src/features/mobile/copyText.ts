/**
 * Copy to the clipboard, in a panel that is only ever open where the modern way is unavailable.
 *
 * navigator.clipboard exists only in a secure context, and the QR panel by definition shows
 * itself on a LAN address — which over plain http is not one. So the API this would reach for
 * first is undefined precisely when the panel is on screen, and the button was silently doing
 * nothing every time it shipped. The deprecated execCommand path is what still works there.
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
