"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Engine, EngineCallbacks, GameState, HudState } from "./engine/Engine";

const GameCanvas = dynamic(() => import("./GameCanvas"), { ssr: false });

const INITIAL_HUD: HudState = {
  pages: 0,
  totalPages: 8,
  stamina: 1,
  prompt: null,
  objective: "COLLECT THE PAGES — 0/8",
  flashlight: true,
  sneaking: false,
  cheats: null,
};

export default function GameShell() {
  const engineRef = useRef<Engine | null>(null);
  const autoStartRef = useRef(false);
  const [runId, setRunId] = useState(0);
  const [state, setState] = useState<GameState>("idle");
  const [booted, setBooted] = useState(false);
  const [hud, setHud] = useState<HudState>(INITIAL_HUD);
  const [pageLines, setPageLines] = useState<string[] | null>(null);
  const [stats, setStats] = useState({ pages: 0, seconds: 0 });
  const [toast, setToast] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [banner, setBanner] = useState<{ title: string; hint: string } | null>(null);
  const [showCredits, setShowCredits] = useState(false);
  const isTouch = useMediaQuery("(pointer: coarse)");
  const portrait = useMediaQuery("(orientation: portrait)");

  const bannerKindRef = useRef("");
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTouchRef = useRef(false);
  useEffect(() => {
    isTouchRef.current = isTouch;
  }, [isTouch]);

  const callbacksRef = useRef<EngineCallbacks>({
    onState: (s) => {
      setState(s);
      if (s !== "paused") setResuming(false); // clears "RESUMING…" feedback
    },
    onHud: (h) => {
      setHud(h);
      // Big objective banner whenever the objective *kind* changes (run
      // start, all pages found, door opened) — not on every counter tick.
      // New players were missing the tiny corner text entirely.
      const kind = h.objective.split("—")[0].trim();
      if (kind !== bannerKindRef.current) {
        bannerKindRef.current = kind;
        const hint =
          kind === "COLLECT THE PAGES"
            ? isTouchRef.current
              ? "PINNED TO THE WALLS — GET CLOSE, TAP TAKE PAGE"
              : "PINNED TO THE WALLS — PRESS [E] TO TAKE THEM"
            : kind === "FIND THE EXIT DOOR"
              ? "ALL PAGES FOUND — A DOOR HAS UNLOCKED SOMEWHERE"
              : "THROUGH THE DOOR — RUN";
        setBanner({ title: h.objective, hint });
        if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
        bannerTimerRef.current = setTimeout(() => setBanner(null), 5200);
      }
    },
    onPageText: (lines) => setPageLines(lines),
    onStats: (s) => setStats(s),
    onToast: (m) => setToast(m),
  });

  const handleReady = useCallback((engine: Engine) => {
    engineRef.current = engine;
    setBooted(true);
    if (autoStartRef.current) {
      autoStartRef.current = false;
      engine.start();
    }
  }, []);

  // Page text fades out on its own.
  useEffect(() => {
    if (!pageLines) return;
    const id = setTimeout(() => setPageLines(null), 6500);
    return () => clearTimeout(id);
  }, [pageLines]);

  // Toasts fade out on their own.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  // Rotating to portrait mid-run pauses the game (phones play landscape).
  useEffect(() => {
    if (isTouch && portrait) engineRef.current?.pause();
  }, [isTouch, portrait]);

  const begin = () => engineRef.current?.start();
  const resume = () => {
    setResuming(true);
    engineRef.current?.resume();
  };
  /** Tear down the current run and remount a fresh engine (new maze). */
  const resetRun = (autoStart: boolean) => {
    autoStartRef.current = autoStart;
    setBooted(false);
    setState("idle");
    setHud(INITIAL_HUD);
    setPageLines(null);
    setBanner(null);
    setShowCredits(false);
    bannerKindRef.current = ""; // next run re-announces the objective
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    engineRef.current = null;
    setRunId((r) => r + 1);
  };
  const retry = () => resetRun(true);
  const exitToMenu = () => resetRun(false);

  const mmss = useMemo(() => {
    const m = Math.floor(stats.seconds / 60);
    const s = stats.seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }, [stats.seconds]);

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-black">
      <GameCanvas key={runId} callbacksRef={callbacksRef} onReady={handleReady} />

      {/* dev/cheat toast — sits above everything */}
      {toast && (
        <div className="font-elite pointer-events-none absolute left-1/2 top-[8%] z-20 -translate-x-1/2 border border-emerald-200/20 bg-black/80 px-5 py-2 text-[12px] tracking-[0.25em] text-emerald-100/90 shadow-[0_0_30px_rgba(0,0,0,0.8)]">
          {toast}
        </div>
      )}

      {/* phones must play in landscape */}
      {isTouch && portrait && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-[#0a0905]/97">
          <div className="phone-spin h-16 w-10 rounded-md border-2 border-amber-100/60" />

          <div className="font-elite text-lg tracking-[0.35em] text-amber-100/80">
            ROTATE YOUR DEVICE
          </div>
          <p className="font-elite max-w-xs text-center text-xs leading-5 tracking-[0.15em] text-amber-100/40">
            the backrooms only exist in landscape
          </p>
        </div>
      )}

      {/* touch controls */}
      {isTouch && !portrait && state === "playing" && (
        <TouchControls
          engineRef={engineRef}
          prompt={hud.prompt}
          flashlight={hud.flashlight}
          sneaking={hud.sneaking}
        />
      )}

      {/* ------------------------------ HUD ------------------------------ */}
      {(state === "playing" || state === "dying") && (
        <div className="pointer-events-none absolute inset-0 cursor-none">
          {/* crosshair */}
          <div className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-100/40" />

          {/* objective — bright + glowing so new players actually see it */}
          <div className="font-elite absolute left-5 top-4 text-sm tracking-[0.25em] text-amber-50/95 [text-shadow:0_0_14px_rgba(255,225,150,0.5)]">
            {hud.objective}
          </div>

          {/* objective banner — announces goal changes front and center */}
          {banner && (
            <div className="objective-pop absolute left-1/2 top-[28%] border-y border-amber-100/15 bg-black/45 px-10 py-4 text-center shadow-[0_0_50px_rgba(0,0,0,0.55)] backdrop-blur-[2px]">
              <div className="font-elite text-[11px] tracking-[0.55em] text-amber-100/55">
                OBJECTIVE
              </div>
              <div className="font-elite mt-2 whitespace-nowrap text-2xl tracking-[0.3em] text-amber-50 [text-shadow:0_0_26px_rgba(255,230,160,0.7)]">
                {banner.title}
              </div>
              <div className="font-elite mt-3 text-[12px] tracking-[0.28em] text-amber-100/80">
                {banner.hint}
              </div>
            </div>
          )}

          {/* active cheats — always visible while any cheat is on */}
          {hud.cheats && (
            <div className="font-elite absolute left-5 top-10 text-[11px] tracking-[0.25em] text-emerald-300/80 [text-shadow:0_0_10px_rgba(60,255,160,0.35)]">
              CHEATS: {hud.cheats}
            </div>
          )}

          {/* sneaking indicator */}
          {hud.sneaking && (
            <div className="font-elite absolute bottom-14 left-1/2 -translate-x-1/2 text-[11px] tracking-[0.4em] text-amber-100/45">
              — SNEAKING —
            </div>
          )}

          {/* pages */}
          <div className="font-elite absolute bottom-4 left-5 text-sm tracking-[0.3em] text-amber-100/60">
            PAGES {hud.pages}/{hud.totalPages}
          </div>

          {/* key hints (desktop only) */}
          {!isTouch && (
            <div className="font-elite absolute bottom-4 right-5 text-[11px] tracking-[0.25em] text-amber-100/35">
              [F] TORCH {hud.flashlight ? "ON" : "OFF"} · [SHIFT] RUN · [C] SNEAK{" "}
              {hud.sneaking ? "ON" : "OFF"}
            </div>
          )}

          {/* stamina */}
          {hud.stamina < 0.995 && (
            <div className="absolute bottom-9 left-1/2 h-[3px] w-44 -translate-x-1/2 overflow-hidden rounded bg-white/10">
              <div
                className={`h-full transition-[width] duration-150 ${
                  hud.stamina < 0.25 ? "bg-red-400/80" : "bg-amber-100/70"
                }`}
                style={{ width: `${hud.stamina * 100}%` }}
              />
            </div>
          )}

          {/* interaction prompt */}
          {hud.prompt && (
            <div className="font-elite absolute bottom-[18%] left-1/2 -translate-x-1/2 animate-pulse text-base tracking-[0.3em] text-amber-100/90 [text-shadow:0_0_12px_rgba(255,220,150,0.5)]">
              {hud.prompt}
            </div>
          )}

          {/* collected page readout */}
          {pageLines && (
            <div className="page-pop absolute left-1/2 top-[16%] -translate-x-1/2">
              <div className="font-elite max-w-sm -rotate-1 border border-amber-100/10 bg-[#171410]/90 px-7 py-5 text-center text-[15px] leading-7 text-amber-100/85 shadow-[0_0_60px_rgba(0,0,0,0.9)]">
                {pageLines.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* --------------------------- START MENU --------------------------- */}
      {state === "idle" && (
        <Overlay vhs>
          {showCredits ? (
            <>
              <h2 className="vhs-title font-elite text-3xl tracking-[0.35em] text-amber-50/90">
                CREDITS
              </h2>
              <div className="font-elite mt-8 flex max-w-md flex-col items-center gap-3 text-center text-[13px] leading-6 tracking-[0.12em] text-amber-100/55">
                <p>a game by StarKnightt</p>
                <p className="text-amber-100/35">
                  every wall, texture, sound and scream in here is generated
                  by code. there are no asset files. there is no level file.
                  each run builds a maze that has never existed before.
                </p>
                <p className="text-amber-100/35">
                  built with three.js · next.js · webaudio
                </p>
              </div>
              <div className="mt-7 flex items-center gap-8">
                <GitHubBadge />
                <XBadge />
              </div>
              <ArmedButton
                onClick={() => setShowCredits(false)}
                className="font-elite mt-10 border border-amber-100/30 px-10 py-2.5 text-sm tracking-[0.4em] text-amber-100/70 transition-all hover:border-amber-100/80 hover:bg-amber-100/5"
              >
                BACK
              </ArmedButton>
            </>
          ) : (
            <>
              <div className="flicker-slow font-elite text-[11px] tracking-[0.6em] text-amber-200/40">
                LEVEL 0
              </div>
              <h1 className="vhs-title font-elite mt-3 text-6xl tracking-[0.18em] text-amber-50/95 sm:text-7xl">
                BACKROOMS
              </h1>
              <p className="font-elite mt-6 max-w-md text-center text-sm leading-6 text-amber-100/45">
                you tripped through a wrong corner of reality, and the world
                healed shut behind you. someone was here before — they left 8
                pages pinned to these walls. take them all and the door will
                show itself. and when the lights start to die, don&apos;t let
                it hear you walk.
              </p>

              {isTouch ? (
                <div className="font-elite mt-7 grid grid-cols-2 gap-x-10 gap-y-1.5 text-[12px] tracking-[0.2em] text-amber-100/35">
                  <span>LEFT STICK — WALK</span>
                  <span>RIGHT SIDE — LOOK</span>
                  <span>STICK FULLY OUT — RUN</span>
                  <span>BUTTONS — TORCH / SNEAK</span>
                </div>
              ) : (
                <div className="font-elite mt-7 grid grid-cols-2 gap-x-10 gap-y-1.5 text-[12px] tracking-[0.2em] text-amber-100/35">
                  <span>WASD — WALK</span>
                  <span>MOUSE — LOOK</span>
                  <span>SHIFT — RUN</span>
                  <span>C — SNEAK</span>
                  <span>F — FLASHLIGHT</span>
                  <span>E — INTERACT</span>
                  <span>ESC — PAUSE</span>
                </div>
              )}

              <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
                <button
                  onClick={begin}
                  disabled={!booted}
                  className="font-elite group flex items-center gap-3 bg-amber-100/90 px-10 py-3 text-base tracking-[0.4em] text-black transition-all hover:bg-amber-50 hover:shadow-[0_0_30px_rgba(255,230,170,0.25)] disabled:opacity-40"
                >
                  <svg viewBox="0 0 10 12" className="h-3 w-3 fill-current" aria-hidden="true">
                    <path d="M0 0 L10 6 L0 12 Z" />
                  </svg>
                  {booted ? "ENTER" : "LOADING TAPE…"}
                </button>
                <button
                  onClick={() => setShowCredits(true)}
                  className="font-elite border border-amber-100/40 px-8 py-3 text-base tracking-[0.3em] text-amber-100/75 transition-all hover:border-amber-100/80 hover:bg-amber-100/5 hover:text-amber-100"
                >
                  CREDITS
                </button>
              </div>

              <p className="font-elite mt-6 text-[11px] tracking-[0.3em] text-amber-100/25">
                HEADPHONES STRONGLY RECOMMENDED
              </p>
            </>
          )}
        </Overlay>
      )}

      {/* ----------------------------- PAUSED ----------------------------- */}
      {state === "paused" && (
        <Overlay>
          <h2 className="font-elite text-4xl tracking-[0.3em] text-amber-100/80">
            PAUSED
          </h2>
          <p className="font-elite mt-4 text-sm tracking-[0.2em] text-amber-100/40">
            it is still in there. it does not pause.
          </p>
          <ArmedButton
            onClick={resume}
            disabled={resuming}
            className="font-elite mt-8 border border-amber-100/30 px-10 py-3 tracking-[0.4em] text-amber-100/80 transition-all hover:border-amber-100/80 hover:bg-amber-100/5 disabled:opacity-50"
          >
            {resuming ? "RESUMING…" : "RESUME"}
          </ArmedButton>
          <ArmedButton
            onClick={exitToMenu}
            className="font-elite mt-4 border border-amber-100/15 px-10 py-2.5 text-sm tracking-[0.4em] text-amber-100/45 transition-all hover:border-red-300/50 hover:text-red-200/80 disabled:opacity-50"
          >
            EXIT TO MENU
          </ArmedButton>
          <p className="font-elite mt-3 text-[10px] tracking-[0.25em] text-amber-100/20">
            THE RUN IS LOST. THE PAGES STAY.
          </p>
          <div className="mt-8 flex items-center gap-8">
            <GitHubBadge />
            <XBadge />
          </div>
        </Overlay>
      )}

      {/* ------------------------------ DEAD ------------------------------ */}
      {state === "dead" && (
        <Overlay tint="red">
          <h2 className="font-elite glitch-text text-5xl tracking-[0.25em] text-red-300/90 [text-shadow:0_0_40px_rgba(255,40,40,0.4)]">
            YOU WERE TAKEN
          </h2>
          <p className="font-elite mt-6 text-sm tracking-[0.25em] text-red-200/40">
            PAGES FOUND — {stats.pages}/8 · SURVIVED — {mmss}
          </p>
          <p className="font-elite mt-2 text-xs tracking-[0.2em] text-red-200/30">
            the backrooms keep what they catch.
          </p>
          <ArmedButton
            onClick={retry}
            className="font-elite mt-10 border border-red-300/30 px-10 py-3 tracking-[0.4em] text-red-200/80 transition-all hover:border-red-300/80 hover:bg-red-300/5 disabled:opacity-40"
          >
            WAKE UP AGAIN
          </ArmedButton>
        </Overlay>
      )}

      {/* ------------------------------ WON ------------------------------ */}
      {state === "won" && (
        <Overlay tint="light">
          <h2 className="font-elite text-5xl tracking-[0.25em] text-amber-50 [text-shadow:0_0_50px_rgba(255,255,220,0.8)]">
            YOU GOT OUT
          </h2>
          <p className="font-elite mt-6 text-sm tracking-[0.25em] text-amber-100/60">
            ALL 8 PAGES · ESCAPED IN {mmss}
          </p>
          <p className="font-elite mt-2 text-xs tracking-[0.2em] text-amber-100/40">
            …or did you just noclip into level 1?
          </p>
          <ArmedButton
            onClick={retry}
            className="font-elite mt-10 border border-amber-100/40 px-10 py-3 tracking-[0.4em] text-amber-100/90 transition-all hover:border-amber-100/90 hover:bg-amber-100/10 disabled:opacity-40"
          >
            GO BACK IN
          </ArmedButton>
          <GitHubBadge className="mt-8" label="escaped? leave a star" />
        </Overlay>
      )}
    </div>
  );
}

/**
 * A button that ignores input for its first 450ms on screen — soaks up the
 * second half of an accidental double-click (which used to instantly retry
 * or quit a run the moment an overlay appeared).
 */
function ArmedButton({
  children,
  onClick,
  className,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), 450);
    return () => clearTimeout(id);
  }, []);
  return (
    <button onClick={onClick} disabled={!armed || disabled} className={className}>
      {children}
    </button>
  );
}

