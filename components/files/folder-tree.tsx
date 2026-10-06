'use client';
import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, FolderClosed, Home, LoaderCircle } from 'lucide-react';
import { useExplorer } from './explorer-context';
export default function FolderTree({ onNavigate }: { onNavigate?: () => void }) {
  const { folders, folderId, navigate, treeLoading, treeError, refreshTree } = useExplorer();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const children = useMemo(() => {
    const result = new Map<string, typeof folders>();
    for (const folder of folders) {
      const parent = folder.parent_id || 'root';
      result.set(parent, [...(result.get(parent) || []), folder]);
    }
    return result;
  }, [folders]);
  useEffect(() => {
    const parents = new Map(folders.map((folder) => [folder.id, folder.parent_id]));
    const ancestors: string[] = [];
    let current = parents.get(folderId);
    while (current && ancestors.length < 32) {
      ancestors.push(current);
      current = parents.get(current);
    }
    setExpanded((old) => new Set([...old, ...ancestors]));
  }, [folders, folderId]);
  const open = (id: string) => {
    navigate(id);
    onNavigate?.();
  };
  function render(parent: string, depth: number): React.ReactNode {
    if (depth > 32) return null;
    return (children.get(parent) || []).map((folder) => (
      <div key={folder.id}>
        <div
          className={`tree-row ${folderId === folder.id ? 'current' : ''}`}
          style={{ paddingLeft: 4 + depth * 12 }}
        >
          <button
            className="tree-toggle"
            aria-label={`${expanded.has(folder.id) ? 'Collapse' : 'Expand'} ${folder.name}`}
            disabled={!children.has(folder.id)}
            aria-expanded={children.has(folder.id) ? expanded.has(folder.id) : undefined}
            onClick={() =>
              setExpanded((old) => {
                const next = new Set(old);
                if (next.has(folder.id)) next.delete(folder.id);
                else next.add(folder.id);
                return next;
              })
            }
          >
            <ChevronRight size={13} className={expanded.has(folder.id) ? 'expanded' : ''} />
          </button>
          <button
            className="tree-link"
            title={folder.name}
            aria-current={folderId === folder.id ? 'page' : undefined}
            onClick={() => open(folder.id)}
          >
            <FolderClosed size={15} />
            <span>{folder.name}</span>
          </button>
        </div>
        {expanded.has(folder.id) && render(folder.id, depth + 1)}
      </div>
    ));
  }
  return (
    <div className="folder-tree">
      <div className="tree-label">FOLDERS</div>
      <button
        className={`tree-home ${folderId === 'root' ? 'current' : ''}`}
        onClick={() => open('root')}
      >
        <Home size={15} />
        My files
      </button>
      {treeError ? (
        <p className="small error-text" role="alert">
          {treeError}
          <button className="text-button" onClick={refreshTree}>
            Retry
          </button>
        </p>
      ) : treeLoading && !folders.length ? (
        <p className="tree-empty">
          <LoaderCircle size={13} className="spin" />
          Loading folders…
        </p>
      ) : folders.length ? (
        <nav aria-label="Folder tree">{render('root', 0)}</nav>
      ) : (
        <p className="tree-empty">Your folders will appear here.</p>
      )}
    </div>
  );
}
