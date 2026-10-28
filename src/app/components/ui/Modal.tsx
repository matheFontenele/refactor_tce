"use client";

import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Modal acessível: portal, foco preso, Esc, retorno de foco e fundo inerte.
 * O conteúdo é montado apenas quando o modal está aberto pelo chamador.
 */
export function Modal({
  onClose,
  labelledBy,
  children,
  className,
  overlayClassName,
}: {
  onClose: () => void;
  labelledBy: string;
  children: React.ReactNode;
  className?: string;
  overlayClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const shell = document.getElementById("app-shell");
    const previousOverflow = document.body.style.overflow;

    shell?.setAttribute("inert", "");
    document.body.style.overflow = "hidden";

    const panel = panelRef.current;
    const frame = window.requestAnimationFrame(() => panel?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;

      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      shell?.removeAttribute("inert");
      previousFocus?.focus();
    };
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={cx(
        "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm",
        overlayClassName,
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cx(
          "max-h-[90vh] w-full overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-slate-950/80 focus:outline-none",
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
