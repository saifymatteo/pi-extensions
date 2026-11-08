// Explicit host stub; Markdown itself is the real pi-tui component.
export const markdownHost = {
  getMarkdownTheme: () => Object.fromEntries([
    'heading', 'link', 'linkUrl', 'code', 'codeBlock', 'codeBlockBorder', 'quote',
    'quoteBorder', 'hr', 'listBullet', 'bold', 'italic', 'strikethrough', 'underline',
  ].map(token => [token, text => token === 'bold' ? `\x1b[1m${text}\x1b[22m`
    : token === 'italic' ? `\x1b[3m${text}\x1b[23m`
    : token === 'codeBlock' ? `\x1b[32m${text}\x1b[39m` : text])),
};
