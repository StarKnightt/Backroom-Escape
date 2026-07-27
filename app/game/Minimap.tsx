"use client";

import { useEffect, useRef } from "react";
import type { MinimapState } from "./engine/Engine";

const SIZE = 190; // px, drawn map square
const PAD = 8;

/** Dev cheat overlay — only rendered while the "map" cheat is on (redrum -> M). */
export default function Minimap({ data }: { data: MinimapState | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio, 2) : 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    const half = data.halfExtent;
    const area = SIZE - PAD * 2;
    const toCanvas = (x: number, z: number) => ({
      cx: PAD + ((x + half) / (half * 2)) * area,
      cy: PAD + ((z + half) / (half * 2)) * area,
    });

    // walls — thin, dense lines, the whole maze at once (QR-code density)
    ctx.strokeStyle = "rgba(255, 225, 170, 0.5)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let i = 0; i < data.walls.length; i += 4) {
      const a = toCanvas(data.walls[i], data.walls[i + 1]);
      const b = toCanvas(data.walls[i + 2], data.walls[i + 3]);
      ctx.moveTo(a.cx, a.cy);
      ctx.lineTo(b.cx, b.cy);
    }
    ctx.stroke();

    // pillars — tiny flecks
    ctx.fillStyle = "rgba(255, 225, 170, 0.35)";
    for (let i = 0; i < data.pillars.length; i += 2) {
      const c = toCanvas(data.pillars[i], data.pillars[i + 1]);
      ctx.fillRect(c.cx - 0.5, c.cy - 0.5, 1, 1);
    }

    // exit — a green bar, brighter once unlocked
    const exitC = toCanvas(data.exit.x, data.exit.z);
    ctx.save();
    ctx.translate(exitC.cx, exitC.cy);
    ctx.fillStyle = data.exit.open ? "rgba(80, 255, 150, 0.95)" : "rgba(60, 200, 120, 0.55)";
    ctx.shadowColor = data.exit.open ? "rgba(80,255,150,0.8)" : "transparent";
    ctx.shadowBlur = data.exit.open ? 8 : 0;
    ctx.fillRect(-6, -2, 12, 4);
    ctx.restore();

    // pages — amber dots, dimmed once collected
    for (const p of data.pages) {
      const c = toCanvas(p.x, p.z);
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, p.collected ? 1.6 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = p.collected ? "rgba(255, 230, 170, 0.25)" : "rgba(255, 225, 150, 0.95)";
      if (!p.collected) {
        ctx.shadowColor = "rgba(255,225,150,0.7)";
        ctx.shadowBlur = 5;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // entity — red dot, only while awake
    if (data.entity) {
      const c = toCanvas(data.entity.x, data.entity.z);
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 60, 60, 0.95)";
      ctx.shadowColor = "rgba(255,40,40,0.85)";
      ctx.shadowBlur = 7;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // player — arrow pointing in facing direction
    const pc = toCanvas(data.player.x, data.player.z);
    const fx = -Math.sin(data.player.yaw);
    const fz = -Math.cos(data.player.yaw);
    const rx = -fz, rz = fx; // perpendicular, for the arrow's back corners
    const tip = { x: pc.cx + fx * 6, y: pc.cy + fz * 6 };
    const back1 = { x: pc.cx - fx * 4 + rx * 4, y: pc.cy - fz * 4 + rz * 4 };
    const back2 = { x: pc.cx - fx * 4 - rx * 4, y: pc.cy - fz * 4 - rz * 4 };
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(back1.x, back1.y);
    ctx.lineTo(back2.x, back2.y);
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.shadowColor = "rgba(255,255,255,0.6)";
    ctx.shadowBlur = 4;
    ctx.fill();
    ctx.shadowBlur = 0;

    // frame
    ctx.strokeStyle = "rgba(255, 225, 170, 0.2)";
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD, PAD, area, area);
  }, [data, dpr]);

  return (
    <div
      className="pointer-events-none absolute right-5 top-4 border border-amber-100/20 bg-black/70 shadow-[0_0_24px_rgba(0,0,0,0.7)]"
      style={{ width: SIZE, height: SIZE }}
    >
      <canvas ref={canvasRef} style={{ width: SIZE, height: SIZE }} className="block" />
    </div>
  );
}
