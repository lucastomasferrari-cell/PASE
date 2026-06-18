import { useEffect } from "react";

/** Deep-link a una fila de una lista. Cuando llega `?focus=<id>` y la lista ya
 *  cargó (`ready`), scrollea hasta la fila con id DOM `${prefix}${focusId}` y le
 *  aplica un parpadeo (clase `.row-focus-flash`). No usa React state: togglea la
 *  clase directo sobre el nodo, así no dispara re-renders ni el warning
 *  react-hooks/set-state-in-effect. */
export function useFocusRow(focusId: string | null, ready: boolean, prefix: string): void {
  useEffect(() => {
    if (!focusId || !ready) return;
    const el = document.getElementById(prefix + focusId);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("row-focus-flash");
    const t = setTimeout(() => el.classList.remove("row-focus-flash"), 2800);
    return () => { clearTimeout(t); el.classList.remove("row-focus-flash"); };
  }, [focusId, ready, prefix]);
}
