'use client';
import { useEffect, useRef, useState } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, keymap, drawSelection, rectangularSelection } from '@codemirror/view';
import { foldGutter, foldKeymap, syntaxHighlighting, defaultHighlightStyle, bracketMatching, StreamLanguage } from '@codemirror/language';
import { search, searchKeymap, openSearchPanel, highlightSelectionMatches } from '@codemirror/search';
import { defaultKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { scala, java, c, cpp, kotlin } from '@codemirror/legacy-modes/mode/clike';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { xml } from '@codemirror/legacy-modes/mode/xml';
import { css } from '@codemirror/legacy-modes/mode/css';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { go } from '@codemirror/legacy-modes/mode/go';
import { oneDark } from '@codemirror/theme-one-dark';
import { Copy, Search, WrapText, Moon, Sun } from 'lucide-react';
import { usePreviewState } from './preview-state';

const aliases: Record<string, string> = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', jsonl: 'json', sql: 'sql', scala: 'scala', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', kt: 'kotlin', kts: 'kotlin', rs: 'rust', go: 'go', sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml', html: 'xml', htm: 'xml', svg: 'xml', xml: 'xml', css: 'css', scss: 'css', json: 'json' };
const legacy = { scala, java, c, cpp, kotlin, shell, yaml, xml, css, rust, go };
function languageExtension(language: string) {
  if (language === 'javascript') return javascript({ jsx: true });
  if (language === 'typescript') return javascript({ typescript: true, jsx: true });
  if (language === 'python') return python();
  if (language === 'sql') return sql();
  if (language === 'json') return json();
  return language in legacy ? StreamLanguage.define(legacy[language as keyof typeof legacy]) : [];
}
export default function PreviewCode({ text, extension, id, encoding }: { text: string; extension: string; id: string; encoding: string }) {
  const [language, setLanguage] = useState(aliases[extension] || 'plain');
  const [wrap, setWrap] = usePreviewState(id, 'wrap', false);
  const [dark, setDark] = usePreviewState('preferences', 'code-dark', false);
  const [formatted, setFormatted] = useState(false); const [message, setMessage] = useState('');
  const [position, setPosition] = useState({ line: 1, column: 1 }); const [jump, setJump] = useState('');
  const host = useRef<HTMLDivElement>(null); const editor = useRef<EditorView | null>(null);
  const compartments = useRef({ language: new Compartment(), wrap: new Compartment(), theme: new Compartment() });
  let source = text; let jsonError = '';
  if (formatted) try { source = JSON.stringify(JSON.parse(text), null, 2); } catch { jsonError = 'This preview is not complete, valid JSON. Showing the original source.'; }
  useEffect(() => {
    const view = new EditorView({ parent: host.current!, state: EditorState.create({ doc: source, extensions: [
      EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(), rectangularSelection(),
      foldGutter(), bracketMatching(), highlightSelectionMatches(), search({ top: true }), keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
      compartments.current.language.of(languageExtension(language)), compartments.current.wrap.of(wrap ? EditorView.lineWrapping : []),
      compartments.current.theme.of(dark ? oneDark : syntaxHighlighting(defaultHighlightStyle)),
      EditorView.contentAttributes.of({ 'aria-label': 'Read-only file source', role: 'textbox', 'aria-readonly': 'true' }),
      EditorView.theme({ '&': { height: '100%', fontSize: '13px' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.7' }, '.cm-content': { padding: '14px 0' }, '.cm-gutters': { borderRight: '1px solid #e3e9e2' }, '&.cm-focused': { outline: 'none' } }),
      EditorView.updateListener.of(update => {
        if (update.selectionSet) { const head = update.state.selection.main.head; const line = update.state.doc.lineAt(head); setPosition({ line: line.number, column: head - line.from + 1 }); }
      })
    ] }) }); editor.current = view;
    try { const saved = Number(sessionStorage.getItem(`pd-preview:${id}:code-scroll`)); if (Number.isFinite(saved)) requestAnimationFrame(() => { view.scrollDOM.scrollTop = saved; }); } catch {}
    return () => { try { sessionStorage.setItem(`pd-preview:${id}:code-scroll`, String(view.scrollDOM.scrollTop)); } catch {} view.destroy(); editor.current = null; };
  }, [source, id]);
  useEffect(() => { editor.current?.dispatch({ effects: [compartments.current.language.reconfigure(languageExtension(language)), compartments.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []), compartments.current.theme.reconfigure(dark ? oneDark : syntaxHighlighting(defaultHighlightStyle))] }); }, [language, wrap, dark, source]);
  async function copy() { try { const selected = editor.current?.state.sliceDoc(editor.current.state.selection.main.from, editor.current.state.selection.main.to); await navigator.clipboard.writeText(selected || source); setMessage(selected ? 'Selection copied' : 'Source copied'); } catch { setMessage('Select the source and use your device’s Copy command.'); } }
  function goToLine(event: React.FormEvent) { event.preventDefault(); const view = editor.current; if (!view) return; const number = Math.floor(Number(jump)); if (!Number.isFinite(number) || number < 1 || number > view.state.doc.lines) { setMessage(`Enter a line from 1 to ${view.state.doc.lines}.`); return; } const line = view.state.doc.line(number); view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) }); view.focus(); }
  return <div className={`pro-code-view${dark ? ' dark' : ''}`}>
    <div className="preview-view-tools code-tools"><select aria-label="Code language" value={language} onChange={e => setLanguage(e.target.value)}>{['plain', 'javascript', 'typescript', 'python', 'sql', 'json', ...Object.keys(legacy)].map(name => <option key={name} value={name}>{name === 'plain' ? 'Plain text' : name}</option>)}</select>
      <button className="preview-tool" onClick={() => { if (editor.current) { openSearchPanel(editor.current); editor.current.focus(); } }}><Search size={15} />Find</button>
      <button className="preview-tool" aria-pressed={wrap} onClick={() => setWrap(!wrap)}><WrapText size={15} />Wrap</button>
      <button className="preview-tool" aria-label={dark ? 'Use light code theme' : 'Use dark code theme'} onClick={() => setDark(!dark)}>{dark ? <Sun size={15} /> : <Moon size={15} />}</button>
      {extension === 'json' && <button className="preview-tool" aria-pressed={formatted} onClick={() => setFormatted(!formatted)}>{formatted ? 'Raw JSON' : 'Format JSON'}</button>}
      <button className="preview-tool" onClick={copy}><Copy size={15} />Copy</button><form className="code-jump" onSubmit={goToLine}><input aria-label="Go to line" type="number" min="1" value={jump} onChange={e => setJump(e.target.value)} placeholder="Line" /><button className="preview-tool">Go</button></form>
    </div>{jsonError && <p className="preview-notice">{jsonError}</p>}<div ref={host} className="pro-code-editor" role="region" aria-label="File source" />
    <div className="code-status"><span>Ln {position.line}, Col {position.column} · {source.split('\n').length.toLocaleString()} lines · {encoding.toUpperCase()}</span><span role="status">{message || 'Read only · Ctrl/⌘ F to find'}</span></div>
  </div>;
}
