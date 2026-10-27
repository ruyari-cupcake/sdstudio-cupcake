const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Encode prompt text once at its final HTML text or quoted-attribute boundary. */
export function escapePromptHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

/**
 * The tooltip keeps the original piece spelling, including quotes and entities.
 * JSON first quotes the JavaScript string; HTML encoding then protects the
 * surrounding attribute. Browser decoding reverses only the outer layer.
 */
export function promptTooltipAttributes(piece: string): string {
  const handler = `window.promptService.showPromptTooltip(${JSON.stringify(piece)}, event)`;
  return `onmousemove="${escapePromptHtml(handler)}" onmouseout="window.promptService.clearPromptTooltip()"`;
}
