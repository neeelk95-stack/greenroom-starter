import Link from "next/link";
import { Logomark } from "@/components/brand/logo";
import { NavLinks } from "./nav-links";

export function Sidebar() {
  return (
    <aside className="hidden md:flex w-[248px] shrink-0 border-r border-ink-200/60 bg-canvas-soft flex-col sticky top-0 h-screen overflow-y-auto z-10">
      <div className="px-5 pt-6 pb-5">
        <Link href="/shows" className="flex items-center gap-2.5">
          <Logomark size={28} />
          <div>
            <div
              className="font-display text-ink-900 leading-none"
              style={{ fontSize: 15, fontWeight: 500, letterSpacing: "-0.02em" }}
            >
              Greenroom
            </div>
            <div className="text-[9.5px] text-ink-400 mt-1 leading-none uppercase tracking-[0.1em]">
              v3.4 · The Crescent
            </div>
          </div>
        </Link>
      </div>

      <nav className="flex-1 px-2.5 space-y-0.5">
        <NavLinks />
      </nav>

      <div className="px-4 py-3 border-t border-ink-200/60 flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-ink-600 to-ink-900 flex items-center justify-center text-white text-[10px] font-medium">
          E
        </div>
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-ink-900 leading-tight truncate">
            Ethan
          </div>
          <div className="text-[10px] text-ink-400 leading-tight">
            Lead Booker
          </div>
        </div>
      </div>
    </aside>
  );
}
