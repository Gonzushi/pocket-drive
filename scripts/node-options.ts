// Keep every unique preload and all other Node options. Next.js 16.3.8
// incorrectly merges repeated --require values into one module filename.
export function deduplicatePreloads(options = '') {
  const tokens = options.match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g) || [];
  const decode = (token: string) =>
    token.replace(/"((?:\\.|[^"\\])*)"/g, (_match: string, value: string) =>
      value.replace(/\\(["\\])/g, '$1'),
    );
  const seen = new Set<string>();
  const kept: string[] = [];
  let removed = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = decode(tokens[i]);
    let preloadModule: string | undefined;
    let nextToken = false;
    if (token === '--require' || token === '-r') {
      if (i + 1 < tokens.length) {
        preloadModule = decode(tokens[i + 1]);
        nextToken = true;
      }
    } else if (token.startsWith('--require=')) preloadModule = token.slice(10);
    else if (token.startsWith('-r=')) preloadModule = token.slice(3);
    if (preloadModule !== undefined) {
      if (seen.has(preloadModule)) {
        removed++;
        if (nextToken) i++;
        continue;
      }
      seen.add(preloadModule);
      kept.push(tokens[i]);
      if (nextToken) kept.push(tokens[++i]);
    } else kept.push(tokens[i]);
  }
  return { options: removed ? kept.join(' ') : options, removed };
}
