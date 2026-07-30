import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";

/**
 * Render -> subtle bloom (fixtures, EXIT sign, flashlight hotspots)
 * -> tone mapping/output -> FXAA -> the Horror pass.
 *
 * The Horror pass runs in display space: animated film grain, breathing
 * vignette synced to the heartbeat, chromatic aberration and VHS-style
 * tearing that ramp up with fear.
 */

const HorrorShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uFear: { value: 0 },
    uGlitch: { value: 0 },
    uBeat: { value: 0 },
    uDeath: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uFear;
    uniform float uGlitch;
    uniform float uBeat;
    uniform float uDeath;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float dist = length(centered);

      // --- VHS tear bands while glitching
      if (uGlitch > 0.003) {
        float band = floor(uv.y * 36.0);
        float tear = (hash(vec2(band, floor(uTime * 24.0))) - 0.5);
        uv.x += tear * uGlitch * 0.05 * step(0.6, hash(vec2(band, floor(uTime * 13.0))));
      }

      // --- chromatic aberration (radial)
      float ab = 0.0012 + uFear * 0.004 + uGlitch * 0.012;
      vec2 dir = centered * ab;
      float r = texture2D(tDiffuse, uv - dir).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, uv + dir).b;
      vec3 col = vec3(r, g, b);

      // --- film grain
      float grain = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 113.0) - 0.5;
      col += grain * (0.045 + uFear * 0.085 + uGlitch * 0.06);

      // --- slight fear desaturation + cold lift in the blacks
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(luma), uFear * 0.22);
      col += vec3(0.004, 0.009, 0.006) * uFear * (1.0 - luma);

      // --- vignette that tightens with fear and throbs with the heartbeat
      float vigR = 0.78 - uFear * 0.17 - uBeat * 0.05;
      float vig = smoothstep(vigR, vigR - 0.55, dist);
      col *= mix(0.18, 1.0, vig);

      // --- death fade: collapse to black-red
      if (uDeath > 0.0) {
        col = mix(col, vec3(luma * 0.35, 0.0, 0.0), uDeath * 0.85);
        col *= 1.0 - uDeath * 0.9;
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class GameFX {
  composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private fxaa: ShaderPass;
  private horror: ShaderPass;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
  ) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));

    // Bloom runs at quarter resolution: it is a wide blur of the brightest
    // pixels, so nobody can tell it was sampled small, and it is ~13 extra
    // full-screen passes we would otherwise pay at full size.
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(width / 4, height / 4),
      0.32, // strength — the tubes were glaring; this is a halo, not a flare
      0.6,
      0.95, // threshold: only the tubes and signs bloom, never lit plaster
    );
    this.composer.addPass(this.bloom);

    this.composer.addPass(new OutputPass());

    this.fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaa);

    this.horror = new ShaderPass(HorrorShader);
    this.composer.addPass(this.horror);

    this.setSize(width, height, renderer.getPixelRatio());
  }

  setSize(width: number, height: number, pixelRatio: number) {
    this.composer.setSize(width, height);
    this.fxaa.material.uniforms["resolution"].value.set(
      1 / (width * pixelRatio),
      1 / (height * pixelRatio),
    );
    this.bloom.resolution.set(width / 4, height / 4);
  }

  update(
    time: number,
    fear: number,
    glitch: number,
    beat: number,
    death: number,
  ) {
    const u = this.horror.uniforms as typeof HorrorShader.uniforms;
    u.uTime.value = time;
    u.uFear.value = fear;
    u.uGlitch.value = glitch;
    u.uBeat.value = beat;
    u.uDeath.value = death;
  }

  render() {
    this.composer.render();
  }

  dispose() {
    this.composer.dispose();
  }
}
