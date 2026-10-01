import { useLayoutEffect, useRef } from "react";

/** Keep a complete financial figure visible in compact summary tiles. */
export function FittedValue({ value, className }: { value: string; className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const outer = container.current;
    const inner = text.current;
    if (!outer || !inner) return;
    let alive = true;
    let lastWidth = -1;
    const fit = () => {
      if (!alive || outer.clientWidth <= 0) return;
      const base = Number.parseFloat(getComputedStyle(outer).fontSize);
      inner.style.fontSize = `${base}px`;
      const width = inner.getBoundingClientRect().width;
      if (width > outer.clientWidth) {
        inner.style.fontSize = `${Math.floor(base * outer.clientWidth / width * 100) / 100}px`;
      }
    };
    const observer = new ResizeObserver(() => {
      if (outer.clientWidth === lastWidth) return;
      lastWidth = outer.clientWidth;
      fit();
    });
    observer.observe(outer);
    fit();
    void document.fonts.ready.then(fit);
    return () => { alive = false; observer.disconnect(); };
  }, [value, className]);

  return <div ref={container} className={className} data-fitted-value>
    <span ref={text} className="inline-block whitespace-nowrap">{value}</span>
  </div>;
}
