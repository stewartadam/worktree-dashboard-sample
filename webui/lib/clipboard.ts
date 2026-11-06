/**
 * Clipboard access that also works when the page is loaded over plain HTTP from
 * another device, where browsers withhold `navigator.clipboard`.
 */

/**
 * Copies text through a temporary selection, the only copy path browsers allow
 * outside secure contexts.
 */
function copyWithSelection(text: string): boolean {
  const previousFocus = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } finally {
    textarea.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
}

/**
 * Writes text to the system clipboard, falling back to a selection-based copy
 * when the async Clipboard API is missing. Rejects when neither path works.
 */
export async function writeClipboardText(text: string): Promise<void> {
  // Browsers only expose this in secure contexts, despite the DOM typings.
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard) {
    await clipboard.writeText(text);
    return;
  }
  if (!copyWithSelection(text)) {
    throw new Error("Clipboard access unavailable");
  }
}
