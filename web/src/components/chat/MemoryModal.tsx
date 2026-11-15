import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type MemoryView } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/Button";

function Heading({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-2 mt-6">
      <h3 className="text-xs font-medium text-faint">{children}</h3>
      {hint && <p className="mt-0.5 text-[12.5px] text-faint">{hint}</p>}
    </div>
  );
}

function Forget({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      aria-label={`Forget ${label}`}
      title="Forget this"
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-md text-faint opacity-60 hover:bg-bad-bg hover:text-bad hover:opacity-100"
    >
      <Icon.x className="size-3.5" />
    </button>
  );
}

export function MemoryModal({ onClose }: { onClose: () => void }) {
  const [m, setM] = useState<MemoryView | null>(null);
  const [err, setErr] = useState(false);

  const load = useCallback(() => {
    api.memory().then(setM).catch(() => setErr(true));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const forgetFact = (id: number) => void api.deleteFact(id).then(load).catch(() => setErr(true));
  const forgetClaim = (id: number) => void api.deleteClaim(id).then(load).catch(() => setErr(true));

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4 backdrop-blur-[3px]" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Memory"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-[720px] animate-fade overflow-y-auto rounded-2xl border border-line-strong bg-surface px-6 pb-6 pt-5 shadow-pop"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-extrabold tracking-tight">What Orbit remembers</h2>
          <IconButton label="Close" onClick={onClose}>
            <Icon.x />
          </IconButton>
        </div>
        <p className="mt-1 text-[13.5px] text-muted">This is everything stored about you and your earlier chats. Remove anything you don't want kept.</p>
        {err && <p className="mt-3 text-sm text-bad">Something went wrong. Try again.</p>}
        {!m && !err && <p className="mt-3 text-muted">Loading…</p>}
        {m && (
          <>
            <Heading>About you</Heading>
            {m.profile.length ? (
              <ul className="m-0 grid list-none gap-1 p-0 text-sm">
                {m.profile.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1 hover:bg-hover">
                    <span>
                      {f.fact}
                      {f.previous ? <span className="ml-2 text-xs text-faint">was: {f.previous}</span> : null}
                    </span>
                    <Forget label={f.fact} onClick={() => forgetFact(f.id)} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nothing yet.</p>
            )}

            <Heading>Recent chats</Heading>
            {m.recent.length ? (
              <ul className="list-disc pl-[18px] text-sm">
                {m.recent.map((e) => (
                  <li key={e.id} className="my-1">
                    <b>{e.localDate}</b> {e.summary}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nothing yet. Memory is written after each answer.</p>
            )}

            <Heading hint="Dated facts from answers. When one changes, you see what it was before.">Recorded facts</Heading>
            {m.claims.length ? (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="text-left text-faint">
                      {["Subject", "Fact", "Value", "As of", ""].map((h, i) => (
                        <th key={i} className="border-b border-line bg-surface-2/50 px-2.5 py-2 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {m.claims.map((c) => (
                      <tr key={c.id} className="align-top">
                        <td className="border-b border-line px-2.5 py-2">{c.subject}</td>
                        <td className="border-b border-line px-2.5 py-2">{c.attribute}</td>
                        <td className="border-b border-line px-2.5 py-2">
                          {c.value}
                          {c.previous && (
                            <span className="mt-0.5 block text-xs text-warn">
                              changed, was {c.previous.value} ({c.previous.asOf})
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap border-b border-line px-2.5 py-2">{c.asOf}</td>
                        <td className="border-b border-line px-1 py-1.5">
                          <Forget label={`${c.subject} ${c.attribute}`} onClick={() => forgetClaim(c.id)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted">No dated facts recorded yet.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
