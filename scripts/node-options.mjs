// Keep every unique preload and all other Node options. Next.js 16.3.8
// incorrectly merges repeated --require values into one module filename.
export function deduplicatePreloads(options = '') {
  const tokens = options.match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g) || [];
  const decode = token => token.replace(/"((?:\\.|[^"\\])*)"/g,
    (_, value) => value.replace(/\\(["\\])/g, '$1'));
  const seen = new Set();
  const kept = [];
  let removed = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = decode(tokens[i]);
    let module; let nextToken = false;
    if (token === '--require' || token === '-r') {
      if (i + 1 < tokens.length) { module = decode(tokens[i + 1]); nextToken = true; }
    } else if (token.startsWith('--require=')) module = token.slice(10);
    else if (token.startsWith('-r=')) module = token.slice(3);
    if (module !== undefined) {
      if (seen.has(module)) {
        removed++;
        if (nextToken) i++;
        continue;
      }
      seen.add(module);
      kept.push(tokens[i]);
      if (nextToken) kept.push(tokens[++i]);
    } else kept.push(tokens[i]);
  }
  return { options: removed ? kept.join(' ') : options, removed };
}