function GitHubBadge({
  className = "",
  label = "StarKnightt/Backroom-Escape",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <a
      href="https://github.com/StarKnightt/Backroom-Escape"
      target="_blank"
      rel="noopener noreferrer"
      className={`font-elite group flex items-center gap-2 text-[11px] tracking-[0.2em] text-amber-100/30 transition-all hover:text-amber-100/80 hover:[text-shadow:0_0_14px_rgba(255,220,140,0.4)] ${className}`}
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="h-4 w-4 fill-current opacity-70 transition-opacity group-hover:opacity-100"
      >
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
      {label}
    </a>
  );
}

function XBadge({
  className = "",
  label = "@Star_Knight12",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <a
      href="https://x.com/Star_Knight12"
      target="_blank"
      rel="noopener noreferrer"
      className={`font-elite group flex items-center gap-2 text-[11px] tracking-[0.2em] text-amber-100/30 transition-all hover:text-amber-100/80 hover:[text-shadow:0_0_14px_rgba(255,220,140,0.4)] ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="h-3.5 w-3.5 fill-current opacity-70 transition-opacity group-hover:opacity-100"
      >
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644Z" />
      </svg>
      {label}
    </a>
  );
}

/* ------------------------------ touch UI ------------------------------ */

function TouchControls({
  engineRef,
  prompt,
  flashlight,
  sneaking,
}: {
  engineRef: React.RefObject<Engine | null>;
  prompt: string | null;
  flashlight: boolean;
  sneaking: boolean;
}) {
  const baseRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const stickActive = useRef(false);
  const lookLast = useRef<{ id: number; x: number; y: number } | null>(null);

  const moveKnob = (e: React.PointerEvent) => {
    const base = baseRef.current, knob = knobRef.current;
    if (!base || !knob) return;
    const r = base.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const R = r.width / 2 - 18;
    const m = Math.hypot(dx, dy);
    if (m > R) {
      dx = (dx / m) * R;
      dy = (dy / m) * R;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    engineRef.current?.setTouchMove(dx / R, dy / R);
  };
  const releaseKnob = () => {
    stickActive.current = false;
    if (knobRef.current) knobRef.current.style.transform = "translate(0px, 0px)";
    engineRef.current?.setTouchMove(0, 0);
  };

  return (
    <div className="absolute inset-0 z-10 select-none" style={{ touchAction: "none" }}>
      {/* look pad — right two thirds of the screen */}
      <div
        className="absolute bottom-0 right-0 top-0 w-[62%]"
        onPointerDown={(e) => {
          lookLast.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const last = lookLast.current;
          if (!last || last.id !== e.pointerId) return;
          engineRef.current?.touchLook((e.clientX - last.x) * 2.4, (e.clientY - last.y) * 2.4);
          lookLast.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
        }}
        onPointerUp={() => (lookLast.current = null)}
        onPointerCancel={() => (lookLast.current = null)}
      />

      {/* movement stick */}
      <div
        ref={baseRef}
        className="absolute bottom-8 left-8 h-36 w-36 rounded-full border border-amber-100/25 bg-black/25"
        onPointerDown={(e) => {
          stickActive.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          moveKnob(e);
        }}
        onPointerMove={(e) => stickActive.current && moveKnob(e)}
        onPointerUp={releaseKnob}
        onPointerCancel={releaseKnob}
      >
        <div
          ref={knobRef}
          className="pointer-events-none absolute left-1/2 top-1/2 -ml-7 -mt-7 h-14 w-14 rounded-full border border-amber-100/40 bg-amber-100/20"
        />
      </div>

      {/* action buttons */}
      <div className="absolute bottom-10 right-5 flex flex-col items-end gap-3">
        {prompt && (
          <button
            className="font-elite animate-pulse rounded border border-amber-100/60 bg-amber-100/15 px-6 py-3.5 text-sm tracking-[0.25em] text-amber-100"
            onPointerDown={() => engineRef.current?.touchInteract()}
          >
            {prompt.replace("[E] ", "")}
          </button>
        )}
        <div className="flex gap-3">
          <button
            className={`font-elite rounded border px-4 py-3 text-[11px] tracking-[0.2em] ${
              sneaking
                ? "border-amber-100/70 bg-amber-100/25 text-amber-100"
                : "border-amber-100/30 bg-black/30 text-amber-100/70"
            }`}
            onPointerDown={() => engineRef.current?.setSneak(!sneaking)}
          >
            SNEAK
          </button>
          <button
            className={`font-elite rounded border px-4 py-3 text-[11px] tracking-[0.2em] ${
              flashlight
                ? "border-amber-100/50 bg-amber-100/15 text-amber-100/90"
                : "border-amber-100/30 bg-black/30 text-amber-100/60"
            }`}
            onPointerDown={() => engineRef.current?.touchTorch()}
          >
            TORCH
          </button>
        </div>
      </div>

      {/* pause */}
      <button
        className="font-elite absolute right-4 top-4 rounded border border-amber-100/30 bg-black/30 px-3.5 py-2 text-[11px] tracking-[0.2em] text-amber-100/70"
        onPointerDown={() => engineRef.current?.pause()}
      >
        ❚❚
      </button>
    </div>
  );
}

function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false, // SSR: assume desktop, corrected on hydration
  );
}

function Overlay({
  children,
  tint = "dark",
  vhs = false,
}: {
  children: React.ReactNode;
  tint?: "dark" | "red" | "light";
  vhs?: boolean;
}) {
  const bg = vhs
    ? "bg-black"
    : tint === "red"
      ? "bg-[#180404]/90"
      : tint === "light"
        ? "bg-[#15130c]/85"
        : "bg-[#0a0905]/92";
  return (
    <div className={`absolute inset-0 z-10 ${bg}`}>
      {vhs && <VHSNoise />}
      <div className="crt-grain pointer-events-none absolute inset-0 opacity-[0.07]" />
      <div className="scanlines pointer-events-none absolute inset-0 opacity-[0.05]" />
      {vhs && (
        <>
          <div className="tracking-band pointer-events-none absolute inset-x-0 h-32" />
          <RecOSD />
        </>
      )}
      {/* Scroll layer: on short screens (phone landscape) the menu is taller
          than the viewport — center when it fits, scroll when it doesn't.
          (Flex centering directly on the overflow container would clip the
          top of the content with no way to reach it.) */}
      <div className="absolute inset-0 overflow-y-auto overscroll-contain">
        <div className="flex min-h-full flex-col items-center justify-center px-6 py-10">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Analog tape snow: a tiny canvas of random grayscale redrawn ~12fps and
 * stretched across the screen. Cheap (20k pixels) and reads far more like
 * a real camcorder than any CSS trick.
 */
function VHSNoise() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const W = 320, H = 180;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(W, H);
    const d = img.data;
    let raf = 0;
    let last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 80) return; // ~12fps — chunky, like real snow
      last = t;
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.random() * 255;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.11] [image-rendering:pixelated]"
    />
  );
}

/** Camcorder on-screen display: blinking REC + a ticking tape counter. */
function RecOSD() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60).toString().padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return (
    <>
      <div className="font-elite pointer-events-none absolute left-5 top-4 flex items-center gap-2 text-[12px] tracking-[0.3em] text-amber-50/70">
        <span className="rec-dot h-2.5 w-2.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(255,40,40,0.8)]" />
        REC
      </div>
      <div className="font-elite pointer-events-none absolute right-5 top-4 text-[12px] tracking-[0.25em] text-amber-50/50">
        SP {h}:{m}:{s}
      </div>
    </>
  );
}
