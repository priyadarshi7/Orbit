import { useState } from "react";
import { Link } from "react-router";
import type { ConversationSummary } from "@/lib/api";
import { Brand } from "@/components/ui/Brand";
import { Icon } from "@/components/ui/Icon";

function group(list: ConversationSummary[]): [string, ConversationSummary[]][] {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const week = Date.now() - 7 * 86_400_000;
  const buckets = new Map<string, ConversationSummary[]>();
  for (const c of list) {
    const d = new Date(c.updatedAt);
    const k = d.toDateString() === today ? "Today" : d.toDateString() === yesterday ? "Yesterday" : d.getTime() > week ? "Previous 7 days" : "Older";
    buckets.set(k, [...(buckets.get(k) ?? []), c]);
  }
  return ["Today", "Yesterday", "Previous 7 days", "Older"].filter((k) => buckets.has(k)).map((k) => [k, buckets.get(k)!]);
}

interface Props {
  open: boolean;
  list: ConversationSummary[];
  activeId: string;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onMemory: () => void;
  onClose: () => void;
}

const navItem = "flex h-[34px] items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-muted no-underline hover:bg-hover hover:text-fg";

export function Sidebar({ open, list, activeId, onNew, onOpen, onDelete, onMemory, onClose }: Props) {
  const [q, setQ] = useState("");
  const shown = q.trim() ? list.filter((c) => c.title.toLowerCase().includes(q.trim().toLowerCase())) : list;

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-scrim md:hidden" onClick={onClose} />}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex min-h-0 w-[280px] flex-col gap-2 border-r border-line bg-side px-2 py-3 transition-transform md:static md:w-auto md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="px-2 pb-2.5 pt-1">
          <Brand />
        </div>
        <button
          onClick={onNew}
          className="flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-canvas px-2.5 text-sm font-medium shadow-card transition-colors hover:bg-hover"
        >
          <Icon.plus /> New chat
        </button>
        {list.length > 5 && (
          <label className="flex h-[34px] items-center gap-2 rounded-lg border border-line bg-canvas px-2.5 text-faint focus-within:border-line-strong">
            <Icon.search />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-faint"
            />
          </label>
        )}
        <nav className="min-h-0 flex-1 overflow-y-auto" aria-label="Conversations">
          {group(shown).map(([label, items]) => (
            <div key={label}>
              <div className="px-2.5 pb-1 pt-3.5 text-[11.5px] font-medium text-faint">{label}</div>
              {items.map((c) => (
                <div key={c.id} className={`group flex items-center rounded-lg ${c.id === activeId ? "bg-active" : "hover:bg-hover"}`}>
                  <button
                    onClick={() => onOpen(c.id)}
                    title={c.title}
                    className={`min-w-0 flex-1 truncate px-2.5 py-[7px] text-left text-sm ${c.id === activeId ? "text-fg" : "text-fg-2"}`}
                  >
                    {c.title}
                  </button>
                  <button
                    aria-label={`Delete ${c.title}`}
                    onClick={() => onDelete(c.id)}
                    className="mr-1 grid size-[26px] place-items-center rounded-md text-faint opacity-0 hover:bg-bad-bg hover:text-bad focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Icon.x />
                  </button>
                </div>
              ))}
            </div>
          ))}
          {list.length === 0 && <p className="p-2.5 text-sm text-muted">No chats yet.</p>}
          {list.length > 0 && shown.length === 0 && <p className="p-2.5 text-sm text-muted">No matches.</p>}
        </nav>
        <div className="grid gap-0.5 border-t border-line pt-2">
          <button className={navItem} onClick={onMemory}>
            <Icon.brain /> Memory
          </button>
          <Link className={navItem} to="/benchmark">
            <Icon.chart /> Benchmarks
          </Link>
        </div>
      </aside>
    </>
  );
}
