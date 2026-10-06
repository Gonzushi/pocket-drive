'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Eye, FolderInput, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import type { DriveItem } from '@/lib/shared/types';
export default function ItemMenu({
  item,
  onRename,
  onMove,
  onDelete,
  onPreview,
}: {
  item: DriveItem;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  onPreview?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    ref.current?.querySelector<HTMLButtonElement>('.item-menu button')?.focus();
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <div className="item-menu-wrap" ref={ref}>
      <button
        ref={trigger}
        className="icon-button"
        aria-label={`Actions for ${item.name}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={20} />
      </button>
      {open && (
        <div className="item-menu" aria-label={`Actions for ${item.name}`}>
          {onPreview && (
            <button onClick={() => run(onPreview)}>
              <Eye size={16} />
              Preview
            </button>
          )}
          <button onClick={() => run(onMove)}>
            <FolderInput size={16} />
            Move to…
          </button>
          <button onClick={() => run(onRename)}>
            <Pencil size={16} />
            Rename
          </button>
          <a
            href={`/api/${item.type === 'folder' ? 'folders' : 'files'}/${item.id}/download`}
            onClick={() => setOpen(false)}
          >
            <ArrowDownToLine size={16} />
            {item.type === 'folder' ? 'Download as ZIP' : 'Download'}
          </a>
          <button className="error-text" onClick={() => run(onDelete)}>
            <Trash2 size={16} />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
