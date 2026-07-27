"use client";

import { useEffect, useRef } from "react";
import { Engine, EngineCallbacks } from "./engine/Engine";

interface Props {
  callbacksRef: React.RefObject<EngineCallbacks>;
  onReady: (engine: Engine) => void;
}

export default function GameCanvas({ callbacksRef, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    let engine: Engine | null = null;
    // Defer construction one frame so the menu paints before level generation.
    const raf = requestAnimationFrame(() => {
      engine = new Engine(container, canvas, {
        onState: (s) => callbacksRef.current?.onState(s),
        onHud: (h) => callbacksRef.current?.onHud(h),
        onMinimap: (m) => callbacksRef.current?.onMinimap(m),
        onPageText: (l) => callbacksRef.current?.onPageText(l),
        onStats: (s) => callbacksRef.current?.onStats(s),
        onToast: (m) => callbacksRef.current?.onToast(m),
      });
      if (process.env.NODE_ENV !== "production") {
        (window as unknown as Record<string, unknown>).__backrooms = engine;
      }
      onReady(engine);
    });

    return () => {
      cancelAnimationFrame(raf);
      engine?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- engine lives for the lifetime of this mount (keyed remount per run)
  }, []);

  return (
    <div ref={containerRef} className="absolute inset-0">
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
